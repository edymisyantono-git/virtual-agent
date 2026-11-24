using System.Text.Json;
using VirtualCompany.Core;

var builder = WebApplication.CreateBuilder(args);

var registry = new AgentRegistry(Path.Combine(builder.Environment.ContentRootPath, "agents.json"));
var store = new ProjectStore(Path.Combine(builder.Environment.ContentRootPath, "data", "projects"));
// Engine: VC_MODE = agent-sdk (default with a key) | api | sim (default without a key).
// agent-sdk runs through Node (agent-runner/), which also works where Windows TLS policy blocks the API.
var hasKey = !string.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable("ANTHROPIC_API_KEY"));
var engine = (Environment.GetEnvironmentVariable("VC_MODE") ?? "").ToLowerInvariant() switch
{
    "sim" => "sim",
    "api" when hasKey => "api",
    "agent-sdk" when hasKey => "agent-sdk",
    _ => hasKey ? "agent-sdk" : "sim",
};
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
builder.Services.AddSingleton<Orchestrator>();
builder.Services.ConfigureHttpJsonOptions(o =>
{
    o.SerializerOptions.PropertyNamingPolicy = JsonNamingPolicy.CamelCase;
    o.SerializerOptions.Converters.Add(new System.Text.Json.Serialization.JsonStringEnumConverter());
});

var app = builder.Build();
app.UseDefaultFiles();
app.UseStaticFiles();
app.Logger.LogInformation("Virtual Company engine: {Engine}", engine);
if (llm is AgentSdkLlm sdk)
{
    await sdk.EnsureRunnerAsync(app.Logger);
    app.Lifetime.ApplicationStopping.Register(sdk.Dispose);
}

// ---------- registry ----------

object Meta() => new
{
    live,
    engine,
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
        return new { a.Id, a.Role, a.Initials, a.Department, a.Model, a.Effort, a.MaxInstances, a.Spawnable, a.CanAskCustomer, a.Persona, a.Disabled, a.Reads,
            maxOutputTokens = a.MaxOutputTokens ?? registry.Config.Defaults.MaxOutputTokens,
            resolvedModel = r.Model, modelSource = r.Source };
    }),
};

app.MapGet("/api/meta", () => Results.Ok(Meta()));

app.MapPut("/api/registry/agents/{id}", (string id, AgentPatch patch) =>
{
    var a = registry.Get(id);
    if (a == null) return Results.NotFound(new { error = $"No agent '{id}'." });
    if (patch.Model != null) a.Model = patch.Model == "" ? null : patch.Model;
    if (patch.Effort != null) a.Effort = patch.Effort == "" ? null : patch.Effort;
    if (patch.MaxInstances is > 0) a.MaxInstances = patch.MaxInstances.Value;
    if (patch.Persona is { Length: > 0 }) a.Persona = patch.Persona;
    if (patch.MaxOutputTokens is { } mot)
    {
        if (mot is < 500 or > 64000) return Results.BadRequest(new { error = "Max output tokens must be between 500 and 64,000." });
        a.MaxOutputTokens = mot;
    }
    if (patch.Disabled is { } off)
    {
        if (off && a.Id == "intake")
            return Results.BadRequest(new { error = "Customer Intake starts every request, so it can't be switched off." });
        a.Disabled = off;
    }
    registry.Save();
    return Results.Ok(Meta());
});

app.MapPost("/api/registry/agents", (NewAgent n) =>
{
    if (string.IsNullOrWhiteSpace(n.Id) || string.IsNullOrWhiteSpace(n.Role))
        return Results.BadRequest(new { error = "Id and role are required." });
    var id = n.Id.Trim().ToLowerInvariant().Replace(' ', '_');
    if (registry.Get(id) != null) return Results.Conflict(new { error = $"An agent with id '{id}' already exists." });
    if (!registry.Config.Departments.ContainsKey(n.Department)) return Results.BadRequest(new { error = $"Unknown department '{n.Department}'." });

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
        if (st == null) return Results.BadRequest(new { error = "Choose the stage this agent joins." });
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

app.MapGet("/api/projects/{id}", (string id) => store.Get(id) is { } p
    ? Results.Ok(new { p.Id, p.Title, status = p.Status.ToString(), p.Brief, p.ModelOverrides, p.AutoApprove, p.Artifacts, p.Runs, p.PendingGate, p.PendingQuestion, p.Plan, p.TokensIn, p.TokensOut, p.Cost })
    : Results.NotFound());

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
            if (ev.Seq > last) { await Write(ctx, ev); last = ev.Seq; }
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
    if (string.IsNullOrWhiteSpace(m.Text)) return Results.BadRequest(new { error = "Write a message first." });
    try { await orc.CustomerMessageAsync(p, m.Text.Trim()); }
    catch (Exception ex) when (ex is not OperationCanceledException)
    {
        return Results.Problem($"The intake agent could not answer: {ex.Message}");
    }
    return Results.Ok();
});

app.MapPut("/api/projects/{id}/overrides", (string id, Dictionary<string, string?> o) =>
{
    var p = store.Get(id);
    if (p == null) return Results.NotFound();
    lock (p) p.ModelOverrides = o.Where(kv => !string.IsNullOrWhiteSpace(kv.Value)).ToDictionary(kv => kv.Key, kv => kv.Value);
    store.Save(p);
    return Results.Ok(p.ModelOverrides);
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
    if (g.Decision is not ("approve" or "revise" or "reject")) return Results.BadRequest(new { error = "Decision must be approve, revise or reject." });
    if (g.Decision == "revise" && string.IsNullOrWhiteSpace(g.Note)) return Results.BadRequest(new { error = "Say what should change so the agent can revise." });
    return orc.Decide(p, g.Decision, g.Note) ? Results.Ok() : Results.Conflict(new { error = "Nothing is waiting for approval." });
});

app.MapPost("/api/projects/{id}/stop", (string id, Orchestrator orc) =>
{
    var p = store.Get(id);
    if (p == null) return Results.NotFound();
    orc.Stop(p, "Stopped by you.");
    return Results.Ok();
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
}

record AgentPatch(string? Model, string? Effort, int? MaxInstances, string? Persona, bool? Disabled, int? MaxOutputTokens);
record NewAgent(string Id, string Role, string? Initials, string Department, string? Model, string? Persona, string? StageId, string? NewStageTitle, bool Spawnable, int? MaxInstances);
record NewProject(bool AutoApprove);
record ChatIn(string Text);
record Toggle(bool On);
record GateIn(string Decision, string? Note);
