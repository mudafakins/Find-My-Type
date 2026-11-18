using System.Diagnostics;
using System.IO.Compression;
using System.Reflection;
using System.Text.Json;

namespace FindMyType;

/// <summary>
/// Updates from the GitHub repository baked in at build time (UpdateRepo).
///
/// Windows can't replace a running program, so updates are "staged": the new files are
/// downloaded and unpacked into %LOCALAPPDATA%\FindMyType\pending-update, then copied over
/// the app folder by a small script once the app has closed — either when the user quits
/// (automatic updates) or right away with a relaunch ("Update now" / "Restart now").
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
    private bool applying;

    public Updater(Action<Dictionary<string, object?>> report, Action quit)
    {
        this.report = report;
        this.quit = quit;
        DiscardStaleStage();
    }

    // ---------------------------------------------------------------- settings & paths

    private static string DataDir
    {
        get
        {
            var dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "FindMyType");
            Directory.CreateDirectory(dir);
            return dir;
        }
    }

    private static string StageDir => Path.Combine(DataDir, "pending-update");
    private static string StagedFiles => Path.Combine(StageDir, "files");
    private static string StagedVersionFile => Path.Combine(StageDir, "version.txt");
    private static string LastCheckFile => Path.Combine(DataDir, "last-update-check.txt");
    private static string SettingsFile => Path.Combine(DataDir, "settings.json");

    private sealed record Settings(bool InstallUpdatesAutomatically = true);

    /// <summary>"Install updates automatically" (on by default).</summary>
    public bool AutoInstall
    {
        get
        {
            try { return JsonSerializer.Deserialize<Settings>(File.ReadAllText(SettingsFile))?.InstallUpdatesAutomatically ?? true; }
            catch { return true; }
        }
        set
        {
            try { File.WriteAllText(SettingsFile, JsonSerializer.Serialize(new Settings(value))); } catch { /* best effort */ }
        }
    }

    /// <summary>Version waiting in the staging folder, if any.</summary>
    public string? StagedVersion =>
        File.Exists(StagedVersionFile) && File.Exists(Path.Combine(StagedFiles, "FindMyType.exe"))
            ? File.ReadAllText(StagedVersionFile).Trim() : null;

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

    private static HttpClient CreateClient()
    {
        var client = new HttpClient { Timeout = TimeSpan.FromMinutes(5) };
        client.DefaultRequestHeaders.UserAgent.ParseAdd("FindMyType-Updater");
        client.DefaultRequestHeaders.Accept.ParseAdd("application/vnd.github+json");
        return client;
    }

    /// <summary>A staged update that's not newer than this version (e.g. already applied) is removed.</summary>
    private void DiscardStaleStage()
    {
        try
        {
            var staged = StagedVersion;
            if (Directory.Exists(StageDir) && (staged == null || !IsNewer(staged, CurrentVersion)))
                Directory.Delete(StageDir, recursive: true);
        }
        catch { /* best effort */ }
    }

    // ---------------------------------------------------------------- checking

    /// <summary>userInitiated: report "checking"/"up to date"/errors. Automatic checks are quiet and daily.</summary>
    public async Task CheckAsync(bool userInitiated)
    {
        if (busy) return;
        if (StagedVersion is { } staged)
        {
            report(new() { ["state"] = "ready", ["version"] = staged });
            return;
        }
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
            File.WriteAllText(LastCheckFile, DateTime.UtcNow.ToString("o"));

            var root = doc.RootElement;
            var version = root.GetProperty("tag_name").GetString()!.TrimStart('v', 'V');
            var asset = root.GetProperty("assets").EnumerateArray()
                .FirstOrDefault(a => a.GetProperty("name").GetString() == AssetName);
            if (asset.ValueKind == JsonValueKind.Undefined) throw new InvalidDataException("No Windows download in the latest release.");

            if (IsNewer(version, CurrentVersion))
            {
                latest = (version, asset.GetProperty("browser_download_url").GetString()!);
                if (AutoInstall) await InstallAsync(restartNow: false, quiet: !userInitiated);
                else report(new() { ["state"] = "available", ["version"] = version, ["current"] = CurrentVersion });
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

    /// <summary>An update was found earlier (while automatic install was off): stage it quietly now.</summary>
    public Task InstallWaitingUpdateAsync() =>
        latest != null && StagedVersion == null ? InstallAsync(restartNow: false, quiet: true) : Task.CompletedTask;

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

    // ---------------------------------------------------------------- installing

    /// <summary>
    /// Download and stage the latest version.
    /// restartNow: apply immediately and relaunch ("Update now"). Otherwise it's applied when the app closes.
    /// quiet: no progress messages (automatic background install) — only "ready" or errors.
    /// </summary>
    public async Task InstallAsync(bool restartNow = true, bool quiet = false)
    {
        if (busy) return;
        if (StagedVersion != null)
        {
            if (restartNow) ApplyStagedUpdate(relaunch: true);
            return;
        }
        if (latest is not { } update) return;
        busy = true;
        void Say(Dictionary<string, object?> status) { if (!quiet) report(status); }
        try
        {
            if (!CanWrite(AppFolder))
                throw new UnauthorizedAccessException("Find My Type can’t update itself in this folder. Move it to a folder you own (for example Documents or AppData), then try again.");

            if (Directory.Exists(StageDir)) Directory.Delete(StageDir, recursive: true);
            Directory.CreateDirectory(StageDir);
            var zip = Path.Combine(StageDir, "update.zip");

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
                    if (percent != lastPercent) { lastPercent = percent; Say(new() { ["state"] = "downloading", ["progress"] = percent }); }
                }
            }

            Say(new() { ["state"] = "installing" });
            ZipFile.ExtractToDirectory(zip, StagedFiles);
            File.Delete(zip);
            if (!File.Exists(Path.Combine(StagedFiles, "FindMyType.exe")))
                throw new InvalidDataException("The downloaded update isn’t Find My Type. Nothing was changed.");
            File.WriteAllText(StagedVersionFile, update.Version);
            busy = false;

            if (restartNow) ApplyStagedUpdate(relaunch: true);
            else report(new() { ["state"] = "ready", ["version"] = update.Version });
        }
        catch (Exception error)
        {
            busy = false;
            try { if (Directory.Exists(StageDir)) Directory.Delete(StageDir, recursive: true); } catch { /* ignore */ }
            var text = error is UnauthorizedAccessException or InvalidDataException ? error.Message : "The update didn’t finish. Try again later.";
            report(new() { ["state"] = "error", ["message"] = text });
        }
    }

    private static string AppFolder => AppContext.BaseDirectory.TrimEnd('\\');

    /// <summary>
    /// Copy the staged files over the app folder once this process exits.
    /// relaunch: start the updated app afterwards and close this one now.
    /// Called with relaunch=false when the app is closing normally.
    /// </summary>
    public void ApplyStagedUpdate(bool relaunch)
    {
        if (applying || StagedVersion == null) return;
        applying = true;
        var script = Path.Combine(DataDir, "apply-update.ps1");
        File.WriteAllText(script, """
            param([int]$ProcessId, [string]$Source, [string]$Target, [string]$Stage, [string]$Relaunch)
            Wait-Process -Id $ProcessId -ErrorAction SilentlyContinue
            Start-Sleep -Milliseconds 400
            Copy-Item -Path (Join-Path $Source '*') -Destination $Target -Recurse -Force
            Remove-Item -Path $Stage -Recurse -Force -ErrorAction SilentlyContinue
            if ($Relaunch -eq 'yes') { Start-Process -FilePath (Join-Path $Target 'FindMyType.exe') }
            """);
        Process.Start(new ProcessStartInfo
        {
            FileName = "powershell.exe",
            ArgumentList =
            {
                "-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File", script,
                "-ProcessId", Environment.ProcessId.ToString(), "-Source", StagedFiles, "-Target", AppFolder,
                "-Stage", StageDir, "-Relaunch", relaunch ? "yes" : "no",
            },
            CreateNoWindow = true,
            UseShellExecute = false,
        });
        if (relaunch)
        {
            report(new() { ["state"] = "installing" });
            quit();
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
