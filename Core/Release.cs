using System.Diagnostics;
using System.IO.Compression;
using System.Text;
using System.Text.RegularExpressions;

namespace VirtualCompany.Core;

/// The package handed to the client: a release build of the app with its own .NET runtime (copied from this machine,
/// so nothing has to be installed or downloaded), a start script that opens the browser, the handover PDF,
/// asset licences and a short read-me. Extract, double-click, done.
public class ReleasePackager
{
    private readonly ProjectStore _store;
    private readonly AppWorkspace _app;
    private readonly AgentRegistry _reg;
    private readonly Handover _handover;
    private readonly ILogger<ReleasePackager> _log;
    private readonly SemaphoreSlim _one = new(1, 1);   // one package build at a time (dotnet publish is heavy)

    public ReleasePackager(ProjectStore store, AppWorkspace app, AgentRegistry reg, Handover handover, ILogger<ReleasePackager> log)
    {
        _store = store; _app = app; _reg = reg; _handover = handover; _log = log;
    }

    public const int ClientPort = 5050;
    private bool Id => _reg.Config.Defaults.Language == "id";
    private string L(string en, string id) => Id ? id : en;

    public string Dir(Project p) => Path.Combine(_store.AppDir(p), "..", "release");

    /// The newest package of the project, if one was built.
    public FileInfo? Latest(Project p)
    {
        var d = new DirectoryInfo(Dir(p));
        return d.Exists ? d.GetFiles("*.zip").OrderByDescending(f => f.LastWriteTimeUtc).FirstOrDefault() : null;
    }

    public static string Slug(string s, int max = 40)
    {
        var t = Regex.Replace(s, @"[^A-Za-z0-9]+", "-").Trim('-');
        return t.Length > max ? t[..max].TrimEnd('-') : t;
    }

    public async Task<FileInfo> BuildAsync(Project p, string handoverUrl, CancellationToken ct)
    {
        if (!_app.Exists(p)) throw new InvalidOperationException(L("This project has no app to package.", "Proyek ini belum punya aplikasi untuk dikemas."));
        if (!await _one.WaitAsync(0, ct)) throw new InvalidOperationException(L("A package is already being built; try again in a minute.", "Paket lain sedang dibuat; coba lagi sebentar lagi."));
        var root = Path.GetFullPath(Dir(p));
        var stage = Path.Combine(root, "stage");
        try
        {
            if (Directory.Exists(stage)) Directory.Delete(stage, recursive: true);
            var pkgName = Slug(p.Title) is { Length: > 0 } s ? s : p.Id;
            var pkg = Path.Combine(stage, pkgName);
            Directory.CreateDirectory(pkg);

            // 1. Release build of the app (packages are already restored: no download).
            _app.KillOrphans(p);
            var appOut = Path.Combine(pkg, "app");
            var pub = await RunAsync(AppWorkspace.Dotnet, ["publish", "App.csproj", "-c", "Release", "-o", appOut, "--no-restore", "-nologo", "-v", "q", "-clp:ErrorsOnly"], _app.Dir(p), ct);
            if (!pub.Ok) throw new InvalidOperationException(L("The release build failed:\n", "Build rilis gagal:\n") + AppWorkspace.Tail(pub.Output, 20));
            foreach (var junk in Directory.EnumerateFiles(appOut, "*.db*", SearchOption.TopDirectoryOnly)) File.Delete(junk);   // the client starts with a fresh database
            var qa = Path.Combine(appOut, ".qa"); if (Directory.Exists(qa)) Directory.Delete(qa, true);

            // 2. A private .NET runtime, copied from the one this server runs on (MIT-licensed, redistributable).
            var rtVersion = CopyRuntime(Path.Combine(pkg, "runtime"));

            // 3. Start script, read-me, licences, handover PDF.
            var start = L("Start.bat", "Mulai.bat");
            File.WriteAllText(Path.Combine(pkg, start), StartScript(p), new UTF8Encoding(false));
            File.WriteAllText(Path.Combine(pkg, L("README.txt", "BACA-SAYA.txt")), ReadMe(p, start, rtVersion), new UTF8Encoding(false));
            foreach (var f in new[] { "ASSETS.md", "LICENSE", "LICENSE.md", "LICENSE.txt", "CREDITS.md", "README.md" })
            {
                var src = Path.Combine(_app.Dir(p), f);
                if (File.Exists(src)) File.Copy(src, Path.Combine(pkg, f == "README.md" ? "APP-README.md" : f), overwrite: true);
            }
            if (_handover.Document(p) != null)
            {
                try
                {
                    var pdf = await Handover.PdfAsync(handoverUrl, ct);
                    await File.WriteAllBytesAsync(Path.Combine(pkg, L("Handover - ", "Serah terima - ") + pkgName + ".pdf"), pdf, ct);
                }
                catch (InvalidOperationException ex) { _log.LogWarning("Handover PDF not added to the package: {Error}", ex.Message); }
            }

            // 4. Zip it.
            var zip = Path.Combine(root, $"{p.Id}-{pkgName}-{DateTime.Now:yyyyMMdd-HHmm}.zip");
            foreach (var old in Directory.EnumerateFiles(root, "*.zip")) File.Delete(old);   // keep only the newest package
            ZipFile.CreateFromDirectory(stage, zip, CompressionLevel.Optimal, includeBaseDirectory: false);
            return new FileInfo(zip);
        }
        finally
        {
            try { if (Directory.Exists(stage)) Directory.Delete(stage, recursive: true); } catch (IOException) { } catch (UnauthorizedAccessException) { }
            _one.Release();
        }
    }

    /// dotnet.exe + host/fxr + the .NET and ASP.NET Core shared frameworks of the version this server runs on.
    private static string CopyRuntime(string dest)
    {
        var dotnetRoot = Path.GetDirectoryName(AppWorkspace.Dotnet) is { Length: > 0 } d && File.Exists(Path.Combine(d, "dotnet.exe")) ? d
            : throw new InvalidOperationException("No .NET installation found to copy the runtime from.");
        var version = Environment.Version.ToString(3);   // e.g. 9.0.10, the runtime this server itself uses
        string Need(string rel) => Directory.Exists(Path.Combine(dotnetRoot, rel)) ? rel : throw new InvalidOperationException($"Missing {rel} in {dotnetRoot}.");
        var parts = new[] { Need(Path.Combine("host", "fxr", version)), Need(Path.Combine("shared", "Microsoft.NETCore.App", version)), Need(Path.Combine("shared", "Microsoft.AspNetCore.App", version)) };
        Directory.CreateDirectory(dest);
        foreach (var f in new[] { "dotnet.exe", "LICENSE.txt", "ThirdPartyNotices.txt" })
            if (File.Exists(Path.Combine(dotnetRoot, f))) File.Copy(Path.Combine(dotnetRoot, f), Path.Combine(dest, f), overwrite: true);
        foreach (var rel in parts) CopyDir(Path.Combine(dotnetRoot, rel), Path.Combine(dest, rel));
        return version;
    }

    private static void CopyDir(string from, string to)
    {
        Directory.CreateDirectory(to);
        foreach (var f in Directory.EnumerateFiles(from)) File.Copy(f, Path.Combine(to, Path.GetFileName(f)), overwrite: true);
        foreach (var sub in Directory.EnumerateDirectories(from)) CopyDir(sub, Path.Combine(to, Path.GetFileName(sub)));
    }

    private string StartScript(Project p) =>
        "@echo off\r\n" +
        $"title {Regex.Replace(p.Title, @"[&|<>^%]", "")}\r\n" +
        "cd /d \"%~dp0app\"\r\n" +
        $"echo {L("Starting the application...", "Menjalankan aplikasi...")}\r\n" +
        $"echo {L($"It opens in your browser at http://localhost:{ClientPort}", $"Aplikasi terbuka di browser pada http://localhost:{ClientPort}")}\r\n" +
        $"echo {L("Keep this window open while you use it; close it to stop the application.", "Biarkan jendela ini terbuka selama dipakai; tutup untuk menghentikan aplikasi.")}\r\n" +
        "echo.\r\n" +
        $"start \"\" /min cmd /c \"timeout /t 4 /nobreak >nul & start http://localhost:{ClientPort}\"\r\n" +
        $"\"%~dp0runtime\\dotnet.exe\" App.dll --urls http://localhost:{ClientPort} --environment Production\r\n" +
        "if errorlevel 1 (\r\n" +
        $"  echo.\r\n  echo {L($"The application stopped with an error. If port {ClientPort} is in use, close the other program and try again.", $"Aplikasi berhenti karena error. Jika port {ClientPort} sedang dipakai, tutup program lain itu lalu coba lagi.")}\r\n" +
        "  pause\r\n)\r\n";

    private string ReadMe(Project p, string start, string rt) => L(
        $"""
        {p.Title}
        {new string('=', Math.Min(60, p.Title.Length))}
        Delivered by {_reg.Config.Company}. Project {p.Id}, package of {DateTime.Now:yyyy-MM-dd}.

        HOW TO RUN (Windows 10/11, 64-bit; nothing to install)
        1. Extract this zip to a folder, for example C:\Apps\{Slug(p.Title, 30)}.
        2. Double-click {start}.
        3. Your browser opens http://localhost:{ClientPort}. Keep the black window open while you use the application;
           close it to stop the application.

        WHAT IS INSIDE
        - {start}: starts the application and opens the browser.
        - app\: the application (release build). Its data (database) is created here on first start.
        - runtime\: a private copy of Microsoft .NET {rt} (MIT licence, see runtime\LICENSE.txt); it does not change your PC.
        - The handover PDF: project summary and user handbook.
        - ASSETS.md / licence files, if the application uses third-party assets.

        BACKUP: copy the app\ folder (it holds the database) while the application is closed.
        UNINSTALL: close the application and delete the folder.
        SUPPORT: contact {_reg.Config.Company} with the project number {p.Id}.
        """,
        $"""
        {p.Title}
        {new string('=', Math.Min(60, p.Title.Length))}
        Diserahkan oleh {_reg.Config.Company}. Proyek {p.Id}, paket tanggal {DateTime.Now:yyyy-MM-dd}.

        CARA MENJALANKAN (Windows 10/11, 64-bit; tidak perlu instal apa pun)
        1. Ekstrak zip ini ke sebuah folder, misalnya C:\Aplikasi\{Slug(p.Title, 30)}.
        2. Klik dua kali {start}.
        3. Browser akan membuka http://localhost:{ClientPort}. Biarkan jendela hitam tetap terbuka selama aplikasi dipakai;
           tutup jendela itu untuk menghentikan aplikasi.

        ISI PAKET
        - {start}: menjalankan aplikasi dan membuka browser.
        - app\: aplikasinya (build rilis). Datanya (database) dibuat di sini saat pertama dijalankan.
        - runtime\: salinan pribadi Microsoft .NET {rt} (lisensi MIT, lihat runtime\LICENSE.txt); tidak mengubah PC Anda.
        - PDF serah terima: ringkasan proyek dan buku panduan pengguna.
        - ASSETS.md / file lisensi, jika aplikasi memakai aset pihak ketiga.

        CADANGAN: salin folder app\ (berisi database) saat aplikasi ditutup.
        MENGHAPUS: tutup aplikasi lalu hapus foldernya.
        DUKUNGAN: hubungi {_reg.Config.Company} dengan nomor proyek {p.Id}.
        """);

    private static async Task<(bool Ok, string Output)> RunAsync(string file, string[] args, string cwd, CancellationToken ct)
    {
        var psi = new ProcessStartInfo(file) { WorkingDirectory = cwd, UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true };
        foreach (var a in args) psi.ArgumentList.Add(a);
        psi.Environment["DOTNET_CLI_TELEMETRY_OPTOUT"] = "1"; psi.Environment["DOTNET_NOLOGO"] = "1";
        using var proc = Process.Start(psi) ?? throw new InvalidOperationException($"Could not start {file}.");
        var o = proc.StandardOutput.ReadToEndAsync(ct); var e = proc.StandardError.ReadToEndAsync(ct);
        using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct); cts.CancelAfter(TimeSpan.FromMinutes(6));
        try { await proc.WaitForExitAsync(cts.Token); }
        catch (OperationCanceledException) { try { proc.Kill(true); } catch (InvalidOperationException) { } return (false, "Timed out."); }
        return (proc.ExitCode == 0, await o + await e);
    }
}
