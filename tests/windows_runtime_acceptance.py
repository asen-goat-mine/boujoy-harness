"""Run only with a synthetic package on a disposable GitHub Windows runner.

Uses the actual pinned upstream runtime but never sends a model prompt or key.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import socket
import subprocess
import sys
import time
import uuid
from pathlib import Path
from urllib.request import ProxyHandler, Request, build_opener


BASE = "http://127.0.0.1:8766"
OPENER = build_opener(ProxyHandler({}))


def request(path, body=None):
    headers = {"Origin": BASE, "Sec-Fetch-Site": "same-origin", "Content-Type": "application/json"}
    data = json.dumps(body).encode() if body is not None else None
    with OPENER.open(Request(BASE + path, data=data, headers=headers), timeout=20) as response:
        return json.load(response)


def rpc(mode, method, payload=None):
    result = request(f"/api/harness/{mode}/{method}", {
        "type": "client-request", "rpcId": str(uuid.uuid4()), "method": method, "payload": payload or {},
    })
    assert result.get("ok") is not False, result
    value = result.get("result", result)
    assert value.get("ok") is not False, value
    return value.get("value", value)


def wait_until(check, label, timeout=90):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = check()
        if value:
            return value
        time.sleep(0.25)
    raise RuntimeError(f"Timed out: {label}")


def websocket(mode, endpoint):
    key = base64.b64encode(os.urandom(16)).decode()
    with socket.create_connection(("127.0.0.1", 8766), timeout=10) as stream:
        stream.sendall((
            f"GET /api/harness/{mode}/{endpoint} HTTP/1.1\r\nHost: 127.0.0.1:8766\r\n"
            f"Origin: {BASE}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n"
        ).encode())
        response = b""
        while b"\r\n\r\n" not in response:
            block = stream.recv(4096)
            if not block:
                break
            response += block
        assert response.startswith(b"HTTP/1.1 101"), response[:256]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("package", type=Path)
    args = parser.parse_args()
    if sys.platform != "win32" or os.environ.get("GITHUB_ACTIONS") != "true":
        raise RuntimeError("Run only on a disposable GitHub Windows runner")
    package = args.package.resolve(strict=True)
    package.relative_to(Path(os.environ["RUNNER_TEMP"]).resolve())
    for port in (3080, 3081, 8766):
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", port))
    digest = hashlib.sha256(str(package).lower().encode()).hexdigest()[:16]
    state_dir = Path(os.environ["LOCALAPPDATA"]) / "Boujoy/BoujoyHarness/Windows" / digest
    if state_dir.exists():
        raise RuntimeError("Refusing an existing Windows Harness instance")
    runtime = package / "runtime/DeepSeekHarness"
    for home_name in ("home", "clean-home"):
        if any((runtime / home_name).iterdir()):
            raise RuntimeError("Acceptance requires empty synthetic runtime homes")
    state_file = state_dir / "processes.json"
    host_log = package.parent / "acceptance-host.log"
    with host_log.open("w", encoding="utf-8") as output:
        process = subprocess.Popen([
            "pwsh", "-NoProfile", "-File", str(package / "windows/Start-Boujoy.ps1"),
            "-Root", str(package), "-NoBrowser",
        ], stdout=output, stderr=subprocess.STDOUT)
        try:
            def started():
                if process.poll() is not None:
                    raise RuntimeError("Windows host exited during startup")
                if not state_file.exists():
                    return None
                state = json.loads(state_file.read_text(encoding="utf-8-sig"))
                assert state["hostPid"] == process.pid
                health = request("/api/health")
                gateway = next(item for item in state["processes"] if item["name"] == "gateway")
                assert health["pid"] == gateway["pid"]
                return health["pid"]

            first_pid = wait_until(started, "all three Windows services")
            identifiers = {}
            for mode in ("knowledge", "clean"):
                rpc(mode, "host.describe")
                rpc(mode, "session.list")
                websocket(mode, "events.mux")
                websocket(mode, "events.host")
                created = rpc(mode, "session.create")
                session = created.get("session", created)
                identifier = session.get("id") or session.get("sessionId")
                assert identifier, created
                identifiers[mode] = identifier
                rpc(mode, "session.rename", {"sessionId": identifier, "title": f"Synthetic {mode} acceptance"})
                rpc(mode, "session.history", {"sessionId": identifier, "maxMessages": 40})
            for mode, other in (("knowledge", "clean"), ("clean", "knowledge")):
                listed = json.dumps(rpc(mode, "session.list"))
                assert identifiers[mode] in listed
                assert identifiers[other] not in listed
            print("PASS: native upstream startup, session lifecycle, mode isolation and WebSocket handshakes", flush=True)
            assert request("/api/app/restart", {})["managed"] is True
            def restarted():
                try:
                    current = started()
                    return current if current and current != first_pid else None
                except (OSError, ValueError, AssertionError):
                    return None
            wait_until(restarted, "managed Windows restart")
            for mode, identifier in identifiers.items():
                assert identifier in json.dumps(rpc(mode, "session.list"))
                rpc(mode, "workspace.archiveSession", {"sessionId": identifier})
                deleted = request("/api/session/delete", {"sessionId": identifier, "mode": mode})
                assert deleted.get("ok") is True, deleted
            print("PASS: managed restart preserves sessions; synthetic sessions can be deleted", flush=True)
        except Exception:
            # These are empty synthetic profiles, with no credential or prompt.
            for log in [host_log, *state_dir.glob("*.log")]:
                print(f"--- {log.name} ---\n{log.read_text(encoding='utf-8-sig', errors='replace')[-12000:]}", file=sys.stderr)
            raise
        finally:
            subprocess.run(["pwsh", "-NoProfile", "-File", str(package / "windows/Stop-Boujoy.ps1"),
                            "-Root", str(package)], check=True, timeout=45)
            if process.poll() is None:
                subprocess.run(["taskkill.exe", "/PID", str(process.pid), "/T", "/F"], check=False, timeout=30)
            process.wait(timeout=30)
    def stopped():
        for port in (3080, 3081, 8766):
            with socket.socket() as probe:
                if probe.connect_ex(("127.0.0.1", port)) == 0:
                    return False
        return True
    wait_until(stopped, "all package ports closed", timeout=30)
    assert not state_file.exists()
    print("PASS: verified package stop closes all services; no model requests were sent", flush=True)


if __name__ == "__main__":
    main()
