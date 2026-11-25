using System.Text.Json;
using System.Text.RegularExpressions;
using VirtualCompany.Core;

var builder = WebApplication.CreateBuilder(args);

var registry = new AgentRegistry(Path.Combine(builder.Environment.ContentRootPath, "agents.json"));
var store = new ProjectStore(Path.Combine(builder.Environment.ContentRootPath, "data", "projects"));
// Engine: VC_MODE = agent-sdk (default with a key) | api | sim (default without a key).
// agent-sdk runs through Node (agent-runner/), which also works where Windows TLS policy blocks the API.
var hasKey = !string.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable("ANTHROPIC_API_KEY"));
// The Agent SDK runs the bundled Claude Code CLI, which also signs in with this machine's Claude Code login
// (~/.claude/.credentials.json, or CLAUDE_CONFIG_DIR) when no API key is set.
var claudeDir = Environment.GetEnvironmentVariable("CLAUDE_CONFIG_DIR") is { Length: > 0 } cd ? cd
    : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".claude");
var hasClaudeLogin = File.Exists(Path.Combine(claudeDir, ".credentials.json"));
var engine = (Environment.GetEnvironmentVariable("VC_MODE") ?? "").ToLowerInvariant() switch
{
    "sim" => "sim",
    "api" when hasKey => "api",
    "agent-sdk" when hasKey || hasClaudeLogin => "agent-sdk",
    _ => hasKey || hasClaudeLogin ? "agent-sdk" : "sim",
};
var auth = engine == "sim" ? null : hasKey ? "api-key" : "claude-login";
var live = engine != "sim";
ILlmClient llm = engine switch
{
    "api" => new AnthropicLlm(),
    "agent-sdk" => new AgentSdkLlm(Path.Combine(builder.Environment.ContentRootPath, "agent-runner")),
    _ => new SimulatedLlm(),
};

builder.Services.AddSingleton(registry);
builder.Services.AddSingleton(store);
builder.Services.AddSingleton(llm);
builder.Services.AddSingleton<AppWorkspace>();
builder.Services.AddSingleton<Handover>();
builder.Services.AddSingleton<ReleasePackager>();
builder.Services.AddSingleton<Orchestrator>();
builder.Services.ConfigureHttpJsonOptions(o =>
{
    o.SerializerOptions.PropertyNamingPolicy = JsonNamingPolicy.CamelCase;
    o.SerializerOptions.Converters.Add(new System.Text.Json.Serialization.JsonStringEnumConverter());
});

var app = builder.Build();
app.UseDefaultFiles();
// The UI changes often: the browser must ask each time (a quick 304 when nothing changed) instead of using an old copy.
app.UseStaticFiles(new StaticFileOptions
{
    OnPrepareResponse = c => c.Context.Response.Headers.CacheControl = "no-cache"
});
app.Logger.LogInformation("Virtual Company engine: {Engine} (auth: {Auth})", engine, auth ?? "none");
if (llm is AgentSdkLlm sdk)
{
    await sdk.EnsureRunnerAsync(app.Logger);
    app.Lifetime.ApplicationStopping.Register(sdk.Dispose);
}
{
    // Projects from before open issues were tracked get them from their last QA / Security / DevOps reports.
    var orcAtStart = app.Services.GetRequiredService<Orchestrator>();
    foreach (var p in store.All) orcAtStart.SeedOpenIssues(p);
}

// ---------- registry ----------

object Meta() => new
{
    live,
    engine,
    auth,
    company = registry.Config.Company,
    defaults = registry.Config.Defaults,
    models = registry.Config.Models,
    departments = registry.Config.Departments,
    overrides = registry.Config.Overrides,
    budget = registry.Config.Budget,
    pipeline = registry.Config.Pipeline,
    agents = registry.Config.Agents.Select(a =>
    {
        var r = registry.ResolveModel(a.Id);
        return new { a.Id, a.Role, a.Names, a.Initials, a.Department, a.Model, a.Effort, a.MaxInstances, a.Spawnable, a.CanAskCustomer, a.Persona, a.Disabled, a.Reads,
            a.Tools, mustDo = a.MustDo ?? [], mustNot = a.MustNot ?? [],
            maxOutputTokens = a.MaxOutputTokens ?? registry.Config.Defaults.MaxOutputTokens,
            resolvedModel = r.Model, modelSource = r.Source };
    }),
    codeMode = registry.Config.CodeMode.Enabled,
    knownTools = KnownTools,
};

app.MapGet("/api/meta", () => Results.Ok(Meta()));

// One language for the whole app: the UI, the team's messages and the documents agents write.
string L(string en, string id) => registry.Config.Defaults.Language == "id" ? id : en;
// media type of a reference file, by its extension
static string RefType(string f) => Path.GetExtension(f).ToLowerInvariant() switch
{
    ".png" => "image/png", ".jpg" or ".jpeg" => "image/jpeg", ".gif" => "image/gif", ".webp" => "image/webp", ".svg" => "image/svg+xml",
    ".pdf" => "application/pdf", ".json" => "application/json", ".xml" => "application/xml", ".zip" => "application/zip",
    ".md" or ".txt" or ".csv" or ".log" or ".yaml" or ".yml" or ".sql" or ".cs" or ".py" or ".ts" => "text/plain", ".html" => "text/html", ".css" => "text/css", ".js" => "text/javascript",
    ".docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document", ".xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    _ => "application/octet-stream",
};

app.MapPut("/api/settings", (SettingsPatch s) =>
{
    if (s.Language is { } lang)
    {
        if (lang is not ("en" or "id")) return Results.BadRequest(new { error = L("Language must be en or id.", "Bahasa harus en atau id.") });
        registry.Config.Defaults.Language = lang;
    }
    // Budget: the project pauses each time this much more is spent (0 = that check is off).
    if (s.MaxUsdPerProject is { } usd)
    {
        if (usd is < 0 or > 10_000) return Results.BadRequest(new { error = L("The dollar budget must be between 0 and 10,000.", "Anggaran dolar harus antara 0 dan 10.000.") });
        registry.Config.Budget.MaxUsdPerProject = usd;
    }
    if (s.MaxTokensPerProject is { } tok)
    {
        if (tok is < 0 or > 1_000_000_000) return Results.BadRequest(new { error = L("The token budget must be 0 or more.", "Anggaran token harus 0 atau lebih.") });
        registry.Config.Budget.MaxTokensPerProject = tok;
    }
    registry.Save();
    return Results.Ok(Meta());
});

app.MapPut("/api/registry/agents/{id}", (string id, AgentPatch patch) =>
{
    var a = registry.Get(id);
    if (a == null) return Results.NotFound(new { error = L($"No agent '{id}'.", $"Tidak ada agent '{id}'.") });
    if (patch.Model != null) a.Model = patch.Model == "" ? null : patch.Model;
    if (patch.Effort != null) a.Effort = patch.Effort == "" ? null : patch.Effort;
    if (patch.MaxInstances is > 0) a.MaxInstances = patch.MaxInstances.Value;
    if (patch.Persona is { Length: > 0 }) a.Persona = patch.Persona.Trim();
    // The owner's rules: blank lines dropped; an empty list removes them.
    static List<string>? Clean(List<string>? xs) => xs?.Select(x => x.Trim()).Where(x => x.Length > 0).Take(30).ToList() is { Count: > 0 } c ? c : null;
    if (patch.MustDo != null) a.MustDo = Clean(patch.MustDo);
    if (patch.MustNot != null) a.MustNot = Clean(patch.MustNot);
    if (patch.CanAskCustomer is { } ask)
    {
        if (ask && a.Id == "intake")
            return Results.BadRequest(new { error = L("Customer Intake already talks to the customer directly.", "Penerima Kebutuhan sudah berbicara langsung dengan pelanggan.") });
        a.CanAskCustomer = ask;
    }
    if (patch.Tools != null)
    {
        var bad = patch.Tools.Where(t => !KnownTools.Contains(t)).ToList();
        if (bad.Count > 0) return Results.BadRequest(new { error = L($"Unknown tool: {string.Join(", ", bad)}.", $"Tool tidak dikenal: {string.Join(", ", bad)}.") });
        a.Tools = patch.Tools.Count == 0 ? null : KnownTools.Where(patch.Tools.Contains).ToList();
    }
    if (patch.MaxOutputTokens is { } mot)
    {
        if (mot is < 500 or > 64000) return Results.BadRequest(new { error = L("Max output tokens must be between 500 and 64,000.", "Batas token keluaran harus antara 500 dan 64.000.") });
        a.MaxOutputTokens = mot;
    }
    if (patch.Disabled is { } off)
    {
        if (off && a.Id == "intake")
            return Results.BadRequest(new { error = L("Customer Intake starts every request, so it can't be switched off.", "Penerima Kebutuhan memulai setiap permintaan, jadi tidak bisa dimatikan.") });
        a.Disabled = off;
    }
    registry.Save();
    return Results.Ok(Meta());
});

app.MapPost("/api/registry/agents", (NewAgent n) =>
{
    if (string.IsNullOrWhiteSpace(n.Id) || string.IsNullOrWhiteSpace(n.Role))
        return Results.BadRequest(new { error = L("Id and role are required.", "Id dan nama posisi wajib diisi.") });
    var id = n.Id.Trim().ToLowerInvariant().Replace(' ', '_');
    if (registry.Get(id) != null) return Results.Conflict(new { error = L($"An agent with id '{id}' already exists.", $"Agent dengan id '{id}' sudah ada.") });
    if (!registry.Config.Departments.ContainsKey(n.Department)) return Results.BadRequest(new { error = L($"Unknown department '{n.Department}'.", $"Departemen '{n.Department}' tidak dikenal.") });

    registry.Config.Agents.Add(new AgentDef
    {
        Id = id, Role = n.Role.Trim(), Department = n.Department,
        Initials = string.IsNullOrWhiteSpace(n.Initials) ? new string(n.Role.Split(' ', StringSplitOptions.RemoveEmptyEntries).Select(w => char.ToUpper(w[0])).Take(2).ToArray()) : n.Initials!.ToUpper(),
        Model = string.IsNullOrWhiteSpace(n.Model) ? null : n.Model,
        Persona = n.Persona ?? $"You are responsible for {n.Role} work on the project.",
        Spawnable = n.Spawnable, MaxInstances = Math.Max(1, n.MaxInstances ?? 1),
    });

    if (!string.IsNullOrWhiteSpace(n.NewStageTitle))
    {
        var idx = registry.Config.Pipeline.FindIndex(s => s.Id == n.StageId);
        var stage = new StageDef { Id = id + "_stage", Title = n.NewStageTitle!, Agents = [id] };
        registry.Config.Pipeline.Insert(idx < 0 ? registry.Config.Pipeline.Count : idx + 1, stage);
    }
    else
    {
        var st = registry.Stage(n.StageId ?? "");
        if (st == null) return Results.BadRequest(new { error = L("Choose the stage this agent joins.", "Pilih tahap yang diikuti agent ini.") });
        st.Agents.Add(id);
    }
    registry.Save();
    return Results.Ok(Meta());
});

app.MapPut("/api/registry/overrides", (Dictionary<string, string?> o) =>
{
    registry.Config.Overrides = o.Where(kv => !string.IsNullOrWhiteSpace(kv.Value)).ToDictionary(kv => kv.Key, kv => kv.Value);
    registry.Save();
    return Results.Ok(Meta());
});

// ---------- projects ----------

object Summary(Project p) => new { p.Id, p.Title, p.CreatedAt, status = p.Status.ToString(), p.Cost, tokens = p.TokensIn + p.TokensOut };

app.MapGet("/api/projects", () => Results.Ok(store.All.Select(Summary)));

app.MapPost("/api/projects", (Orchestrator orc, NewProject n) => Results.Ok(Summary(orc.StartProject(n.AutoApprove))));

app.MapGet("/api/projects/{id}", (string id, AppWorkspace ws, Handover hv, Orchestrator orc, ReleasePackager rel) => store.Get(id) is { } p
    ? Results.Ok(new { p.Id, p.Title, status = p.Status.ToString(), p.Brief, p.ModelOverrides, p.AutoApprove, p.Artifacts, p.Runs, p.PendingGate, p.PendingQuestion, p.Plan, p.TokensIn, p.TokensOut, p.TokensCacheRead, p.Cost, p.OpenIssues,
        appExists = ws.Exists(p), appUrl = ws.IsRunning(p) ? p.AppUrl : null,
        handover = hv.Document(p)?.Name, canWriteHandover = orc.CanWriteHandover(p),
        release = rel.Latest(p) is { } z ? new { name = z.Name, size = z.Length, at = z.LastWriteTime } : null })
    : Results.NotFound());

// ---------- client handover: project summary + user handbook, as a printable page and as a PDF ----------

app.MapGet("/api/projects/{id}/handover", (string id, Handover hv) =>
{
    var p = store.Get(id);
    var html = p == null ? null : hv.Html(p);
    return html == null
        ? Results.NotFound(new { error = L("There is no handover document yet. It is written at the end of the project, or with 'Create handover document'.", "Belum ada dokumen serah terima. Dokumen ini dibuat di akhir proyek, atau lewat 'Buat dokumen serah terima'.") })
        : Results.Content(html, "text/html; charset=utf-8");
});

app.MapGet("/api/projects/{id}/handover.pdf", async (string id, Handover hv, HttpContext ctx) =>
{
    var p = store.Get(id);
    if (p == null || hv.Document(p) == null) return Results.NotFound(new { error = L("There is no handover document yet.", "Belum ada dokumen serah terima.") });
    var url = $"http://127.0.0.1:{ctx.Connection.LocalPort}/api/projects/{Uri.EscapeDataString(p.Id)}/handover";
    try
    {
        var pdf = await Handover.PdfAsync(url, ctx.RequestAborted);
        var safe = string.Concat(p.Title.Select(c => char.IsLetterOrDigit(c) ? c : '-')).Trim('-');
        return Results.File(pdf, "application/pdf", $"{p.Id}-{(safe.Length > 40 ? safe[..40] : safe)}-handover.pdf");
    }
    catch (InvalidOperationException ex) { return Results.Problem(ex.Message); }
});

// ---------- release package for the client: app + private .NET runtime + start script + handover PDF ----------

app.MapPost("/api/projects/{id}/release", async (string id, ReleasePackager rel, HttpContext ctx) =>
{
    var p = store.Get(id);
    if (p == null) return Results.NotFound();
    if (p.Status is ProjectStatus.Running or ProjectStatus.WaitingCustomer)
        return Results.Conflict(new { error = L("Agents are still changing the app; package it when the project is paused, waiting at a gate or finished.",
                                               "Agent masih mengubah aplikasi; buat paket saat proyek dijeda, menunggu di gate, atau selesai.") });
    store.Publish(p, "log", new { level = "info", text = L("Building the release package for the client...", "Membuat paket rilis untuk klien...") });
    try
    {
        var url = $"http://127.0.0.1:{ctx.Connection.LocalPort}/api/projects/{Uri.EscapeDataString(p.Id)}/handover";
        var zip = await rel.BuildAsync(p, url, ctx.RequestAborted);
        store.Publish(p, "log", new { level = "ok", text = L($"Release package ready: {zip.Name} ({zip.Length / 1048576.0:N0} MB).", $"Paket rilis siap: {zip.Name} ({zip.Length / 1048576.0:N0} MB).") });
        store.Save(p);
        return Results.Ok(new { name = zip.Name, size = zip.Length, at = zip.LastWriteTime });
    }
    catch (InvalidOperationException ex)
    {
        store.Publish(p, "log", new { level = "error", text = ex.Message });
        return Results.Problem(ex.Message);
    }
});

app.MapGet("/api/projects/{id}/release.zip", (string id, ReleasePackager rel) =>
{
    var p = store.Get(id);
    var zip = p == null ? null : rel.Latest(p);
    return zip == null ? Results.NotFound(new { error = L("No release package yet.", "Belum ada paket rilis.") })
                       : Results.File(zip.FullName, "application/zip", zip.Name);
});

app.MapPost("/api/projects/{id}/handover", (string id, Orchestrator orc) =>
{
    var p = store.Get(id);
    if (p == null) return Results.NotFound();
    try { orc.WriteHandover(p); return Results.Ok(); }
    catch (InvalidOperationException ex) { return Results.Conflict(new { error = ex.Message }); }
});

app.MapPost("/api/projects/{id}/app/start", async (string id, Orchestrator orc, AppWorkspace ws) =>
{
    var p = store.Get(id);
    if (p == null) return Results.NotFound();
    if (!ws.Exists(p)) return Results.Conflict(new { error = L("This project has no app yet. Code mode builds one during the Build stage.", "Proyek ini belum punya aplikasi. Mode kode membuatnya di tahap Pembangunan.") });
    try { return Results.Ok(new { url = await orc.StartAppAsync(p) }); }
    catch (InvalidOperationException ex) { return Results.Problem(ex.Message); }
});

app.MapPost("/api/projects/{id}/app/stop", (string id, Orchestrator orc) =>
{
    var p = store.Get(id);
    if (p == null) return Results.NotFound();
    orc.StopApp(p);
    return Results.Ok();
});

app.MapGet("/api/projects/{id}/events", async (string id, HttpContext ctx) =>
{
    var p = store.Get(id);
    if (p == null) { ctx.Response.StatusCode = 404; return; }
    ctx.Response.Headers.ContentType = "text/event-stream";
    ctx.Response.Headers.CacheControl = "no-cache";
    var reader = store.Subscribe(id, out var unsubscribe);
    try
    {
        long last = 0;
        foreach (var ev in store.Snapshot(p)) { await Write(ctx, ev); last = ev.Seq; }
        await ctx.Response.WriteAsync("event: replayed\ndata: {}\n\n");
        await ctx.Response.Body.FlushAsync();
        await foreach (var ev in reader.ReadAllAsync(ctx.RequestAborted))
        {
            if (ev.Seq == 0) await Write(ctx, ev);                         // live-only progress tick
            else if (ev.Seq > last) { await Write(ctx, ev); last = ev.Seq; }
        }
    }
    catch (OperationCanceledException) { }
    finally { unsubscribe(); }

    static async Task Write(HttpContext ctx, VcEvent ev)
    {
        // SSE needs one line per data field, so serialize without indentation.
        await ctx.Response.WriteAsync($"data: {JsonSerializer.Serialize(ev, SseJson)}\n\n");
        await ctx.Response.Body.FlushAsync();
    }
});

app.MapPost("/api/projects/{id}/chat", async (string id, ChatIn m, Orchestrator orc) =>
{
    var p = store.Get(id);
    if (p == null) return Results.NotFound();
    // attachments: files uploaded first through /attachments, referred to by their stored names
    var files = new List<ChatAttachment>();
    foreach (var f in m.Attachments ?? [])
    {
        var path = Path.Combine(store.RefsDir(p), Path.GetFileName(f));
        if (!File.Exists(path)) continue;
        files.Add(new ChatAttachment { File = Path.GetFileName(f), Name = Regex.Replace(Path.GetFileName(f), @"^\d+-", ""), Type = RefType(f), Size = new FileInfo(path).Length });
    }
    if (string.IsNullOrWhiteSpace(m.Text) && files.Count == 0) return Results.BadRequest(new { error = L("Write a message first.", "Tulis pesan dulu.") });
    try { await orc.CustomerMessageAsync(p, (m.Text ?? "").Trim(), files); }
    catch (Exception ex) when (ex is not OperationCanceledException)
    {
        return Results.Problem(L($"The intake agent could not answer: {ex.Message}", $"Agent penerima kebutuhan tidak bisa menjawab: {ex.Message}"));
    }
    return Results.Ok();
});

// Reference files for the chat (pasted screenshots, documents): stored with the project, sent with the next message.
app.MapPost("/api/projects/{id}/attachments", async (string id, HttpRequest req) =>
{
    var p = store.Get(id);
    if (p == null) return Results.NotFound();
    if (!req.HasFormContentType) return Results.BadRequest(new { error = "multipart/form-data expected" });
    var form = await req.ReadFormAsync();
    var dir = store.RefsDir(p); Directory.CreateDirectory(dir);
    var outList = new List<object>();
    foreach (var f in form.Files)
    {
        if (f.Length == 0) continue;
        if (f.Length > 20_000_000) return Results.BadRequest(new { error = L($"{f.FileName} is larger than 20 MB.", $"{f.FileName} lebih besar dari 20 MB.") });
        var safe = Regex.Replace(Path.GetFileName(f.FileName), @"[^\w.\- ]", "_").Trim();
        if (safe.Length == 0 || safe.StartsWith('.')) safe = "file" + safe;
        var n = Directory.GetFiles(dir).Length + 1;
        var stored = $"{n:D2}-{safe}";
        while (File.Exists(Path.Combine(dir, stored))) stored = $"{++n:D2}-{safe}";
        await using (var s = File.Create(Path.Combine(dir, stored))) await f.CopyToAsync(s);
        outList.Add(new { file = stored, name = safe, type = RefType(stored), size = f.Length, url = $"/api/projects/{id}/attachments/{Uri.EscapeDataString(stored)}" });
    }
    return Results.Ok(outList);
}).DisableAntiforgery();

app.MapGet("/api/projects/{id}/attachments/{file}", (string id, string file) =>
{
    var p = store.Get(id);
    if (p == null) return Results.NotFound();
    var path = Path.Combine(store.RefsDir(p), Path.GetFileName(file));
    return File.Exists(path) ? Results.File(path, RefType(file), Path.GetFileName(file)) : Results.NotFound();
});

app.MapPut("/api/projects/{id}/overrides", (string id, Dictionary<string, string?> o) =>
{
    var p = store.Get(id);
    if (p == null) return Results.NotFound();
    lock (p) p.ModelOverrides = o.Where(kv => !string.IsNullOrWhiteSpace(kv.Value)).ToDictionary(kv => kv.Key, kv => kv.Value);
    store.Save(p);
    return Results.Ok(p.ModelOverrides);
});

// Pause: agents at work finish their step and nothing new starts; Continue picks up exactly there (Stop cancels instead).
app.MapPost("/api/projects/{id}/pause", (string id, Orchestrator orc) =>
{
    var p = store.Get(id);
    if (p == null) return Results.NotFound();
    try { orc.Pause(p); return Results.Ok(); } catch (InvalidOperationException ex) { return Results.Conflict(new { error = ex.Message }); }
});

app.MapPost("/api/projects/{id}/unpause", (string id, Orchestrator orc) =>
{
    var p = store.Get(id);
    if (p == null) return Results.NotFound();
    try { orc.Unpause(p); return Results.Ok(); } catch (InvalidOperationException ex) { return Results.Conflict(new { error = ex.Message }); }
});

// The owner renames the project (the intake gives it a first title from the brief).
app.MapPut("/api/projects/{id}/title", (string id, TitleIn t) =>
{
    var p = store.Get(id);
    if (p == null) return Results.NotFound();
    var title = (t.Title ?? "").Trim();
    if (title.Length is 0 or > 120) return Results.BadRequest(new { error = L("The title must be 1 to 120 characters.", "Judul harus 1 sampai 120 karakter.") });
    lock (p) p.Title = title;
    store.Publish(p, "title", new { title });
    store.Save(p);
    return Results.Ok(new { title });
});

app.MapPut("/api/projects/{id}/autoapprove", (string id, Toggle t) =>
{
    var p = store.Get(id);
    if (p == null) return Results.NotFound();
    p.AutoApprove = t.On;
    store.Save(p);
    return Results.Ok();
});

app.MapPost("/api/projects/{id}/gate", (string id, GateIn g, Orchestrator orc) =>
{
    var p = store.Get(id);
    if (p == null) return Results.NotFound();
    if (g.Decision is not ("approve" or "revise" or "reject")) return Results.BadRequest(new { error = L("Decision must be approve, revise or reject.", "Keputusan harus approve, revise, atau reject.") });
    if (g.Decision == "revise" && string.IsNullOrWhiteSpace(g.Note)) return Results.BadRequest(new { error = L("Say what should change so the agent can revise.", "Tulis apa yang perlu diubah agar agent bisa merevisi.") });
    return orc.Decide(p, g.Decision, g.Note) ? Results.Ok() : Results.Conflict(new { error = L("Nothing is waiting for approval.", "Tidak ada yang menunggu persetujuan.") });
});

app.MapPost("/api/projects/{id}/resume", (string id, Orchestrator orc) =>
{
    var p = store.Get(id);
    if (p == null) return Results.NotFound();
    if (!orc.CanResume(p)) return Results.Conflict(new { error = L("Only a stopped or failed project with a finished intake can be resumed.", "Hanya proyek yang berhenti atau gagal, dengan intake selesai, yang bisa dilanjutkan.") });
    orc.Resume(p);
    return Results.Ok();
});

app.MapPost("/api/projects/{id}/stop", (string id, Orchestrator orc) =>
{
    var p = store.Get(id);
    if (p == null) return Results.NotFound();
    orc.Stop(p, L("Stopped by you.", "Dihentikan oleh Anda."));
    return Results.Ok();
});

app.MapGet("/api/projects/{id}/export", (string id, AppWorkspace ws) =>
{
    var p = store.Get(id);
    if (p == null) return Results.NotFound();
    using var ms = new MemoryStream();
    using (var zip = new System.IO.Compression.ZipArchive(ms, System.IO.Compression.ZipArchiveMode.Create, leaveOpen: true))
    {
        var index = new System.Text.StringBuilder($"# {p.Title}\n\nProject {p.Id}, status {p.Status}, cost USD {p.Cost:N2}.\n\n");
        foreach (var a in p.Artifacts)
        {
            var text = store.ReadArtifact(p, a.Name);
            if (text == null) continue;
            var path = (a.Helper ? "parts/" : "") + a.Name;
            using (var w = new StreamWriter(zip.CreateEntry(path).Open())) w.Write(text);
            index.AppendLine($"- [{a.Title}]({path})");
        }
        // Code mode: the application's source, without build output or the local database.
        var appDir = ws.Dir(p);
        if (ws.Exists(p))
        {
            index.AppendLine("\n## Application source\n\nFolder `app/`. Run it with `dotnet run` inside that folder.");
            foreach (var f in Directory.EnumerateFiles(appDir, "*", SearchOption.AllDirectories))
            {
                var rel = Path.GetRelativePath(appDir, f).Replace('\\', '/');
                if (rel.StartsWith("bin/") || rel.StartsWith("obj/") || rel.StartsWith(".qa/") || rel.StartsWith(".refs/") || rel.EndsWith(".db") || rel.EndsWith(".db-shm") || rel.EndsWith(".db-wal")) continue;
                System.IO.Compression.ZipFileExtensions.CreateEntryFromFile(zip, f, "app/" + rel);
            }
        }
        using (var w = new StreamWriter(zip.CreateEntry("INDEX.md").Open())) w.Write(index.ToString());
    }
    return Results.File(ms.ToArray(), "application/zip", $"{p.Id}-documents.zip");
});

app.MapGet("/api/projects/{id}/artifacts/{name}", (string id, string name) =>
{
    var p = store.Get(id);
    var text = p == null ? null : store.ReadArtifact(p, name);
    return text == null ? Results.NotFound() : Results.Text(text, "text/markdown; charset=utf-8");
});

app.Run();

partial class Program
{
    static readonly JsonSerializerOptions SseJson = new(AgentRegistry.Json) { WriteIndented = false };
    /// Agent SDK tools a role may be given in code mode (the runner's guard still keeps them inside the app folder).
    static readonly string[] KnownTools = ["Read", "Write", "Edit", "Glob", "Grep", "Bash"];
}

record AgentPatch(string? Model, string? Effort, int? MaxInstances, string? Persona, bool? Disabled, int? MaxOutputTokens,
    List<string>? MustDo = null, List<string>? MustNot = null, bool? CanAskCustomer = null, List<string>? Tools = null);
record NewAgent(string Id, string Role, string? Initials, string Department, string? Model, string? Persona, string? StageId, string? NewStageTitle, bool Spawnable, int? MaxInstances);
record NewProject(bool AutoApprove);
record SettingsPatch(string? Language, decimal? MaxUsdPerProject = null, long? MaxTokensPerProject = null);
record ChatIn(string? Text, List<string>? Attachments);
record Toggle(bool On);
record TitleIn(string? Title);
record GateIn(string Decision, string? Note);
