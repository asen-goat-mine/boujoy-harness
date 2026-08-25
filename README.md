<div align="center">

# Boujoy Harness

## DeepSeek Harness 的本地桌面客户端

Boujoy Harness 使用 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 作为 Agent runtime，并提供桌面宿主、本地网关、对话界面和 Markdown 知识工作区。事件与 RPC 继续使用上游协议。

[English](README_EN.md) · [观看完整演示](https://github.com/asen-goat-mine/boujoy-harness/releases/download/demo-2026-08-19/Boujoy-Harness-Demo.mp4) · [DeepSeek Harness 上游项目](https://github.com/deepseek-ai/deepseek-harness)

</div>

<p align="center">
  <a href="https://github.com/asen-goat-mine/boujoy-harness/releases/download/demo-2026-08-19/Boujoy-Harness-Demo.mp4">
    <img src="docs/assets/harness-demo.gif" alt="Boujoy Harness UI 动态演示。点击观看完整视频。" width="900">
  </a>
</p>

<p align="center"><sub>README 内自动播放 UI 演示；点击即可打开完整 49 秒视频。</sub></p>

## 项目说明

Boujoy Harness 不替代 DeepSeek Harness。上游继续负责模型、工具、事件帧和 RPC；Boujoy 负责本地桌面体验和 Markdown 工作区。

1. **不替换 Agent runtime。** DeepSeek Harness 仍负责模型、工具、事件帧和 RPC。
2. **让工作上下文留在本地。** 可连接一个 Markdown Vault，让项目卡、知识卡、提示词和资料仍是普通文件。
3. **处理长对话和媒体。** 历史分页、流式投影、滚动稳定、断线恢复，以及会话内图片和视频预览。
4. **让本地启动可控。** macOS 有原生宿主与受控重启；Windows 提供浏览器宿主适配器（Beta）。

> 当前版本按 DeepSeek Harness `0.1.1-rc.2` 适配。源码仓库不提供模型或上游运行时，也不包含个人 Vault、会话或凭据。

## 核心能力

| 能力 | 说明 |
| --- | --- |
| 原生 Agent 连接 | 保持 DeepSeek Harness 的 WebSocket、事件帧与 RPC 语义。 |
| 本地 Markdown 工作区 | 项目、知识、提示词和内容资料仍是本机普通文件。 |
| 对话与媒体 | 长历史按页加载；流式文本不抢用户滚动；图片和本机视频可直接在消息中预览。 |
| 任务与中断交互 | 对需要确认、输入或批准的 Agent RPC 做队列化处理；过期响应会收口，弹窗不会永久卡住。 |
| 本地优先 | 未配置访问码时仅绑定本机回环地址；macOS 手机配对可启用受访问码保护的局域网访问；没有遥测。 |
| 启动恢复 | 处理健康检查、App Translocation、路径选择和可选知识服务缺失。 |
| 跨平台路线 | macOS 13+ Apple Silicon 原生桌面宿主；Windows 10/11 x64 为浏览器宿主 Beta。 |

## 工作方式

~~~text
你的一句话任务
        │
        ▼
Boujoy UI ── 本地网关 ── DeepSeek Harness ── 你配置的模型 / 工具
        │
        └────────────── 本地 Markdown Vault
                             项目 · 知识 · 提示词 · 内容
~~~

- **DeepSeek Harness** 负责让 Agent 真正行动。
- **Boujoy Harness** 负责让行动有工作区、有可视化、有可恢复的桌面体验。
- **Markdown Vault** 负责把值得长期复用的上下文留在你自己的文件里。

## 最快上手

### macOS

准备好已构建的 DeepSeek Harness 后，在仓库根目录双击或运行：

~~~bash
./macos/setup.command
~~~

引导程序会自动寻找 Python、已安装配置和常见的 DeepSeek Harness 路径；找不到时才会弹出文件夹选择器。知识库可以选择已有 Markdown 文件夹，也可以一键创建空 Vault。完成检查后，它会构建、安装并打开桌面 App。

只想检查环境而不安装时运行：

~~~bash
./macos/doctor.command
~~~

### Windows 10/11 x64（Beta）

首次使用双击 `Setup-Boujoy.cmd`。它会创建空 Vault、检查 Node.js 与 Python，并在缺少时安装 Windows 原生 DeepSeek Harness runtime。准备完成后双击 `启动 Boujoy Harness.cmd`。

Windows 仍需要在真实 Windows x64 机器上准备和验收；macOS runtime 不能复制过去使用。

## 手动从源码启动（macOS）

### 前置条件

- macOS 13+，Apple Silicon（arm64）
- 已单独安装并从源码构建好 DeepSeek Harness；需要存在可执行的 node_modules/.bin/dsh
- 一个本地 Markdown Vault 目录
- 可用的 Python 3

### 构建

~~~bash
git clone https://github.com/asen-goat-mine/boujoy-harness.git
cd boujoy-harness

# 指向你自己的、本机上的依赖；不要把这些值提交进 Git。
export BOUJOY_DSH_ROOT="$HOME/src/deepseek-harness"
export BOUJOY_VAULT_DIR="$HOME/BoujoyVault"
export BOUJOY_PYTHON_BIN="$(command -v python3)"

./macos/build-app.command --install
~~~

构建完成后，应用会安装到桌面上的 Boujoy Harness.app。首次启动后：

1. 在左侧选择或创建一个工作区。
2. 选择知识模式时，连接你自己的 Markdown Vault；选择纯净模式时，只运行 Harness，不读取 Vault。
3. 在输入框描述任务；模型、Provider 与工具权限仍由你已经配置好的 DeepSeek Harness 决定。
4. Agent 请求确认或输入时，使用弹窗继续；如果请求已经超时或被取消，界面会自动收口并进入下一项。

### 日常使用建议

- 将稳定项目资料放进 Vault，而不是只留在聊天记录里。
- 需要延续项目时，先让 Agent 读取当前项目上下文，再开始具体任务。
- 长任务生成时可以自由上翻查看历史；只有当你位于底部并主动跟随时，界面才会自动滚到底部。
- 不确定某次运行是否完成时，看右侧运行记录和状态，而不要根据输入框是否仍显示加载状态猜测。

## 知识模式与纯净模式

| 模式 | 适合什么 | 不会做什么 |
| --- | --- | --- |
| 知识模式 | 有项目背景、文档、提示词或历史决策需要复用的任务 | 不会把整个 Vault 无差别塞给模型；应由索引和相关卡片按需提供上下文。 |
| 纯净模式 | 临时问答、实验、无关任务或你不希望使用工作资料的场景 | 不会读取你的 Markdown Vault。 |

公开源码不附带个人 Vault。你可以从空目录开始，也可以连接自己的本地 Markdown 知识库。

## 便携包与 App Translocation

macOS 对从 ZIP 直接打开的未签名 App 可能启用 App Translocation：系统会把 App 放进临时、只读目录，导致它看不到同级的 vault 和 runtime。

因此，便携包必须保持完整目录结构，并双击包根目录的 启动 Boujoy Harness.command，而不是直接双击 App：

~~~text
你的便携包/
├── Boujoy Harness.app
├── runtime/
├── vault/
└── 启动 Boujoy Harness.command   ← 从这里启动
~~~

启动器会把包根目录显式传给 App。若用户仍直接打开 App，Boujoy 会识别异常启动路径并引导选择正确目录，而不是把临时系统路径暴露出来。

这是未签名分发的兼容处理；面向普通用户的正式 macOS 发布，仍建议使用 Apple Developer ID 签名与 notarization。

## Windows 适配器（Beta）

Windows 版本保留同一套 Web UI，但用本地 PowerShell 服务宿主，并在可用时以 Edge 应用模式打开。

它目前是 **Windows 10/11 x64 Beta**：

1. 必须在真实 Windows x64 机器上执行 windows/Prepare-Windows-Runtime.ps1，准备该平台对应的 DeepSeek Harness runtime。
2. 不可以把 macOS 的 runtime 直接复制到 Windows；其中存在平台原生依赖。
3. 使用 windows/Start-Boujoy.ps1 启动；站内重启会通过本地重启信号交回宿主处理。
4. 详情见 [Windows 说明](windows/README-Windows.zh-CN.md) 与 [发布状态](windows/WINDOWS-RELEASE-STATUS.md)。

## 常见问题

### 为什么应用提示缺少运行组件？

先运行 `./macos/doctor.command`。首次源码安装可以直接运行 `./macos/setup.command`，不必手写环境变量。若你使用下载的便携包，请从 启动 Boujoy Harness.command 启动，而不要直接打开 App。

### 为什么启动页停留较久？

首次运行需要启动本地网关和 Harness。Boujoy 会等待健康检查，而不是盲目加载尚未就绪的页面。若最终失败，请检查本地 runtime、Python 和 Provider 配置，而不是反复刷新浏览器。

### 为什么 Agent 没有回复？

Boujoy 不托管模型余额或 API Key。请从 DeepSeek Harness 本身检查模型 Provider、余额、网络、权限与运行日志。

### 知识库预览不可用会影响聊天吗？

不会。知识预览是可选服务；缺失时主 Agent 界面应继续可用。知识模式能否提供上下文，取决于你的 Vault 与 Harness 配置。

### 这是 DeepSeek 官方产品吗？

不是。Boujoy Harness 是独立的非官方开源产品层，不受 DeepSeek AI 支持或背书。

## 隐私与网络边界

- Vault 内容、会话状态和凭据留在你的本机；本仓库不会包含这些数据。
- 未提供访问码时，本地网关只绑定 127.0.0.1；macOS 手机配对会启用受访问码保护的局域网访问。
- 模型请求可经本机网关转交给你自行配置的 DeepSeek Harness 或 Provider；Boujoy 不运营远端中转，也不以 Boujoy 服务的形式持久化 API Key。
- AI 新闻页面会请求 web/boujoy_server.py 中列出的公开 RSS；Boujoy 不配置分析或遥测端点。
- 永远不要提交 boujoy-config.json、Vault、会话、凭据、生成的 dist App 或平台 runtime。

详细安全说明见 [SECURITY.md](SECURITY.md)。

## 验证与开发

不需要模型账户即可运行静态 smoke test：

~~~bash
env PYTHONDONTWRITEBYTECODE=1 python3 tests/smoke_test.py --skip-live
~~~

若本机已有正在运行的实例，可额外执行：

~~~bash
python3 tests/smoke_test.py --live-origin http://127.0.0.1:8766
~~~

测试会验证网关契约、路径边界、媒体预览、访问控制和便携运行时归一化；不会调用模型。当前隔离回归共 18 项。

## 仓库内容

~~~text
macos/      macOS 原生 WKWebView 宿主与构建脚本
web/        本地网关、Boujoy UI 与资源
windows/    Windows 浏览器宿主 Beta 脚本与说明
tests/      不依赖模型的 smoke test
assets/     Boujoy 一方拥有的图标、字体归属与视觉资源
~~~

便利入口：`macos/setup.command`、`macos/doctor.command` 与 `Setup-Boujoy.cmd`。

## 许可与致谢

Boujoy 自研代码与图形使用 [MIT License](LICENSE) 发布。DeepSeek Harness 是独立的 MIT 依赖，适用其自身的许可证与声明；字体归属与第三方信息见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
