"""Package a checked Windows binary and license texts; never traverse private data."""
from pathlib import Path
import hashlib
import json
import sys
from zipfile import ZipFile, ZipInfo, ZIP_DEFLATED

ROOT = Path(__file__).resolve().parents[1]
VERSION = "0.5.0"


def main():
    receipt = json.loads((ROOT / "private/desktop-build/build-receipt.json").read_text(encoding="utf-8"))
    sys.path.insert(0, str(ROOT))
    from desktop.build_windows import SOURCES, RESOURCES
    if set(receipt["sources"]) != set((*SOURCES, *RESOURCES)):
        raise ValueError("构建记录与源码资源白名单不一致。")
    for name, expected in receipt["sources"].items():
        path = ROOT / name
        if path.is_symlink() or not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest() != expected:
            raise ValueError("构建源文件已变化，请重新构建：" + name)
    exe = (ROOT / "packages/windows/McdPickupHandoff.exe").read_bytes()
    if hashlib.sha256(exe).hexdigest() != receipt["exe_sha256"] or len(exe) != receipt["exe_bytes"]:
        raise ValueError("EXE 与构建记录不一致。")
    entries = {
        "麦麦电脑连接器.exe": exe,
        "使用说明.txt": ("麦麦电脑连接器 v" + VERSION + "\n\n解压后双击“麦麦电脑连接器.exe”。不用安装 Python，也不用输入命令。\n\n1. 在连接窗口保存自己的麦当劳 MCP Token。\n2. 点击“启动连接”和“打开手机入口”。\n3. 手机扫码配对，选好订单后生成链接发给朋友。\n\n手机网页：https://mcd-pickup-handoff.epic-rain-2778.chatgpt.site/\nToken 申请：https://open.mcd.cn/mcp\n说明和源码：https://github.com/Jay1023CN/mcd-pickup-handoff\n\n关闭窗口后，后台继续连接；暂时不用时，重新打开窗口点击“停止连接”。\nToken 和设备凭据只存放在本机当前用户的 %LOCALAPPDATA%\\McdPickupHandoff。\n更新时先停止旧连接、解压新包并打开新版；本机数据保留。\n本程序未做代码签名，完整源码和构建脚本在公开仓库。\n\nEXE SHA-256：" + receipt["exe_sha256"] + "\n").encode("utf-8-sig"),
        "licenses/Project-MIT.txt": (ROOT / "LICENSE").read_bytes(),
        "licenses/QR-generator-MIT.txt": (ROOT / "scripts/vendor/LICENSE.qrcodegen.txt").read_bytes(),
        "licenses/Python-LICENSE.txt": (Path(sys.base_prefix) / "LICENSE.txt").read_bytes(),
        "licenses/Tcl-license.terms": (ROOT / "desktop/licenses/Tcl-license.terms").read_bytes(),
        "licenses/Tk-license.terms": (ROOT / "desktop/licenses/Tk-license.terms").read_bytes(),
        "licenses/PyInstaller-COPYING.txt": (ROOT / "desktop/licenses/PyInstaller-COPYING.txt").read_bytes(),
        "licenses/NotoSansSC-OFL.txt": (ROOT / "assets/fonts/NotoSansSC-OFL.txt").read_bytes(),
        "licenses/DMMono-OFL.txt": (ROOT / "assets/fonts/DMMono-OFL.txt").read_bytes(),
        "licenses/Phosphor-Icons-MIT.txt": (ROOT / "assets/icons/LICENSE.txt").read_bytes(),
        "build-sources.json": json.dumps(receipt, ensure_ascii=False, indent=2).encode("utf-8"),
    }
    from check_public_artifacts import check_file, sensitive_values
    values = sensitive_values()
    for name, data in entries.items():
        check_file(name, data, values)
    output = ROOT / f"packages/mcd-pickup-handoff-windows-v{VERSION}.zip"
    with ZipFile(output, "w", compression=ZIP_DEFLATED) as archive:
        for name, data in entries.items():
            info = ZipInfo(name, date_time=(2026, 10, 10, 0, 0, 0))
            info.compress_type = ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            archive.writestr(info, data)
    digest = hashlib.sha256(output.read_bytes()).hexdigest()
    output.with_suffix(".sha256").write_text(digest + "  " + output.name + "\n", encoding="ascii")
    print("Windows package verified: " + output.name + "; SHA-256 " + digest)


if __name__ == "__main__":
    main()
