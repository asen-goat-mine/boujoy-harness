"""Isolated socket lifecycle contracts; no Harness, Vault, or model required."""
from __future__ import annotations

import importlib.util
import os
import socket
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

server_path = Path(os.environ.get("BOUJOY_SERVER_SOURCE", Path(__file__).resolve().parents[1] / "web" / "boujoy_server.py"))
spec = importlib.util.spec_from_file_location("boujoy_stream_contracts", server_path)
server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server)


class StreamLifecycleContracts(unittest.TestCase):
    def test_idle_relay_outlives_the_connection_handshake_timeout(self):
        relay_browser, browser = socket.socketpair()
        relay_upstream, upstream = socket.socketpair()
        relay_upstream.settimeout(0.05)
        browser.settimeout(1)
        upstream.settimeout(1)
        worker = threading.Thread(target=server._ws_relay, args=(relay_browser, relay_upstream), daemon=True)
        worker.start()
        try:
            time.sleep(0.15)
            self.assertTrue(worker.is_alive(), "Idle relay inherited the short connection timeout")
            upstream.sendall(b"still-alive")
            self.assertEqual(browser.recv(11), b"still-alive")
        finally:
            browser.close()
            upstream.close()
            worker.join(timeout=3)
            relay_browser.close()
            relay_upstream.close()
        self.assertFalse(worker.is_alive())

    def test_handshake_timeout_closes_upstream_and_returns_gateway_error(self):
        handler = object.__new__(server.BoujoyHandler)
        handler.headers = {"Sec-WebSocket-Key": "fixture"}
        handler._error = Mock()
        upstream = Mock()
        with patch.object(server.socket, "create_connection", return_value=upstream), patch.object(server, "_ws_handshake", side_effect=TimeoutError("handshake timed out")):
            handler._ws_upgrade("knowledge", "/api/events.mux")
        upstream.close.assert_called_once()
        handler._error.assert_called_once_with(502, "Harness WebSocket 握手失败")


if __name__ == "__main__":
    unittest.main()
