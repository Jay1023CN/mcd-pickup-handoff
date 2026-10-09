#!/usr/bin/env python3
"""Package only reviewed Skill files; never include private orders or secrets."""
from pathlib import Path
from zipfile import ZipFile, ZipInfo, ZIP_DEFLATED

ROOT = Path(__file__).resolve().parents[1]
FILES = (
    "SKILL.md", "README.md", "LICENSE", "CONTEST_DECLARATION.md", "MCP_INTEGRATION.md",
    "mcp-config.example.json", "scripts/render_card.py", "scripts/mcp_readonly.py",
    "references/tools.md", "references/input-format.md", "examples/order.synthetic.json",
    "docs/SOURCES.md", "docs/REGISTRATION.md", "docs/VALIDATION.md", "docs/demo.html", "docs/demo.png", "docs/demo.txt",
)


def main():
    output = ROOT / "packages/mcd-pickup-handoff-v0.1.0.zip"
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
