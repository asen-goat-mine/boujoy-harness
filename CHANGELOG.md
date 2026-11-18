# Changelog

## macOS 1.1.0 · DSH 0.2 bridge

- Add isolated engine homes and a loopback bridge for the pinned 0.2.1-alpha.2 protocol. Reconnect rebuilds the current stream from its snapshot, and child or archived sessions stay out of the default selection.
- Add a fresh setup path and a private-copy migration path. Windows Beta and legacy direct installs retain their existing 0.1.1-rc.2 compatibility.
- Verify the restart target is the native macOS host before signalling it.

## Earlier public main

- Discard history responses, animation callbacks and socket events from retired sessions or modes. A stale reconnect cannot reopen the previous mode.
- Clear WebSocket handshake timeouts before long-lived relaying and close sockets after handshake failures.
- Check the installed DeepSeek Harness version during setup/preflight; keep `0.1.1-rc.2` until the newer protocol is adapted. See [compatibility](docs/UPSTREAM-COMPATIBILITY.md).
- Add Linux, macOS and Windows CI for session, stream and version contracts, plus Windows script parsing and macOS gateway/launcher checks.
- Isolate smoke-test ports and verify child process identity so an unrelated local service cannot be mistaken for the test server.

Windows remains a source/Beta adaptation pending actual runtime and desktop acceptance. No installer or new upstream adapter is included in this update.
