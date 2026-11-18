# Find My Type

Preview your company name in every Google Font and every font installed on your computer.
Shortlist favourites, compare them side by side, and export PNG sheets or a PDF.

Available for **macOS** (12 Monterey or later, Apple Silicon and Intel) and **Windows** (10 and 11).

## Download

Get the latest version from the [Releases](../../releases/latest) page:

- **Mac:** `Find-My-Type-Mac.zip` → unzip → drag **Find My Type** into Applications.
  The first time, right-click the app and choose **Open** (it isn't notarised by Apple yet).
- **Windows:** `Find-My-Type-Windows.zip` → extract to a folder you own (for example
  `Documents\Find My Type`) → run `FindMyType.exe`. If SmartScreen appears, choose
  **More info → Run anyway**.

Both apps check for updates once a day and from **Check for Updates…**
(Mac: app menu · Windows: the ⋯ menu). With **Install Updates Automatically** on (the default),
new versions download and install in the background and are used the next time the app opens —
or straight away with **Restart now**. Turn it off to be asked before each update.

## Project layout

```
app/
  web/        The interface, shared by both apps (HTML/CSS/JS)
  native/     macOS app (Swift, WKWebView)
  windows/    Windows app (C#, WinForms + WebView2)
  build.sh    Build the Mac app            → app/dist/Find My Type.app
  release.sh  Publish a new version        → GitHub builds both apps and makes a release
  VERSION     The current version number
.github/workflows/build.yml   Builds both apps on every push; publishes releases for tags
```

## Building

- **Mac:** `app/build.sh --open` (needs Xcode command-line tools).
- **Windows:** on a Windows PC with the .NET 8 SDK:
  `dotnet publish app/windows/FindMyType.Windows.csproj -c Release -o publish`
  — or just push to GitHub and download the build from the Actions tab.

## Releasing an update

```
app/release.sh 2.2.0
```

This updates `app/VERSION`, tags `v2.2.0` and pushes. GitHub Actions builds the Mac and
Windows apps and publishes the release; installed apps offer the update.
See [GITHUB.md](GITHUB.md) for the one-time setup.
