"""Double-click entry for the local MCP connector window."""
from pathlib import Path
import runpy
import sys

scripts = Path(__file__).resolve().parent / "scripts"
sys.path.insert(0, str(scripts))
runpy.run_path(str(scripts / "mobile_connector.pyw"), run_name="__main__")
