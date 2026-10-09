#!/usr/bin/env python3
"""Package only reviewed Skill files; never include private orders or secrets."""
from pathlib import Path
from zipfile import ZipFile, ZipInfo, ZIP_DEFLATED

ROOT = Path(__file__).resolve().parents[1]
FILES = (
    "SKILL.md", "README.md", "LICENSE", "CONTEST_DECLARATION.md", "MCP_INTEGRATION.md",
    "mcp-config.example.json", "scripts/render_card.py", "scripts/mcp_readonly.py",
    "scripts/connect_mcp.py", "scripts/live_app.py", "scripts/live_handoff.py", "start-local.cmd",
    "scripts/visual_assets.py", "templates/card.html", "templates/workbench.html",
    "assets/handoff.png", "assets/title.png", "assets/paper.png",
    "assets/fonts/source.css", "assets/fonts/dm-mono-source.css",
    "assets/fonts/noto-display-0.ttf", "assets/fonts/noto-display-1.ttf",
    "assets/fonts/noto-display-2.ttf", "assets/fonts/noto-display-3.ttf",
    "assets/fonts/dm-mono-0.ttf", "assets/fonts/dm-mono-1.ttf",
    "assets/fonts/NotoSansSC-OFL.txt", "assets/fonts/DMMono-OFL.txt",
    "assets/icons/storefront.svg", "assets/icons/bag.svg", "assets/icons/clock.svg",
    "assets/icons/clipboard-text.svg", "assets/icons/map-pin.svg", "assets/icons/LICENSE.txt",
    "references/tools.md", "references/input-format.md", "examples/order.synthetic.json",
    "docs/MCP_TOOLS.md", "docs/SOURCES.md", "docs/REGISTRATION.md", "docs/VALIDATION.md", "docs/demo.html", "docs/demo.png", "docs/demo.txt",
    "scripts/mobile_bridge.py", "scripts/mobile_connector.pyw", "打开电脑连接.pyw",
    "docs/WEB_ARCHITECTURE.md", "docs/PROJECT_LAYOUT.md",
    "assets/brand/handoff-concept.png", "assets/brand/handoff-mark.svg", "docs/BRAND.md",
    "scripts/vendor/qrcodegen.py", "scripts/vendor/LICENSE.qrcodegen.txt",
)


def main():
    output = ROOT / "packages/mcd-pickup-handoff-v0.4.0.zip"
    output.parent.mkdir(exist_ok=True)
    with ZipFile(output, "w", compression=ZIP_DEFLATED) as archive:
        for name in FILES:
            info = ZipInfo(name, date_time=(2026, 10, 9, 0, 0, 0))
            info.compress_type = ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            archive.writestr(info, (ROOT / name).read_bytes())
    print(output)


if __name__ == "__main__":
    main()
