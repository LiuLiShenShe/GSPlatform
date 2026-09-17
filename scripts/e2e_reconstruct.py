#!/usr/bin/env python3
"""E2E driver for Phase 07 — upload a real asset, reconstruct, watch to Viewer.

Exercises the full production path: API upload (tus-style) → submit → Celery
CPU/GPU workers → orchestrator → publish → Viewer. Prints a machine-readable
summary of the final job + scene version state.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
import time
import urllib.request
import uuid
from pathlib import Path

API = "http://127.0.0.1:8800"


def _req(method: str, path: str, data: bytes | None = None, headers: dict | None = None):
    r = urllib.request.Request(f"{API}{path}", method=method, data=data,
                               headers=headers or {})
    try:
        with urllib.request.urlopen(r, timeout=120) as resp:
            body = resp.read()
            return resp.status, json.loads(body) if body else None
    except urllib.error.HTTPError as e:
        body = e.read()
        try:
            parsed = json.loads(body)
        except Exception:
            parsed = {"raw": body.decode(errors="replace")[:500]}
        return e.code, parsed


def upload_file(path: str, *, purpose: str, title: str, category: str = "experiment",
                mime: str = "video/mp4") -> dict:
    """Upload a local file through the real tus-style flow; return session info."""
    size = len(open(path, "rb").read())
    sha = hashlib.sha256(open(path, "rb").read()).hexdigest()
    fname = path.rsplit("/", 1)[-1]

    status, sess = _req("POST", "/api/v1/uploads", json.dumps({
        "filename": fname,
        "mime_type": mime,
        "size": size,
        "format": fname.rsplit(".", 1)[-1],
        "sha256": sha,
        "title": title,
        "purpose": purpose,
        "category": category,
    }).encode(), {"Content-Type": "application/json"})
    assert status == 201, f"create failed {status}: {sess}"
    uid = sess["uploadId"]
    print(f"    created upload {uid} purpose={purpose} size={size}")

    # Patch the file in one chunk.
    with open(path, "rb") as fh:
        body = fh.read()
    status, sess2 = _req("PATCH", f"/api/v1/uploads/{uid}", body, {
        "Content-Type": "application/offset+octet-stream",
        "Upload-Offset": "0",
        "Upload-Length": str(size),
    })
    assert status == 200, f"patch failed {status}: {sess2}"

    status, done = _req("POST", f"/api/v1/uploads/{uid}/complete", json.dumps({
        "sha256": sha, "expected_size": size,
    }).encode(), {"Content-Type": "application/json"})
    assert status in (200, 201), f"complete failed {status}: {done}"
    print(f"    upload complete: status={done.get('status')}")
    return {"uploadId": uid, "purpose": purpose, "status": done.get("status")}


def submit_reconstruction(upload_ids: list[str], profile: str = "draft",
                          scene_title: str = "Phase07 E2E test") -> dict:
    status, job = _req("POST", "/api/v1/compute/reconstruct", json.dumps({
        "uploadIds": upload_ids,
        "profile": profile,
        "sceneTitle": scene_title,
    }).encode(), {"Content-Type": "application/json"})
    assert status in (200, 201, 202), f"submit failed {status}: {job}"
    print(f"    submitted job {job.get('jobId')} status={job.get('status')}")
    return job


def wait_job(job_id: str, poll_s: float = 5.0, max_s: float = 3600) -> dict:
    """Poll the job until a terminal state; return the final job payload."""
    t0 = time.time()
    last = None
    while time.time() - t0 < max_s:
        status, job = _req("GET", f"/api/v1/jobs/{job_id}")
        if status != 200:
            print(f"    poll error {status}: {job}")
            time.sleep(poll_s)
            continue
        st, stage, prog = job.get("status"), job.get("stage"), job.get("progress")
        if last != (st, stage, prog):
            print(f"    [{time.time()-t0:6.1f}s] status={st} stage={stage} progress={prog}%")
            last = (st, stage, prog)
        if st in ("SUCCEEDED", "FAILED", "CANCELLED", "CANCEL_REQUESTED"):
            return job
        time.sleep(poll_s)
    return job


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True)
    ap.add_argument("--purpose", default="RECONSTRUCT")
    ap.add_argument("--profile", default="draft")
    ap.add_argument("--scene-id", default=None)
    ap.add_argument("--no-submit", action="store_true")
    args = ap.parse_args()

    input_path = Path(args.input)
    if input_path.is_file():
        mime = "video/mp4" if input_path.suffix == ".mp4" else "image/jpeg"
        print(f">>> E2E: input={input_path} purpose={args.purpose} profile={args.profile}")
        up = upload_file(str(input_path), purpose=args.purpose, title="Phase07 E2E test", mime=mime)
        upload_ids = [up["uploadId"]]
    elif input_path.is_dir():
        files = sorted(f for f in input_path.iterdir()
                       if f.suffix.lower() in {".jpg", ".jpeg", ".png", ".webp"})
        print(f">>> E2E: {len(files)} photos from {input_path}")
        upload_ids = []
        for i, f in enumerate(files):
            up = upload_file(str(f), purpose=args.purpose,
                             title=f"Phase07 photo {i}", mime="image/jpeg")
            upload_ids.append(up["uploadId"])
        print(f"    uploaded {len(upload_ids)} photos")
    else:
        print(f"input not found: {input_path}", file=sys.stderr)
        return 1

    if args.no_submit:
        return 0

    job = submit_reconstruction(upload_ids, profile=args.profile,
                                scene_title="Phase07 E2E photos")
    job_id = job.get("jobId")
    final = wait_job(job_id)
    print("=" * 60)
    print(f"FINAL status={final.get('status')} stage={final.get('stage')}")
    print(f"  error_code={final.get('errorCode')}")
    print(f"  error_message={final.get('errorMessage')}")
    print(f"  scene_id={final.get('sceneId')}")
    print(f"  version_id={final.get('versionId')}")
    print(f"  progress={final.get('progress')}")
    print(f"  timings={json.dumps(final.get('timings') or {}, ensure_ascii=False)}")
    return 0 if final.get("status") == "SUCCEEDED" else 1


if __name__ == "__main__":
    sys.exit(main())
