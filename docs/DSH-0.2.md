# Boujoy Harness 1.1 on macOS

The local adapter runs the pinned DeepSeek Harness on loopback and keeps its launch token in memory. The two modes have separate homes. A stream snapshot restores the selected chat after a reconnect. Session title generation is local and upstream session logging is disabled by default.

## Fresh setup · 新环境

Use Node.js 24 with npm, Python 3 and the macOS build tools. Run these commands from the repository root. Choose new sibling directories in a location you intend to keep. The runtime records their absolute paths. Set the vault path to your own Markdown workspace when prompted by guided setup.

```sh
mkdir -p "$HOME/BoujoyRuntime"
upstream="$HOME/BoujoyRuntime/upstream-0.2.1-alpha.2"
wrapper="$HOME/BoujoyRuntime/boujoy-1.1"
npm install --prefix "$upstream" --save-exact @deepseek-ai/dsh@0.2.1-alpha.2
node tools/prepare-upstream-runtime.mjs "$upstream" --fresh "$wrapper"
node tools/configure-deepseek-flash.mjs "$wrapper"
python3 web/check_runtime.py "$wrapper"
BOUJOY_DSH_ROOT="$wrapper" ./macos/setup.command
```

首次安装会创建两份独立的会话目录，模型凭证由用户配置。Windows Beta 与可搬移分发仍采用原协议。公开源码更新不会自动替换已安装的应用或运行时。

## Migrating a legacy installation · 迁移旧会话

Stop the old runtime before copying its session files. Supply its root in place of `--fresh` and add a new backup directory as the fourth argument. The preparer copies both homes and normalizes supported legacy descriptors in the copies. Unmodified descriptor bytes remain in the private backup. Keep both runtime homes and backups off Git. Roll back by selecting the old runtime again. The 0.2 workspace uses the separately installed pinned upstream engine.

```sh
node tools/prepare-upstream-runtime.mjs "$upstream" /path/to/old-runtime "$wrapper" /path/to/new-private-backup
```

新建和迁移是两种独立的安装方式。迁移时使用新的 wrapper 目录，保留旧版目录以便回退。
