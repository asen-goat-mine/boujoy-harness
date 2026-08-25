#!/usr/bin/env python3
"""Repeatable Boujoy Harness smoke tests using only the Python standard library."""

from __future__ import annotations

import argparse
import email.message
import importlib.util
import json
import os
import socket
import subprocess
import sys
import tempfile
import threading
import time
import shutil
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path
from types import SimpleNamespace
from typing import Any


PROJECT = Path(__file__).resolve().parents[1]
SERVER = PROJECT / "web" / "boujoy_server.py"
STATIC = PROJECT / "web"
LOCAL_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def receive_exact(sock: socket.socket, length: int) -> bytes:
    received = b""
    while len(received) < length:
        part = sock.recv(length - len(received))
        if not part:
            raise AssertionError("socket closed before all relay bytes arrived")
        received += part
    return received


def websocket_relay_checks(server_module: Any) -> None:
    """The gateway must preserve client masking and message fragmentation."""
    relay_browser, browser = socket.socketpair()
    relay_upstream, upstream = socket.socketpair()
    for endpoint in (relay_browser, browser, relay_upstream, upstream):
        endpoint.settimeout(2)
    relay = threading.Thread(
        target=server_module._ws_relay,
        args=(relay_browser, relay_upstream),
        daemon=True,
    )
    relay.start()
    try:
        # A masked browser ping must reach the Harness side byte-for-byte.
        client_frame = b"\x89\x84\x01\x02\x03\x04qkpf"
        browser.sendall(client_frame)
        assert receive_exact(upstream, len(client_frame)) == client_frame

        # A fragmented server text message must retain its continuation frame.
        server_frames = b"\x01\x03one\x80\x03two"
        upstream.sendall(server_frames)
        assert receive_exact(browser, len(server_frames)) == server_frames
    finally:
        for endpoint in (browser, upstream, relay_browser, relay_upstream):
            try:
                endpoint.close()
            except OSError:
                pass
        # The bundled portable Python can take a little longer than the host
        # interpreter to schedule the relay's two cleanup joins. This is a
        # teardown bound, not a live-traffic wait: both sockets are closed.
        relay.join(timeout=5)
    assert not relay.is_alive(), "WebSocket relay did not release after peer close"


def websocket_handshake_checks(server_module: Any) -> None:
    """A frame coalesced with HTTP 101 must not be discarded by the bridge."""
    client, harness = socket.socketpair()
    client.settimeout(2)
    harness.settimeout(2)
    frame = b"\x81\x02{}"

    def reply() -> None:
        request = b""
        while b"\r\n\r\n" not in request:
            request += harness.recv(4096)
        harness.sendall(b"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n\r\n" + frame)

    responder = threading.Thread(target=reply, daemon=True)
    responder.start()
    try:
        assert server_module._ws_handshake(client, "/api/events.mux", "127.0.0.1:3080") == frame
    finally:
        client.close()
        harness.close()
        responder.join(timeout=2)


def request(
    url: str,
    payload: dict[str, Any] | None = None,
    headers: dict[str, str] | None = None,
) -> tuple[int, Any]:
    data = None if payload is None else json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        headers={**({"Content-Type": "application/json"} if data is not None else {}), **(headers or {})},
        method="POST" if data is not None else "GET",
    )
    try:
        # Loopback product checks must never ride the user's macOS/system proxy;
        # common proxy apps otherwise turn a healthy 127.0.0.1 server into a
        # misleading HTTP 502 during distribution QA.
        with LOCAL_OPENER.open(req, timeout=20) as response:
            body = response.read()
            content_type = response.headers.get("Content-Type", "")
            return response.status, json.loads(body) if "json" in content_type else body.decode("utf-8", "replace")
    except urllib.error.HTTPError as exc:
        body = exc.read()
        try:
            value = json.loads(body)
        except json.JSONDecodeError:
            value = body.decode("utf-8", "replace")
        return exc.code, value


def wait_ready(origin: str) -> None:
    for _ in range(50):
        try:
            status, value = request(origin + "/api/heartbeat")
            if status == 200 and value.get("ok"):
                return
        except OSError:
            pass
        time.sleep(0.1)
    raise AssertionError(f"server did not become ready: {origin}")


def rpc(origin: str, mode: str, method: str, payload: dict[str, Any] | None = None) -> Any:
    envelope = {
        "type": "client-request",
        "rpcId": f"smoke-{uuid.uuid4()}",
        "method": method,
        "payload": payload or {},
    }
    status, value = request(f"{origin}/api/harness/{mode}/{method}", envelope)
    assert status == 200, (method, status, value)
    assert value.get("result", {}).get("ok") is True, (method, value)
    return value["result"]["value"]


def isolated_gateway_checks() -> list[str]:
    passed: list[str] = []
    with tempfile.TemporaryDirectory(prefix="boujoy-smoke-") as temp_name:
        temp = Path(temp_name)
        vault = temp / "vault"
        fake_home = temp / "home"
        fake_dsh_home = temp / "dsh-home"
        (vault / "03-Knowledge").mkdir(parents=True)
        fake_home.mkdir()
        fake_session = fake_dsh_home / "sessions" / "--test-workspace--" / "session-12345678-abcd-4321-abcd-123456789abc"
        fake_session.mkdir(parents=True)
        (fake_session / "session.jsonl.zstd").write_bytes(b"test")
        (vault / "AGENTS.md").write_text("# Protected\n", "utf-8")
        (vault / "03-Knowledge" / "smoke.md").write_text("# Smoke Card\n\nLocal Markdown.\n", "utf-8")
        (vault / "03-Knowledge" / "large.md").write_text("# Large\n\n" + ("x" * 150_000) + "\nFULL-TEXT-MARKER\n", "utf-8")
        desktop = fake_home / "Desktop"
        desktop.mkdir()
        preview_image = desktop / "preview image.png"
        preview_video = desktop / "preview video.mp4"
        preview_image.write_bytes(b"image-preview")
        preview_video.write_bytes(b"0123456789")
        private_image = fake_home / "private.png"
        private_image.write_bytes(b"private")
        origin = "http://127.0.0.1:8776"
        restart_file = temp / "restart.request"
        env = dict(os.environ)
        env["HOME"] = str(fake_home)
        process = subprocess.Popen(
            [sys.executable, str(SERVER), "--port", "8776", "--vault", str(vault), "--static", str(STATIC), "--knowledge-home", str(fake_dsh_home), "--restart-file", str(restart_file)],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            env=env,
        )
        try:
            wait_ready(origin)
            passed.append("isolated server startup")

            status, value = request(origin + "/api/health")
            assert status == 200 and value["ready"] is True and value["services"]["product"] is True and isinstance(value["pid"], int)
            passed.append("product health readiness")

            status, value = request(origin + "/api/app/restart", {})
            assert status == 200 and value["restarting"] is True and value["managed"] is True and value["serverPid"] > 0
            for _ in range(20):
                if restart_file.is_file():
                    break
                time.sleep(0.05)
            assert restart_file.is_file() and json.loads(restart_file.read_text("utf-8"))["pid"] == value["serverPid"]
            passed.append("managed restart signal")

            spec = importlib.util.spec_from_file_location("boujoy_server_smoke", SERVER)
            assert spec and spec.loader
            server_module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(server_module)
            websocket_relay_checks(server_module)
            websocket_handshake_checks(server_module)
            passed.append("WebSocket masking + fragmentation relay")
            access_config = server_module.AppConfig(vault, STATIC)
            access_config.access_code = "654321"
            handler = object.__new__(server_module.BoujoyHandler)
            handler.server = SimpleNamespace(
                config=access_config,
                server_address=("0.0.0.0", 8776),
                access_attempt_lock=__import__("threading").Lock(),
                access_attempts={},
            )
            handler.client_address = ("192.168.1.88", 54321)
            handler.headers = email.message.Message()
            handler.headers["Host"] = "127.0.0.1:8776"
            handler.headers["Origin"] = "http://127.0.0.1:8766"
            parsed = urllib.parse.urlsplit("/api/config")
            assert handler._require_access(parsed) is False
            handler.headers["X-Boujoy-Access"] = "654321"
            assert handler._require_access(parsed) is True
            handler.client_address = ("127.0.0.1", 54321)
            del handler.headers["X-Boujoy-Access"]
            assert handler._require_access(parsed) is True
            handler.headers.replace_header("Host", "192.168.1.20:8776")
            assert handler._request_origin_allowed("http://192.168.1.20:8776") is True
            assert handler._request_origin_allowed("http://attacker.example:8776") is False
            status, _ = request(
                origin + "/api/harness/knowledge/session.prompt",
                {"type": "client-request", "rpcId": "csrf", "method": "session.prompt", "payload": {}},
                {"Origin": "https://attacker.example"},
            )
            assert status == 403
            passed.append("remote access + browser-origin spoof resistance")

            status, value = request(origin + "/api/config")
            assert status == 200 and value["vaultName"] == "vault"
            status, value = request(origin + "/api/knowledge/vault")
            paths = {item["path"] for item in value["files"]}
            assert {"AGENTS.md", "03-Knowledge/smoke.md"}.issubset(paths)
            passed.append("Markdown vault index/read")

            status, value = request(origin + "/api/knowledge/vault?compact=1")
            large = next(item for item in value["files"] if item["path"] == "03-Knowledge/large.md")
            assert status == 200 and large["truncated"] is True and "FULL-TEXT-MARKER" not in large["text"]
            status, value = request(origin + "/api/knowledge/search?q=FULL-TEXT-MARKER")
            assert status == 200 and "03-Knowledge/large.md" in value["paths"]
            passed.append("compact index + full-text search")

            status, value = request(origin + "/api/knowledge/file?path=" + urllib.parse.quote("03-Knowledge/smoke.md"))
            assert status == 200 and "Local Markdown" in value["text"]
            status, _ = request(origin + "/api/knowledge/file?path=" + urllib.parse.quote("../../etc/passwd"))
            assert status in {400, 403}
            passed.append("vault path containment")

            media_url = origin + "/api/conversation/media?path="
            status, value = request(media_url + urllib.parse.quote(str(preview_image)))
            assert status == 200 and value == "image-preview"
            status, value = request(media_url + urllib.parse.quote(str(preview_video)), headers={"Range": "bytes=2-5"})
            assert status == 206 and value == "2345"
            status, _ = request(media_url + urllib.parse.quote(str(private_image)))
            assert status == 403
            passed.append("conversation image/video previews + path containment")

            status, _ = request(origin + "/api/knowledge/delete-card", {"path": "AGENTS.md"})
            assert status == 403 and (vault / "AGENTS.md").is_file()
            passed.append("protected Markdown deletion guard")

            record = {
                "kind": "expert",
                "name": "测试专家",
                "description": "仅用于自动测试",
                "instructions": "只回复测试结果。",
                "enabled": True,
            }
            status, value = request(origin + "/api/records/save", record)
            assert status == 200 and value["record"]["name"] == "测试专家"
            record_id = value["record"]["id"]
            record_path = vault / "05-Prompts" / "Boujoy-Harness" / "Experts" / f"{record_id}.md"
            assert record_path.is_file() and "type: boujoy-expert" in record_path.read_text("utf-8")
            status, value = request(origin + "/api/records?kind=expert")
            assert status == 200 and any(item["id"] == record_id for item in value["records"])
            record.update({"id": record_id, "description": "已更新"})
            status, value = request(origin + "/api/records/save", record)
            assert status == 200 and value["record"]["description"] == "已更新"
            status, _ = request(origin + "/api/records/delete", {"kind": "expert", "id": record_id})
            assert status == 200 and not record_path.exists()
            assert any(path.name.startswith(record_id) for path in (fake_home / ".Trash").iterdir())
            passed.append("expert Markdown CRUD + recoverable trash")

            status, value = request(origin + "/api/session/delete", {"sessionId": fake_session.name, "mode": "knowledge"})
            assert status == 200 and value["movedLogs"] == 1 and not fake_session.exists()
            assert (fake_home / ".Trash" / f"Boujoy-Session-{fake_session.name}").is_dir()
            status, value = request(origin + "/api/session/deleted")
            assert status == 200 and fake_session.name in value["sessionIds"]
            passed.append("session log deletion + recoverable trash")

            status, page = request(origin + "/")
            assert status == 200 and "Boujoy Harness" in page
            assert "iframe" not in page.lower() and "预览版" not in page
            passed.append("new product shell (no embedded legacy UI)")

            app_js = (STATIC / "app.js").read_text("utf-8")
            app_css = (STATIC / "app.css").read_text("utf-8")
            index_html = (STATIC / "index.html").read_text("utf-8")
            swift = (PROJECT / "macos" / "BoujoyHarness.swift").read_text("utf-8")
            build_script = (PROJECT / "macos" / "build-app.command").read_text("utf-8")
            python_bundle_script = PROJECT / "macos" / "bundle-portable-python.command"
            portable_runtime_script = PROJECT / "macos" / "make-runtime-portable.command"
            portable_launcher_script = PROJECT / "macos" / "open-portable.command"
            portable_readme = PROJECT / "macos" / "PORTABLE-README.zh-CN.md"
            portable_release_status = PROJECT / "macos" / "PORTABLE-RELEASE-STATUS.md"
            windows_dir = PROJECT / "windows"
            windows_launcher = windows_dir / "Start-Boujoy.ps1"
            windows_stopper = windows_dir / "Stop-Boujoy.ps1"
            windows_runtime = windows_dir / "Prepare-Windows-Runtime.ps1"
            windows_builder = windows_dir / "Build-Windows-Portable.ps1"
            windows_readme = windows_dir / "README-Windows.zh-CN.md"
            windows_release_status = windows_dir / "WINDOWS-RELEASE-STATUS.md"
            macos_setup = PROJECT / "macos" / "setup.command"
            macos_doctor = PROJECT / "macos" / "doctor.command"
            windows_setup = windows_dir / "Setup-Boujoy.ps1"
            windows_setup_entry = PROJECT / "Setup-Boujoy.cmd"
            for convenience_entry in (macos_setup, macos_doctor, windows_setup, windows_setup_entry):
                assert convenience_entry.is_file(), convenience_entry
            assert "choose folder" in macos_setup.read_text("utf-8")
            assert "All required local components are ready" in macos_doctor.read_text("utf-8")
            assert "Prepare-Windows-Runtime.ps1" in windows_setup.read_text("utf-8")
            assert "Setup-Boujoy.ps1" in windows_setup_entry.read_text("utf-8")
            assert "Setup-Boujoy.cmd" in windows_builder.read_text("utf-8")
            assert "previousBottomOffset" in app_js
            assert "stream.scrollHeight - previousScrollTop - stream.clientHeight" not in app_js
            assert "maxMessages: HISTORY_FETCH_LIMIT" in app_js
            assert "history-loading-card" in app_js and ".history-loading-card" in app_css
            assert "overflow-anchor: none" in app_css and "scroll-behavior: auto" in app_css
            assert "long-content" in app_js
            assert ".message.user.long-content .message-body" in app_css
            assert "calc(100% - 36px)" in app_css
            assert "hasActiveLiveResponse" in app_js and "liveScrollFrame" in app_js
            assert "suspendLiveFollow" in app_js and "previousScrollTop" in app_js
            assert "restoringConversationScroll" in app_js and "scrollRestoreGeneration" in app_js
            assert "const readerWasScrolledUp = state.userScrolledUp" in app_js
            assert "if (state.restoringConversationScroll) return;" in app_js
            assert "acceptSessionEvent" in app_js and "intentionalClose" in app_js
            assert "session/subscribed" in app_js and "requestSessionGapRepair" in app_js
            assert "seq is the sole dedup key" in app_js and "requestAnimationFrame(pumpLiveResponse)" in app_js
            assert "seedSessionProjections" in app_js and "truncateSessionProjections" in app_js
            assert "visibilitySyncBound" in app_js
            assert "resetSessionView(createdId)" in app_js
            assert "loadOlderHistory" in app_js and "beforeSeq: firstSeq" in app_js
            assert "historyHasMore" in app_js and "historyLoadingOlder" in app_js
            assert "RENDER_CAP" not in app_js
            assert "RECALL_TRIGGER" not in app_js and "recallKnowledge(text)" not in app_js
            assert "knowledgeContext" not in app_js
            assert "const HISTORY_FETCH_LIMIT = 50" in app_js
            assert 'eventStreamConnected("events.host")' in app_js
            assert 'eventStreamConnected("events.mux")' in app_js
            assert "setTimeout(() => loadSession(state.sessionId, { quiet: true }), 250)" not in app_js
            assert "mode = state.mode" in app_js and "pending.mode" in app_js
            assert "const stoppedLive = state.liveResponse" in app_js
            assert "item.rpcId === frame.questionRpcId" in app_js
            assert "item.approvalId === frame.approvalId || item.rpcId === message.rpcId" not in app_js
            assert "Math.ceil(remaining / 20)" not in app_js
            assert "[Boujoy] respondToServer" in app_js and "resolvingInterrupt" in app_js
            assert "not[-\\s]?pending" in app_js
            assert "previousServerPid" in app_js and 'jsonFetch("/api/app/restart"' in app_js
            assert "platformModifier = event.metaKey || event.ctrlKey" in app_js
            assert 'data-close-dialog="recordDialog"' in index_html
            assert 'data-close-dialog="dispatchDialog"' in index_html
            assert 'if (eventStreamConnected("events.mux")) continue;' in app_js
            assert "...state.pendingImages.map(image" in app_js
            assert "if (type === \"llm/retry\" || type === \"llm/retry-started\")" in app_js
            assert "textBlocks" in app_js
            assert 'rpc("session.attachment"' in app_js
            assert "mediaFromContent" in app_js and "hydrateMessageMedia" in app_js
            assert 'textKinds: ["video"]' in app_js and "：，。；、！？" in app_js
            assert "BOUJOY_MEDIA_START" in app_js and "withBoujoyMediaGuidance" in app_js
            assert "内部执行规则，不要在回复中引用" in app_js
            assert "不要先写确认语、道歉或进度说明" in app_js
            assert "找到后只给简短结果" in app_js and "不要解释界面、路径规则或另起 HTTP 服务" in app_js
            assert "const admittedText = withBoujoyMediaGuidance(text)" in app_js
            assert "\\\\x60：，。；、！？" in app_js
            assert "/api/conversation/media?path=" in app_js
            assert ".message-media" in app_css and ".context-image-preview" in app_css
            assert 'data.interrupted === true' in app_js
            assert 'reason.kind === "aborted" || reason.kind === "interrupted"' in app_js
            assert "function safeHttpHref" in app_js
            assert 'parsed.protocol === "http:" || parsed.protocol === "https:"' in app_js
            server_source = SERVER.read_text("utf-8")
            assert "source.recv(64 * 1024)" in server_source
            assert "deadline = time.monotonic() + 300" not in server_source
            assert "_ws_read_frame" not in server_source and "_ws_write_frame" not in server_source
            assert "initial_upstream_bytes" in server_source and "return trailing" in server_source
            assert "ipaddress.ip_address(str(self.client_address[0])).is_loopback" in server_source
            assert 'self.headers.get("Host"' not in server_source[
                server_source.index("def _require_access"):server_source.index("def _request_origin_allowed")
            ]
            assert "cross-origin websocket blocked" in server_source
            assert "access_attempts" in server_source and "hmac.compare_digest" in server_source
            assert 'bind_host = "0.0.0.0" if config.access_code else LOOPBACK' in server_source
            assert 'path == "/api/health"' in server_source and '"ready": True' in server_source
            assert '"pid": os.getpid()' in server_source and "--restart-file" in server_source
            assert "request_managed_restart" in server_source and '"Windows restart host is not configured"' in server_source
            assert 'path == "/api/conversation/media"' in server_source
            assert "_safe_conversation_media_path" in server_source
            assert "explorer.exe" in server_source and "trash_directory" in server_source
            assert 'case "restart"' in swift and "private func relaunch()" in swift
            assert "BOUJOY_HARNESS_ROOT" in swift and "BoujoyHarnessPortableRoot" in swift
            assert "AppTranslocation" in swift and "choosePortableRoot" in swift
            assert "/api/health" in swift and "FileHandle.nullDevice" in swift
            assert "Optional knowledge preview" in swift
            assert "installRestartSignal" in swift and 'path == "/api/app/restart"' in server_source
            assert '"PYTHONDONTWRITEBYTECODE": "1"' in swift
            assert '"BOUJOY_DSH_ROOT": paths.dshRoot' in swift
            assert '"--no-open"' in swift
            assert '"/bin/launchctl"' in swift and '"bootstrap", domain' in swift
            assert '"KeepAlive": false' in swift and '"bootout", service' in swift
            assert "/usr/bin/nc -z 127.0.0.1 8766" in swift
            assert "/api/app/restart" in build_script and "launchctl submit" not in build_script
            assert "xcrun --show-sdk-path" in build_script
            assert "manifest.json" in build_script and "icon-192.png" in build_script and "icon-512.png" in build_script
            assert "--install" in build_script and "--relaunch" in build_script
            assert "--portable-root" in build_script and 'CONFIG_DSH_ROOT="runtime/DeepSeekHarness"' in build_script
            assert 'make-runtime-portable.command" "${PORTABLE_ROOT}' in build_script
            assert "BOUJOY_VAULT_DIR" in build_script and "BOUJOY_DSH_ROOT" in build_script
            assert "/Users/" not in build_script
            assert python_bundle_script.is_file() and os.access(python_bundle_script, os.X_OK)
            assert portable_runtime_script.is_file() and os.access(portable_runtime_script, os.X_OK)
            assert portable_launcher_script.is_file() and os.access(portable_launcher_script, os.X_OK)
            assert "BOUJOY_HARNESS_ROOT" in portable_launcher_script.read_text("utf-8")
            assert "open-portable.command" in build_script
            assert portable_readme.is_file() and portable_release_status.is_file()
            assert "PORTABLE-README.zh-CN.md" in build_script
            assert "PYTHONDONTWRITEBYTECODE=1" in portable_runtime_script.read_text("utf-8")
            assert all(path.is_file() for path in (windows_launcher, windows_stopper, windows_runtime, windows_builder, windows_readme, windows_release_status))
            windows_launcher_source = windows_launcher.read_text("utf-8")
            assert "--restart-file" in windows_launcher_source and "taskkill.exe" in windows_launcher_source
            assert "dsh.cmd" in windows_launcher_source and "Start-BoujoyChild" in windows_launcher_source
            assert windows_launcher_source.count('"--no-open"') == 2
            assert 'DshVersion = "0.1.1-rc.2"' in windows_runtime.read_text("utf-8")
            assert "Do not copy the macOS runtime" in windows_launcher_source
            assert 'Label "Clean Harness"' in windows_launcher_source
            assert "hostStartTicks" in windows_launcher_source and "startTicks" in windows_launcher_source
            windows_stopper_source = windows_stopper.read_text("utf-8")
            assert "ExpectedStartTicks" in windows_stopper_source and "Get-Process -Id" in windows_stopper_source
            assert "Prepare-Windows-Runtime.ps1" in windows_readme.read_text("utf-8")
            assert "不是现在就能发给朋友的最终分享包" in windows_release_status.read_text("utf-8")
            assert (PROJECT / "启动 Boujoy Harness.cmd").is_file() and (PROJECT / "关闭 Boujoy Harness.cmd").is_file()
            passed.append("conversation stability + restart contracts")

            # PowerShell can parse and preflight the Windows package shape on
            # macOS/Linux without trying to execute Windows binaries. A real
            # Windows x64 runtime test remains mandatory before release.
            powershell = shutil.which("pwsh")
            if powershell:
                windows_fixture = temp / "windows-portable"
                (windows_fixture / "app" / "web").mkdir(parents=True)
                (windows_fixture / "vault").mkdir()
                (windows_fixture / "runtime" / "node").mkdir(parents=True)
                (windows_fixture / "runtime" / "python").mkdir(parents=True)
                (windows_fixture / "runtime" / "DeepSeekHarness" / "node_modules" / ".bin").mkdir(parents=True)
                (windows_fixture / "app" / "web" / "boujoy_server.py").write_text("# fixture\n", "utf-8")
                (windows_fixture / "runtime" / "node" / "node.exe").write_bytes(b"")
                (windows_fixture / "runtime" / "python" / "python.exe").write_bytes(b"")
                (windows_fixture / "runtime" / "DeepSeekHarness" / "node_modules" / ".bin" / "dsh.cmd").write_text("@echo off\n", "utf-8")
                checked = subprocess.run(
                    [powershell, "-NoProfile", "-File", str(windows_launcher), "-Root", str(windows_fixture), "-Check", "-SkipRuntimeProbe"],
                    check=True,
                    capture_output=True,
                    text=True,
                )
                assert "launcher check passed" in checked.stdout
                passed.append("Windows launcher package preflight")

            portable = temp / "portable"
            portable_dsh = portable / "runtime" / "DeepSeekHarness"
            portable_bin = portable_dsh / "node_modules" / ".bin"
            portable_target = portable_dsh / "node_modules" / ".pnpm" / "node_modules" / "zod"
            portable_profile = portable_dsh / "home" / "profiles" / "node_modules"
            portable_bin.mkdir(parents=True)
            portable_target.mkdir(parents=True)
            portable_profile.mkdir(parents=True)
            (portable_dsh / "pnpm-lock.yaml").write_text("lockfileVersion: '9.0'\n", "utf-8")
            (portable_dsh / "node_modules" / ".modules.yaml").write_text(
                '  "storeDir": "/Users/example/Library/pnpm/store",\n', "utf-8"
            )
            fake_shim = portable_bin / "dsh"
            fake_shim.write_text(
                '#!/bin/sh\nbasedir=$(dirname "$0")\n'
                'export NODE_PATH="/Users/example/Library/Application Support/Boujoy/DeepSeekHarness/node_modules/.pnpm/node_modules"\n',
                "utf-8",
            )
            fake_shim.chmod(0o755)
            os.symlink(
                "/Users/example/Library/Application Support/Boujoy/DeepSeekHarness/node_modules/.pnpm/node_modules/zod",
                portable_profile / "zod",
            )
            subprocess.run([str(portable_runtime_script), str(portable)], check=True, capture_output=True, text=True)
            normalized_shim = fake_shim.read_text("utf-8")
            normalized_link = os.readlink(portable_profile / "zod")
            assert "/Users/" not in normalized_shim and "boujoy-portable-runtime" in normalized_shim
            assert not os.path.isabs(normalized_link) and (portable_profile / "zod").exists()
            assert '"storeDir": ".pnpm-store",' in (portable_dsh / "node_modules" / ".modules.yaml").read_text("utf-8")
            passed.append("portable Harness runtime path normalization")

            fake_app = portable / "Boujoy Harness.app" / "Contents" / "MacOS" / "BoujoyHarness"
            fake_app.parent.mkdir(parents=True)
            fake_app.write_text("#!/bin/zsh\nprint -r -- \"${BOUJOY_HARNESS_ROOT}|${BOUJOY_HARNESS_CONFIG:-}\"\n", "utf-8")
            fake_app.chmod(0o755)
            (portable / "boujoy-config.json").write_text("{}\n", "utf-8")
            launcher = portable / "启动 Boujoy Harness.command"
            launcher.write_bytes(portable_launcher_script.read_bytes())
            launcher.chmod(0o755)
            launched = subprocess.run([str(launcher)], check=True, capture_output=True, text=True)
            expected_root = str(portable.resolve())
            assert launched.stdout.strip() == f"{expected_root}|{expected_root}/boujoy-config.json"
            passed.append("portable launcher root handoff")

            orphan_origin = "http://127.0.0.1:8778"
            wrapper = """
import socket, subprocess, sys, time
subprocess.Popen(sys.argv[1:], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
for _ in range(30):
    try:
        with socket.create_connection(("127.0.0.1", 8778), timeout=0.1):
            print("READY")
            break
    except OSError:
        time.sleep(0.1)
else:
    raise SystemExit("orphan fixture did not start")
"""
            fixture = subprocess.run(
                [
                    sys.executable, "-c", wrapper,
                    sys.executable, str(SERVER), "--port", "8778",
                    "--vault", str(vault), "--static", str(STATIC),
                ],
                env=env,
                check=True,
                timeout=5,
                capture_output=True,
                text=True,
            )
            assert "READY" in fixture.stdout
            closed = False
            for _ in range(30):
                try:
                    request(orphan_origin + "/api/heartbeat")
                except OSError:
                    closed = True
                    break
                time.sleep(0.1)
            assert closed
            passed.append("native-parent orphan shutdown")
        finally:
            process.terminate()
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                process.kill()
    return passed


def live_harness_checks(origin: str, mode: str = "knowledge") -> list[str]:
    passed: list[str] = []
    wait_ready(origin)
    host = rpc(origin, mode, "host.describe")
    assert host.get("version") and host.get("model")
    passed.append(f"{mode} Harness host")

    sessions = rpc(origin, mode, "session.list").get("items", [])
    workspaces = rpc(origin, mode, "workspace.list").get("items", [])
    assert isinstance(sessions, list) and isinstance(workspaces, list)
    passed.append("sessions/workspaces")

    if sessions:
        session_id = sessions[0]["sessionId"]
        models = rpc(origin, mode, "session.models", {"sessionId": session_id})
        history = rpc(origin, mode, "session.history", {"sessionId": session_id})
        assert models.get("groups") and "events" in history and "projections" in history
        passed.append("models/history/projections")
    else:
        # A fresh portable/clean home legitimately has no workspace or session
        # until the user creates the first conversation.
        passed.append("blank registry ready")
    return passed


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--live-origin", default="http://127.0.0.1:8766")
    parser.add_argument("--live-mode", choices=("knowledge", "clean"), default="knowledge")
    parser.add_argument("--skip-live", action="store_true")
    args = parser.parse_args()
    results = isolated_gateway_checks()
    if not args.skip_live:
        results.extend(live_harness_checks(args.live_origin, args.live_mode))
    for item in results:
        print(f"PASS  {item}")
    print(f"PASS  {len(results)} checks total")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
