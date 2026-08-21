import AppKit
import Darwin
import Foundation
import OSLog
import UniformTypeIdentifiers
import WebKit

struct AppPaths: Codable {
    var vault: String
    var dshRoot: String
    var knowledgeHome: String
    var cleanHome: String
    var python: String
}

final class ServiceManager {
    let paths: AppPaths
    private(set) var children: [Process] = []
    private var logHandles: [FileHandle] = []
    private let logger = Logger(subsystem: "com.boujoy.harness", category: "services")

    init(paths: AppPaths) { self.paths = paths }

    func serviceAlive(_ url: String, timeout: TimeInterval = 0.65) -> Bool {
        guard let target = URL(string: url) else { return false }
        let semaphore = DispatchSemaphore(value: 0)
        var success = false
        var request = URLRequest(url: target)
        request.timeoutInterval = timeout
        URLSession.shared.dataTask(with: request) { _, response, _ in
            if let http = response as? HTTPURLResponse {
                success = (200..<500).contains(http.statusCode)
            }
            semaphore.signal()
        }.resume()
        _ = semaphore.wait(timeout: .now() + timeout + 0.25)
        return success
    }

    private func launch(_ executable: String, _ arguments: [String], cwd: String, environment: [String: String] = [:]) {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = arguments
        process.currentDirectoryURL = URL(fileURLWithPath: cwd, isDirectory: true)
        process.standardInput = FileHandle.nullDevice
        var env = ProcessInfo.processInfo.environment
        environment.forEach { env[$0] = $1 }
        process.environment = env

        let logDirectory = FileManager.default.temporaryDirectory.appendingPathComponent("BoujoyHarness", isDirectory: true)
        try? FileManager.default.createDirectory(at: logDirectory, withIntermediateDirectories: true)
        let logURL = logDirectory.appendingPathComponent("services.log")
        if !FileManager.default.fileExists(atPath: logURL.path) {
            _ = FileManager.default.createFile(atPath: logURL.path, contents: nil)
        }
        if let handle = try? FileHandle(forWritingTo: logURL) {
            _ = try? handle.seekToEnd()
            process.standardOutput = handle
            process.standardError = handle
            logHandles.append(handle)
        } else {
            // A log failure must never prevent the local engine from starting.
            process.standardOutput = FileHandle.nullDevice
            process.standardError = FileHandle.nullDevice
            logger.error("Unable to open the service log; using /dev/null")
        }
        do {
            try process.run()
            children.append(process)
        } catch {
            logger.error("Boujoy service launch failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    func ensureKnowledgeServer() {
        if serviceAlive("http://127.0.0.1:8765/api/heartbeat") { return }
        let script = URL(fileURLWithPath: paths.vault)
            .appendingPathComponent("AI-Second-Brain-UI/web_preview.pyw").path
        guard FileManager.default.fileExists(atPath: script) else {
            // The second-brain preview is optional in the portable Harness
            // package. The product gateway has its own Markdown reader.
            logger.info("Optional knowledge preview is not bundled; skipping port 8765")
            return
        }
        guard FileManager.default.isExecutableFile(atPath: paths.python) else {
            logger.error("Optional knowledge preview skipped because Python is unavailable")
            return
        }
        launch(paths.python, [script, "--server-only", "8765"], cwd: paths.vault)
    }

    private func ensureCleanHome() {
        let manager = FileManager.default
        try? manager.createDirectory(atPath: paths.cleanHome, withIntermediateDirectories: true)
        let source = URL(fileURLWithPath: paths.knowledgeHome).appendingPathComponent(".credentials.yaml")
        let destination = URL(fileURLWithPath: paths.cleanHome).appendingPathComponent(".credentials.yaml")
        if manager.fileExists(atPath: source.path), !manager.fileExists(atPath: destination.path) {
            try? manager.copyItem(at: source, to: destination)
            try? manager.setAttributes([.posixPermissions: 0o600], ofItemAtPath: destination.path)
        }
    }

    func ensureHarness(clean: Bool) {
        let port = clean ? 3081 : 3080
        if serviceAlive("http://127.0.0.1:\(port)/") { return }
        if clean { ensureCleanHome() }
        let home = clean ? paths.cleanHome : paths.knowledgeHome
        let runtimeBin = URL(fileURLWithPath: paths.dshRoot).appendingPathComponent("runtime/bin").path
        let executable = URL(fileURLWithPath: paths.dshRoot).appendingPathComponent("node_modules/.bin/dsh").path
        let workingDirectory = clean ? FileManager.default.homeDirectoryForCurrentUser.path : paths.vault
        launch(executable, ["web", "--host", "127.0.0.1", "--port", "\(port)", "--no-open"], cwd: workingDirectory, environment: [
            "BOUJOY_DSH_ROOT": paths.dshRoot,
            "DSH_HOME": home,
            "DSH_TELEMETRY_DISABLED": "1",
            "PATH": runtimeBin + ":/usr/bin:/bin:/usr/sbin:/sbin"
        ])
    }

    func ensureProductServer(resources: URL) {
        // A previous compatible Boujoy instance may already own the port.
        // Accept its legacy heartbeat as a fallback during an in-place update;
        // otherwise the new process would fail to bind and the splash would
        // wait forever for a health endpoint the old gateway does not expose.
        if serviceAlive("http://127.0.0.1:8766/api/health") || serviceAlive("http://127.0.0.1:8766/api/heartbeat") { return }
        let script = resources.appendingPathComponent("boujoy_server.py").path
        let accessCode = persistAccessCode()
        launch(
            paths.python,
            [script, "--port", "8766", "--vault", paths.vault, "--static", resources.path, "--knowledge-home", paths.knowledgeHome, "--clean-home", paths.cleanHome, "--access-code", accessCode],
            cwd: resources.path,
            environment: ["PYTHONDONTWRITEBYTECODE": "1"]
        )
        writeAccessCodeHint(accessCode)
    }

    /// Stable, persisted 6-digit access code for phone/remote use. Generated
    /// once, stored in UserDefaults, reused across launches so the phone does
    /// not need a new code every restart.
    private func persistAccessCode() -> String {
        let key = "BoujoyAccessCode"
        if let existing = UserDefaults.standard.string(forKey: key), existing.count >= 6 {
            return existing
        }
        var code = ""
        for _ in 0..<6 { code += String(Int.random(in: 0...9)) }
        UserDefaults.standard.set(code, forKey: key)
        return code
    }

    /// Surface the access code to the user: a desktop hint file plus an alert
    /// on first launch, so the phone can be paired without hunting logs.
    private func writeAccessCodeHint(_ code: String) {
        let hint = URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Desktop/Boujoy-访问码.txt")
        let text = "手机访问 Boujoy：\n\n同一 Wi-Fi 下，手机浏览器打开\nhttp://<这台 Mac 的局域网 IP>:8766\n\n访问码：\(code)\n\n（首次输入后手机会记住，重启 Mac 也有效）\n"
        try? text.write(to: hint, atomically: true, encoding: .utf8)
        if !UserDefaults.standard.bool(forKey: "BoujoyAccessCodeShown") {
            UserDefaults.standard.set(true, forKey: "BoujoyAccessCodeShown")
            DispatchQueue.main.async {
                let alert = NSAlert()
                alert.messageText = "手机访问已开启"
                alert.informativeText = "访问码：\(code)\n\n同一 Wi-Fi 下用手机浏览器打开 http://<Mac 局域网IP>:8766 即可实时监控和操作。\n（访问码已保存到桌面 Boujoy-访问码.txt）"
                alert.addButton(withTitle: "知道了")
                alert.runModal()
            }
        }
    }

    func stopOwnedProcesses() {
        children.filter(\.isRunning).forEach { $0.terminate() }
    }
}

final class NativeBridge: NSObject, WKScriptMessageHandler {
    weak var controller: AppController?
    init(controller: AppController) { self.controller = controller }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let payload = message.body as? [String: Any], let action = payload["action"] as? String else { return }
        controller?.handleNative(action: action, payload: payload)
    }
}

final class ProductWebDelegate: NSObject, WKNavigationDelegate, WKUIDelegate {
    var didFinishNavigation: ((WKWebView) -> Void)?

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        didFinishNavigation?(webView)
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else {
            decisionHandler(.cancel)
            return
        }
        let isWebLink = ["http", "https"].contains(url.scheme?.lowercased() ?? "")
        let isProductHost = ["127.0.0.1", "localhost"].contains(url.host ?? "") && url.port == 8766
        if navigationAction.navigationType == .linkActivated, isProductHost, url.path != "/" {
            decisionHandler(.cancel)
            return
        }
        if navigationAction.navigationType == .linkActivated, isWebLink {
            NSWorkspace.shared.open(url)
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url { NSWorkspace.shared.open(url) }
        return nil
    }

    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.allowedContentTypes = ["png", "jpg", "jpeg", "webp", "gif"].compactMap {
            UTType(filenameExtension: $0)
        }
        panel.message = "选择要发送给 Agent 的图片"
        if let window = webView.window {
            panel.beginSheetModal(for: window) { response in
                completionHandler(response == .OK ? panel.urls : nil)
            }
        } else {
            completionHandler(panel.runModal() == .OK ? panel.urls : nil)
        }
    }
}

final class AppController: NSObject, NSApplicationDelegate {
    private var window: NSWindow!
    private var webView: WKWebView!
    private var paths: AppPaths!
    private var services: ServiceManager!
    private var bridge: NativeBridge!
    private let webDelegate = ProductWebDelegate()
    private var restartSignalSource: DispatchSourceSignal?
    private var relaunching = false
    private var waitingForSplashNavigation = false
    private let relaunchLabel = "com.boujoy.harness.relaunch"
    private let logger = Logger(subsystem: "com.boujoy.harness", category: "app")

    func applicationDidFinishLaunching(_ notification: Notification) {
        installRestartSignal()
        cleanupPreviousRelaunchJob()
        do {
            paths = try loadConfig()
        } catch {
            presentFatal("无法读取 Boujoy Harness 配置：\(error.localizedDescription)")
            return
        }
        guard let resources = Bundle.main.resourceURL else {
            presentFatal("应用资源不完整。")
            return
        }

        services = ServiceManager(paths: paths)
        services.ensureHarness(clean: false)
        services.ensureProductServer(resources: resources)
        DispatchQueue.global(qos: .utility).async { [weak self] in self?.services.ensureKnowledgeServer() }
        buildWindow()
        buildWebView()
        showSplashScreen()

        window.isReleasedWhenClosed = false
        window.makeKeyAndOrderFront(nil)
        window.orderFrontRegardless()
        NSApp.activate(ignoringOtherApps: true)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
    func applicationWillTerminate(_ notification: Notification) { services?.stopOwnedProcesses() }

    private func loadConfig() throws -> AppPaths {
        let fileManager = FileManager.default
        let environment = ProcessInfo.processInfo.environment
        let bundleURL = Bundle.main.bundleURL.standardizedFileURL
        let appIsTranslocated = bundleURL.path.contains("/AppTranslocation/")
        let explicitRoot = environment["BOUJOY_HARNESS_ROOT"].flatMap { value -> URL? in
            let candidate = URL(fileURLWithPath: (value as NSString).expandingTildeInPath).standardizedFileURL
            return fileManager.fileExists(atPath: candidate.path) ? candidate : nil
        }
        let configURL: URL
        if let override = environment["BOUJOY_HARNESS_CONFIG"] {
            configURL = URL(fileURLWithPath: (override as NSString).expandingTildeInPath).standardizedFileURL
        } else if let explicitRoot,
                  fileManager.fileExists(atPath: explicitRoot.appendingPathComponent("boujoy-config.json").path) {
            configURL = explicitRoot.appendingPathComponent("boujoy-config.json")
        } else if let bundled = Bundle.main.url(forResource: "boujoy-config", withExtension: "json") {
            configURL = bundled
        } else {
            throw configError("找不到 boujoy-config.json。")
        }
        guard fileManager.fileExists(atPath: configURL.path) else {
            throw configError("指定的 boujoy-config.json 不存在。")
        }

        let raw = try JSONDecoder().decode(AppPaths.self, from: Data(contentsOf: configURL))
        let values = [raw.vault, raw.dshRoot, raw.knowledgeHome, raw.cleanHome, raw.python]
        let hasRelativeValue = values.contains { value in
            let expanded = (value as NSString).expandingTildeInPath
            return !(expanded as NSString).isAbsolutePath && value.contains("/")
        }

        var bases: [URL] = []
        func appendBase(_ value: URL?) {
            guard let value else { return }
            let normalized = value.standardizedFileURL
            if !bases.contains(where: { $0.path == normalized.path }) { bases.append(normalized) }
        }
        appendBase(explicitRoot)
        appendBase(configURL.deletingLastPathComponent())
        if let saved = UserDefaults.standard.string(forKey: "BoujoyHarnessPortableRoot") {
            appendBase(URL(fileURLWithPath: saved))
        }
        if !appIsTranslocated { appendBase(bundleURL.deletingLastPathComponent()) }

        for base in bases {
            let candidate = resolve(paths: raw, relativeTo: base)
            if missingComponents(for: candidate).isEmpty {
                if hasRelativeValue { UserDefaults.standard.set(base.path, forKey: "BoujoyHarnessPortableRoot") }
                return candidate
            }
        }

        // Unsigned .app bundles launched directly from Finder can be moved by
        // Gatekeeper into App Translocation. Their bundle parent is temporary,
        // so ask once for the real extracted package instead of exposing a
        // cryptic /private/var/... error or relying on a brittle relative path.
        if hasRelativeValue, let selected = choosePortableRoot(translocated: appIsTranslocated) {
            let candidate = resolve(paths: raw, relativeTo: selected)
            if missingComponents(for: candidate).isEmpty {
                UserDefaults.standard.set(selected.path, forKey: "BoujoyHarnessPortableRoot")
                return candidate
            }
            throw configError("所选文件夹不是完整的 Boujoy Harness 包。需要同时包含 vault、runtime/DeepSeekHarness 和 Python 运行时。")
        }

        let guidance = appIsTranslocated
            ? "macOS 正在隔离运行这个未签名 App。请从分享包双击「启动 Boujoy Harness.command」，或重新打开 App 并选择包含 vault 和 runtime 的文件夹。"
            : "未找到完整运行组件。请确认 App、vault 和 runtime 保持在同一分享包内，或使用「启动 Boujoy Harness.command」打开。"
        throw configError(guidance)
    }

    private func resolve(paths raw: AppPaths, relativeTo base: URL) -> AppPaths {
        func resolved(_ value: String) -> String {
            let expanded = (value as NSString).expandingTildeInPath
            if (expanded as NSString).isAbsolutePath { return (expanded as NSString).standardizingPath }
            return base.appendingPathComponent(expanded).standardizedFileURL.path
        }
        var paths = raw
        paths.vault = resolved(raw.vault)
        paths.dshRoot = resolved(raw.dshRoot)
        paths.knowledgeHome = resolved(raw.knowledgeHome)
        paths.cleanHome = resolved(raw.cleanHome)
        if raw.python.contains("/") {
            paths.python = resolved(raw.python)
        } else {
            let candidates = ["/usr/bin/\(raw.python)", "/opt/homebrew/bin/\(raw.python)", "/usr/local/bin/\(raw.python)"]
            paths.python = candidates.first(where: { FileManager.default.isExecutableFile(atPath: $0) }) ?? raw.python
        }
        return paths
    }

    private func missingComponents(for paths: AppPaths) -> [String] {
        let manager = FileManager.default
        let required: [(String, String, Bool)] = [
            (paths.vault, "Markdown Vault", false),
            (paths.dshRoot, "DeepSeek Harness 运行时", false),
            (URL(fileURLWithPath: paths.dshRoot).appendingPathComponent("node_modules/.bin/dsh").path, "dsh 启动器", true),
            (paths.python, "Python 3", true),
        ]
        return required.compactMap { path, name, executable in
            let exists = executable ? manager.isExecutableFile(atPath: path) : manager.fileExists(atPath: path)
            return exists ? nil : name
        }
    }

    private func choosePortableRoot(translocated: Bool) -> URL? {
        let alert = NSAlert()
        alert.messageText = translocated ? "请选择原始 Boujoy Harness 文件夹" : "请选择 Boujoy Harness 文件夹"
        alert.informativeText = translocated
            ? "macOS 正在隔离运行此 App，无法读取它旁边的运行组件。请选择解压后同时包含 vault 和 runtime 的文件夹；只需一次。"
            : "请选择同时包含 vault 和 runtime 的 Boujoy Harness 文件夹。"
        alert.addButton(withTitle: "选择文件夹")
        alert.addButton(withTitle: "取消")
        guard alert.runModal() == .alertFirstButtonReturn else { return nil }

        let panel = NSOpenPanel()
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = false
        panel.prompt = "使用此文件夹"
        panel.message = "选择包含 vault 和 runtime 的 Boujoy Harness 文件夹"
        return panel.runModal() == .OK ? panel.url?.standardizedFileURL : nil
    }

    private func configError(_ message: String) -> NSError {
        NSError(domain: "BoujoyHarness", code: 2, userInfo: [NSLocalizedDescriptionKey: message])
    }

    private func presentFatal(_ text: String) {
        let alert = NSAlert()
        alert.messageText = "Boujoy Harness 启动失败"
        alert.informativeText = text
        alert.runModal()
        NSApp.terminate(nil)
    }

    private func buildWindow() {
        let screen = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        let size = NSSize(width: min(1540, screen.width * 0.94), height: min(960, screen.height * 0.94))
        let frame = NSRect(origin: .zero, size: size)
        window = NSWindow(
            contentRect: frame,
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        window.title = "Boujoy Harness"
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.minSize = NSSize(width: 900, height: 650)
        window.backgroundColor = NSColor(calibratedWhite: 0.025, alpha: 1)
        window.center()
    }

    private func buildWebView() {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        configuration.preferences.setValue(true, forKey: "developerExtrasEnabled")
        bridge = NativeBridge(controller: self)
        configuration.userContentController.add(bridge, name: "boujoy")

        webView = WKWebView(frame: window.contentView?.bounds ?? .zero, configuration: configuration)
        webView.autoresizingMask = [.width, .height]
        webView.navigationDelegate = webDelegate
        webView.uiDelegate = webDelegate
        webDelegate.didFinishNavigation = { [weak self] _ in self?.splashDidFinish() }
        webView.setValue(false, forKey: "drawsBackground")
        window.contentView = webView
    }

    private func showSplashScreen() {
        waitingForSplashNavigation = true
        let splash = """
        <!doctype html><html><head><meta charset="utf-8"><style>
          html,body{height:100%;margin:0;background:#080a0d;color:#f5efdf;font-family:-apple-system,"PingFang SC",sans-serif;display:flex;align-items:center;justify-content:center;overflow:hidden}
          .wrap{text-align:center;animation:fadein .5s ease}
          .mark{display:grid;place-items:center;width:88px;height:88px;margin:0 auto 26px;color:#c8f000;background:#050607;border:5px solid #c8f000;box-shadow:9px 9px 0 #213cff;font:800 52px/1 -apple-system;transform:rotate(-3deg)}
          h1{margin:0;font-size:22px;letter-spacing:2px;font-weight:800}
          p{margin:10px 0 0;color:#8a90a8;font-size:12px;letter-spacing:1px}
          .bar{width:180px;height:5px;margin:26px auto 0;background:#1a1f2e;overflow:hidden;border-radius:3px}
          .bar::after{content:"";display:block;width:60px;height:100%;background:#ff2b8b;animation:load 1.1s ease-in-out infinite}
          @keyframes load{0%{transform:translateX(-70px)}100%{transform:translateX(190px)}}
          @keyframes fadein{from{opacity:0}to{opacity:1}}
        </style></head><body>
        <div class="wrap"><div class="mark">B</div><h1>BOUJOY HARNESS</h1><p>正在启动本地引擎…</p><div class="bar"></div></div>
        </body></html>
        """
        webView.loadHTMLString(splash, baseURL: nil)
    }

    private func splashDidFinish() {
        guard waitingForSplashNavigation else { return }
        waitingForSplashNavigation = false
        waitAndLoadProduct()
    }

    private func waitAndLoadProduct() {
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self else { return }
            let startedAt = Date()
            let deadline = startedAt.addingTimeInterval(45)
            var attempt = 0
            while Date() < deadline {
                let healthy = self.services.serviceAlive("http://127.0.0.1:8766/api/health", timeout: 0.35)
                    || self.services.serviceAlive("http://127.0.0.1:8766/api/heartbeat", timeout: 0.20)
                if healthy {
                    // Keep the splash long enough to render once, rather than
                    // imposing the former fixed two-second artificial delay.
                    let minimumSplash = max(0, 0.55 - Date().timeIntervalSince(startedAt))
                    if minimumSplash > 0 { Thread.sleep(forTimeInterval: minimumSplash) }
                    DispatchQueue.main.async {
                        self.webView.load(URLRequest(url: URL(string: "http://127.0.0.1:8766/")!))
                    }
                    return
                }
                let delay: TimeInterval = attempt < 50 ? 0.10 : (attempt < 130 ? 0.25 : 0.50)
                attempt += 1
                Thread.sleep(forTimeInterval: delay)
            }
            DispatchQueue.main.async {
                self.presentFatal("新产品界面服务未能在 45 秒内启动。请确认分享包没有被拆开后重试。")
            }
        }
    }

    func handleNative(action: String, payload: [String: Any]) {
        switch action {
        case "mode":
            let clean = payload["clean"] as? Bool ?? false
            if clean { services.ensureHarness(clean: true) }
            notifyModeWhenReady(clean: clean)
        case "openExternal":
            if let value = payload["url"] as? String, let url = URL(string: value) { NSWorkspace.shared.open(url) }
        case "restart":
            relaunch()
        default:
            break
        }
    }

    private var relaunchPlistURL: URL {
        FileManager.default.temporaryDirectory
            .appendingPathComponent("BoujoyHarness", isDirectory: true)
            .appendingPathComponent("relaunch.plist")
    }

    private func runLaunchctl(_ arguments: [String]) -> Int32 {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/launchctl")
        process.arguments = arguments
        process.standardInput = FileHandle.nullDevice
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        do {
            try process.run()
            process.waitUntilExit()
            return process.terminationStatus
        } catch {
            return -1
        }
    }

    private func cleanupPreviousRelaunchJob() {
        let service = "gui/\(getuid())/\(relaunchLabel)"
        let plistURL = relaunchPlistURL
        DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + 3) { [weak self] in
            guard let self else { return }
            _ = self.runLaunchctl(["bootout", service])
            try? FileManager.default.removeItem(at: plistURL)
        }
    }

    /// Relaunch through a one-shot launchd job. KeepAlive is explicitly false:
    /// a failed cleanup may leave an inert definition, but can never create the
    /// repeating-window loop caused by `launchctl submit`.
    private func relaunch() {
        guard !relaunching else { return }
        relaunching = true
        let logDirectory = FileManager.default.temporaryDirectory.appendingPathComponent("BoujoyHarness", isDirectory: true)
        try? FileManager.default.createDirectory(at: logDirectory, withIntermediateDirectories: true)
        let relaunchLog = logDirectory.appendingPathComponent("relaunch.log").path
        do {
            let plist: [String: Any] = [
                "Label": relaunchLabel,
                "ProgramArguments": [
                    "/bin/zsh", "-c",
                    "for _ in {1..100}; do /usr/bin/nc -z 127.0.0.1 8766 2>/dev/null || break; /bin/sleep 0.1; done; /bin/sleep 0.2; exec /usr/bin/open -n -- \"$1\"",
                    "boujoy-relaunch", Bundle.main.bundlePath,
                ],
                "RunAtLoad": true,
                "KeepAlive": false,
                "ProcessType": "Background",
                "StandardOutPath": relaunchLog,
                "StandardErrorPath": relaunchLog,
            ]
            let data = try PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0)
            try data.write(to: relaunchPlistURL, options: .atomic)
            let domain = "gui/\(getuid())"
            _ = runLaunchctl(["bootout", "\(domain)/\(relaunchLabel)"])
            let status = runLaunchctl(["bootstrap", domain, relaunchPlistURL.path])
            guard status == 0 else {
                throw NSError(domain: "BoujoyHarness", code: Int(status), userInfo: [NSLocalizedDescriptionKey: "launchd one-shot relaunch rejected"])
            }
            NSApp.terminate(nil)
        } catch {
            relaunching = false
            presentFatal("无法重启 Boujoy Harness：\(error.localizedDescription)")
        }
    }

    /// The local product gateway uses SIGUSR1 for Agent-initiated restarts.
    /// DispatchSource converts the signal into normal main-thread work; the
    /// signal handler itself never touches AppKit.
    private func installRestartSignal() {
        Darwin.signal(SIGUSR1, SIG_IGN)
        let source = DispatchSource.makeSignalSource(signal: SIGUSR1, queue: .main)
        source.setEventHandler { [weak self] in self?.relaunch() }
        source.resume()
        restartSignalSource = source
    }

    private func notifyModeWhenReady(clean: Bool) {
        let port = clean ? 3081 : 3080
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self else { return }
            for _ in 0..<100 {
                if self.services.serviceAlive("http://127.0.0.1:\(port)/", timeout: 0.35) {
                    DispatchQueue.main.async {
                        self.webView.evaluateJavaScript("window.Boujoy && window.Boujoy.nativeModeReady(\(clean ? "true" : "false"))")
                    }
                    return
                }
                Thread.sleep(forTimeInterval: 0.15)
            }
        }
    }
}

let app = NSApplication.shared
let delegate = AppController()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
