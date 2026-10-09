#!/usr/bin/env python3
"""Copy reviewed phone-site source into its separate Sites deployment checkout."""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess

ROOT = Path(__file__).resolve().parents[1]
WEB = ROOT / "web"
DEFAULT_DEST = ROOT.parent / ".sites/mcd-pickup-handoff"
EXCLUDED = {"node_modules", "dist", ".wrangler", ".next", ".vinext", ".sites-runtime", ".git", "private", ".agents", ".codex", "coverage", "outputs", "work"}

def source_files():
    for directory, subdirs, files in os.walk(WEB):
        subdirs[:] = [name for name in subdirs if name not in EXCLUDED]
        for name in files:
            if name.startswith(".env") or name.endswith((".log", ".pem", ".tsbuildinfo")) or name == "next-env.d.ts":
                continue
            path = Path(directory) / name
            if path.is_symlink():
                raise ValueError("Source symlinks are not supported")
            yield path.relative_to(WEB)

def sync(destination: Path):
    destination = destination.resolve()
    expected = DEFAULT_DEST.resolve()
    if destination != expected or not (destination / ".git").is_dir():
        raise ValueError("Use the registered, separate Sites checkout")
    hosting = json.loads((WEB / ".openai/hosting.json").read_text(encoding="utf-8"))
    target_hosting = json.loads((destination / ".openai/hosting.json").read_text(encoding="utf-8"))
    if hosting["project_id"] != target_hosting["project_id"]:
        raise ValueError("Sites identity mismatch")
    git_root = subprocess.check_output(["git", "rev-parse", "--show-toplevel"], cwd=destination, text=True, encoding="utf-8").strip()
    if Path(git_root).resolve() != destination:
        raise ValueError("Deployment checkout is not its own repository")
    count = 0
    for relative in source_files():
        target = destination / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        if not target.exists() or (WEB / relative).read_bytes() != target.read_bytes():
            shutil.copyfile(WEB / relative, target)
        count += 1
    print(json.dumps({"source_files": count, "destination": str(destination), "project_id": hosting["project_id"]}))

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--destination", type=Path, default=DEFAULT_DEST)
    sync(parser.parse_args().destination)
