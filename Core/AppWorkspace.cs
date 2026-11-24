using System.Collections.Concurrent;
using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Text;

namespace VirtualCompany.Core;

/// The real application the engineering agents build: data/projects/{id}/app, an ASP.NET Core project.
/// Scaffolds it, builds it, and runs it so the owner can open and test it.
public class AppWorkspace : IDisposable
{
    private readonly ProjectStore _store;
    private readonly ILogger<AppWorkspace> _log;
    private readonly ConcurrentDictionary<string, Process> _running = new();

    public AppWorkspace(ProjectStore store, ILogger<AppWorkspace> log)
    {
        _store = store; _log = log;
    }

    public string Dir(Project p) => _store.AppDir(p);

    public bool Exists(Project p) => File.Exists(Path.Combine(Dir(p), "App.csproj"));

    /// A dotnet with an SDK. The "dotnet" on PATH may have none (this laptop: Program Files (x86)), and the server
    /// itself runs as VirtualCompany.exe, so look at the runtime this process is using: ...\dotnet\shared\Microsoft.NETCore.App\9.x\.
    public static string Dotnet { get; } = FindDotnet();

    private static string FindDotnet()
    {
        bool HasSdk(string exe) => File.Exists(exe) && Directory.Exists(Path.Combine(Path.GetDirectoryName(exe)!, "sdk"));
        var exeName = OperatingSystem.IsWindows() ? "dotnet.exe" : "dotnet";
        var candidates = new List<string?>
        {
            Environment.GetEnvironmentVariable("DOTNET_HOST_PATH"),
            Environment.ProcessPath,
            Path.Combine(Path.GetFullPath(Path.Combine(Path.GetDirectoryName(typeof(object).Assembly.Location)!, "..", "..", "..")), exeName),
            Environment.GetEnvironmentVariable("DOTNET_ROOT") is { } root ? Path.Combine(root, exeName) : null,
            OperatingSystem.IsWindows() ? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "dotnet", exeName) : null,
        };
        return candidates.FirstOrDefault(c => c != null && Path.GetFileName(c).Equals(exeName, StringComparison.OrdinalIgnoreCase) && HasSdk(c)) ?? "dotnet";
    }

    /// Creates the empty web project once, so every agent works in the same known structure.
    public async Task<(bool Ok, string Output)> EnsureScaffoldAsync(Project p, CancellationToken ct)
    {
        if (Exists(p)) return (true, "exists");
        var dir = Dir(p);
        Directory.CreateDirectory(dir);
        var r = await RunAsync(Dotnet, "new web -n App -o . --framework net9.0 --force", dir, TimeSpan.FromMinutes(3), ct);
        if (r.Ok)
        {
            File.WriteAllText(Path.Combine(dir, ".gitignore"), "bin/\nobj/\n*.db\n");
            File.WriteAllText(Path.Combine(dir, "README.md"), $"# {p.Title}\n\nBuilt by the Virtual Company agents.\n\nRun: `dotnet run` then open the URL it prints.\n");
        }
        return r;
    }

    public async Task<(bool Ok, string Output)> BuildAsync(Project p, CancellationToken ct)
    {
        if (!Exists(p)) return (false, "There is no App.csproj in the app folder yet.");
        // A running copy locks the DLLs; stop it before building.
        Stop(p);
        return await RunAsync(Dotnet, "build -nologo -v q -clp:ErrorsOnly", Dir(p), TimeSpan.FromMinutes(5), ct);
    }

    public bool IsRunning(Project p) => _running.TryGetValue(p.Id, out var proc) && !proc.HasExited;

    /// Builds and starts the app on a free port; returns its URL.
    public async Task<string> StartAsync(Project p, int preferredPort, CancellationToken ct)
    {
        Stop(p);
        var build = await BuildAsync(p, ct);
        if (!build.Ok) throw new InvalidOperationException("The app does not build:\n" + Tail(build.Output, 25));
        var port = FreePort(preferredPort);
        var url = $"http://localhost:{port}";
        var psi = new ProcessStartInfo(Dotnet, $"run --no-build --urls {url}")
        {
            WorkingDirectory = Dir(p), UseShellExecute = false, CreateNoWindow = true,
            RedirectStandardOutput = true, RedirectStandardError = true,
        };
        psi.Environment["ASPNETCORE_ENVIRONMENT"] = "Development";
        var proc = Process.Start(psi) ?? throw new InvalidOperationException("Could not start the app.");
        var log = new StringBuilder();
        proc.OutputDataReceived += (_, e) => { if (e.Data != null) lock (log) log.AppendLine(e.Data); };
        proc.ErrorDataReceived += (_, e) => { if (e.Data != null) lock (log) log.AppendLine(e.Data); };
        proc.BeginOutputReadLine(); proc.BeginErrorReadLine();
        _running[p.Id] = proc;

        using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(3) };
        for (var i = 0; i < 40; i++)
        {
            await Task.Delay(500, ct);
            if (proc.HasExited) throw new InvalidOperationException("The app stopped right after starting:\n" + Tail(log.ToString(), 25));
            try { await http.GetAsync(url, ct); p.AppUrl = url; return url; }
            catch (HttpRequestException) { }
            catch (TaskCanceledException) when (!ct.IsCancellationRequested) { }
        }
        Stop(p);
        throw new InvalidOperationException("The app did not answer within 20 seconds:\n" + Tail(log.ToString(), 25));
    }

    public void Stop(Project p)
    {
        if (_running.TryRemove(p.Id, out var proc))
        {
            try { if (!proc.HasExited) proc.Kill(entireProcessTree: true); } catch (InvalidOperationException) { }
        }
        p.AppUrl = null;
    }

    public static string Tail(string text, int lines) =>
        string.Join("\n", text.Split('\n').Select(l => l.TrimEnd()).Where(l => l.Length > 0).TakeLast(lines));

    private static int FreePort(int start)
    {
        for (var port = start; port < start + 50; port++)
        {
            try { var l = new TcpListener(IPAddress.Loopback, port); l.Start(); l.Stop(); return port; }
            catch (SocketException) { }
        }
        throw new InvalidOperationException($"No free port between {start} and {start + 49}.");
    }

    private static async Task<(bool Ok, string Output)> RunAsync(string file, string args, string cwd, TimeSpan timeout, CancellationToken ct)
    {
        var psi = new ProcessStartInfo(file, args)
        {
            WorkingDirectory = cwd, UseShellExecute = false, CreateNoWindow = true,
            RedirectStandardOutput = true, RedirectStandardError = true,
        };
        psi.Environment["DOTNET_CLI_TELEMETRY_OPTOUT"] = "1";
        psi.Environment["DOTNET_NOLOGO"] = "1";
        using var proc = Process.Start(psi) ?? throw new InvalidOperationException($"Could not start {file}.");
        var outTask = proc.StandardOutput.ReadToEndAsync(ct);
        var errTask = proc.StandardError.ReadToEndAsync(ct);
        using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        cts.CancelAfter(timeout);
        try { await proc.WaitForExitAsync(cts.Token); }
        catch (OperationCanceledException)
        {
            try { proc.Kill(entireProcessTree: true); } catch (InvalidOperationException) { }
            if (ct.IsCancellationRequested) throw;
            return (false, $"Timed out after {timeout.TotalMinutes:N0} minutes.");
        }
        var output = (await outTask) + (await errTask);
        return (proc.ExitCode == 0, output);
    }

    public void Dispose()
    {
        foreach (var proc in _running.Values)
            try { if (!proc.HasExited) proc.Kill(entireProcessTree: true); } catch (InvalidOperationException) { }
    }
}
