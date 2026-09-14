# DeepSeek Harness compatibility

This Boujoy adapter supports **`0.1.1-rc.2`**. Keep the pinned version when preparing a runtime. A newer upstream release requires a transport and history adapter update before it can be used here.

## Checks before startup

- macOS: `./macos/doctor.command` checks the installed package version during guided setup.
- Windows: `Start-Boujoy.ps1` checks it before starting child processes; runtime preparation rejects unsupported requested versions before installation.
- Either platform: `python web/check_runtime.py /path/to/DeepSeekHarness` checks a runtime without starting it or contacting a provider. It inspects the installed package, not just a dependency declaration. A source checkout with a recognized package name is also supported.
- `-SkipRuntimeProbe` is only for Windows package-shape tests using synthetic executables. It does not demonstrate that a runtime works.

## Source comparison: 2026-09-14

Upstream `dsh-v0.1.5-rc.2` was inspected at commit `fb2c4b9e698e30edb738bca4cf0618587db7d203`.

| Contract | Current Boujoy adapter | Upstream 0.1.5-rc.2 |
|---|---|---|
| Event streams | `/api/events.mux`, `/api/events.host` | `/api/remote.mux`, multiplexed logical streams and new event envelopes |
| Session history | Session ID based requests | Durable session `address` and paged records |
| Runtime | Pinned 0.1.1-rc.2 | Node `^22.19.0` or `>=24.0.0` |

Source: [stream protocol](https://github.com/deepseek-ai/deepseek-harness/blob/fb2c4b9e698e30edb738bca4cf0618587db7d203/packages/api/gateway/src/stream-protocol.ts), [history](https://github.com/deepseek-ai/deepseek-harness/blob/fb2c4b9e698e30edb738bca4cf0618587db7d203/packages/api/session-controller/src/history.ts), [runtime manifest](https://github.com/deepseek-ai/deepseek-harness/blob/fb2c4b9e698e30edb738bca4cf0618587db7d203/package.json).

This is a source contract comparison, not an end-to-end model conversation test. The version gate prevents accidental upgrades; it does not certify the upstream runtime or provider setup.

## Adapter migration acceptance

Before changing the pin, implement the new transport and session address mapping, then validate knowledge/clean mode isolation, history pagination, streamed tool calls, cancellation, reconnect, image upload, session deletion, restart and shutdown. Run those flows on macOS and Windows with the actual upstream runtime. Keep the current adapter available until the migration is accepted.
