# Boujoy Harness Windows 适配版（x64 Beta）

这个适配版继续使用**完全同一套 Boujoy Web UI**；没有重做或替换界面。区别只在宿主：macOS 使用原生 Swift + WebKit，Windows 使用本地 PowerShell 宿主启动 DeepSeek Harness 与 Boujoy 网关，再由 Edge（优先）或默认浏览器承载 `http://127.0.0.1:8766`。

## 支持范围

- Windows 10 / 11，x64。
- DeepSeek Harness 必须在 **Windows 本机** 安装/构建；不能把 macOS 的 `runtime/` 复制到 Windows。
- 默认只监听本机回环地址，不会自动对局域网开放知识库。
- 纯净模式和知识模式在启动时同时准备，切换时不依赖 macOS 原生桥接。

## 目录结构

```text
Boujoy-Harness-Windows/
├── Start-Boujoy.cmd
├── Stop-Boujoy.cmd
├── README-Windows.md
├── app/
│   └── web/                  # Boujoy UI 与本地网关
├── vault/                    # 你的 Markdown 知识库
├── runtime/
│   ├── DeepSeekHarness/
│   │   └── node_modules/.bin/dsh.cmd
│   ├── node/node.exe         # 可选：便携 Node
│   └── python/python.exe     # 可选：便携 Python
└── windows/
```

## 第一次准备（在 Windows 上）

### 推荐：引导式准备

1. 安装 Node.js LTS 和 Python 3。
2. 双击包根目录的 `Setup-Boujoy.cmd`。
3. 检查通过后双击 `Start-Boujoy.cmd` 或 `启动 Boujoy Harness.cmd`。

引导脚本只在缺少 Windows runtime 时调用 npm 安装；已有完整 runtime 时只做本地检查。它不会复制或上传你的 Vault。

### 手动准备

1. 安装 Node.js LTS 和 Python 3（推荐 Python 3.12）。
2. 把一个空的或你自己的 Markdown Vault 放进 `vault/`。不要把私有 Vault 直接用于公开分享。
3. 在包根目录打开 PowerShell，执行：

```powershell
powershell -ExecutionPolicy Bypass -File .\windows\Prepare-Windows-Runtime.ps1 -Root (Get-Location)
```

它会在 Windows 上安装固定版本的 `@deepseek-ai/dsh`，从而得到正确的 `dsh.cmd` 和 Windows 原生依赖。

4. 双击 `Start-Boujoy.cmd`。启动器会先自检路径、Node、Python 和 `dsh.cmd`，成功后以 Edge 应用窗口打开同一套 Boujoy UI。

## 重启与排错

- 界面的「重启 Boujoy Harness」会通知 Windows 宿主依次重启 Gateway、知识模式和纯净模式，不会只做网页刷新。
- `Stop-Boujoy.cmd` 只会停止该包自己记录的 PID，不会按进程名误杀别的项目。
- 日志在 `%LOCALAPPDATA%\Boujoy\BoujoyHarness\Windows\<包实例>\`。
- 如果启动器提示缺少 `dsh.cmd`，说明运行时不是 Windows 原生版；回到上面的第一次准备步骤，不要复制 Mac 的 `runtime/`。

## 分发边界

本仓库提供的是 Windows 宿主、启动器、重启桥接和构建脚本。要称为「给朋友直接双击的分享版」，还必须在真实 Windows x64 机器上完成一次运行时安装、启动、知识/纯净模式切换、图片上传、对话交互和重启测试，然后再把 Windows 原生 `runtime/` 连同公开 Vault 一起打包。

在没有真实 Windows 验机前，不要把 macOS 的 ZIP 改名为 Windows 版，也不要给出“已验证可用”的承诺。
