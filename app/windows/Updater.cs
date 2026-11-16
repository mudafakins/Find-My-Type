using System.Diagnostics;
using System.IO.Compression;
using System.Reflection;
using System.Text.Json;

namespace FindMyType;

/// <summary>
/// Checks the GitHub repository baked in at build time (UpdateRepo) for a newer release,
/// downloads Find-My-Type-Windows.zip, and swaps the new files in after the app exits.
/// Progress is reported to the page as { state, ... } (same shape as the Mac app).
/// </summary>
internal sealed class Updater
{
    private const string AssetName = "Find-My-Type-Windows.zip";
    private static readonly HttpClient Http = CreateClient();

    private readonly Action<Dictionary<string, object?>> report;
    private readonly Action quit;
    private (string Version, string Url)? latest;
    private bool busy;

    public Updater(Action<Dictionary<string, object?>> report, Action quit)
    {
        this.report = report;
        this.quit = quit;
    }

    public static string CurrentVersion
    {
        get
        {
            var v = Assembly.GetExecutingAssembly().GetName().Version ?? new Version(0, 0, 0);
            return $"{v.Major}.{v.Minor}.{Math.Max(0, v.Build)}";
        }
    }

    private static string? Repository =>
        Assembly.GetExecutingAssembly().GetCustomAttributes<AssemblyMetadataAttribute>()
            .FirstOrDefault(a => a.Key == "UpdateRepo")?.Value is { } repo && repo.Contains('/') ? repo.Trim() : null;

    private static string LastCheckFile =>
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "FindMyType", "last-update-check.txt");

    private static HttpClient CreateClient()
    {
        var client = new HttpClient { Timeout = TimeSpan.FromMinutes(5) };
        client.DefaultRequestHeaders.UserAgent.ParseAdd("FindMyType-Updater");
        client.DefaultRequestHeaders.Accept.ParseAdd("application/vnd.github+json");
        return client;
    }

    /// <summary>userInitiated: report "checking"/"up to date"/errors. Automatic checks are quiet and daily.</summary>
    public async Task CheckAsync(bool userInitiated)
    {
        if (busy) return;
        var repo = Repository;
        if (repo == null)
        {
            if (userInitiated) report(new() { ["state"] = "unconfigured" });
            return;
        }
        if (!userInitiated && File.Exists(LastCheckFile)
            && DateTime.TryParse(File.ReadAllText(LastCheckFile), out var last)
            && DateTime.UtcNow - last.ToUniversalTime() < TimeSpan.FromDays(1)) return;
        if (userInitiated) report(new() { ["state"] = "checking" });

        try
        {
            using var doc = JsonDocument.Parse(await Http.GetStringAsync($"https://api.github.com/repos/{repo}/releases/latest"));
            Directory.CreateDirectory(Path.GetDirectoryName(LastCheckFile)!);
            File.WriteAllText(LastCheckFile, DateTime.UtcNow.ToString("o"));

            var root = doc.RootElement;
            var version = root.GetProperty("tag_name").GetString()!.TrimStart('v', 'V');
            var asset = root.GetProperty("assets").EnumerateArray()
                .FirstOrDefault(a => a.GetProperty("name").GetString() == AssetName);
            if (asset.ValueKind == JsonValueKind.Undefined) throw new InvalidDataException("No Windows download in the latest release.");

            if (IsNewer(version, CurrentVersion))
            {
                latest = (version, asset.GetProperty("browser_download_url").GetString()!);
                report(new() { ["state"] = "available", ["version"] = version, ["current"] = CurrentVersion });
            }
            else if (userInitiated)
            {
                report(new() { ["state"] = "uptodate", ["current"] = CurrentVersion });
            }
        }
        catch
        {
            if (userInitiated) report(new() { ["state"] = "error", ["message"] = "Couldn’t reach the update server. Check your connection and try again." });
        }
    }

    public static bool IsNewer(string a, string b)
    {
        int[] Parse(string s) => s.Split('.').Select(p => int.TryParse(p, out var n) ? n : 0).ToArray();
        var x = Parse(a);
        var y = Parse(b);
        for (var i = 0; i < Math.Max(x.Length, y.Length); i++)
        {
            var l = i < x.Length ? x[i] : 0;
            var r = i < y.Length ? y[i] : 0;
            if (l != r) return l > r;
        }
        return false;
    }

    public async Task InstallAsync()
    {
        if (latest is not { } update || busy) return;
        busy = true;
        try
        {
            var installDir = AppContext.BaseDirectory.TrimEnd('\\');
            if (!CanWrite(installDir))
                throw new UnauthorizedAccessException("Find My Type can’t update itself in this folder. Move it to a folder you own (for example Documents or AppData), then try again.");

            var work = Path.Combine(Path.GetTempPath(), "FindMyTypeUpdate-" + Guid.NewGuid().ToString("N"));
            var zip = Path.Combine(work, "update.zip");
            var extracted = Path.Combine(work, "files");
            Directory.CreateDirectory(work);

            // Download with progress
            using (var response = await Http.GetAsync(update.Url, HttpCompletionOption.ResponseHeadersRead))
            {
                response.EnsureSuccessStatusCode();
                var total = response.Content.Headers.ContentLength ?? 0;
                await using var input = await response.Content.ReadAsStreamAsync();
                await using var output = File.Create(zip);
                var buffer = new byte[81920];
                long received = 0;
                var lastPercent = -1;
                int read;
                while ((read = await input.ReadAsync(buffer)) > 0)
                {
                    await output.WriteAsync(buffer.AsMemory(0, read));
                    received += read;
                    var percent = total > 0 ? (int)(received * 100 / total) : 0;
                    if (percent != lastPercent) { lastPercent = percent; report(new() { ["state"] = "downloading", ["progress"] = percent }); }
                }
            }

            report(new() { ["state"] = "installing" });
            ZipFile.ExtractToDirectory(zip, extracted);
            if (!File.Exists(Path.Combine(extracted, "FindMyType.exe")))
                throw new InvalidDataException("The downloaded update isn’t Find My Type. Nothing was changed.");

            // After this process exits: copy the new files over, relaunch, clean up.
            var script = Path.Combine(work, "apply-update.ps1");
            File.WriteAllText(script, """
                param([int]$ProcessId, [string]$Source, [string]$Target, [string]$Work)
                Wait-Process -Id $ProcessId -ErrorAction SilentlyContinue
                Start-Sleep -Milliseconds 400
                Copy-Item -Path (Join-Path $Source '*') -Destination $Target -Recurse -Force
                Start-Process -FilePath (Join-Path $Target 'FindMyType.exe')
                Remove-Item -Path $Work -Recurse -Force -ErrorAction SilentlyContinue
                """);
            Process.Start(new ProcessStartInfo
            {
                FileName = "powershell.exe",
                ArgumentList = { "-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File", script,
                                 "-ProcessId", Environment.ProcessId.ToString(), "-Source", extracted, "-Target", installDir, "-Work", work },
                CreateNoWindow = true,
                UseShellExecute = false,
            });
            quit();
        }
        catch (Exception error)
        {
            busy = false;
            var text = error is UnauthorizedAccessException or InvalidDataException ? error.Message : "The update didn’t finish. Try again later.";
            report(new() { ["state"] = "error", ["message"] = text });
        }
    }

    private static bool CanWrite(string dir)
    {
        try
        {
            var probe = Path.Combine(dir, ".update-check-" + Guid.NewGuid().ToString("N"));
            File.WriteAllText(probe, "");
            File.Delete(probe);
            return true;
        }
        catch { return false; }
    }
}
