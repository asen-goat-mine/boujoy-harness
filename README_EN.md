<div align="center">

# Boujoy Harness

## A local desktop client for DeepSeek Harness

Boujoy Harness uses [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) as the Agent runtime and adds a desktop host, local gateway, conversation UI, and Markdown knowledge workspace. It keeps the upstream event and RPC protocols.

[简体中文](README.md) · [Watch the full demo](https://github.com/asen-goat-mine/boujoy-harness/releases/download/demo-2026-08-19/Boujoy-Harness-Demo.mp4) · [Upstream DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)

</div>

<p align="center">
  <a href="https://github.com/asen-goat-mine/boujoy-harness/releases/download/demo-2026-08-19/Boujoy-Harness-Demo.mp4">
    <img src="docs/assets/harness-demo.gif" alt="Animated Boujoy Harness UI demo. Click for the full video." width="900">
  </a>
</p>

<p align="center"><sub>The animation plays in this README. Click it to open the complete 49-second MP4.</sub></p>

## What it is

DeepSeek Harness remains responsible for models, tools, event frames, and RPC. Boujoy provides the local desktop experience and Markdown workspace.

It keeps the upstream WebSocket event and RPC semantics intact, then connects the runtime to a local Markdown vault, a task-oriented UI, and desktop-host reliability work:

- Native WKWebView host and controlled restart path on macOS.
- A local-only gateway between the UI and separately installed DeepSeek Harness instances.
- A Markdown vault browser for projects, notes, prompts, and reusable context.
- Paged history, streaming projection, stable scrolling, reconnect handling, and inline image/video previews.
- Queue-safe interrupt dialogs so expired RPCs do not leave the UI trapped behind a modal.

This version is tested with DeepSeek Harness `0.1.1-rc.2`. The source repository does not ship a model, provider account, upstream runtime, vault, session, or credentials.

## Main capabilities

| Capability | Why it matters |
| --- | --- |
| Upstream-compatible runtime bridge | DeepSeek Harness stays responsible for models, tools, event frames, and RPC. Boujoy does not invent an incompatible agent protocol. |
| Local Markdown workspace | Keep projects, knowledge, prompts, and drafts as ordinary files that any editor can open. |
| Conversation and media | History paging, streaming isolation, and user-scroll protection keep long conversations stable; images and local videos can render inline. |
| Recoverable human-in-the-loop actions | Approval and input requests are queued; stale or cancelled requests close cleanly instead of permanently blocking the page. |
| Local-first defaults | Without an access code the gateway is loopback-only; macOS phone pairing can enable access-code-protected LAN access; no analytics endpoint is configured. |
| Startup recovery | Handles health checks, App Translocation, path selection, and optional service failures. |
| Cross-platform direction | Native macOS 13+ Apple Silicon host today; Windows 10/11 x64 browser-host adapter is available as a Beta. |

## Architecture

~~~text
Your task
    │
    ▼
Boujoy UI ── Local gateway ── DeepSeek Harness ── Your model provider / tools
    │
    └──────────────────────── Local Markdown Vault
                                  projects · knowledge · prompts · content
~~~

## Fastest setup

### macOS

After building DeepSeek Harness, run this from the repository root:

~~~bash
./macos/setup.command
~~~

The guided setup detects Python, an existing Boujoy configuration, and common DeepSeek Harness locations. It only opens a folder picker when automatic detection fails. You can select an existing Markdown vault or create an empty one, then the script checks, builds, installs, and opens the Desktop app.

For a read-only environment check:

~~~bash
./macos/doctor.command
~~~

### Windows 10/11 x64 (Beta)

Double-click `Setup-Boujoy.cmd` once. It creates an empty vault, checks Node.js and Python, and prepares a Windows-native DeepSeek Harness runtime when missing. Then use `启动 Boujoy Harness.cmd` for normal launches.

Windows still needs preparation and acceptance testing on a real Windows x64 machine. A macOS runtime cannot be reused there.

## Manual source setup on macOS

### Requirements

- macOS 13+ on Apple Silicon (arm64)
- A separately installed and built DeepSeek Harness checkout with node_modules/.bin/dsh
- A local Markdown vault directory
- A usable Python 3 executable

### Build and install

~~~bash
git clone https://github.com/asen-goat-mine/boujoy-harness.git
cd boujoy-harness

# Point these at your own local dependencies. Do not commit them.
export BOUJOY_DSH_ROOT="$HOME/src/deepseek-harness"
export BOUJOY_VAULT_DIR="$HOME/BoujoyVault"
export BOUJOY_PYTHON_BIN="$(command -v python3)"

./macos/build-app.command --install
~~~

The app is installed to Desktop as Boujoy Harness.app. Then:

1. Select or create a workspace.
2. Use Knowledge mode when the task should draw from your Markdown vault; use Clean mode for isolated work.
3. Describe the task. Model, provider, and tool permissions still come from your DeepSeek Harness configuration.
4. Handle confirmations or questions in the interrupt dialog. Expired requests are closed safely and the queue advances.

## Knowledge mode and Clean mode

| Mode | Use it for | It does not do |
| --- | --- | --- |
| Knowledge mode | Work that benefits from projects, notes, prompts, or prior decisions | It should not dump your entire vault into a prompt. Relevant context should be selected through indexes and cards. |
| Clean mode | Experiments, one-off questions, or work that should not use local notes | It does not read your Markdown vault. |

The public repository contains no personal vault. Start with an empty local directory or connect your own Markdown knowledge base.

## Portable packages and App Translocation

An unsigned macOS app opened directly from a downloaded ZIP can be placed in a temporary App Translocation directory. It then cannot reliably find sibling vault and runtime directories.

For a portable package, preserve the full layout and start it through the package-root launcher rather than opening the App directly:

~~~text
portable-package/
├── Boujoy Harness.app
├── runtime/
├── vault/
└── 启动 Boujoy Harness.command
~~~

The launcher passes the package root explicitly. Direct launches are detected and should lead to a safe folder-selection flow rather than exposing temporary macOS paths. This is a compatibility fallback, not notarization; signed public macOS distribution still needs a Developer ID signature and Apple notarization.

## Windows adapter (Beta)

The Windows adapter keeps the same product UI but uses a local PowerShell host and opens Edge in app mode when possible.

It is a **Windows 10/11 x64 Beta**:

1. Prepare the platform-specific DeepSeek Harness runtime on a real Windows x64 machine with windows/Prepare-Windows-Runtime.ps1.
2. Do not copy a macOS runtime folder to Windows; it contains platform-native dependencies.
3. Start it with windows/Start-Boujoy.ps1; in-product restart is delegated to the host via a local restart signal.
4. Read the [Windows guide](windows/README-Windows.zh-CN.md) and [release status](windows/WINDOWS-RELEASE-STATUS.md) before redistributing it.

## Troubleshooting

### Missing runtime component

Run `./macos/doctor.command` first. For an initial source install, `./macos/setup.command` avoids hand-writing environment variables. For a downloaded portable package, use the package-root launcher instead of opening the App directly.

### The splash screen waits for a while

The gateway and Harness need time to start on a cold run. Boujoy waits for a health check instead of loading a page before it is ready. If it finally fails, inspect the local runtime, Python, and provider configuration rather than repeatedly reloading the page.

### The agent has no response

Boujoy does not operate model accounts or API balances. Check the configured DeepSeek Harness provider, balance, network, permissions, and runtime logs.

### The knowledge preview is unavailable

The preview is optional. Its absence should not block the main Agent UI. Whether Knowledge mode can provide context depends on your own vault and Harness setup.

### Is this an official DeepSeek product?

No. Boujoy Harness is an independent, unofficial open-source product layer and is not endorsed or supported by DeepSeek AI.

## Privacy and network boundary

- Vault content, session state, and credentials stay on your machine and are not included in this repository.
- Without an access code, the local gateway binds only to 127.0.0.1. macOS phone pairing can enable access-code-protected LAN access.
- Model requests can pass through the local gateway to the DeepSeek Harness or provider that you configure. Boujoy operates no remote proxy and does not persist API keys as a Boujoy service.
- The AI news view requests public RSS feeds listed in web/boujoy_server.py; Boujoy configures no analytics or telemetry endpoint.
- Never commit boujoy-config.json, a vault, sessions, credentials, generated dist Apps, or platform runtimes.

See [SECURITY.md](SECURITY.md) for reporting guidance.

## Verification

Run the isolated smoke suite without a model account:

~~~bash
env PYTHONDONTWRITEBYTECODE=1 python3 tests/smoke_test.py --skip-live
~~~

For a locally running instance:

~~~bash
python3 tests/smoke_test.py --live-origin http://127.0.0.1:8766
~~~

The suite checks gateway contracts, path containment, media previews, access control, and portable-runtime normalization. It does not call a model provider. The isolated suite currently contains 18 checks.

## Repository map

~~~text
macos/      Native macOS WKWebView host and build scripts
web/        Local gateway, Boujoy UI, and first-party web assets
windows/    Windows browser-host Beta scripts and documentation
tests/      Model-free smoke tests
assets/     Boujoy-owned visual assets and attribution material
~~~

Convenience entry points: `macos/setup.command`, `macos/doctor.command`, and `Setup-Boujoy.cmd`.

## License and notices

Boujoy-authored code and artwork are released under the [MIT License](LICENSE). DeepSeek Harness is a separate MIT-licensed dependency with its own license and notices. Font attribution and third-party information live in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
