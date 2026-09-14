import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "web" / "check_runtime.py"
spec = importlib.util.spec_from_file_location("check_runtime", SCRIPT)
runtime = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runtime)


class RuntimeCompatibilityTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.manifest = self.root / "node_modules" / "@deepseek-ai" / "dsh" / "package.json"
        self.manifest.parent.mkdir(parents=True)

    def write_version(self, version):
        self.manifest.write_text(json.dumps({"name": "@deepseek-ai/dsh", "version": version}), encoding="utf-8")

    def test_supported_installed_version(self):
        self.write_version("0.1.1-rc.2")
        self.assertEqual(runtime.check_runtime(self.root), "0.1.1-rc.2")

    def test_actual_install_takes_precedence_over_requested_dependency(self):
        (self.root / "package.json").write_text(json.dumps({"dependencies": {"@deepseek-ai/dsh": "0.1.1-rc.2"}}), encoding="utf-8")
        self.write_version("0.1.5-rc.2")
        with self.assertRaisesRegex(ValueError, "0.1.5-rc.2 is not supported"):
            runtime.check_runtime(self.root)

    def test_declaration_is_not_an_install(self):
        (self.root / "package.json").write_text(json.dumps({"dependencies": {"@deepseek-ai/dsh": "0.1.1-rc.2"}}), encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "declaration alone"):
            runtime.check_runtime(self.root)

    def test_source_checkout_version(self):
        (self.root / "package.json").write_text(json.dumps({"name": "@deepseek-ai/dsh-root", "version": "0.1.1-rc.2"}), encoding="utf-8")
        self.assertEqual(runtime.check_runtime(self.root), "0.1.1-rc.2")

    def test_invalid_or_missing_manifest_fails_with_actionable_error(self):
        for data in (None, "broken", "[]", "{}"):
            if data is not None:
                self.manifest.write_text(data, encoding="utf-8")
            with self.subTest(data=data), self.assertRaises(ValueError):
                runtime.check_runtime(self.root)

    def test_cli_status_codes(self):
        for version, expected in (("0.1.1-rc.2", 0), ("0.1.5-rc.2", 1)):
            self.write_version(version)
            result = subprocess.run([sys.executable, str(SCRIPT), str(self.root)], capture_output=True, text=True)
            self.assertEqual(result.returncode, expected, result.stdout + result.stderr)
            self.assertIn(version, result.stdout)


if __name__ == "__main__":
    unittest.main()
