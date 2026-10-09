#!/usr/bin/env python3
"""Check staged files and release archives without printing private values."""
from io import BytesIO
import json
from pathlib import Path, PurePosixPath
import subprocess
from zipfile import ZipFile, is_zipfile

from mcp_readonly import read_token

ROOT = Path(__file__).resolve().parents[1]
BLOCKED = {"private", "node_modules", "dist", ".wrangler", ".sites-runtime", ".git", "__pycache__"}

def sensitive_values():
    result = []
    token = read_token()
    if token:
        result.append(token.encode())
    for path in (ROOT / "private").rglob("signing.key"):
        value = path.read_bytes()
        if value:
            result.extend([value, value.hex().encode()])
    for relative in ["private/mobile/device.json", "private/live-app.local.json"]:
        path = ROOT / relative
        if path.exists():
            values = json.loads(path.read_text(encoding="utf-8"))
            for key in ["device_token", "pair_code", "session_key", "token"]:
                value = values.get(key)
                if isinstance(value, str) and len(value) >= 16:
                    result.append(value.encode())
    return result

def check_file(name, data, values):
    parts = PurePosixPath(name).parts
    if (parts and parts[0] == "build") or any(part in BLOCKED or part.startswith(".env") for part in parts):
        raise ValueError(f"Private path in public files: {name}")
    if any(value in data for value in values):
        raise ValueError(f"Local credential detected in: {name}")
    if is_zipfile(BytesIO(data)):
        with ZipFile(BytesIO(data)) as archive:
            for entry in archive.infolist():
                if entry.is_dir():
                    continue
                if entry.file_size > 50 * 1024 * 1024:
                    raise ValueError(f"Unexpected large archive entry: {entry.filename}")
                check_file(entry.filename, archive.read(entry), values)

def main():
    names = subprocess.check_output(["git", "ls-files", "--stage", "-z"], cwd=ROOT).split(b"\0")
    values = sensitive_values()
    count = 0
    for entry in names:
        if not entry:
            continue
        metadata, name = entry.split(b"\t", 1)
        mode, sha, stage = metadata.split()
        if stage != b"0" or mode == b"160000":
            raise ValueError("Unmerged file or embedded repository in public index")
        data = subprocess.check_output(["git", "cat-file", "blob", sha.decode()], cwd=ROOT)
        check_file(name.decode("utf-8"), data, values)
        count += 1
    print(f"Public index and ZIP entries checked: {count} files; no local credentials found.")

if __name__ == "__main__":
    main()
