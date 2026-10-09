"""Verify that a frozen app never reads credentials from its bundled resources."""
from pathlib import Path
import os
import sys
import tempfile
import unittest
from unittest.mock import patch
import importlib.util
import shutil
import subprocess

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import runtime_paths
from mcp_readonly import read_token


class RuntimePathTests(unittest.TestCase):
    def test_source_paths_stay_in_current_project(self):
        expected = Path(__file__).resolve().parents[1]
        with patch.object(sys, "frozen", False, create=True):
            self.assertEqual(runtime_paths.data_root(), expected)
            self.assertEqual(runtime_paths.resource_root(), expected)

    def test_bundle_resources_and_credentials_are_separate_and_never_migrated(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            bundle = root / "_MEI-synthetic"
            bundle.mkdir()
            (bundle / ".env").write_text("MCD_MCP_TOKEN=BUNDLE_TOKEN_MUST_NOT_BE_READ", encoding="utf-8")
            with patch.object(sys, "frozen", True, create=True), patch.object(sys, "_MEIPASS", str(bundle), create=True), patch.dict(os.environ, {"LOCALAPPDATA": str(root)}, clear=True):
                self.assertEqual(runtime_paths.resource_root(), bundle.resolve())
                data = runtime_paths.data_root()
                self.assertEqual(data, root / "McdPickupHandoff")
                self.assertFalse(data.exists())
                self.assertEqual(read_token(), "")
                data.mkdir()
                (data / ".env").write_text("MCD_MCP_TOKEN=SYNTHETIC_LOCAL_TOKEN", encoding="utf-8")
                self.assertEqual(read_token(), "SYNTHETIC_LOCAL_TOKEN")
                self.assertEqual((bundle / ".env").read_text(encoding="utf-8"), "MCD_MCP_TOKEN=BUNDLE_TOKEN_MUST_NOT_BE_READ")

    def test_missing_or_relative_localappdata_fails_instead_of_writing_beside_exe(self):
        with patch.object(sys, "frozen", True, create=True):
            for value in ("", "relative"):
                with patch.dict(os.environ, {"LOCALAPPDATA": value}, clear=True), self.assertRaises(RuntimeError):
                    runtime_paths.data_root()

    def test_reviewed_bundle_resources_render_without_source_tree_or_remote_assets(self):
        root = Path(__file__).resolve().parents[1]
        spec = importlib.util.spec_from_file_location("desktop_build", root / "desktop/build_windows.py")
        build = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(build)
        with tempfile.TemporaryDirectory() as folder:
            bundle = Path(folder)
            for name in build.RESOURCES:
                source = root / name
                destination = bundle / name
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(source, destination)
            script = (
                "import sys,json\n"
                f"sys.path.insert(0,{str(root / 'scripts')!r})\n"
                f"sys.frozen=True;sys._MEIPASS={str(bundle)!r}\n"
                "from render_card import render\n"
                f"data=json.loads({(root / 'examples/order.synthetic.json').read_text(encoding='utf-8')!r})\n"
                "page,summary=render(data,True)\n"
                "assert 'data:image/png;base64,' in page\n"
                "assert 'data:font/ttf;base64,' in page\n"
                "assert 'url(https:' not in page\n"
                "assert '模拟' in summary\n"
                "print('bundled rendering passed')\n"
            )
            result = subprocess.run([sys.executable, "-X", "utf8", "-c", script], capture_output=True, text=True, encoding="utf-8", cwd=bundle)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("bundled rendering passed", result.stdout)


if __name__ == "__main__":
    unittest.main()
