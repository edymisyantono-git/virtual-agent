using System.Diagnostics;
using System.Net;
using System.Text;
using System.Text.RegularExpressions;

namespace VirtualCompany.Core;

/// The client handover: the Technical Writer's document (project summary + user handbook) rendered as a
/// printable A4 page with a cover and the module status table, and printed to PDF with a local Edge/Chrome.
public class Handover
{
    private readonly ProjectStore _store;
    private readonly AgentRegistry _reg;

    public Handover(ProjectStore store, AgentRegistry reg) { _store = store; _reg = reg; }

    public const string WriterId = "tech_writer";

    /// The newest merged handover document of the project, if the Technical Writer has written one.
    public ArtifactRef? Document(Project p)
    {
        lock (p) return p.Artifacts.LastOrDefault(a => a.AgentId == WriterId && !a.Helper);
    }

    private string Lang => _reg.Config.Defaults.Language == "id" ? "id" : "en";
    private string L(string en, string id) => Lang == "id" ? id : en;

    // ---------- module status (from the agents' per-module reports) ----------

    public record ModuleRow(string Code, string Name, string State, string Text);

    public static List<ModuleRow> ModuleStatus(Project p)
    {
        List<VcEvent> evs; List<string> plan;
        lock (p) { evs = p.Events.Where(e => e.Type == "module").ToList(); plan = p.Plan?.Modules.ToList() ?? new(); }
        string S(VcEvent e, string k) => e.Data.TryGetValue(k, out var v) ? v?.ToString() ?? "" : "";
        var byCode = evs.GroupBy(e => S(e, "module")).ToDictionary(g => g.Key, g => g.ToList());
        var codes = plan.Count > 0 ? plan : byCode.Keys.ToList();
        return codes.Select(name =>
        {
            var code = Regex.Match(name, @"\bM\d{1,3}\b") is { Success: true } m ? m.Value : name.Split(' ')[0];
            var log = byCode.GetValueOrDefault(code) ?? new();
            var settled = log.LastOrDefault(e => S(e, "state") != "working") ?? log.LastOrDefault();
            var title = name.StartsWith(code) ? name[code.Length..].Trim() : name;
            return new ModuleRow(code, title.Length > 0 ? title : code, settled == null ? "todo" : S(settled, "state"), settled == null ? "" : S(settled, "text"));
        }).ToList();
    }

    /// Short facts the writer gets on top of the team's documents.
    public string FactsForWriter(Project p)
    {
        var sb = new StringBuilder("PROJECT FACTS FOR THE HANDOVER:\n");
        sb.AppendLine($"- Project: {p.Title} ({p.Id}), company: {_reg.Config.Company}, date: {DateTime.Now:yyyy-MM-dd}");
        foreach (var (k, v) in p.Brief) sb.AppendLine($"- Customer brief, {k}: {v}");
        if (p.AppUrl != null) sb.AppendLine($"- The delivered app runs locally at {p.AppUrl}");
        var mods = ModuleStatus(p);
        if (mods.Count > 0)
        {
            sb.AppendLine("MODULE STATUS (latest report per module):");
            foreach (var m in mods) sb.AppendLine($"- {m.Code} {m.Name}: {m.State}{(m.Text.Length > 0 ? " - " + m.Text : "")}");
        }
        List<CustomerAnswer> qas; lock (p) qas = p.CustomerAnswers.ToList();
        foreach (var qa in qas) sb.AppendLine($"- Customer decision: {string.Join(" | ", qa.Questions)} -> {qa.Reply}");
        List<string> open; lock (p) open = p.OpenIssues.ToList();
        if (open.Count > 0) sb.AppendLine("OPEN ISSUES (state them honestly in the summary, with their impact and the plan):\n- " + string.Join("\n- ", open));
        return sb.ToString();
    }

    // ---------- printable HTML ----------

    public string? Html(Project p)
    {
        var doc = Document(p);
        var md = doc == null ? null : _store.ReadArtifact(p, doc.Name);
        if (md == null) return null;
        md = Regex.Replace(md, @"```json\s*\{[^`]*?""status""[^`]*?```\s*$", "", RegexOptions.Singleline).TrimEnd();   // the team's handoff block

        var mods = ModuleStatus(p);
        string StateLabel(string s) => s switch
        {
            "done" => L("Done", "Selesai"), "partial" => L("Partial", "Sebagian"), "blocked" => L("Open issue", "Ada kendala"),
            "todo" => L("Not started", "Belum dimulai"), _ => L("Reported", "Dilaporkan"),
        };
        var done = mods.Count(m => m.State == "done");
        var e = (Func<string?, string>)(s => WebUtility.HtmlEncode(s ?? ""));
        var brief = string.Join("", p.Brief.Select(kv => $"<tr><th>{e(BriefLabel(kv.Key))}</th><td>{e(kv.Value)}</td></tr>"));
        var modTable = mods.Count == 0 ? "" :
            $"<section class=\"modules\"><h2>{e(L("Delivery status per module", "Status penyerahan per modul"))}</h2>" +
            $"<p class=\"muted\">{e(L($"{done} of {mods.Count} modules done.", $"{done} dari {mods.Count} modul selesai."))}</p>" +
            "<table><thead><tr><th>" + e(L("Module", "Modul")) + "</th><th>" + e(L("Status", "Status")) + "</th><th>" + e(L("Notes", "Catatan")) + "</th></tr></thead><tbody>" +
            string.Join("", mods.Select(m => $"<tr class=\"{e(m.State)}\"><td><b>{e(m.Code)}</b> {e(m.Name)}</td><td class=\"st\">{e(StateLabel(m.State))}</td><td>{e(m.Text)}</td></tr>")) +
            "</tbody></table></section>";

        return $$"""
<!doctype html>
<html lang="{{Lang}}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{{e(L("Handover", "Serah terima"))}} - {{e(p.Title)}}</title>
<style>
  @page { size: A4; margin: 18mm 16mm 18mm 16mm; }
  :root { --ink: #16202b; --muted: #5b6673; --line: #d9dee4; --accent: #1f5fad; --ok: #23824a; --warn: #b7791f; --bad: #c0352b; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #fff; color: var(--ink); font: 11pt/1.55 "Segoe UI", "Helvetica Neue", Arial, sans-serif; }
  .page { max-width: 820px; margin: 0 auto; padding: 24px; }
  .cover { min-height: 92vh; display: flex; flex-direction: column; justify-content: space-between; padding: 40px 0; break-after: page; }
  .cover .company { font-weight: 700; color: var(--accent); letter-spacing: .04em; text-transform: uppercase; font-size: 10pt; }
  .cover h1 { font-size: 26pt; line-height: 1.15; margin: 40px 0 10px; }
  .cover .sub { font-size: 13pt; color: var(--muted); }
  .cover table { margin-top: 28px; }
  .meta { color: var(--muted); font-size: 10pt; }
  h1 { font-size: 20pt; margin: 28px 0 10px; color: var(--accent); break-before: page; }
  .cover h1, .doc > h1:first-child { break-before: auto; }
  h2 { font-size: 14pt; margin: 22px 0 8px; break-after: avoid; }
  h3 { font-size: 12pt; margin: 16px 0 6px; break-after: avoid; }
  p, li { orphans: 3; widows: 3; }
  table { border-collapse: collapse; width: 100%; margin: 10px 0; font-size: 10pt; break-inside: auto; }
  tr { break-inside: avoid; }
  th, td { border: 1px solid var(--line); padding: 6px 8px; text-align: left; vertical-align: top; }
  thead th, .cover th, .brief th { background: #f2f5f8; }
  .cover th, .brief th { width: 32%; }
  .modules { break-after: page; }
  .modules .st { white-space: nowrap; font-weight: 600; }
  .modules tr.done .st { color: var(--ok); } .modules tr.partial .st, .modules tr.info .st { color: var(--warn); } .modules tr.blocked .st { color: var(--bad); }
  .muted { color: var(--muted); }
  pre { background: #f5f7f9; border: 1px solid var(--line); border-radius: 4px; padding: 8px 10px; font: 9pt/1.45 Consolas, monospace; white-space: pre-wrap; word-break: break-word; }
  code { font-family: Consolas, monospace; font-size: 9.5pt; background: #f2f5f8; padding: 0 3px; border-radius: 3px; }
  pre code { background: none; padding: 0; }
  .toolbar { position: sticky; top: 0; background: #fff; border-bottom: 1px solid var(--line); padding: 10px 24px; display: flex; gap: 8px; justify-content: flex-end; }
  .toolbar a, .toolbar button { font: 600 10pt "Segoe UI", sans-serif; padding: 7px 14px; border-radius: 6px; border: 1px solid var(--ink); background: var(--ink); color: #fff; text-decoration: none; cursor: pointer; }
  .toolbar button { background: #fff; color: var(--ink); }
  @media print { .toolbar { display: none; } .page { padding: 0; max-width: none; } }
</style>
</head>
<body>
<div class="toolbar"><button type="button" onclick="window.print()">{{e(L("Print", "Cetak"))}}</button><a href="/api/projects/{{Uri.EscapeDataString(p.Id)}}/handover.pdf">{{e(L("Download PDF", "Unduh PDF"))}}</a></div>
<div class="page">
  <section class="cover">
    <div class="company">{{e(_reg.Config.Company)}}</div>
    <div>
      <h1>{{e(p.Title)}}</h1>
      <div class="sub">{{e(L("Project summary and user handbook", "Ringkasan proyek dan buku panduan pengguna"))}}</div>
      <table class="brief">{{brief}}</table>
    </div>
    <div class="meta">{{e(L("Project", "Proyek"))}} {{e(p.Id)}} · {{e(DateTime.Now.ToString(Lang == "id" ? "d MMMM yyyy" : "MMMM d, yyyy", new System.Globalization.CultureInfo(Lang == "id" ? "id-ID" : "en-GB")))}}</div>
  </section>
  {{modTable}}
  <div class="doc">{{Markdown.ToHtml(md)}}</div>
</div>
</body>
</html>
""";
    }

    private string BriefLabel(string k) => k switch
    {
        "problem" => L("Problem", "Masalah"), "users" => L("Users", "Pengguna"), "features" => L("Features", "Fitur"),
        "integrations" => L("Integrations", "Integrasi"), "constraints" => L("Deadline & budget", "Tenggat & anggaran"), _ => k,
    };

    // ---------- PDF through a local Chromium browser ----------

    public static string? BrowserPath()
    {
        string?[] candidates =
        [
            Environment.GetEnvironmentVariable("VC_PDF_BROWSER"),
            @"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
            @"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
            @"C:\Program Files\Google\Chrome\Application\chrome.exe",
            @"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
            "/usr/bin/chromium", "/usr/bin/google-chrome",
        ];
        return candidates.FirstOrDefault(c => !string.IsNullOrEmpty(c) && File.Exists(c));
    }

    /// Prints the page at `url` to a PDF file with a headless browser; returns the PDF bytes.
    public static async Task<byte[]> PdfAsync(string url, CancellationToken ct)
    {
        var browser = BrowserPath() ?? throw new InvalidOperationException("No Edge or Chrome found to make the PDF. Open the handover page and use Print > Save as PDF.");
        var dir = Path.Combine(Path.GetTempPath(), "vc-pdf-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        var pdf = Path.Combine(dir, "handover.pdf");
        try
        {
            var psi = new ProcessStartInfo(browser)
            {
                UseShellExecute = false, CreateNoWindow = true, RedirectStandardError = true, RedirectStandardOutput = true,
            };
            foreach (var a in new[] { "--headless=new", "--disable-gpu", "--no-first-run", "--no-pdf-header-footer", $"--user-data-dir={Path.Combine(dir, "profile")}",
                                      "--virtual-time-budget=5000", $"--print-to-pdf={pdf}", url })
                psi.ArgumentList.Add(a);
            using var proc = Process.Start(psi) ?? throw new InvalidOperationException("Could not start the browser to make the PDF.");
            using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
            cts.CancelAfter(TimeSpan.FromSeconds(90));
            try { await proc.WaitForExitAsync(cts.Token); }
            catch (OperationCanceledException) { try { proc.Kill(entireProcessTree: true); } catch (InvalidOperationException) { } throw new InvalidOperationException("Making the PDF took too long."); }
            if (!File.Exists(pdf) || new FileInfo(pdf).Length == 0) throw new InvalidOperationException("The browser did not produce a PDF.");
            return await File.ReadAllBytesAsync(pdf, ct);
        }
        finally
        {
            try { Directory.Delete(dir, recursive: true); } catch (IOException) { } catch (UnauthorizedAccessException) { }
        }
    }
}

/// Small Markdown to HTML converter for the agents' documents: headings, lists, tables, code blocks,
/// bold, italic, inline code and links. Everything is HTML-encoded first.
public static class Markdown
{
    public static string ToHtml(string src)
    {
        var lines = src.Replace("\r", "").Split('\n');
        var sb = new StringBuilder();
        var i = 0;
        while (i < lines.Length)
        {
            var l = lines[i];
            if (l.TrimStart().StartsWith("```"))
            {
                var code = new StringBuilder(); i++;
                while (i < lines.Length && !lines[i].TrimStart().StartsWith("```")) code.AppendLine(lines[i++]);
                i++;
                sb.Append("<pre><code>").Append(WebUtility.HtmlEncode(code.ToString().TrimEnd())).Append("</code></pre>\n");
                continue;
            }
            if (l.TrimStart().StartsWith('|'))
            {
                var rows = new List<string>();
                while (i < lines.Length && lines[i].TrimStart().StartsWith('|')) rows.Add(lines[i++].Trim());
                var cells = (string r) => r.Trim('|').Split('|').Select(c => c.Trim()).ToList();
                var body = rows.Where(r => !Regex.IsMatch(r, @"^\|[\s|:\-]+\|?$")).ToList();
                sb.Append("<table>");
                for (var k = 0; k < body.Count; k++)
                {
                    var tag = k == 0 ? "th" : "td";
                    sb.Append(k == 0 ? "<thead><tr>" : "<tr>");
                    foreach (var c in cells(body[k])) sb.Append($"<{tag}>{Inline(c)}</{tag}>");
                    sb.Append(k == 0 ? "</tr></thead><tbody>" : "</tr>");
                }
                sb.Append("</tbody></table>\n");
                continue;
            }
            var h = Regex.Match(l, @"^(#{1,4})\s+(.*)");
            if (h.Success) { var n = h.Groups[1].Length; sb.Append($"<h{n}>{Inline(h.Groups[2].Value)}</h{n}>\n"); i++; continue; }
            if (Regex.IsMatch(l, @"^\s*([-*+]|\d+[.)])\s+"))
            {
                var ordered = Regex.IsMatch(l, @"^\s*\d+[.)]");
                sb.Append(ordered ? "<ol>" : "<ul>");
                while (i < lines.Length && Regex.IsMatch(lines[i], @"^\s*([-*+]|\d+[.)])\s+"))
                    sb.Append("<li>").Append(Inline(Regex.Replace(lines[i++], @"^\s*([-*+]|\d+[.)])\s+", ""))).Append("</li>");
                sb.Append(ordered ? "</ol>\n" : "</ul>\n");
                continue;
            }
            if (Regex.IsMatch(l, @"^\s*(-{3,}|\*{3,})\s*$")) { sb.Append("<hr>\n"); i++; continue; }
            if (l.TrimStart().StartsWith('>')) { sb.Append("<blockquote>").Append(Inline(l.TrimStart().TrimStart('>').Trim())).Append("</blockquote>\n"); i++; continue; }
            if (l.Trim().Length > 0)
            {
                var para = new StringBuilder(l.Trim()); i++;
                while (i < lines.Length && lines[i].Trim().Length > 0 && !Regex.IsMatch(lines[i], @"^(\s*(#{1,4}\s|[-*+]\s|\d+[.)]\s|\||```|>))"))
                    para.Append(' ').Append(lines[i++].Trim());
                sb.Append("<p>").Append(Inline(para.ToString())).Append("</p>\n");
                continue;
            }
            i++;
        }
        return sb.ToString();
    }

    private static string Inline(string s)
    {
        var t = WebUtility.HtmlEncode(s);
        t = Regex.Replace(t, @"`([^`]+)`", "<code>$1</code>");
        t = Regex.Replace(t, @"\*\*(.+?)\*\*", "<b>$1</b>");
        t = Regex.Replace(t, @"(?<![\w*])\*(?!\s)(.+?)(?<!\s)\*(?![\w*])", "<i>$1</i>");
        t = Regex.Replace(t, @"\[([^\]]+)\]\((https?://[^)\s]+)\)", "<a href=\"$2\">$1</a>");
        return t;
    }
}
