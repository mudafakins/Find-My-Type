from pathlib import Path
p=Path('outputs/Typefolio/serve.py');s=p.read_text().replace('import webbrowser, threading, subprocess','import webbrowser, threading, subprocess, json, re, time\nfrom urllib.parse import urlparse\nFONT_CACHE = None\nFONT_FILES = {}\nFONT_LOCK = threading.Lock()\ndef font_catalog():\n    global FONT_CACHE\n    with FONT_LOCK:\n        if FONT_CACHE is not None: return FONT_CACHE\n        data = json.loads(subprocess.check_output(["/usr/sbin/system_profiler", "SPFontsDataType", "-json"], timeout=120))\n        faces = []\n        for item in data.get("SPFontsDataType", []):\n            path = Path(item.get("path", ""))\n            if not path.is_file() or item.get("enabled") == "no": continue\n            token = str(len(FONT_FILES))\n            FONT_FILES[token] = path\n            for face in item.get("typefaces", []):\n                if face.get("enabled") == "no" or not face.get("family"): continue\n                if face["family"].startswith("."): continue\n                faces.append({"family": face["family"], "style": face.get("style", "Regular"), "fullName": face.get("fullname", face["family"]), "postscriptName": face.get("_name", ""), "file": "/api/font/" + token, "extension": path.suffix.lower()})\n        FONT_CACHE = faces\n        return faces')
s=s.replace('    def end_headers(self):','''    def do_GET(self):
        route = urlparse(self.path).path
        if route.startswith("/api/"):
            if self.headers.get("Host", "") not in {f"127.0.0.1:{PORT}", f"localhost:{PORT}"} or self.headers.get("Sec-Fetch-Site") == "cross-site":
                self.send_error(403); return
            if route == "/api/local-fonts":
                try:
                    payload = json.dumps(font_catalog()).encode()
                except Exception as error:
                    self.send_error(500, "Could not read installed fonts"); return
                self.send_response(200); self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(payload))); self.end_headers(); self.wfile.write(payload); return
            if route.startswith("/api/font/"):
                token = route.removeprefix("/api/font/") if hasattr(str, "removeprefix") else route[len("/api/font/"):]
                path = FONT_FILES.get(token)
                if path is None: self.send_error(404); return
                payload = path.read_bytes()
                self.send_response(200); self.send_header("Content-Type", "application/octet-stream"); self.send_header("Content-Length", str(len(payload))); self.end_headers(); self.wfile.write(payload); return
            self.send_error(404); return
        super().do_GET()
    def end_headers(self):''')
p.write_text(s)
p=Path('outputs/Typefolio/app.js');s=p.read_text();old="if(!window.queryLocalFonts){message('To browse all installed fonts, open this app in desktop Chrome or Edge. You can also import font files here.');return}";new="""if(!window.queryLocalFonts){await connectMacFonts();return}""";assert old in s;s=s.replace(old,new)
s+='''
async function connectMacFonts(){
  const button=$('#connect');button.disabled=true;message('Reading installed Mac fonts… This can take a minute on the first connection.');
  try{
    const response=await fetch('/api/local-fonts');if(!response.ok)throw Error();const faces=await response.json();const map=new Map();const rules=[];
    for(const face of faces){
      if(!map.has(face.family))map.set(face.family,{family:face.family,alias:'MacLocal'+map.size,category:infer(face.family),source:'local',weights:[],variable:false});
      const f=map.get(face.family),weight=weightOf(face.style);if(!f.weights.includes(weight))f.weights.push(weight);
      const italic=/italic|oblique/i.test(face.style);const sources=['local('+JSON.stringify(face.postscriptName)+')','local('+JSON.stringify(face.fullName)+')'];
      if(['.ttf','.otf','.woff','.woff2'].includes(face.extension))sources.push('url('+JSON.stringify(face.file)+')');
      rules.push('@font-face{font-family:'+JSON.stringify(f.alias)+';src:'+sources.join(',')+';font-weight:'+weight+';font-style:'+(italic?'italic':'normal')+';font-display:swap;}');
    }
    let style=document.querySelector('#mac-local-faces');if(!style){style=document.createElement('style');style.id='mac-local-faces';document.head.append(style)}style.textContent=rules.join('\\n');
    localFonts=[...map.values()].map(f=>({...f,weights:f.weights.sort((a,b)=>a-b)})).sort((a,b)=>a.family.localeCompare(b.family));document.querySelector('[data-source="local"]').click();message('Connected '+localFonts.length+' installed Mac font families.');
  }catch{message('Could not connect to the Mac font service. Restart Typefolio with Launch Typefolio.command, then try again.');}
  finally{button.disabled=false}
}
'''
p.write_text(s)
p=Path('outputs/Typefolio/README.md');s=p.read_text().replace('Click **Connect local fonts** in desktop Chrome or Edge and grant font access. Other browsers can use **Import fonts**.','Click **Connect local fonts**. Safari uses the local Mac launcher to read installed fonts; the first scan can take a minute. Chrome and Edge use their browser font permission. Other browsers on this Mac can also use the local launcher fallback.');p.write_text(s)
compile(Path('outputs/Typefolio/serve.py').read_text(),'serve.py','exec')
