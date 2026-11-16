// Find My Type — native macOS shell.
//
// Hosts the web UI (Resources/web) in a WKWebView and adds two bridges:
//   • window.nativeFontCatalog()  → lists installed fonts via system_profiler
//   • window.nativeDownload(data, name) → saves exports with an NSSavePanel
//
// The "typefolio://" scheme name is kept from the MVP: WebKit keys localStorage
// by origin, so changing it would lose users' saved favourites.

import Cocoa
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

    /// JSON array of installed font faces. Cached after the first (slow) scan.
    func fontCatalog() throws -> Data {
        if let catalog { return catalog }

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

            let key = String(files.count)
            let url = URL(fileURLWithPath: path)
            files[key] = url
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
                    "file": "typefolio://app/api/font/" + key,
                    "extension": "." + url.pathExtension.lowercased(),
                    "installedAt": (created?.timeIntervalSince1970 ?? 0) * 1000,
                ])
            }
        }
        let result = try JSONSerialization.data(withJSONObject: faces)
        catalog = result
        return result
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
        if path == "/api/local-fonts" {
            return (try fontCatalog(), "application/json")
        }
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

// MARK: - App delegate

final class AppDelegate: NSObject, NSApplicationDelegate, WKScriptMessageHandler, WKNavigationDelegate {
    var window: NSWindow!
    var web: WKWebView!
    var content: LocalContent!
    private var pendingExports: [(Data, String)] = []
    private var saving = false

    private var reduceTransparency: Bool { NSWorkspace.shared.accessibilityDisplayShouldReduceTransparency }

    private var bridgeScript: String { "window.__reduceTransparency = \(reduceTransparency);\n" + Self.bridgeFunctions }

    private static let bridgeFunctions = """
    window.nativeFontCatalog = () => new Promise((resolve, reject) => {
      window.fontCatalogResolve = resolve;
      window.fontCatalogReject = reject;
      window.webkit.messageHandlers.loadFonts.postMessage("load");
    });
    window.nativeDownload = (data, name) => window.webkit.messageHandlers.saveExport.postMessage({ data, name });
    """

    func applicationDidFinishLaunching(_ notification: Notification) {
        buildMenu()

        let config = WKWebViewConfiguration()
        content = LocalContent(root: Bundle.main.resourceURL!.appendingPathComponent("web"))
        config.setURLSchemeHandler(content, forURLScheme: "typefolio")
        config.userContentController.add(self, name: "saveExport")
        config.userContentController.add(self, name: "loadFonts")
        config.userContentController.addUserScript(WKUserScript(source: bridgeScript, injectionTime: .atDocumentStart, forMainFrameOnly: true))

        web = WKWebView(frame: .zero, configuration: config)
        web.navigationDelegate = self

        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1200, height: 850),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable],
                          backing: .buffered, defer: false)
        window.title = "Find My Type"
        window.contentView = web
        window.center()
        window.makeKeyAndOrderFront(nil)

        web.load(URLRequest(url: URL(string: "typefolio://app/")!))

        // Follow System Settings › Accessibility › Display › Reduce transparency live.
        NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.accessibilityDisplayOptionsDidChangeNotification, object: nil, queue: .main
        ) { [weak self] _ in
            guard let self else { return }
            self.web.evaluateJavaScript("window.setReduceTransparency?.(\(self.reduceTransparency))", completionHandler: nil)
        }
        NSApp.activate(ignoringOtherApps: true)
    }

    private func buildMenu() {
        let menu = NSMenu()

        let appItem = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "Quit Find My Type", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu
        menu.addItem(appItem)

        let editItem = NSMenuItem()
        let editMenu = NSMenu(title: "Edit")
        for (title, action, key) in [("Cut", "cut:", "x"), ("Copy", "copy:", "c"), ("Paste", "paste:", "v"), ("Select All", "selectAll:", "a")] {
            editMenu.addItem(withTitle: title, action: Selector(action), keyEquivalent: key)
        }
        editItem.submenu = editMenu
        menu.addItem(editItem)

        NSApp.mainMenu = menu
    }

    // MARK: JS → native messages

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        switch message.name {
        case "loadFonts": sendFontCatalog()
        case "saveExport": queueExport(message.body)
        default: break
        }
    }

    private func sendFontCatalog() {
        content.queue.async {
            let script: String
            if let data = try? self.content.fontCatalog(), let json = String(data: data, encoding: .utf8) {
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
        panel.beginSheetModal(for: window) { response in
            if response == .OK, let url = panel.url {
                do { try data.write(to: url) } catch {
                    let alert = NSAlert()
                    alert.messageText = "Could not save export"
                    alert.informativeText = error.localizedDescription
                    alert.runModal()
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
