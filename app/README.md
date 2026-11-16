# Find My Type — macOS app

Preview a company name in every Google Font and every font installed on your Mac,
shortlist favourites, compare them side by side, and export PNG sheets or a PDF.

```
app/
  web/          The app's interface (shown inside the Mac app's window)
    index.html    markup
    styles.css    all styles (design tokens at the top)
    app.js        all logic
    fonts.js      Google Fonts catalogue snapshot (1,950 families)
  native/       macOS app shell
    FindMyType.swift   window, font scanning (+ on-disk cache), save panels
    Info.plist, AppIcon.icns
  build.sh      builds dist/Find My Type.app (universal: Apple Silicon + Intel)
```

Build and run:

    ./build.sh --open      # build and launch
    ./build.sh --zip       # also create dist/Find My Type Mac.zip

Requires macOS 12+ and Xcode command-line tools (`swiftc`). The original MVP is
kept untouched in `../Source Code/` and in git tag `v0-mvp`.
