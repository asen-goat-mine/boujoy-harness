# Windows 适配版发布状态

## 当前完成

- 同一套 Boujoy Web UI 的 Windows 本地宿主。
- Windows 路径、`LOCALAPPDATA` 状态目录、可恢复删除目录、Explorer 定位文件。
- 知识模式与纯净模式双引擎启动、PID 受控停止、日志、健康检查和重启信号桥接。
- `.cmd` 入口、PowerShell 运行时准备脚本、无私有数据的包组装脚本。
- macOS 上完成 Python 网关回归、PowerShell 解析和 Windows 包形状预检。

## 仍不能称为“分享版”的原因

1. 尚未在真实 Windows 10/11 x64 机器上运行 Windows 原生 DeepSeek Harness 依赖。
2. 尚未完成 Windows 实机的知识/纯净模式切换、图片上传、Agent 交互、重启和关闭回归。
3. 尚未生成 Windows 运行时的最终 ZIP、SHA-256 和 Windows 代码签名/SmartScreen 验证。

因此此文件夹是 **Windows 适配工程包 / Beta**，不是现在就能发给朋友的最终分享包。等有一台 Windows 实机后，按 [Windows 说明](https://github.com/asen-goat-mine/boujoy-harness/blob/main/windows/README-Windows.zh-CN.md) 完成运行时准备与验收，再生成独立分享压缩包。
