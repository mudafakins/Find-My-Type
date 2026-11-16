// Find My Type — native macOS shell.
//
// Hosts the UI (Resources/web) in a WKWebView and bridges it to macOS:
//   • window.nativeFontCatalog(fresh) → installed fonts (system_profiler, cached on disk)
//   • window.nativeDownload(data, name) → save panel for exports
//   • window.nativeSetTheme(dark)    → window appearance follows the in-app theme
//   • menu commands → window.appCommand(name); File › Import → window.importFontFiles(...)
//
// The "typefolio://" scheme name is kept from the MVP: WebKit keys localStorage
// by origin, so changing it would lose users' saved favourites.

import Cocoa
import UniformTypeIdentifiers
import WebKit

// MARK: - Local content + font catalogue

final class LocalContent: NSObject, WKURLSchemeHandler {
    static let webAssets: [String: String] = [
        "index.html": "text/html",
        "styles.css": "text/css",
        "app.js": "application/javascript",
        "fonts.js": "application/javascript",
    ]

    let root: URL
    let queue = DispatchQueue(label: "typefolio.localfonts")
    private var catalog: Data?
    private var files: [String: URL] = [:]

    init(root: URL) { self.root = root }

    /// Saved font list, so later launches don't wait for system_profiler (can take a minute).
    private lazy var cacheURL: URL = {
        let dir = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent(Bundle.main.bundleIdentifier ?? "FindMyType", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("font-catalog.json")
    }()

    /// JSON array of installed font faces.
    /// - fresh == false: memory → saved list on disk (then refresh it in the background) → full scan.
    /// - fresh == true:  always scan again (the Rescan button).
    func fontCatalog(fresh: Bool = false) throws -> Data {
        if !fresh, let catalog { return catalog }
        if !fresh, let data = try? Data(contentsOf: cacheURL),
           let raw = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]], !raw.isEmpty {
            let result = try register(raw)
            queue.asyncAfter(deadline: .now() + 2) { [weak self] in self?.refreshCache() }
            return result
        }
        let raw = try scanInstalledFonts()
        saveCache(raw)
        return try register(raw)
    }

    /// Give every font file a token URL the web view can load, and remember the result.
    private func register(_ raw: [[String: Any]]) throws -> Data {
        files = [:]
        var tokens: [String: String] = [:]
        var faces: [[String: Any]] = []
        for var face in raw {
            guard let path = face["path"] as? String, FileManager.default.fileExists(atPath: path) else { continue }
            let key = tokens[path] ?? {
                let k = String(files.count)
                tokens[path] = k
                files[k] = URL(fileURLWithPath: path)
                return k
            }()
            face["file"] = "typefolio://app/api/font/" + key
            face.removeValue(forKey: "path")
            faces.append(face)
        }
        let result = try JSONSerialization.data(withJSONObject: faces)
        catalog = result
        return result
    }

    private func saveCache(_ raw: [[String: Any]]) {
        if let data = try? JSONSerialization.data(withJSONObject: raw) { try? data.write(to: cacheURL, options: .atomic) }
    }

    /// Quietly rescan so the next launch picks up newly installed fonts.
    private func refreshCache() {
        if let raw = try? scanInstalledFonts() { saveCache(raw) }
    }

    /// Ask macOS for every installed, enabled font face.
    private func scanInstalledFonts() throws -> [[String: Any]] {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/sbin/system_profiler")
        process.arguments = ["SPFontsDataType", "-json"]
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice
        try process.run()
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()

        guard process.terminationStatus == 0,
              let decoded = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let entries = decoded["SPFontsDataType"] as? [[String: Any]]
        else { throw NSError(domain: "Fonts", code: 1) }

        var faces: [[String: Any]] = []
        for entry in entries {
            guard entry["enabled"] as? String != "no",
                  let path = entry["path"] as? String,
                  FileManager.default.fileExists(atPath: path),
                  let typefaces = entry["typefaces"] as? [[String: Any]]
            else { continue }

            let url = URL(fileURLWithPath: path)
            let created = (try? FileManager.default.attributesOfItem(atPath: path)[.creationDate]) as? Date

            for face in typefaces {
                guard face["enabled"] as? String != "no",
                      let family = face["family"] as? String,
                      !family.hasPrefix(".")
                else { continue }
                faces.append([
                    "family": family,
                    "style": face["style"] as? String ?? "Regular",
                    "fullName": face["fullname"] as? String ?? family,
                    "postscriptName": face["_name"] as? String ?? "",
                    "path": path,
                    "extension": "." + url.pathExtension.lowercased(),
                    "installedAt": (created?.timeIntervalSince1970 ?? 0) * 1000,
                ])
            }
        }
        return faces
    }

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard let url = task.request.url else { return }
        queue.async {
            do {
                let (data, mime) = try self.response(for: url.path)
                DispatchQueue.main.async {
                    task.didReceive(URLResponse(url: url, mimeType: mime, expectedContentLength: data.count, textEncodingName: "utf-8"))
                    task.didReceive(data)
                    task.didFinish()
                }
            } catch {
                DispatchQueue.main.async { task.didFailWithError(error) }
            }
        }
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}

    private func response(for path: String) throws -> (Data, String) {
        if path.hasPrefix("/api/font/") {
            guard let file = files[String(path.dropFirst("/api/font/".count))] else {
                throw NSError(domain: "MissingFont", code: 404)
            }
            return (try Data(contentsOf: file), "application/octet-stream")
        }
        let name = path == "/" ? "index.html" : String(path.dropFirst())
        guard let mime = Self.webAssets[name] else { throw NSError(domain: "MissingAsset", code: 404) }
        return (try Data(contentsOf: root.appendingPathComponent(name)), mime)
    }
}

// MARK: - Title bar drag strip

/// The page fills the window (hidden title bar), so this transparent strip along the
/// top lets you drag the window — and double-click to zoom/minimise — like any Mac app.
final class TitlebarDragView: NSView {
    override var mouseDownCanMoveWindow: Bool { true }
    override func mouseDown(with event: NSEvent) {
        if event.clickCount == 2 {
            let action = UserDefaults.standard.string(forKey: "AppleActionOnDoubleClick") ?? "Maximize"
            if action == "Minimize" { window?.performMiniaturize(nil) } else if action != "None" { window?.performZoom(nil) }
        } else {
            window?.performDrag(with: event)
        }
    }
}

// MARK: - App delegate

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, WKScriptMessageHandler, WKNavigationDelegate, WKUIDelegate {
    var window: NSWindow!
    var web: WKWebView!
    var content: LocalContent!
    private var pendingExports: [(Data, String)] = []
    private var saving = false
    private var shown = false

    static let titlebarHeight: CGFloat = 28
    private static let lightBackground = NSColor(srgbRed: 0xf4 / 255, green: 0xf4 / 255, blue: 0xf4 / 255, alpha: 1)
    private static let darkBackground = NSColor(srgbRed: 0x14 / 255, green: 0x14 / 255, blue: 0x14 / 255, alpha: 1)

    private static let bridgeScript = """
    window.isMacApp = true;
    window.nativeFontCatalog = (fresh) => new Promise((resolve, reject) => {
      window.fontCatalogResolve = resolve;
      window.fontCatalogReject = reject;
      window.webkit.messageHandlers.loadFonts.postMessage(fresh ? "rescan" : "load");
    });
    window.nativeDownload = (data, name) => window.webkit.messageHandlers.saveExport.postMessage({ data, name });
    window.nativeSetTheme = (dark) => window.webkit.messageHandlers.theme.postMessage(!!dark);
    """

    func applicationDidFinishLaunching(_ notification: Notification) {
        buildMenu()

        let config = WKWebViewConfiguration()
        content = LocalContent(root: Bundle.main.resourceURL!.appendingPathComponent("web"))
        config.setURLSchemeHandler(content, forURLScheme: "typefolio")
        for name in ["saveExport", "loadFonts", "theme"] { config.userContentController.add(self, name: name) }
        config.userContentController.addUserScript(WKUserScript(source: Self.bridgeScript, injectionTime: .atDocumentStart, forMainFrameOnly: true))

        web = WKWebView(frame: .zero, configuration: config)
        web.navigationDelegate = self
        web.uiDelegate = self
        web.allowsMagnification = false
        web.allowsBackForwardNavigationGestures = false

        // Hidden title bar: the page runs edge to edge, traffic lights float over it.
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1280, height: 860),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
                          backing: .buffered, defer: false)
        window.title = "Find My Type"
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.isMovableByWindowBackground = false
        window.minSize = NSSize(width: 760, height: 560)
        window.backgroundColor = Self.lightBackground
        window.tabbingMode = .disallowed
        window.delegate = self

        let container = NSView()
        container.autoresizesSubviews = true
        web.autoresizingMask = [.width, .height]
        container.addSubview(web)
        let drag = TitlebarDragView()
        drag.autoresizingMask = [.width, .minYMargin]
        container.addSubview(drag)
        window.contentView = container
        web.frame = container.bounds
        drag.frame = NSRect(x: 0, y: container.bounds.height - Self.titlebarHeight, width: container.bounds.width, height: Self.titlebarHeight)

        // Remember size and position between launches; centre the first time.
        if !window.setFrameUsingName("MainWindow") { window.center() }
        window.setFrameAutosaveName("MainWindow")

        web.load(URLRequest(url: URL(string: "typefolio://app/")!))
        // Show once the page has drawn (no white flash); fall back after 2s.
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { self.showWindow() }
    }

    private func showWindow() {
        guard !shown else { return }
        shown = true
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        // One more frame so the first paint (with the saved theme) is on screen.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { self.showWindow() }
    }

    /// Keep the app on its own page: never navigate away (e.g. a file dropped on the window).
    /// http(s) links open in the default browser.
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { return decisionHandler(.cancel) }
        if url.scheme == "typefolio" { return decisionHandler(.allow) }
        if ["http", "https", "mailto"].contains(url.scheme ?? ""), action.navigationType == .linkActivated {
            NSWorkspace.shared.open(url)
        }
        decisionHandler(.cancel)
    }

    /// <input type="file"> needs a native open panel inside WKWebView.
    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        let panel = fontOpenPanel(multiple: parameters.allowsMultipleSelection)
        panel.beginSheetModal(for: window) { response in completionHandler(response == .OK ? panel.urls : nil) }
    }

    private func fontOpenPanel(multiple: Bool) -> NSOpenPanel {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = multiple
        panel.canChooseDirectories = false
        panel.allowedContentTypes = ["ttf", "otf", "woff", "woff2"].compactMap { UTType(filenameExtension: $0) }
        panel.message = "Choose font files to preview in Find My Type"
        panel.prompt = "Import"
        return panel
    }

    // MARK: Menus

    private func buildMenu() {
        let main = NSMenu()

        func submenu(_ title: String, _ items: [NSMenuItem]) -> NSMenu {
            let menu = NSMenu(title: title)
            items.forEach(menu.addItem)
            let holder = NSMenuItem()
            holder.submenu = menu
            main.addItem(holder)
            return menu
        }
        func item(_ title: String, _ action: Selector?, _ key: String = "", _ mods: NSEvent.ModifierFlags = .command, target: AnyObject? = nil) -> NSMenuItem {
            let i = NSMenuItem(title: title, action: action, keyEquivalent: key)
            i.keyEquivalentModifierMask = mods
            i.target = target
            return i
        }
        func command(_ title: String, _ name: String, _ key: String = "", _ mods: NSEvent.ModifierFlags = .command) -> NSMenuItem {
            let i = item(title, #selector(sendCommand(_:)), key, mods, target: self)
            i.representedObject = name
            return i
        }
        let sep = { NSMenuItem.separator() }

        _ = submenu("Find My Type", [
            item("About Find My Type", #selector(NSApplication.orderFrontStandardAboutPanel(_:))),
            sep(),
            item("Hide Find My Type", #selector(NSApplication.hide(_:)), "h"),
            item("Hide Others", #selector(NSApplication.hideOtherApplications(_:)), "h", [.command, .option]),
            item("Show All", #selector(NSApplication.unhideAllApplications(_:))),
            sep(),
            item("Quit Find My Type", #selector(NSApplication.terminate(_:)), "q"),
        ])

        _ = submenu("File", [
            item("Import Font Files…", #selector(importFonts(_:)), "o", target: self),
            command("Rescan Installed Fonts", "rescan", "r"),
            sep(),
            command("Export Shortlist as PDF…", "export-pdf", "e"),
            command("Export Shortlist as PNG…", "export-png", "e", [.command, .shift]),
            sep(),
            item("Close Window", #selector(NSWindow.performClose(_:)), "w"),
        ])

        _ = submenu("Edit", [
            item("Undo", Selector(("undo:")), "z"),
            item("Redo", Selector(("redo:")), "z", [.command, .shift]),
            sep(),
            item("Cut", #selector(NSText.cut(_:)), "x"),
            item("Copy", #selector(NSText.copy(_:)), "c"),
            item("Paste", #selector(NSText.paste(_:)), "v"),
            item("Select All", #selector(NSText.selectAll(_:)), "a"),
            sep(),
            command("Find Fonts…", "find", "f"),
            command("Edit Company Name", "edit-name", "n"),
        ])

        _ = submenu("View", [
            command("Google Fonts", "source-google", "1"),
            command("Local Fonts", "source-local", "2"),
            sep(),
            command("Show Shortlist", "shortlist", "l"),
            command("Grid", "view-grid", "1", [.command, .option]),
            command("List", "view-list", "2", [.command, .option]),
            command("Shuffle Fonts", "shuffle", "s", [.command, .option]),
            sep(),
            command("Larger Preview", "size-up", "="),
            command("Smaller Preview", "size-down", "-"),
            command("Default Preview Size", "size-reset", "0"),
            sep(),
            command("Toggle Dark Mode", "toggle-theme", "d", [.command, .shift]),
            item("Enter Full Screen", #selector(NSWindow.toggleFullScreen(_:)), "f", [.command, .control]),
        ])

        let windowMenu = submenu("Window", [
            item("Minimize", #selector(NSWindow.performMiniaturize(_:)), "m"),
            item("Zoom", #selector(NSWindow.performZoom(_:))),
            sep(),
            item("Bring All to Front", #selector(NSApplication.arrangeInFront(_:))),
        ])

        NSApp.mainMenu = main
        NSApp.windowsMenu = windowMenu
    }

    /// Menu item → window.appCommand(name) in the page.
    @objc private func sendCommand(_ sender: NSMenuItem) {
        guard let name = sender.representedObject as? String else { return }
        web.evaluateJavaScript("window.appCommand && window.appCommand(\(jsString(name)))", completionHandler: nil)
    }

    /// File › Import: native open panel, then hand the bytes to the page.
    @objc private func importFonts(_ sender: Any?) {
        let panel = fontOpenPanel(multiple: true)
        panel.beginSheetModal(for: window) { response in
            guard response == .OK else { return }
            let files: [[String: String]] = panel.urls.compactMap { url in
                guard let data = try? Data(contentsOf: url) else { return nil }
                return ["name": url.lastPathComponent, "data": data.base64EncodedString()]
            }
            guard let json = try? JSONSerialization.data(withJSONObject: files), let text = String(data: json, encoding: .utf8) else { return }
            self.web.evaluateJavaScript("window.importFontData && window.importFontData(\(text))", completionHandler: nil)
        }
    }

    private func jsString(_ value: String) -> String {
        let data = try? JSONSerialization.data(withJSONObject: [value])
        return String(data: data ?? Data(), encoding: .utf8).map { String($0.dropFirst().dropLast()) } ?? "\"\""
    }

    // MARK: JS → native messages

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        switch message.name {
        case "loadFonts": sendFontCatalog(fresh: message.body as? String == "rescan")
        case "saveExport": queueExport(message.body)
        case "theme": applyTheme(dark: message.body as? Bool ?? false)
        default: break
        }
    }

    /// Match the window chrome (traffic lights, scrollbars, save panels) to the in-app theme.
    private func applyTheme(dark: Bool) {
        window.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
        window.backgroundColor = dark ? Self.darkBackground : Self.lightBackground
    }

    private func sendFontCatalog(fresh: Bool) {
        content.queue.async {
            let script: String
            if let data = try? self.content.fontCatalog(fresh: fresh), let json = String(data: data, encoding: .utf8) {
                script = "window.fontCatalogResolve(" + json + ")"
            } else {
                script = "window.fontCatalogReject(new Error('Could not read fonts'))"
            }
            DispatchQueue.main.async { self.web.evaluateJavaScript(script, completionHandler: nil) }
        }
    }

    /// Body is { data: "data:...;base64,....", name: "file.png" }.
    private func queueExport(_ body: Any) {
        guard let body = body as? [String: String],
              let raw = body["data"],
              let comma = raw.firstIndex(of: ","),
              let data = Data(base64Encoded: String(raw[raw.index(after: comma)...]))
        else { return }
        pendingExports.append((data, body["name"] ?? "Find My Type-export"))
        saveNext()
    }

    /// Show save panels one at a time.
    private func saveNext() {
        guard !saving, !pendingExports.isEmpty else { return }
        saving = true
        let (data, name) = pendingExports.removeFirst()
        let panel = NSSavePanel()
        panel.nameFieldStringValue = name
        panel.canCreateDirectories = true
        panel.beginSheetModal(for: window) { response in
            if response == .OK, let url = panel.url {
                do { try data.write(to: url) } catch {
                    let alert = NSAlert()
                    alert.messageText = "Couldn’t save the export"
                    alert.informativeText = error.localizedDescription
                    alert.beginSheetModal(for: self.window)
                }
            }
            self.saving = false
            self.saveNext()
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}

let application = NSApplication.shared
let delegate = AppDelegate()
application.delegate = delegate
application.setActivationPolicy(.regular)
application.run()
