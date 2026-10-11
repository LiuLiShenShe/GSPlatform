"""Independently build/serve the pinned unmodified official Editor."""

import argparse
import hashlib
import json
import os
import shutil
import signal
import subprocess
import sys
import time
from datetime import datetime, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parent
PIN = json.loads((ROOT / "editor-version.json").read_text())
BASE = PIN["basePath"]
CSP = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' blob:; worker-src 'self' blob:; media-src 'self' blob:; font-src 'self' data:; object-src 'none'; base-uri 'self'; form-action 'none'; frame-ancestors 'none'"


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def run(command, cwd=None, env=None):
    return subprocess.check_output(command, cwd=cwd, env=env, text=True, timeout=600).strip()


def verify(artifact):
    receipt = json.loads((artifact / "editor-build.json").read_text())
    if any(receipt.get(key) != value for key, value in PIN.items()):
        raise ValueError("Artifact does not match the approved Editor pin")
    checksums = (artifact / "checksums.sha256").read_text()
    if hashlib.sha256(checksums.encode()).hexdigest() != receipt["artifactSha256"]:
        raise ValueError("Artifact identity mismatch")
    recorded = set()
    for entry in checksums.splitlines():
        expected, name = entry.split("  ", 1)
        target = (artifact / name).resolve()
        if not target.is_relative_to(artifact.resolve()) or digest(target) != expected:
            raise ValueError(f"Checksum mismatch: {name}")
        recorded.add(name)
    actual = {path.relative_to(artifact).as_posix() for path in artifact.rglob("*") if path.is_file()}
    if actual != recorded | {"checksums.sha256", "editor-build.json"}:
        raise ValueError("Artifact contains missing or unrecorded files")
    return receipt


def build(cache, local_source):
    source = cache / "source"
    artifact = cache / "dist"
    if artifact.exists():
        raise ValueError("Use a new --cache; existing release artifacts are preserved")
    cache.mkdir(parents=True, exist_ok=True)
    if not source.exists():
        if local_source:
            run(["git", "clone", "--no-hardlinks", str(local_source), str(source)])
        else:
            run(["git", "clone", "--depth=1", "--branch", PIN["upstreamTag"], PIN["upstreamRepository"], str(source)])
        run(["git", "checkout", "--detach", PIN["upstreamCommit"]], source)
    if run(["git", "rev-parse", "HEAD"], source) != PIN["upstreamCommit"]:
        raise ValueError("Source commit mismatch")
    if run(["git", "status", "--porcelain", "--untracked-files=all"], source):
        raise ValueError("Refusing modified upstream source")
    for name, expected in [("package-lock.json", PIN["packageLockSha256"]), ("LICENSE", PIN["licenseSha256"])]:
        if digest(source / name) != expected:
            raise ValueError(f"Pin checksum mismatch: {name}")
    node = run(["node", "--version"]).removeprefix("v")
    if tuple(map(int, node.split("."))) < tuple(map(int, PIN["minimumNode"].split("."))):
        raise ValueError("Unsupported Node version")
    subprocess.run(PIN["installCommand"].split(), cwd=source, check=True, timeout=600)
    subprocess.run(["npm", "run", "build"], cwd=source, check=True, timeout=600,
                   env={**os.environ, "BASE_HREF": BASE, "BUILD_TYPE": "release"})
    shutil.copytree(source / "dist", artifact)
    shutil.copyfile(source / "LICENSE", artifact / "LICENSE")
    (artifact / "UPSTREAM.txt").write_text(f"{PIN['upstreamRepository']}\n{PIN['upstreamCommit']}\nMIT, unmodified source\n")
    notices = artifact / "licenses"
    notices.mkdir()
    inventory = []
    for name, package in sorted(json.loads((source / "package-lock.json").read_text())["packages"].items()):
        if not name:
            continue
        item = {"path": name, "version": package.get("version"), "license": package.get("license"), "notices": []}
        for path in sorted((source / name).glob("*")):
            if path.is_file() and path.name.lower().startswith(("license", "licence", "copying", "notice")):
                filename = name.replace("/", "_") + "_" + path.name
                shutil.copyfile(path, notices / filename)
                item["notices"].append("licenses/" + filename)
        inventory.append(item)
    (artifact / "dependency-licenses.json").write_text(json.dumps(inventory, indent=2) + "\n")
    checksums = "".join(f"{digest(path)}  {path.relative_to(artifact).as_posix()}\n" for path in sorted(artifact.rglob("*")) if path.is_file())
    (artifact / "checksums.sha256").write_text(checksums)
    receipt = {**PIN, "builtAt": datetime.now(timezone.utc).isoformat(), "nodeVersion": node,
               "npmVersion": run(["npm", "--version"]), "artifactSha256": hashlib.sha256(checksums.encode()).hexdigest()}
    (artifact / "editor-build.json").write_text(json.dumps(receipt, indent=2) + "\n")
    print(json.dumps(verify(artifact), indent=2))


def serve(artifact, port):
    verify(artifact)

    class Handler(SimpleHTTPRequestHandler):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, directory=str(artifact), **kwargs)

        def log_message(self, message, *args):
            sys.stderr.write(f"{self.command} {self.path.split('?')[0]}\n")

        def do_GET(self):
            self._serve_resource(head=False)

        def do_HEAD(self):
            self._serve_resource(head=True)

        def _serve_resource(self, head):
            resource = unquote(urlsplit(self.path).path)
            if not resource.startswith(BASE) or any(part in {".", ".."} for part in resource.split("/")):
                self.send_error(404)
                return
            relative = resource[len(BASE):] or "index.html"
            target = (artifact / relative).resolve()
            if not target.is_relative_to(artifact.resolve()) or not target.is_file():
                self.send_error(404)
                return
            self.path = "/" + relative
            if head:
                super().do_HEAD()
            else:
                super().do_GET()

        def end_headers(self):
            for key, value in {"Content-Security-Policy": CSP, "Referrer-Policy": "no-referrer", "Cross-Origin-Opener-Policy": "same-origin", "X-Content-Type-Options": "nosniff", "Cache-Control": "no-cache"}.items():
                self.send_header(key, value)
            super().end_headers()

    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()


def health(port):
    for name in ["index.html", "index.js", "index.css", "static/lib/webp/webp.wasm", "editor-build.json", "LICENSE"]:
        with urlopen(f"http://127.0.0.1:{port}{BASE}{name}", timeout=5) as response:
            if response.status != 200:
                raise ValueError("HTTP health failed")
    print("EDITOR_HTTP_HEALTH=PASS; real browser functional gate is separate")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["build", "verify", "start", "serve", "stop", "health"])
    parser.add_argument("--cache", type=Path, default=ROOT / ".cache")
    parser.add_argument("--local-source", type=Path)
    parser.add_argument("--runtime", type=Path, default=ROOT / ".runtime")
    parser.add_argument("--port", type=int, default=18031)
    args = parser.parse_args()
    cache = args.cache.resolve()
    runtime = args.runtime.resolve()
    pidfile = runtime / "editor.pid"
    if args.command == "build":
        build(cache, args.local_source)
    elif args.command == "verify":
        print(json.dumps(verify(cache / "dist"), indent=2))
    elif args.command == "serve":
        serve(cache / "dist", args.port)
    elif args.command == "health":
        health(args.port)
    elif args.command == "start":
        if pidfile.exists():
            raise ValueError("Managed PID receipt exists; use health/stop first")
        verify(cache / "dist")
        runtime.mkdir(parents=True, exist_ok=True)
        with (runtime / "editor.log").open("ab") as logfile:
            process = subprocess.Popen([sys.executable, str(Path(__file__).resolve()), "serve", "--cache", str(cache), "--port", str(args.port)], stdout=logfile, stderr=logfile, start_new_session=True)
        pidfile.write_text(str(process.pid))
        for attempt in range(20):
            if process.poll() is not None:
                pidfile.unlink()
                raise ValueError("Editor failed to start; inspect editor.log")
            try:
                health(args.port)
                return
            except OSError:
                time.sleep(.25)
        raise ValueError("Editor did not become healthy; inspect editor.log and stop")
    elif args.command == "stop":
        if pidfile.exists():
            pid = int(pidfile.read_text())
            proc = Path(f"/proc/{pid}/cmdline")
            if proc.exists():
                if proc.read_bytes().decode().split("\0")[1:3] != [str(Path(__file__).resolve()), "serve"]:
                    raise ValueError("Refusing to stop a foreign PID")
                os.kill(pid, signal.SIGTERM)
            pidfile.unlink()
        print("Editor stopped; platform processes/assets untouched")


if __name__ == "__main__":
    main()
