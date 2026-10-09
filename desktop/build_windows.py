"""Build a windowed portable EXE from an explicit, private-data-free whitelist.

Run with a normal Windows Python: py -3 desktop/build_windows.py.
Only private/desktop-build/venv receives build dependencies.
"""
from pathlib import Path
import hashlib
import json
import os
import shutil
import subprocess
import sys
import venv

ROOT = Path(__file__).resolve().parents[1]
BUILD = ROOT / "private/desktop-build"
SOURCES = (
    "desktop/main.pyw", "scripts/runtime_paths.py", "scripts/mobile_bridge.py",
    "scripts/mobile_connector.pyw", "scripts/mcp_readonly.py", "scripts/live_handoff.py",
    "scripts/render_card.py", "scripts/visual_assets.py", "scripts/vendor/qrcodegen.py",
)
RESOURCES = (
    "LICENSE", "scripts/vendor/LICENSE.qrcodegen.txt", "desktop/licenses/Tcl-license.terms",
    "desktop/licenses/Tk-license.terms", "templates/card.html",
    "assets/brand/handoff-mark.png", "assets/brand/handoff-mark.ico",
    "assets/paper.png", "assets/handoff.png", "assets/title.png",
    "assets/fonts/source.css", "assets/fonts/dm-mono-source.css",
    "assets/fonts/noto-display-0.ttf", "assets/fonts/noto-display-1.ttf",
    "assets/fonts/noto-display-2.ttf", "assets/fonts/noto-display-3.ttf",
    "assets/fonts/dm-mono-0.ttf", "assets/fonts/dm-mono-1.ttf",
    "assets/fonts/NotoSansSC-OFL.txt", "assets/fonts/DMMono-OFL.txt",
    "assets/icons/storefront.svg", "assets/icons/bag.svg", "assets/icons/clock.svg",
    "assets/icons/clipboard-text.svg", "assets/icons/map-pin.svg", "assets/icons/LICENSE.txt",
)
# Reproducible build-tool versions; none are imported by the application itself.
BUILD_DEPS = (
    "PyInstaller==6.22.3", "altgraph==0.17.5", "packaging==26.3", "pefile==2024.8.26",
    "pyinstaller-hooks-contrib==2026.8", "pywin32-ctypes==0.2.3", "setuptools==84.0.0",
)


def main():
    if sys.platform != "win32":
        raise SystemExit("Windows EXE 必须在 Windows 上构建。")
    BUILD.mkdir(parents=True, exist_ok=True)
    python = BUILD / "venv/Scripts/python.exe"
    if not python.is_file():
        venv.EnvBuilder(with_pip=True).create(BUILD / "venv")
    subprocess.run([str(python), "-m", "pip", "install", "--index-url", "https://pypi.org/simple", *BUILD_DEPS], check=True)
    # Unique staging avoids stale files and never traverses the working project.
    import tempfile
    stage = Path(tempfile.mkdtemp(prefix="source-", dir=BUILD))
    receipt = {}
    for name in (*SOURCES, *RESOURCES):
        source = ROOT / name
        if not source.is_file() or source.is_symlink():
            raise SystemExit("缺少已审核的构建文件：" + name)
        dest = stage / name
        if name == "scripts/mobile_connector.pyw":
            dest = dest.with_suffix(".py")
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, dest)
        receipt[name] = hashlib.sha256(source.read_bytes()).hexdigest()
    # CPython's combined license also covers its bundled standard-library dependencies.
    python_license = Path(sys.base_prefix) / "LICENSE.txt"
    shutil.copyfile(python_license, stage / "desktop/licenses/Python-LICENSE.txt")
    output = ROOT / "packages/windows"
    output.mkdir(parents=True, exist_ok=True)
    command = [str(python), "-m", "PyInstaller", "--onefile", "--windowed", "--noupx",
               "--noconfirm", "--name", "McdPickupHandoff", "--distpath", str(output),
               "--workpath", str(BUILD / "work"), "--specpath", str(BUILD),
               "--paths", str(stage / "scripts"), "--icon", str(stage / "assets/brand/handoff-mark.ico")]
    for name in (*RESOURCES, "desktop/licenses/Python-LICENSE.txt"):
        command.extend(["--add-data", str(stage / name) + ":" + str(Path(name).parent)])
    command.append(str(stage / "desktop/main.pyw"))
    env = dict(os.environ, PYINSTALLER_CONFIG_DIR=str(BUILD / "cache"))
    subprocess.run(command, cwd=stage, env=env, check=True)
    exe = output / "McdPickupHandoff.exe"
    (BUILD / "build-receipt.json").write_text(json.dumps({
        "sources": receipt, "build_dependencies": BUILD_DEPS,
        "python": sys.version, "exe_sha256": hashlib.sha256(exe.read_bytes()).hexdigest(),
        "exe_bytes": exe.stat().st_size,
    }, indent=2), encoding="utf-8")
    print("已构建：" + str(exe))


if __name__ == "__main__":
    main()
