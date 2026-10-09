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
    "scripts/runtime_paths.py", "docs/WINDOWS_CONNECTOR.md", "docs/DEMO_SCRIPT.md",
    "docs/WEB_ARCHITECTURE.md", "docs/PROJECT_LAYOUT.md",
    "docs/hero.png", "docs/mobile-demo.png", "docs/windows-connector.png",
    "assets/brand/handoff-concept.png", "assets/brand/handoff-mark.svg", "assets/brand/handoff-mark.png", "docs/BRAND.md",
    "scripts/vendor/qrcodegen.py", "scripts/vendor/LICENSE.qrcodegen.txt",
)


def main():
    output = ROOT / "packages/mcd-pickup-handoff-v0.5.0.zip"
    output.parent.mkdir(exist_ok=True)
    with ZipFile(output, "w", compression=ZIP_DEFLATED) as archive:
        for name in FILES:
            info = ZipInfo(name, date_time=(2026, 10, 9, 0, 0, 0))
            info.compress_type = ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            data = (ROOT / name).read_bytes()
            if name.endswith(".md"):
                text = data.decode("utf-8")
                downloads = "https://raw.githubusercontent.com/Jay1023CN/mcd-pickup-handoff/main/packages/"
                text = text.replace("](../packages/", "](" + downloads).replace("](packages/", "](" + downloads)
                text = text.replace("](../design-qa.md)", "](https://github.com/Jay1023CN/mcd-pickup-handoff/blob/main/design-qa.md)")
                data = text.encode("utf-8")
            archive.writestr(info, data)
    print(output)


if __name__ == "__main__":
    main()
