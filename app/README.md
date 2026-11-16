# app/

- `web/` — the interface shared by both apps
- `native/` — macOS shell (Swift): `build.sh` builds it
- `windows/` — Windows shell (C# + WebView2): built by GitHub Actions or `dotnet publish`
- `VERSION` — current version; `release.sh <version>` publishes a release

See the project [README](../README.md) and [GITHUB.md](../GITHUB.md).
