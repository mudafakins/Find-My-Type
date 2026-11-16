using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text.Json;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace FindMyType;

/// <summary>
/// The app window: hosts the shared UI (web/) in WebView2 and provides the same bridges
/// as the Mac app — window.nativeFontCatalog, nativeDownload, nativeSetTheme, nativeCommand.
/// </summary>
internal sealed class MainForm : Form
{
    private const string AppHost = "app.findmytype.local";
    private static readonly Color LightBackground = Color.FromArgb(244, 244, 244);
    private static readonly Color DarkBackground = Color.FromArgb(20, 20, 20);

    private readonly WebView2 web = new() { Dock = DockStyle.Fill };
    private readonly FontCatalog fonts = new();
    private readonly Updater updater;
    private readonly Queue<(byte[] Data, string Name)> exports = new();
    private CoreWebView2Environment? environment;
    private bool saving;
    private bool checkedForUpdates;

    private static string AppData(string file, bool roaming = false)
    {
        var root = Environment.GetFolderPath(roaming ? Environment.SpecialFolder.ApplicationData : Environment.SpecialFolder.LocalApplicationData);
        var dir = Path.Combine(root, "FindMyType");
        Directory.CreateDirectory(dir);
        return Path.Combine(dir, file);
    }

    // Same API the Mac app injects (see native/FindMyType.swift), over WebView2 messaging.
    private const string BridgeScript = """
        window.appPlatform = 'windows';
        (() => {
          const pending = new Map();
          let next = 0;
          const send = (message) => window.chrome.webview.postMessage(message);
          window.chrome.webview.addEventListener('message', (event) => {
            const m = event.data;
            if (m.type === 'fonts') {
              const p = pending.get(m.id); pending.delete(m.id);
              if (p) m.error ? p.reject(new Error(m.error)) : p.resolve(m.faces);
            } else if (m.type === 'update') {
              window.onUpdateStatus && window.onUpdateStatus(m);
            } else if (m.type === 'command') {
              window.appCommand && window.appCommand(m.name);
            }
          });
          window.nativeFontCatalog = (fresh) => new Promise((resolve, reject) => {
            const id = ++next; pending.set(id, { resolve, reject });
            send({ type: 'loadFonts', id, fresh: !!fresh });
          });
          window.nativeDownload = (data, name) => send({ type: 'saveExport', data, name });
          window.nativeSetTheme = (dark) => send({ type: 'theme', dark: !!dark });
          window.nativeCommand = (name) => send({ type: 'command', name: String(name) });
        })();
        """;

    public MainForm()
    {
        Text = "Find My Type";
        Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
        MinimumSize = new Size(760, 560);
        Size = new Size(1280, 860);
        StartPosition = FormStartPosition.CenterScreen;
        BackColor = LightBackground;
        web.DefaultBackgroundColor = LightBackground; // no white flash before the page draws
        Controls.Add(web);
        RestoreWindowBounds();

        updater = new Updater(status => Post("update", status), () => BeginInvoke(new Action(Close)));
        Load += async (_, _) => await InitializeWebViewAsync();
        FormClosing += (_, _) => SaveWindowBounds();
    }

    private async Task InitializeWebViewAsync()
    {
        try
        {
            environment = await CoreWebView2Environment.CreateAsync(null, AppData("WebView2"));
            await web.EnsureCoreWebView2Async(environment);
        }
        catch (WebView2RuntimeNotFoundException)
        {
            MessageBox.Show(this,
                "Find My Type needs the Microsoft Edge WebView2 Runtime, which is part of Windows 10 and 11.\n\nInstall it from microsoft.com/edge/webview2, then open Find My Type again.",
                "WebView2 is missing", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            Close();
            return;
        }

        var core = web.CoreWebView2;
        var settings = core.Settings;
#if !DEBUG
        settings.AreDevToolsEnabled = false;
#endif
        settings.IsZoomControlEnabled = false;
        settings.IsPinchZoomEnabled = false;
        settings.IsStatusBarEnabled = false;
        settings.IsSwipeNavigationEnabled = false;
        settings.AreBrowserAcceleratorKeysEnabled = false; // Ctrl+R, Ctrl+F, F5… go to the app's own shortcuts

        core.SetVirtualHostNameToFolderMapping(AppHost, Path.Combine(AppContext.BaseDirectory, "web"), CoreWebView2HostResourceAccessKind.Allow);
        core.AddWebResourceRequestedFilter($"https://{FontCatalog.FontHost}/*", CoreWebView2WebResourceContext.All);
        core.WebResourceRequested += ServeFontFile;
        core.WebMessageReceived += OnWebMessage;

        // Stay on the app page; open web links in the default browser.
        core.NavigationStarting += (_, e) =>
        {
            if (e.Uri.StartsWith($"https://{AppHost}/", StringComparison.OrdinalIgnoreCase)) return;
            e.Cancel = true;
            OpenExternal(e.Uri);
        };
        core.NewWindowRequested += (_, e) => { e.Handled = true; OpenExternal(e.Uri); };
        core.NavigationCompleted += async (_, _) =>
        {
            if (checkedForUpdates) return;
            checkedForUpdates = true;
            await Task.Delay(4000);
            await updater.CheckAsync(userInitiated: false);
        };

        await core.AddScriptToExecuteOnDocumentCreatedAsync(BridgeScript);
        core.Navigate($"https://{AppHost}/index.html");
    }

    /// <summary>Installed font files, by token URL, so previews use the exact file.</summary>
    private void ServeFontFile(object? sender, CoreWebView2WebResourceRequestedEventArgs e)
    {
        var token = new Uri(e.Request.Uri).AbsolutePath.Trim('/');
        var path = fonts.PathForToken(token);
        if (path == null || environment == null)
        {
            e.Response = environment?.CreateWebResourceResponse(null, 404, "Not Found", "");
            return;
        }
        try
        {
            var bytes = File.ReadAllBytes(path);
            e.Response = environment.CreateWebResourceResponse(new MemoryStream(bytes), 200, "OK",
                "Content-Type: application/octet-stream\r\nAccess-Control-Allow-Origin: *");
        }
        catch
        {
            e.Response = environment.CreateWebResourceResponse(null, 404, "Not Found", "");
        }
    }

    private void OnWebMessage(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        using var doc = JsonDocument.Parse(e.WebMessageAsJson);
        var message = doc.RootElement;
        switch (message.GetProperty("type").GetString())
        {
            case "loadFonts":
                _ = SendFontsAsync(message.GetProperty("id").GetInt32(), message.GetProperty("fresh").GetBoolean());
                break;
            case "saveExport":
                var data = message.GetProperty("data").GetString() ?? "";
                var comma = data.IndexOf(',');
                exports.Enqueue((Convert.FromBase64String(data[(comma + 1)..]), message.GetProperty("name").GetString() ?? "Find My Type export"));
                SaveNextExport();
                break;
            case "theme":
                ApplyTheme(message.GetProperty("dark").GetBoolean());
                break;
            case "command":
                switch (message.GetProperty("name").GetString())
                {
                    case "check-updates": _ = updater.CheckAsync(userInitiated: true); break;
                    case "install-update": _ = updater.InstallAsync(); break;
                    case "about": ShowAbout(); break;
                }
                break;
        }
    }

    private async Task SendFontsAsync(int id, bool fresh)
    {
        try
        {
            var faces = await Task.Run(() => fonts.Get(fresh));
            web.CoreWebView2.PostWebMessageAsJson($"{{\"type\":\"fonts\",\"id\":{id},\"faces\":{faces}}}");
        }
        catch
        {
            web.CoreWebView2.PostWebMessageAsJson($"{{\"type\":\"fonts\",\"id\":{id},\"error\":\"Could not read fonts\"}}");
        }
    }

    /// <summary>Send { type, ...payload } to the page (from any thread).</summary>
    private void Post(string type, Dictionary<string, object?> payload)
    {
        if (InvokeRequired) { BeginInvoke(new Action(() => Post(type, payload))); return; }
        if (web.CoreWebView2 == null) return;
        payload["type"] = type;
        web.CoreWebView2.PostWebMessageAsJson(JsonSerializer.Serialize(payload));
    }

    /// <summary>Show save dialogs one at a time (PNG sheets + details can arrive together).</summary>
    private void SaveNextExport()
    {
        if (saving) return;
        saving = true;
        try
        {
            while (exports.Count > 0)
            {
                var (data, name) = exports.Dequeue();
                var extension = Path.GetExtension(name).ToLowerInvariant();
                using var dialog = new SaveFileDialog
                {
                    FileName = name,
                    Filter = extension switch
                    {
                        ".pdf" => "PDF document (*.pdf)|*.pdf",
                        ".png" => "PNG image (*.png)|*.png",
                        ".txt" => "Text file (*.txt)|*.txt",
                        _ => "All files (*.*)|*.*",
                    },
                    OverwritePrompt = true,
                };
                if (dialog.ShowDialog(this) != DialogResult.OK) continue;
                try { File.WriteAllBytes(dialog.FileName, data); }
                catch (Exception error)
                {
                    MessageBox.Show(this, error.Message, "Couldn’t save the export", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                }
            }
        }
        finally { saving = false; }
    }

    // ---------------------------------------------------------------- window chrome

    [DllImport("dwmapi.dll")]
    private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attribute, ref int value, int size);

    /// <summary>Dark/light title bar to match the in-app theme (Windows 10 20H1+ / 11).</summary>
    private void ApplyTheme(bool dark)
    {
        var value = dark ? 1 : 0;
        DwmSetWindowAttribute(Handle, 20 /* DWMWA_USE_IMMERSIVE_DARK_MODE */, ref value, sizeof(int));
        BackColor = dark ? DarkBackground : LightBackground;
        web.DefaultBackgroundColor = BackColor;
    }

    private void ShowAbout() =>
        MessageBox.Show(this, $"Find My Type {Updater.CurrentVersion}\n\nPreview your company name in every font you have.",
            "About Find My Type", MessageBoxButtons.OK, MessageBoxIcon.Information);

    private static void OpenExternal(string uri)
    {
        if (uri.StartsWith("https://", StringComparison.OrdinalIgnoreCase) || uri.StartsWith("http://", StringComparison.OrdinalIgnoreCase))
            Process.Start(new ProcessStartInfo(uri) { UseShellExecute = true });
    }

    private sealed record WindowBounds(int X, int Y, int Width, int Height, bool Maximized);

    private void RestoreWindowBounds()
    {
        try
        {
            var saved = JsonSerializer.Deserialize<WindowBounds>(File.ReadAllText(AppData("window.json", roaming: true)));
            if (saved == null) return;
            var rect = new Rectangle(saved.X, saved.Y, saved.Width, saved.Height);
            if (!Screen.AllScreens.Any(s => s.WorkingArea.IntersectsWith(rect))) return; // monitor gone
            StartPosition = FormStartPosition.Manual;
            Bounds = rect;
            if (saved.Maximized) WindowState = FormWindowState.Maximized;
        }
        catch { /* first launch or unreadable: use defaults */ }
    }

    private void SaveWindowBounds()
    {
        try
        {
            var bounds = WindowState == FormWindowState.Normal ? Bounds : RestoreBounds;
            var data = new WindowBounds(bounds.X, bounds.Y, bounds.Width, bounds.Height, WindowState == FormWindowState.Maximized);
            File.WriteAllText(AppData("window.json", roaming: true), JsonSerializer.Serialize(data));
        }
        catch { /* best effort */ }
    }
}
