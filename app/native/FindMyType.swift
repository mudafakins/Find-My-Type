// Find My Type — native macOS shell.
//
// Hosts the UI (Resources/web) in a WKWebView and bridges it to macOS:
//   • window.nativeFontCatalog(fresh) → installed fonts with real categories (Core Text, cached on disk)
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

    /// Saved font list, so launches show fonts instantly; refreshed quietly in the background.
    private lazy var cacheURL: URL = {
        let dir = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent(Bundle.main.bundleIdentifier ?? "FindMyType", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        try? FileManager.default.removeItem(at: dir.appendingPathComponent("font-catalog.json")) // pre-v2 cache
        return dir.appendingPathComponent("font-catalog-v2.json") // v2 adds categories
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

    /// Ask Core Text for every font available to this user, with its real classification
    /// (read from the font's own OS/2 data), weight, width, slant and variable axes.
    /// Takes about a second — much faster than system_profiler.
    private func scanInstalledFonts() throws -> [[String: Any]] {
        let collection = CTFontCollectionCreateFromAvailableFonts(nil)
        guard let descriptors = CTFontCollectionCreateMatchingFontDescriptors(collection) as? [CTFontDescriptor] else {
            throw NSError(domain: "Fonts", code: 1)
        }

        var created: [String: Double] = [:] // file path → creation time (ms)
        var shapes: [String: String] = [:]  // family → shape-based guess (computed once per family)
        var faces: [[String: Any]] = []
        for descriptor in descriptors {
            func attribute<T>(_ key: CFString) -> T? { CTFontDescriptorCopyAttribute(descriptor, key) as? T }
            guard let family: String = attribute(kCTFontFamilyNameAttribute), !family.hasPrefix("."),
                  let url: URL = attribute(kCTFontURLAttribute), url.isFileURL
            else { continue }
            let path = url.path

            let traits: [String: Any] = attribute(kCTFontTraitsAttribute) ?? [:]
            let symbolic = (traits[kCTFontSymbolicTrait as String] as? NSNumber)?.uint32Value ?? 0
            let weightTrait = (traits[kCTFontWeightTrait as String] as? NSNumber)?.doubleValue ?? 0
            let widthTrait = (traits[kCTFontWidthTrait as String] as? NSNumber)?.doubleValue ?? 0
            let font = CTFontCreateWithFontDescriptor(descriptor, 12, nil)
            let axes = CTFontCopyVariationAxes(font) as? [Any] ?? []

            if created[path] == nil {
                let date = (try? FileManager.default.attributesOfItem(atPath: path)[.creationDate]) as? Date
                created[path] = (date?.timeIntervalSince1970 ?? 0) * 1000
            }

            var face: [String: Any] = [
                "family": family,
                "style": attribute(kCTFontStyleNameAttribute) ?? "Regular",
                "fullName": attribute(kCTFontDisplayNameAttribute) ?? family,
                "postscriptName": attribute(kCTFontNameAttribute) ?? "",
                "path": path,
                "extension": "." + url.pathExtension.lowercased(),
                "installedAt": created[path] ?? 0,
                "weight": Self.cssWeight(weightTrait),
                "italic": symbolic & CTFontSymbolicTraits.traitItalic.rawValue != 0,
                "width": (symbolic & CTFontSymbolicTraits.traitCondensed.rawValue != 0 || widthTrait < -0.1) ? "condensed"
                    : (symbolic & CTFontSymbolicTraits.traitExpanded.rawValue != 0 || widthTrait > 0.1) ? "expanded" : "normal",
                "variable": !axes.isEmpty,
            ]
            if let category = Self.category(symbolic) ?? Self.panoseCategory(font) {
                face["category"] = category
            } else if symbolic & CTFontSymbolicTraits.traitItalic.rawValue == 0 {
                if shapes[family] == nil { shapes[family] = Self.shapeCategory(font) ?? "" }
                if let shape = shapes[family], !shape.isEmpty { face["shapeCategory"] = shape }
            }
            faces.append(face)
        }
        return faces
    }

    /// Core Text weight trait (-1…1) → nearest CSS weight (100…900).
    private static func cssWeight(_ trait: Double) -> Int {
        let scale: [(Double, Int)] = [(-0.8, 100), (-0.6, 200), (-0.4, 300), (0, 400), (0.23, 500), (0.3, 600), (0.4, 700), (0.56, 800), (0.62, 900)]
        return scale.min { abs($0.0 - trait) < abs($1.0 - trait) }!.1
    }

    /// Fallback: the PANOSE classification in the font's OS/2 table (bytes 32–41).
    private static func panoseCategory(_ font: CTFont) -> String? {
        guard let table = CTFontCopyTable(font, CTFontTableTag(kCTFontTableOS2), []) as Data?, table.count >= 42 else { return nil }
        let familyType = table[32], serifStyle = table[33], proportion = table[35]
        switch familyType {
        case 2: // Latin text
            if proportion == 9 { return "Monospace" }
            switch serifStyle {
            case 2...10: return "Serif"
            case 11...15: return "Sans serif"
            default: return nil
            }
        case 3: return "Handwriting"
        case 4, 5: return "Display"
        default: return nil
        }
    }

    /// Last resort for fonts with no classification: look at the letters.
    /// Monospace if "i" and "M" have the same advance; serif if the capital "I" is
    /// much wider at its ends than in the middle.
    private static func shapeCategory(_ font: CTFont) -> String? {
        var chars = Array("IiM".utf16)
        var glyphs = [CGGlyph](repeating: 0, count: 3)
        guard CTFontGetGlyphsForCharacters(font, &chars, &glyphs, 3), !glyphs.contains(0) else { return nil }

        var advances = [CGSize](repeating: .zero, count: 3)
        CTFontGetAdvancesForGlyphs(font, .horizontal, glyphs, &advances, 3)
        if advances[2].width > 0, abs(advances[1].width - advances[2].width) < advances[2].width * 0.01 { return "Monospace" }

        let big = CTFontCreateCopyWithAttributes(font, 100, nil, nil)
        guard let path = CTFontCreatePathForGlyph(big, glyphs[0], nil) else { return nil }
        let box = path.boundingBox
        guard box.width > 2, box.height > 20 else { return nil }
        let w = Int(box.width.rounded(.up)) + 4, h = Int(box.height.rounded(.up)) + 4
        guard let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w,
                                  space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue),
              let raw = ctx.data else { return nil }
        ctx.translateBy(x: 2 - box.minX, y: 2 - box.minY)
        ctx.addPath(path)
        ctx.setFillColor(gray: 1, alpha: 1)
        ctx.fillPath()
        let pixels = raw.bindMemory(to: UInt8.self, capacity: w * h)
        func ink(_ row: Int) -> Int { (0..<w).reduce(0) { $0 + (pixels[row * w + $1] > 127 ? 1 : 0) } }

        let inset = max(1, Int(box.height * 0.05))
        let middle = ink(h / 2)
        guard middle > 0 else { return nil }
        let ends = max(ink(2 + inset), ink(h - 3 - inset))
        return Double(ends) / Double(middle) > 1.5 ? "Serif" : "Sans serif"
    }

    /// The font's declared design class (OS/2 sFamilyClass, via Core Text). nil = not declared.
    private static func category(_ symbolic: UInt32) -> String? {
        if symbolic & CTFontSymbolicTraits.traitMonoSpace.rawValue != 0 { return "Monospace" }
        switch CTFontStylisticClass(rawValue: symbolic & CTFontSymbolicTraits.traitClassMask.rawValue) {
        case .classOldStyleSerifs, .classTransitionalSerifs, .classModernSerifs,
             .classClarendonSerifs, .classSlabSerifs, .classFreeformSerifs: return "Serif"
        case .classSansSerif: return "Sans serif"
        case .classScripts: return "Handwriting"
        case .classOrnamentals, .classSymbolic: return "Display"
        default: return nil
        }
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

// MARK: - Updates (GitHub Releases)

/// Checks the GitHub repository in Info.plist (FMTUpdateRepo, set by build.sh) for a newer
/// release, downloads Find-My-Type-Mac.zip, checks it's this app, swaps it in and relaunches.
final class Updater {
    private let report: ([String: Any]) -> Void
    private var latest: (version: String, url: URL)?
    private var busy = false
    private static let assetName = "Find-My-Type-Mac.zip"
    private static let lastCheckKey = "LastUpdateCheck"

    init(report: @escaping ([String: Any]) -> Void) { self.report = report }

    private var current: String { Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0" }
    private var repository: String? {
        let repo = (Bundle.main.object(forInfoDictionaryKey: "FMTUpdateRepo") as? String)?.trimmingCharacters(in: .whitespaces)
        return (repo?.contains("/") ?? false) ? repo : nil
    }

    /// userInitiated: show "checking" / "up to date" / errors. Automatic checks stay quiet unless there's an update.
    func check(userInitiated: Bool) {
        guard !busy else { return }
        guard let repo = repository else { if userInitiated { report(["state": "unconfigured"]) }; return }
        if !userInitiated, let last = UserDefaults.standard.object(forKey: Self.lastCheckKey) as? Date, Date().timeIntervalSince(last) < 86_400 { return }
        if userInitiated { report(["state": "checking"]) }

        var request = URLRequest(url: URL(string: "https://api.github.com/repos/\(repo)/releases/latest")!)
        request.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
        request.setValue("FindMyType-Updater", forHTTPHeaderField: "User-Agent")
        URLSession.shared.dataTask(with: request) { data, response, _ in
            DispatchQueue.main.async {
                UserDefaults.standard.set(Date(), forKey: Self.lastCheckKey)
                guard let data, (response as? HTTPURLResponse)?.statusCode == 200,
                      let release = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                      let tag = release["tag_name"] as? String,
                      let assets = release["assets"] as? [[String: Any]],
                      let asset = assets.first(where: { $0["name"] as? String == Self.assetName }),
                      let link = asset["browser_download_url"] as? String, let url = URL(string: link)
                else {
                    if userInitiated { self.report(["state": "error", "message": "Couldn’t reach the update server. Check your connection and try again."]) }
                    return
                }
                let version = tag.trimmingCharacters(in: CharacterSet(charactersIn: "vV"))
                if Self.isNewer(version, than: self.current) {
                    self.latest = (version, url)
                    self.report(["state": "available", "version": version, "current": self.current])
                } else if userInitiated {
                    self.report(["state": "uptodate", "current": self.current])
                }
            }
        }.resume()
    }

    static func isNewer(_ a: String, than b: String) -> Bool {
        let x = a.split(separator: ".").map { Int($0) ?? 0 }, y = b.split(separator: ".").map { Int($0) ?? 0 }
        for i in 0..<max(x.count, y.count) {
            let l = i < x.count ? x[i] : 0, r = i < y.count ? y[i] : 0
            if l != r { return l > r }
        }
        return false
    }

    func install() {
        guard let latest, !busy else { return }
        busy = true
        report(["state": "downloading", "progress": 0])
        let task = URLSession.shared.downloadTask(with: latest.url) { file, response, error in
            let fail = { (message: String) in DispatchQueue.main.async { self.busy = false; self.report(["state": "error", "message": message]) } }
            guard let file, error == nil, (response as? HTTPURLResponse)?.statusCode == 200 else { return fail("The download didn’t finish. Try again later.") }
            do {
                let work = FileManager.default.temporaryDirectory.appendingPathComponent("FindMyTypeUpdate-\(UUID().uuidString)")
                try FileManager.default.createDirectory(at: work, withIntermediateDirectories: true)
                let zip = work.appendingPathComponent("update.zip")
                try FileManager.default.moveItem(at: file, to: zip)
                DispatchQueue.main.async { self.report(["state": "installing"]) }
                try Self.run("/usr/bin/ditto", ["-x", "-k", zip.path, work.path])
                guard let newApp = try FileManager.default.contentsOfDirectory(at: work, includingPropertiesForKeys: nil).first(where: { $0.pathExtension == "app" }),
                      Bundle(url: newApp)?.bundleIdentifier == Bundle.main.bundleIdentifier
                else { return fail("The downloaded update isn’t Find My Type. Nothing was changed.") }
                try Self.run("/usr/bin/codesign", ["--verify", "--deep", newApp.path])

                let target = Bundle.main.bundleURL
                _ = try FileManager.default.replaceItemAt(target, withItemAt: newApp)
                // Relaunch the new copy once this one has quit.
                let relaunch = Process()
                relaunch.executableURL = URL(fileURLWithPath: "/bin/sh")
                relaunch.arguments = ["-c", "sleep 1; /usr/bin/open \"$0\"", target.path]
                try relaunch.run()
                DispatchQueue.main.async { NSApp.terminate(nil) }
            } catch {
                fail("Couldn’t install the update. Move Find My Type into your Applications folder, then try again.")
            }
        }
        var observation: NSKeyValueObservation?
        var lastPercent = -1
        observation = task.progress.observe(\.fractionCompleted) { progress, _ in
            let percent = Int(progress.fractionCompleted * 100)
            guard percent != lastPercent else { return } // only whole-percent changes
            lastPercent = percent
            DispatchQueue.main.async { self.report(["state": "downloading", "progress": percent]) }
            if progress.fractionCompleted >= 1 { observation?.invalidate() }
        }
        task.resume()
    }

    private static func run(_ tool: String, _ arguments: [String]) throws {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: tool)
        process.arguments = arguments
        try process.run()
        process.waitUntilExit()
        if process.terminationStatus != 0 { throw NSError(domain: "Updater", code: Int(process.terminationStatus)) }
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
    private lazy var updater = Updater(report: { [weak self] status in self?.reportUpdate(status) })

    static let titlebarHeight: CGFloat = 28
    private static let lightBackground = NSColor(srgbRed: 0xf4 / 255, green: 0xf4 / 255, blue: 0xf4 / 255, alpha: 1)
    private static let darkBackground = NSColor(srgbRed: 0x14 / 255, green: 0x14 / 255, blue: 0x14 / 255, alpha: 1)

    private static let bridgeScript = """
    window.appPlatform = "mac";
    window.nativeCommand = (name) => window.webkit.messageHandlers.command.postMessage(String(name));
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
        for name in ["saveExport", "loadFonts", "theme", "command"] { config.userContentController.add(self, name: name) }
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
        // Quietly look for a new version (at most once a day).
        DispatchQueue.main.asyncAfter(deadline: .now() + 4) { self.updater.check(userInitiated: false) }
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
            item("Check for Updates…", #selector(checkForUpdates(_:)), target: self),
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

    @objc private func checkForUpdates(_ sender: Any?) { updater.check(userInitiated: true) }

    /// Send update progress to the page, which shows it as a toast.
    private func reportUpdate(_ status: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: status), let json = String(data: data, encoding: .utf8) else { return }
        web.evaluateJavaScript("window.onUpdateStatus && window.onUpdateStatus(\(json))", completionHandler: nil)
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
        case "command":
            switch message.body as? String {
            case "check-updates": updater.check(userInitiated: true)
            case "install-update": updater.install()
            case "about": NSApp.orderFrontStandardAboutPanel(nil)
            default: break
            }
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
