"""Keep bundled read-only resources separate from this computer's private data."""
import os
from pathlib import Path
import sys


def frozen() -> bool:
    return bool(getattr(sys, "frozen", False))


def resource_root() -> Path:
    if frozen():
        return Path(sys._MEIPASS).resolve()
    return Path(__file__).resolve().parents[1]


def data_root() -> Path:
    if frozen():
        # Never place credentials in the one-file extraction directory or beside
        # an EXE that may be downloaded into a shared or read-only folder.
        local = os.environ.get("LOCALAPPDATA")
        if not local or not Path(local).is_absolute():
            raise RuntimeError("无法确定本机应用数据目录。")
        return Path(local) / "McdPickupHandoff"
    return Path(__file__).resolve().parents[1]
