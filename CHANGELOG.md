# Changelog

## Unreleased

- Prepare Windows dependencies with pinned, runtime-local pnpm and explicit lifecycle-script rules to avoid npm peer-placement stalls.
- Add a disposable Windows runner check that installs the pinned upstream runtime and exercises isolated session operations, WebSocket handshakes, restart and shutdown without model requests.
- Keep `-NoBrowser` startup failures noninteractive so unattended launchers can report errors without blocking on a dialog.

- Discard history responses, animation callbacks and socket events from retired sessions or modes. A stale reconnect cannot reopen the previous mode.
- Clear WebSocket handshake timeouts before long-lived relaying and close sockets after handshake failures.
- Check the installed DeepSeek Harness version during setup/preflight; keep `0.1.1-rc.2` until the newer protocol is adapted. See [compatibility](docs/UPSTREAM-COMPATIBILITY.md).
- Add Linux, macOS and Windows CI for session, stream and version contracts, plus Windows script parsing and macOS gateway/launcher checks.
- Isolate smoke-test ports and verify child process identity so an unrelated local service cannot be mistaken for the test server.

Windows remains a source/Beta adaptation. Actual runtime installation and service/session acceptance passed on a disposable Windows runner; manual Windows 10/11 desktop and model-conversation acceptance remain pending. No installer or new upstream adapter is included in this update.
