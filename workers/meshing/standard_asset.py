"""Full geometry PLY -> glTF with explicit unit conversion and no recalibration."""

import argparse
import hashlib
import json
import struct
import subprocess
from pathlib import Path

import numpy as np
import trimesh
from plyfile import PlyData
from trimesh.exchange.gltf import export_glb
from trimesh.visual.material import PBRMaterial
from trimesh.visual.texture import TextureVisuals

from workers.meshing.asset_coordinates import (
    CONVERTER_VERSION,
    SOURCE_UNIT_TO_METERS,
    TRANSFORM_VERSION,
    rotation_matrix,
)


def digest(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def read_glb(path):
    """Independent accessor inspection, no geometry processing or node flattening."""
    raw = Path(path).read_bytes()
    magic, version, length = struct.unpack_from("<III", raw)
    if (magic, version, length) != (0x46546C67, 2, len(raw)):
        raise ValueError("Invalid GLB envelope")
    size, kind = struct.unpack_from("<II", raw, 12)
    if kind != 0x4E4F534A:
        raise ValueError("Missing JSON chunk")
    tree = json.loads(raw[20 : 20 + size])
    binary_start = 20 + size + 8
    primitive = tree["meshes"][0]["primitives"][0]

    def accessor(index):
        acc = tree["accessors"][index]
        view = tree["bufferViews"][acc["bufferView"]]
        types = {5121: "u1", 5123: "<u2", 5125: "<u4", 5126: "<f4"}
        widths = {"SCALAR": 1, "VEC3": 3, "VEC4": 4}
        if "byteStride" in view or "sparse" in acc:
            raise ValueError("Unexpected accessor layout")
        values = np.frombuffer(
            raw,
            dtype=types[acc["componentType"]],
            count=acc["count"] * widths[acc["type"]],
            offset=binary_start + view.get("byteOffset", 0) + acc.get("byteOffset", 0),
        )
        return values.reshape(acc["count"], widths[acc["type"]])

    return (
        tree,
        {k: accessor(v) for k, v in primitive["attributes"].items()},
        accessor(primitive["indices"]).reshape(-1, 3),
    )


def convert(source, target, rotation, expected_sha, expected_vertices, expected_faces, source_units="m"):
    if trimesh.__version__ != "4.11.4":
        raise ValueError("Exporter version differs from recipe")
    if source_units not in SOURCE_UNIT_TO_METERS:
        raise ValueError("Unsupported source mesh unit")
    unit_scale = SOURCE_UNIT_TO_METERS[source_units]
    if digest(source) != expected_sha:
        raise ValueError("Source checksum mismatch")
    ply = PlyData.read(source)
    data = ply["vertex"].data
    vertices = np.column_stack([data[a] for a in ["x", "y", "z"]]).astype(np.float64)
    face_data = ply["face"].data["vertex_indices"]
    faces = np.stack(face_data) if face_data.dtype == object else np.asarray(face_data)
    if (
        faces.shape != (expected_faces, 3)
        or len(vertices) != expected_vertices
        or not np.isfinite(vertices).all()
        or faces.min() < 0
        or faces.max() >= len(vertices)
    ):
        raise ValueError("Source geometry does not match immutable catalog")
    normal_names = ["nx", "ny", "nz"]
    normals = (
        np.column_stack([data[n] for n in normal_names])
        if all(n in data.dtype.names for n in normal_names)
        else None
    )
    rotation = rotation_matrix(rotation)
    rotated = (vertices @ rotation.T) * unit_scale
    bounds = np.array([rotated.min(0), rotated.max(0)])
    pivot = np.array(
        [
            (bounds[0, 0] + bounds[1, 0]) / 2,
            bounds[0, 1],
            (bounds[0, 2] + bounds[1, 2]) / 2,
        ]
    )
    matrix = np.eye(4)
    matrix[:3, :3] = rotation * unit_scale
    matrix[:3, 3] = -pivot
    transformed = rotated - pivot
    mesh = trimesh.Trimesh(vertices=transformed, faces=faces, process=False)
    zero_normal_count = 0
    if normals is not None:
        norm = np.linalg.norm(normals, axis=1)
        if not np.isfinite(normals).all():
            raise ValueError("Invalid source normals")
        missing = norm < 1e-12
        zero_normal_count = int(missing.sum())
        # Zero normals have no direction to preserve. Fill from incident faces,
        # falling back to unit up only when the incident normal is undefined.
        if zero_normal_count:
            computed = np.array(mesh.vertex_normals) @ rotation
            computed[np.linalg.norm(computed, axis=1) < 1e-12] = [0, 1, 0]
            normals[missing] = computed[missing]
            norm = np.linalg.norm(normals, axis=1)
        mesh.vertex_normals = (normals / norm[:, None]) @ rotation.T
    else:
        # Missing normals are computed without changing topology.
        normals = np.array(mesh.vertex_normals)
        zero = np.linalg.norm(normals, axis=1) < 1e-12
        zero_normal_count = int(zero.sum())
        normals[zero] = [0, 1, 0]
        mesh.vertex_normals = normals
    colors = None
    if all(n in data.dtype.names for n in ["red", "green", "blue"]):
        rgb = np.column_stack([data[n] for n in ["red", "green", "blue"]])
        if rgb.dtype != np.uint8:
            raise ValueError(
                "Unsupported PLY color range; cannot assume sRGB normalization"
            )
        srgb = rgb.astype(np.float64) / 255
        colors = np.where(
            srgb <= 0.04045, srgb / 12.92, ((srgb + 0.055) / 1.055) ** 2.4
        ).astype(np.float32)
        mesh.vertex_attributes["_LINEAR_COLOR"] = colors
    mesh.visual = TextureVisuals(
        material=PBRMaterial(
            baseColorFactor=[1.0, 1.0, 1.0, 1.0],
            metallicFactor=0.0,
            roughnessFactor=1.0,
            doubleSided=True,
        )
    )

    def standard_color(tree):
        primitive = tree["meshes"][0]["primitives"][0]
        if colors is not None:
            primitive["attributes"]["COLOR_0"] = primitive["attributes"].pop(
                "_LINEAR_COLOR"
            )
        tree["asset"]["extras"] = {
            "coordinateSystem": "RIGHT_HANDED_Y_UP",
            "units": "m",
            "sourceUnits": source_units,
            "unitConversionScale": unit_scale,
            "pivotPolicy": "BOTTOM_CENTER",
            "transformBaked": True,
            "transformVersion": TRANSFORM_VERSION,
        }

    target = Path(target)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(
        export_glb(
            mesh.scene(), include_normals=True, tree_postprocessor=standard_color
        )
    )
    tree, attributes, indices = read_glb(target)
    if (
        tree.get("extensionsRequired")
        or len(tree["meshes"]) != 1
        or len(tree["meshes"][0]["primitives"]) != 1
        or not np.array_equal(indices, faces)
    ):
        raise ValueError("Topology or glTF dependencies changed")
    for node in tree["nodes"]:
        if any(k in node for k in ["translation", "rotation", "scale"]) or (
            "matrix" in node
            and not np.allclose(np.array(node["matrix"]).reshape(4, 4), np.eye(4))
        ):
            raise ValueError("Hidden node transform")
    actual = attributes["POSITION"].astype(np.float64)
    error = float(np.max(np.abs(actual - transformed)))
    tolerance = max(2e-7, float(np.ptp(transformed, axis=0).max()) * 2e-7)
    if error > tolerance:
        raise ValueError("Vertex geometry changed")
    # Corresponding pair lengths, using all vertices and a deterministic offset.
    delta = (vertices - np.roll(vertices, 1, axis=0)) * unit_scale
    actual_delta = actual - np.roll(actual, 1, axis=0)
    distance_error = float(
        np.max(
            np.abs(np.linalg.norm(delta, axis=1) - np.linalg.norm(actual_delta, axis=1))
        )
    )
    if distance_error > tolerance * 4:
        raise ValueError("Physical pair distance changed")
    if colors is not None and not np.array_equal(attributes["COLOR_0"], colors):
        raise ValueError("Vertex color changed")
    expected_normals = np.asarray(mesh.vertex_normals)
    normal_error = float(np.max(np.abs(attributes["NORMAL"] - expected_normals)))
    if normal_error > 2e-6:
        raise ValueError("Normals changed")
    if digest(source) != expected_sha:
        raise ValueError("Source changed during conversion")
    report = target.with_suffix(".validator.json")
    root = Path(__file__).resolve().parents[2]
    subprocess.run(
        ["node", str(root / "scripts/validate_glb.cjs"), str(target), str(report)],
        check=True,
        timeout=600,
    )
    validation = json.loads(report.read_text())
    if validation["issues"]["numErrors"]:
        raise ValueError("Official validator rejected GLB")
    asset_bounds = np.array([actual.min(0), actual.max(0)])
    return {
        "sourceToAssetMatrix": matrix.tolist(),
        "matrixConvention": "row-major; column vectors; already baked",
        "rotation": rotation.tolist(),
        "sourceBounds": [vertices.min(0).tolist(), vertices.max(0).tolist()],
        "assetBounds": asset_bounds.tolist(),
        "dimensionsMeters": (asset_bounds[1] - asset_bounds[0]).tolist(),
        "pivotPolicy": "BOTTOM_CENTER",
        "pivotInRotatedSource": (pivot / unit_scale).tolist(),
        "coordinateSystem": "RIGHT_HANDED_Y_UP",
        "units": "m",
        "sourceUnits": source_units,
        "unitConversionScale": unit_scale,
        "calibrationScaleApplied": 1,
        "scaleApplied": 1,
        "vertices": len(vertices),
        "faces": len(faces),
        "positionMaxErrorMeters": error,
        "pairDistanceMaxErrorMeters": distance_error,
        "normalMaxError": normal_error,
        "undefinedSourceNormalsFilled": zero_normal_count,
        "colorSpace": "sRGB PLY -> linear float32 COLOR_0",
        "vertexColors": colors is not None,
        "converterVersion": CONVERTER_VERSION,
        "transformVersion": TRANSFORM_VERSION,
        "validator": validation,
        "sha256": digest(target),
        "sizeBytes": target.stat().st_size,
        "sourcePlySha256": expected_sha,
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--request", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    request = json.loads(args.request.read_text())
    result = convert(
        Path(request["source"]),
        args.output,
        request["rotation"],
        request["sha256"],
        request["vertices"],
        request["faces"],
        request.get("sourceUnits", "m"),
    )
    args.output.with_suffix(".result.json").write_text(
        json.dumps(result, indent=2) + "\n"
    )
