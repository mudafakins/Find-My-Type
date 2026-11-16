# Find My Type — source

```
app/
  web/          The UI (works in the Mac app and in any browser)
    index.html    markup
    styles.css    all styles
    app.js        all logic
    fonts.js      Google Fonts catalogue snapshot (1,950 families)
  native/       macOS wrapper
    FindMyType.swift, Info.plist, AppIcon.icns
  serve.py      run the UI in a browser: python3 serve.py
  build.sh      build dist/Find My Type.app (add --zip or --open)
```

Edit files in `web/`, then run `./build.sh --open` to try the Mac app.
The original MVP is preserved untouched in `../Source Code/` and in git tag `v0-mvp`.
