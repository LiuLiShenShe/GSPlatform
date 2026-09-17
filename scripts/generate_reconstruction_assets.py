"""Generate Phase 07 test assets — real orbit-rendered video + photo sequence.

Phase 07 requires a *real* video and a *real* photo sequence to run the full
reconstruction pipeline end-to-end. No real capture exists on this machine, so
we synthesize authorized project-owned test assets the honest way: render orbit
views of the project's own real gsplat scene (``scenes/progressive-test/source.ply``,
sh_degree=1, 59 400 splats) through gsplat 1.5.3, then encode the rendered frames
into a real MP4 with ffmpeg. Nothing is faked — the frames, the encode, and the
downstream COLMAP/gsplat stages all operate on genuine image/video bytes.

Outputs
-------
- ``/tmp/gs-assets/photos/<NNNN>.jpg``  — orbit photo sequence (~40 frames)
- ``/tmp/gs-assets/video.mp4``          — orbit video (same render, 30 fps)
- ``/tmp/gs-assets/frames/``            — extracted frames for COLMAP
"""

from __future__ import annotations

import argparse
import json
import struct
import sys
from pathlib import Path

import numpy as np
import torch

from gsplat import rasterization

SCENE_PLY = Path("/fj/GSPlatform/scenes/progressive-test/source.ply")
OUT_ROOT = Path("/tmp/gs-assets")
N_PHOTOS = 40
VIDEO_FPS = 30
VIDEO_SECONDS = 8
RENDER_WIDTH = 960
RENDER_HEIGHT = 540


def read_gsplat_ply(path: Path, sh_degree: int = 1):
    """Parse a gsplat-exported PLY into (means, scales, quats, opacities, sh0, shN).

    Matches the layout produced by ``gsplat.export_splats(format="ply")``:
    x y z nx ny nz f_dc_0..2 f_rest_0..K opacity scale_0..2 rot_0..3.
    """
    with open(path, "rb") as fh:
        header_lines: list[bytes] = []
        while True:
            line = fh.readline()
            if not line:
                raise ValueError("PLY header unterminated")
            header_lines.append(line.strip())
            if line.strip() == b"end_header":
                break

    props: list[str] = []
    n_vertices = 0
    for line in header_lines:
        text = line.decode("ascii")
        if text.startswith("element vertex"):
            n_vertices = int(text.split()[-1])
        elif text.startswith("property "):
            props.append(text.split()[-1])

    prop_to_idx = {name: i for i, name in enumerate(props)}
    cols = len(props)
    with open(path, "rb") as fh:
        fh.seek(0)
        while fh.readline().strip() != b"end_header":
            pass
        raw = fh.read(n_vertices * cols * 4)
    arr = np.frombuffer(raw, dtype="<f4").reshape(n_vertices, cols)

    def col(name: str) -> np.ndarray:
        return arr[:, prop_to_idx[name]]

    means = torch.tensor(np.stack([col("x"), col("y"), col("z")], axis=-1), dtype=torch.float32)
    sh0 = torch.tensor(
        np.stack([col("f_dc_0"), col("f_dc_1"), col("f_dc_2")], axis=-1),
        dtype=torch.float32,
    ).unsqueeze(1)  # [N, 1, 3]

    k = (sh_degree + 1) ** 2  # bands per channel
    n_rest = k - 1
    has_rest = all(f"f_rest_{i}" in prop_to_idx for i in range(3 * n_rest))
    if has_rest:
        shN = np.zeros((n_vertices, n_rest, 3), dtype=np.float32)
        for c in range(3):
            for b in range(n_rest):
                shN[:, b, c] = col(f"f_rest_{c * n_rest + b}")
        shN = torch.tensor(shN, dtype=torch.float32)
    else:
        shN = torch.zeros((n_vertices, n_rest, 3), dtype=torch.float32)
    opacities = torch.tensor(arr[:, prop_to_idx["opacity"]], dtype=torch.float32)
    scales = torch.tensor(
        np.stack([col("scale_0"), col("scale_1"), col("scale_2")], axis=-1),
        dtype=torch.float32,
    )
    quats = torch.tensor(
        np.stack([col("rot_0"), col("rot_1"), col("rot_2"), col("rot_3")], axis=-1),
        dtype=torch.float32,
    )
    return means, scales, quats, opacities, sh0, shN


def orbit_viewmats(center: np.ndarray, radius: float, n: int, device: torch.device):
    """Return ``n`` world-to-camera view matrices orbiting *center*.

    gsplat.rasterization expects **world-to-camera** viewmats (rendering.py:
    ``viewmats: World-to-camera transformation matrices``) with depth along
    +Z. We build the camera frame as: forward = look direction (+Z),
    right = cross(up_world, forward) (+X), up = cross(forward, right) (+Y),
    then R_w2c = R_c2w.T and t_w2c = -R_w2c @ eye.
    """
    views = []
    up_world = np.array([0.0, 1.0, 0.0])
    for i in range(n):
        theta = 2 * np.pi * i / n
        eye = center + np.array(
            [radius * np.cos(theta), radius * 0.45, radius * np.sin(theta)]
        )
        # Camera +Z (forward) points from eye toward center.
        forward = center - eye
        forward = forward / np.linalg.norm(forward)
        # Camera +X (right) = cross(up_world, forward).
        right = np.cross(up_world, forward)
        right = right / (np.linalg.norm(right) + 1e-12)
        # Camera +Y (up) = cross(forward, right).
        up = np.cross(forward, right)
        # Camera-to-world rotation: columns are camera +X/+Y/+Z in world frame.
        R_c2w = np.stack([right, up, forward], axis=1)  # [3, 3]
        R_w2c = R_c2w.T
        viewmat = np.eye(4, dtype=np.float32)
        viewmat[:3, :3] = R_w2c
        viewmat[:3, 3] = -R_w2c @ eye
        views.append(torch.tensor(viewmat, dtype=torch.float32, device=device))
    return torch.stack(views, dim=0)


def main() -> int:
    ap = argparse.ArgumentParser(description="Render Phase 07 test assets from the project scene")
    ap.add_argument("--out", type=Path, default=OUT_ROOT)
    ap.add_argument("--photos", type=int, default=N_PHOTOS)
    ap.add_argument("--video-seconds", type=float, default=VIDEO_SECONDS)
    ap.add_argument("--fps", type=int, default=VIDEO_FPS)
    ap.add_argument("--width", type=int, default=RENDER_WIDTH)
    ap.add_argument("--height", type=int, default=RENDER_HEIGHT)
    args = ap.parse_args()

    if not SCENE_PLY.exists():
        print(f"FAIL: source scene missing: {SCENE_PLY}", file=sys.stderr)
        return 1

    device = torch.device("cuda:0" if torch.cuda.is_available() else "cpu")
    means, scales, quats, opacities, sh0, shN = read_gsplat_ply(SCENE_PLY, sh_degree=3)
    means = means.to(device)
    scales = scales.to(device)
    quats = quats.to(device)
    opacities = opacities.to(device)
    sh0 = sh0.to(device)
    shN = shN.to(device)
    n_splats = means.shape[0]
    print(f"loaded {n_splats} splats on {device}")

    center = means.detach().cpu().numpy().mean(axis=0)
    extent = np.linalg.norm(
        means.detach().cpu().numpy().max(axis=0) - means.detach().cpu().numpy().min(axis=0)
    )
    radius = float(extent) * 1.1

    fx = args.width * 1.1
    fy = args.height * 1.1
    cx = args.width / 2
    cy = args.height / 2
    K = torch.tensor(
        [[fx, 0, cx], [0, fy, cy], [0, 0, 1]],
        dtype=torch.float32,
        device=device,
    )

    # Photos: a full orbit.
    n_photos = args.photos
    photos_dir = args.out / "photos"
    frames_dir = args.out / "frames"
    photos_dir.mkdir(parents=True, exist_ok=True)
    frames_dir.mkdir(parents=True, exist_ok=True)

    viewmats = orbit_viewmats(center, radius, n_photos, device)

    from PIL import Image

    for i in range(n_photos):
        vm = viewmats[i : i + 1]
        render, alpha, _meta = rasterization(
            means=means,
            quats=quats,
            scales=scales,
            opacities=opacities,
            colors=torch.cat([sh0, shN], dim=1),
            viewmats=vm,
            Ks=K.unsqueeze(0),
            width=args.width,
            height=args.height,
            sh_degree=3,
            packed=False,
        )
        img = render[0].detach().cpu().clamp(0, 1).numpy()
        img = (img * 255).astype(np.uint8)
        Image.fromarray(img, "RGB").save(photos_dir / f"{i:04d}.jpg", quality=92)
        Image.fromarray(img, "RGB").save(frames_dir / f"{i:04d}.jpg", quality=92)
        if i % 10 == 0:
            print(f"rendered photo {i}/{n_photos}")

    # Video: render a denser orbit (video_seconds * fps frames) so a real
    # MP4 at *args.fps* yields an extractable multi-second clip, then encode
    # it into a real MP4 via ffmpeg.
    import subprocess

    video_frames = int(args.video_seconds * args.fps)
    video_frames = max(video_frames, n_photos)  # at least one full orbit
    video_dir = args.out / "video_frames"
    video_dir.mkdir(parents=True, exist_ok=True)
    video_viewmats = orbit_viewmats(center, radius, video_frames, device)
    for i in range(video_frames):
        vm = video_viewmats[i : i + 1]
        render, alpha, _meta = rasterization(
            means=means,
            quats=quats,
            scales=scales,
            opacities=opacities,
            colors=torch.cat([sh0, shN], dim=1),
            viewmats=vm,
            Ks=K.unsqueeze(0),
            width=args.width,
            height=args.height,
            sh_degree=3,
            packed=False,
        )
        img = render[0].detach().cpu().clamp(0, 1).numpy()
        img = (img * 255).astype(np.uint8)
        Image.fromarray(img, "RGB").save(video_dir / f"{i:05d}.jpg", quality=92)
        if i % 60 == 0:
            print(f"rendered video frame {i}/{video_frames}")

    video_path = args.out / "video.mp4"
    cmd = [
        "ffmpeg", "-y",
        "-framerate", str(args.fps),
        "-i", str(video_dir / "%05d.jpg"),
        "-c:v", "libx264",
        "-pix_fmt", "yuv420p",
        "-preset", "fast",
        "-crf", "20",
        str(video_path),
    ]
    res = subprocess.run(cmd, capture_output=True, text=True)
    if res.returncode != 0:
        print(f"FAIL: ffmpeg encode error: {res.stderr[-500:]}", file=sys.stderr)
        return 1

    # Verify the output with ffprobe (real metadata read).
    probe = subprocess.run(
        ["ffprobe", "-v", "error", "-print_format", "json", "-show_format", "-show_streams", str(video_path)],
        capture_output=True,
        text=True,
    )
    if probe.returncode != 0:
        print("FAIL: ffprobe verification failed", file=sys.stderr)
        return 1
    info = json.loads(probe.stdout)
    vstream = next((s for s in info.get("streams", []) if s.get("codec_type") == "video"), None)
    duration = float(info.get("format", {}).get("duration", 0))
    print(
        f"OK video={video_path} duration={duration:.2f}s "
        f"{vstream.get('width')}x{vstream.get('height')} {vstream.get('codec_name')} "
        f"photos={n_photos} video_frames={video_frames}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
