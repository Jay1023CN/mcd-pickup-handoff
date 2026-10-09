"""Single windowed EXE entry point; --bridge runs its background connector."""
import os
from pathlib import Path
import sys


def main():
    if not getattr(sys, "frozen", False):
        # The build stages the unchanged .pyw as an importable .py module.
        # Source launches keep using the existing project GUI file.
        sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
    for stream in ("stdout", "stderr"):
        if getattr(sys, stream) is None:
            setattr(sys, stream, open(os.devnull, "w", encoding="utf-8"))
    if len(sys.argv) > 1 and sys.argv[1] == "--bridge":
        del sys.argv[1]
        from mobile_bridge import main as run
    elif getattr(sys, "frozen", False):
        from mobile_connector import main as run
    else:
        import runpy
        runpy.run_path(str(Path(__file__).resolve().parents[1] / "scripts/mobile_connector.pyw"), run_name="__main__")
        return
    run()


if __name__ == "__main__":
    main()
