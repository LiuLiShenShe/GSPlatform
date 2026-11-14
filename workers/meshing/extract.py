"""Native 2DGS TSDF / official NKSR mesh adapters in their existing environments."""

import argparse
import copy
import hashlib
import json
import os
import sys
from pathlib import Path

import numpy as np
import open3d as o3d
import torch

from workers.meshing.runtime import mesh_runtime


def extract_2dgs(source):
    _, repo = mesh_runtime("2dgs")
    sys.path.insert(0, str(repo))
    from arguments import ModelParams, PipelineParams
    from gaussian_renderer import GaussianModel, render
    from scene import Scene
    from utils.mesh_utils import GaussianExtractor, post_process_mesh

    settings = json.loads((source / "gsplat/params.json").read_text())
    root = source / "gsplat/checkpoints/2dgs"
    parser = argparse.ArgumentParser()
    models, pipeline = ModelParams(parser), PipelineParams(parser)
    args = parser.parse_args([])
    args.source_path, args.model_path = str(root / "dataset"), str(root)
    args.sh_degree, args.resolution, args.data_device = (
        int(settings.get("sh_degree", 0)),
        1,
        "cpu",
    )
    if (root / "dataset/masks").is_dir() and any((root / "dataset/masks").iterdir()):
        args.mask_mode, args.mask_dir, args.mask_pattern = (
            "alpha",
            str(root / "dataset/masks"),
            "{stem}.png",
        )
    gaussians = GaussianModel(args.sh_degree)
    scene = Scene(
        models.extract(args),
        gaussians,
        load_iteration=int(settings["iterations"]),
        shuffle=False,
    )
    extractor = GaussianExtractor(
        gaussians, render, pipeline.extract(args), bg_color=[0, 0, 0]
    )
    gaussians.active_sh_degree = 0
    print("MESHPROGRESS RENDERING 15", flush=True)
    extractor.reconstruction(scene.getTrainCameras())
    depth_trunc = float(extractor.radius) * 2
    voxel_size = depth_trunc / 1024  # Native bounded-mesh defaults.
    if not np.isfinite(voxel_size) or voxel_size <= 0:
        raise ValueError("2DGS 相机包围范围无效")
    print("MESHPROGRESS TSDF 60", flush=True)
    mesh = extractor.extract_mesh_bounded(
        voxel_size=voxel_size, sdf_trunc=5 * voxel_size, depth_trunc=depth_trunc
    )
    # The native component filter assumes at least one triangle.
    if len(mesh.triangles):
        mesh = post_process_mesh(mesh, cluster_to_keep=50)
    return mesh, {
        "method": "2DGS_NATIVE_TSDF",
        "voxelSizeSourceUnits": voxel_size,
        "depthTruncSourceUnits": depth_trunc,
        "meshResolution": 1024,
    }


def extract_nksr(observations):
    import nksr
    from nksr.configs import __configs__
    from scipy.spatial import cKDTree

    _, weights = mesh_runtime("gsplat")
    data = np.load(observations)
    xyz, normal, rgb, sensor = (
        data[k].astype(np.float32) for k in ("xyz", "normal", "rgb", "sensor")
    )
    if not all(np.isfinite(a).all() for a in (xyz, normal, rgb, sensor)):
        raise ValueError("深度观测包含无效数值")
    span = float(
        np.max(np.quantile(xyz, 0.99, axis=0) - np.quantile(xyz, 0.01, axis=0))
    )
    if span <= 0 or len(xyz) < 100:
        raise ValueError("有效表面点不足")
    config = copy.deepcopy(__configs__["ks"])
    config["url"] = str(weights)
    print("MESHPROGRESS NKSR 50", flush=True)
    reconstructor = nksr.Reconstructor(torch.device("cuda:0"), config=config)
    with torch.no_grad():
        field = reconstructor.reconstruct(
            torch.from_numpy(xyz).cuda(),
            normal=torch.from_numpy(normal).cuda(),
            sensor=torch.from_numpy(sensor).cuda(),
            detail_level=None,
            voxel_size=span / 256,
            solver_max_iter=2000,
            solver_tol=1e-5,
            approx_kernel_grad=False,
            fused_mode=True,
        )
        if field is None:
            raise ValueError("NKSR 未生成有效表面")
        print("MESHPROGRESS EXTRACTING 80", flush=True)
        extracted = field.extract_dual_mesh(mise_iter=1, trim=True, max_points=1000000)
    vertices, faces = extracted.v.cpu().numpy(), extracted.f.cpu().numpy()
    mesh = o3d.geometry.TriangleMesh(
        o3d.utility.Vector3dVector(vertices), o3d.utility.Vector3iVector(faces)
    )
    _, indices = cKDTree(xyz).query(vertices)
    mesh.vertex_colors = o3d.utility.Vector3dVector(rgb[indices])
    return mesh, {
        "method": "NKSR",
        "input": "GSPLAT_EXPECTED_DEPTH_ORIENTED_NORMALS",
        "inputPoints": len(xyz),
        "voxelSizeSourceUnits": span / 256,
        "weightsSha256": hashlib.sha256(weights.read_bytes()).hexdigest(),
    }


def save_mesh(mesh, output, scale, metadata):
    if (
        not len(mesh.vertices)
        or not len(mesh.triangles)
        or not np.isfinite(np.asarray(mesh.vertices)).all()
    ):
        raise ValueError("网格为空或包含无效顶点")
    mesh.remove_degenerate_triangles()
    mesh.remove_unreferenced_vertices()
    if not len(mesh.triangles):
        raise ValueError("网格没有有效三角面")
    # Apply the exact same uniform scale as automatic Gaussian calibration, once.
    mesh.vertices = o3d.utility.Vector3dVector(np.asarray(mesh.vertices) * scale)
    mesh.compute_vertex_normals()
    output.mkdir(parents=True, exist_ok=True)
    temporary = output / "mesh.tmp.ply"
    if not o3d.io.write_triangle_mesh(str(temporary), mesh, write_ascii=False):
        raise ValueError("网格写入失败")
    os.replace(temporary, output / "mesh.ply")
    metadata.update(
        vertices=len(mesh.vertices),
        faces=len(mesh.triangles),
        scaleFactor=scale,
        units="m",
        sizeBytes=(output / "mesh.ply").stat().st_size,
        boundsMeters=[
            np.asarray(mesh.vertices).min(0).tolist(),
            np.asarray(mesh.vertices).max(0).tolist(),
        ],
        sha256=hashlib.sha256((output / "mesh.ply").read_bytes()).hexdigest(),
    )
    temporary = output / "result.tmp.json"
    temporary.write_text(json.dumps(metadata, indent=2))
    os.replace(temporary, output / "result.json")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--algorithm", choices=("gsplat", "2dgs"), required=True)
    parser.add_argument("--scale", type=float, required=True)
    args = parser.parse_args()
    if not np.isfinite(args.scale) or args.scale <= 0:
        raise ValueError("无效的标定倍率")
    torch.set_num_threads(4)
    mesh, metadata = (
        extract_2dgs(args.source)
        if args.algorithm == "2dgs"
        else extract_nksr(args.output / "observations.npz")
    )
    print("MESHPROGRESS WRITING 95", flush=True)
    save_mesh(mesh, args.output, args.scale, metadata)
    torch.cuda.synchronize()
    print("MESHPROGRESS SUCCEEDED 100", flush=True)


if __name__ == "__main__":
    main()
