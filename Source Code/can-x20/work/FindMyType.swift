import Cocoa
import WebKit

final class LocalContent: NSObject, WKURLSchemeHandler {
    let root: URL
    var catalog: Data?
    var files: [String:URL] = [:]
    let queue = DispatchQueue(label: "typefolio.localfonts")
    init(root:URL) { self.root=root }
    func fontCatalog() throws -> Data {
        if let catalog=catalog { return catalog }
        let process=Process(); process.executableURL=URL(fileURLWithPath:"/usr/sbin/system_profiler"); process.arguments=["SPFontsDataType","-json"]
        let pipe=Pipe();process.standardOutput=pipe;process.standardError=FileHandle.nullDevice
        try process.run();let data=pipe.fileHandleForReading.readDataToEndOfFile();process.waitUntilExit()
        guard process.terminationStatus==0, let decoded=try JSONSerialization.jsonObject(with:data) as? [String:Any], let entries=decoded["SPFontsDataType"] as? [[String:Any]] else {throw NSError(domain:"Fonts",code:1)}
        var faces:[[String:Any]]=[]
        for entry in entries {
            guard entry["enabled"] as? String != "no",let path=entry["path"] as? String,FileManager.default.fileExists(atPath:path),let list=entry["typefaces"] as? [[String:Any]] else {continue}
            let key=String(files.count);let url=URL(fileURLWithPath:path);files[key]=url
            for face in list {
                guard face["enabled"] as? String != "no",let family=face["family"] as? String,!family.hasPrefix(".") else {continue}
                faces.append(["family":family,"style":face["style"] as? String ?? "Regular","fullName":face["fullname"] as? String ?? family,"postscriptName":face["_name"] as? String ?? "","file":"typefolio://app/api/font/"+key,"extension":"."+url.pathExtension.lowercased(),"installedAt":(((try? FileManager.default.attributesOfItem(atPath:path)[.creationDate]) as? Date)?.timeIntervalSince1970 ?? 0) * 1000])
            }
        }
        let result=try JSONSerialization.data(withJSONObject:faces);catalog=result;return result
    }
    func webView(_ webView:WKWebView,start task:WKURLSchemeTask) {
        guard let url=task.request.url else {return}
        queue.async {
            do {
                let data:Data;let mime:String
                if url.path=="/api/local-fonts" {data=try self.fontCatalog();mime="application/json"}
                else if url.path.hasPrefix("/api/font/") {
                    guard let file=self.files[String(url.path.dropFirst(10))] else {throw NSError(domain:"MissingFont",code:404)}
                    data=try Data(contentsOf:file);mime="application/octet-stream"
                } else {
                    let path=url.path=="/" ? "index.html" : String(url.path.dropFirst())
                    guard ["index.html","app.js","fonts.json"].contains(path) else {throw NSError(domain:"MissingAsset",code:404)}
                    data=try Data(contentsOf:self.root.appendingPathComponent(path));mime=path.hasSuffix(".html") ? "text/html" : path.hasSuffix(".js") ? "application/javascript" : "application/json"
                }
                DispatchQueue.main.async { task.didReceive(URLResponse(url:url,mimeType:mime,expectedContentLength:data.count,textEncodingName:"utf-8"));task.didReceive(data);task.didFinish() }
            } catch { DispatchQueue.main.async {task.didFailWithError(error)} }
        }
    }
    func webView(_ webView:WKWebView,stop task:WKURLSchemeTask) {}
}

final class AppDelegate:NSObject,NSApplicationDelegate,WKScriptMessageHandler,WKNavigationDelegate {
    var window:NSWindow!;var web:WKWebView!;var content:LocalContent!;var exports:[(Data,String)]=[];var saving=false
    func applicationDidFinishLaunching(_ notification:Notification) {
        let menu=NSMenu();let item=NSMenuItem();menu.addItem(item);let appMenu=NSMenu();appMenu.addItem(withTitle:"Quit Find My Type",action:#selector(NSApplication.terminate(_:)),keyEquivalent:"q");item.submenu=appMenu
        let edit=NSMenuItem();menu.addItem(edit);let editMenu=NSMenu(title:"Edit");for (title,action,key) in [("Cut","cut:","x"),("Copy","copy:","c"),("Paste","paste:","v"),("Select All","selectAll:","a")] {editMenu.addItem(withTitle:title,action:Selector(action),keyEquivalent:key)};edit.submenu=editMenu;NSApp.mainMenu=menu
        let config=WKWebViewConfiguration();content=LocalContent(root:Bundle.main.resourceURL!.appendingPathComponent("web"));config.setURLSchemeHandler(content,forURLScheme:"typefolio");config.userContentController.add(self,name:"saveExport");config.userContentController.add(self,name:"loadFonts")
        let script="window.nativeFontCatalog=()=>new Promise((resolve,reject)=>{window.fontCatalogResolve=resolve;window.fontCatalogReject=reject;window.webkit.messageHandlers.loadFonts.postMessage(\"load\");});window.nativeDownload=function(data,name){window.webkit.messageHandlers.saveExport.postMessage({data:data,name:name});};"
        config.userContentController.addUserScript(WKUserScript(source:script,injectionTime:.atDocumentStart,forMainFrameOnly:true))
        web=WKWebView(frame:.zero,configuration:config);web.navigationDelegate=self
        window=NSWindow(contentRect:NSRect(x:0,y:0,width:1200,height:850),styleMask:[.titled,.closable,.miniaturizable,.resizable],backing:.buffered,defer:false);window.title="Find My Type";window.contentView=web;window.center();window.makeKeyAndOrderFront(nil)
        web.load(URLRequest(url:URL(string:"typefolio://app/")!));NSApp.activate(ignoringOtherApps:true)
    }
    func userContentController(_ controller:WKUserContentController,didReceive message:WKScriptMessage) {
        if message.name == "loadFonts" {
            content.queue.async {
                do {let data=try self.content.fontCatalog();let json=String(data:data,encoding:.utf8)!;DispatchQueue.main.async {self.web.evaluateJavaScript("window.fontCatalogResolve("+json+")",completionHandler:nil)}}
                catch {DispatchQueue.main.async {self.web.evaluateJavaScript("window.fontCatalogReject(new Error('Could not read fonts'))",completionHandler:nil)}}
            }
            return
        }
        guard let body=message.body as? [String:String],let raw=body["data"],let comma=raw.firstIndex(of:","),let data=Data(base64Encoded:String(raw[raw.index(after:comma)...])) else {return}
        exports.append((data,body["name"] ?? "Find My Type-export"));saveNext()
    }
    func saveNext() {
        guard !saving,!exports.isEmpty else {return};saving=true;let next=exports.removeFirst()
        let panel=NSSavePanel();panel.nameFieldStringValue=next.1;panel.beginSheetModal(for:window) {response in
            if response == .OK,let url=panel.url {do {try next.0.write(to:url)}catch {let alert=NSAlert();alert.messageText="Could not save export";alert.informativeText=error.localizedDescription;alert.runModal()}}
            self.saving=false;self.saveNext()
        }
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender:NSApplication)->Bool {true}
}
let application=NSApplication.shared
let delegate=AppDelegate();application.delegate=delegate;application.setActivationPolicy(.regular);application.run()
