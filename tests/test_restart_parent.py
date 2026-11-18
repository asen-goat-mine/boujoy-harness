import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("restart_server", Path(__file__).resolve().parents[1] / "web/boujoy_server.py")
server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server)


class RestartParentTest(unittest.TestCase):
    def test_only_native_host_can_receive_restart_signal(self):
        with patch.object(server.sys, "platform", "darwin"), patch.object(server.subprocess, "check_output") as ps:
            self.assertFalse(server.is_native_app_parent(1))
            ps.assert_not_called()
            for executable in ("/bin/zsh\n", "/usr/bin/python3\n", "/tmp/BoujoyHarness\n"):
                ps.return_value = executable
                self.assertFalse(server.is_native_app_parent(42))
            ps.return_value = "/Applications/Boujoy Harness.app/Contents/MacOS/BoujoyHarness\n"
            self.assertTrue(server.is_native_app_parent(42))
            ps.side_effect = ProcessLookupError()
            self.assertFalse(server.is_native_app_parent(42))


if __name__ == "__main__":
    unittest.main()
