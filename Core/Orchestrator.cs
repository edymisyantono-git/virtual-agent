using System.Collections.Concurrent;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace VirtualCompany.Core;

public record GateDecision(string Decision, string? Note);   // approve | revise | reject

/// Runs a project through the pipeline in agents.json: intake chat, stages, spawned instances,
/// QA loops, human gates and questions back to the customer.
public class Orchestrator
{
    private static readonly string[] Slots = ["problem", "users", "features", "integrations", "constraints"];

    private readonly AgentRegistry _reg;
    private readonly ProjectStore _store;
    private readonly ILlmClient _llm;
    private readonly ILogger<Orchestrator> _log;
    private readonly ConcurrentDictionary<string, Runtime> _rt = new();

    private class Runtime
    {
        public CancellationTokenSource Cts = new();
        public TaskCompletionSource<GateDecision>? Gate;
        public TaskCompletionSource<string>? Answer;
        public SemaphoreSlim IntakeLock = new(1, 1);
        public SemaphoreSlim BudgetLock = new(1, 1);   // parallel agents share one budget gate
        public SemaphoreSlim AskLock = new(1, 1);      // parallel agents ask the customer one at a time
        public string? TestUrl, TestError;              // the copy of the app QA tests against, run by the orchestrator
        public string? BrowserCheck;                    // what a real browser saw on that copy (for QA)
        public TaskCompletionSource? PauseGate;         // set while the owner has paused the project
        // Floor cards per role (guarded by lock(Busy)): how many the PM staffed, and helper cards in use right now.
        public Dictionary<string, int> Staffed = new();
        public Dictionary<string, HashSet<int>> Busy = new();
    }

    /// How many times one agent may go back to the customer within a single task.
    private const int MaxAskRounds = 3;

    private readonly AppWorkspace _app;
    private readonly Handover _handover;

    public Orchestrator(AgentRegistry reg, ProjectStore store, ILlmClient llm, AppWorkspace app, Handover handover, ILogger<Orchestrator> log)
    {
        _reg = reg; _store = store; _llm = llm; _app = app; _handover = handover; _log = log;
    }

    public bool IsLive => _llm.IsLive;

    private Runtime Rt(Project p) => _rt.GetOrAdd(p.Id, _ => new Runtime());

    // ---- language: one setting (defaults.language) for the UI, the team's messages and the documents ----
    private string Lang => _reg.Config.Defaults.Language == "id" ? "id" : "en";
    private string L(string en, string id) => Lang == "id" ? id : en;
    private static string Pick(Dictionary<string, string>? names, string lang, string fallback) =>
        names != null && names.TryGetValue(lang, out var v) && !string.IsNullOrWhiteSpace(v) ? v : fallback;
    private string RoleName(AgentDef d) => Pick(d.Names, Lang, d.Role);
    private string StageName(StageDef s) => Pick(s.Names, Lang, s.Title);
    private string GateName(GateDef g) => Pick(g.Names, Lang, g.Label);
    private string DocLanguage => L("English", "Indonesian (Bahasa Indonesia)");

    /// The owner's own rules for a role (Registry / agent settings). Placed last in every prompt of that role.
    private static string RulesBlock(AgentDef d)
    {
        var must = (d.MustDo ?? []).Where(x => !string.IsNullOrWhiteSpace(x)).ToList();
        var never = (d.MustNot ?? []).Where(x => !string.IsNullOrWhiteSpace(x)).ToList();
        if (must.Count == 0 && never.Count == 0) return "";
        var sb = new StringBuilder("\n\nTHE CEO'S RULES FOR YOUR ROLE. They take priority over the other instructions above when they conflict.");
        if (must.Count > 0) sb.Append("\nYou must always:\n" + string.Join("\n", must.Select(x => "- " + x.Trim())));
        if (never.Count > 0) sb.Append("\nYou must never:\n" + string.Join("\n", never.Select(x => "- " + x.Trim())));
        sb.Append("\nIf a rule cannot be followed for this task, say so in your summary instead of quietly breaking it.");
        return sb.ToString();
    }

    // ================= Intake =================

    public Project StartProject(bool autoApprove)
    {
        var p = _store.Create();
        p.AutoApprove = autoApprove;
        var intake = _reg.Get("intake");
        var greeting = Pick(intake?.Greetings, Lang, intake?.Greeting ?? L("Hi! What can we build for you?", "Halo! Apa yang bisa kami buatkan untuk Anda?"));
        AddChat(p, "agent", "intake", greeting);
        _store.Save(p);
        return p;
    }

    public async Task CustomerMessageAsync(Project p, string text, List<ChatAttachment>? files = null)
    {
        files = files is { Count: > 0 } ? files : null;
        if (files != null) lock (p) p.Attachments.AddRange(files);
        AddChat(p, "customer", null, text, files);
        if (files != null) text = ChatLine(text, files);
        var rt = Rt(p);
        if (p.Status == ProjectStatus.Intake)
        {
            await rt.IntakeLock.WaitAsync();
            try { await IntakeTurnAsync(p, rt.Cts.Token); }
            finally { rt.IntakeLock.Release(); }
        }
        else if (p.Status == ProjectStatus.WaitingCustomer && rt.Answer != null)
        {
            rt.Answer.TrySetResult(text);
        }
        else
        {
            await AnswerCustomerAsync(p, text, rt.Cts.Token);
        }
        _store.Save(p);
    }

    /// After intake, the customer talks to Customer Support, which answers from the project's real state.
    private async Task AnswerCustomerAsync(Project p, string question, CancellationToken ct)
    {
        var def = _reg.Require(IsActive("support") ? "support" : "intake");
        _store.Publish(p, "typing", new { agentId = def.Id, on = true });
        try
        {
            var system = $"You are the {def.Role} at {_reg.Config.Company}. The customer is asking about their project. " +
                         "Answer in the customer's language, briefly (at most about 120 words), using ONLY the facts given. Never invent progress or results. " +
                         "When they ask where the results or documents are: all deliverables are in the Documents tab on the right side of the project page; " +
                         "each opens with a click, and the 'Download all (.zip)' button there saves every document at once. Name the most relevant documents. " +
                         "If a fact is not given, say you will check with the team. Reply with plain text only, no json block." + RulesBlock(def);
            var msg = $"PROJECT FACTS\n{ProjectFacts(p)}\n\nRECENT CHAT\n" +
                      string.Join("\n", p.Chat.TakeLast(8).Select(c => $"{(c.Role == "customer" ? "Customer" : "Team")}: {ChatLine(c.Text, c.Attachments)}")) +
                      $"\n\nCUSTOMER QUESTION: {question}";
            var sw = System.Diagnostics.Stopwatch.StartNew();
            var (result, model) = await CallAsync(p, def, "chat", system, [("user", msg)], ct);
            var reply = Regex.Replace(result.Text, "```json.*?```", "", RegexOptions.Singleline).Trim();
            Record(p, def, "chat", 1, model, result, "done", "Answered a customer question", sw.ElapsedMilliseconds);
            AddChat(p, "agent", def.Id, reply.Length > 0 ? reply : StatusReport(p));
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _log.LogWarning(ex, "Support answer failed for {Project}", p.Id);
            AddChat(p, "agent", def.Id, StatusReport(p));
        }
        finally
        {
            _store.Publish(p, "typing", new { agentId = def.Id, on = false });
        }
    }

    private string ProjectFacts(Project p)
    {
        var sb = new StringBuilder();
        sb.AppendLine($"Project: {p.Title} ({p.Id}). Status: {p.Status}.");
        sb.AppendLine(StatusReport(p));
        sb.AppendLine("Customer brief: " + string.Join("; ", Slots.Select(k => $"{k}: {p.Brief.GetValueOrDefault(k, "(unknown)")}")));
        List<ArtifactRef> docs; List<AgentRun> runs;
        lock (p) { docs = p.Artifacts.Where(a => !a.Helper).ToList(); runs = p.Runs.ToList(); }
        sb.AppendLine($"DOCUMENTS ({docs.Count}, newest last):");
        foreach (var a in docs)
        {
            var summary = runs.LastOrDefault(r => r.AgentId == a.AgentId && r.Instance == a.Instance && r.StageId == a.StageId && r.Status != "delegate")?.Summary;
            sb.AppendLine($"- {a.Title} [{a.Name}]{(string.IsNullOrWhiteSpace(summary) ? "" : $": {summary}")}");
        }
        if (p.PendingGate != null) sb.AppendLine($"Waiting for the CEO's approval: {p.PendingGate.Label}");
        // Never report "finished" without saying what is not: module progress and open issues.
        var mods = Handover.ModuleStatus(p);
        if (mods.Count > 0)
            sb.AppendLine($"MODULES: {mods.Count(m => m.State == "done")} of {mods.Count} done; " +
                          string.Join("; ", mods.Where(m => m.State != "done").Select(m => $"{m.Code} {m.State}")));
        List<string> open; lock (p) open = p.OpenIssues.ToList();
        sb.AppendLine(open.Count == 0 ? "OPEN ISSUES: none recorded." : "OPEN ISSUES (the project is not finished while these are open):\n- " + string.Join("\n- ", open));
        if (Code)
            sb.AppendLine(p.AppUrl != null
                ? $"THE APP IS RUNNING for the customer to test at {p.AppUrl} (also the 'Open app' button above the floor). Source code is included in 'Download all (.zip)'."
                : _app.Exists(p) ? "The app's source exists; it can be started with the 'Start app' button above the floor, then opened with 'Open app'."
                : "No runnable app has been built yet.");
        List<VcEvent> events;
        lock (p) events = p.Events.Where(e => e.Type == "gate" && e.Data.GetValueOrDefault("status")?.ToString() != "waiting").ToList();
        if (events.Count > 0)
        {
            sb.AppendLine("CEO DECISIONS (approval gates):");
            foreach (var e in events)
            {
                var gateNote = e.Data.GetValueOrDefault("note")?.ToString();
                sb.AppendLine($"- {e.Ts:yyyy-MM-dd HH:mm} UTC {e.Data.GetValueOrDefault("label")}: {e.Data.GetValueOrDefault("status")}{(string.IsNullOrWhiteSpace(gateNote) ? "" : $" ({gateNote})")}");
            }
        }
        return sb.ToString();
    }

    private async Task IntakeTurnAsync(Project p, CancellationToken ct)
    {
        var agent = _reg.Require("intake");
        _store.Publish(p, "typing", new { agentId = "intake", on = true });
        var system = $"You are the {agent.Role} at {_reg.Config.Company}. {agent.Persona}\n\n" +
                     $"You opened the conversation with: \"{agent.Greeting}\"\n" +
                     $"Known facts so far (JSON): {JsonSerializer.Serialize(p.Brief)}\n\n" +
                     "Respond ONLY with one JSON object, no other text:\n" +
                     "{\"reply\": \"<your next message to the customer>\", \"slots\": {\"problem\": \"\", \"users\": \"\", \"features\": \"\", \"integrations\": \"\", \"constraints\": \"\"}, \"complete\": false}\n" +
                     "Copy known facts into slots and add what the customer just told you; leave unknown slots empty. Set complete to true only when all five slots are filled." + RulesBlock(agent);
        var messages = p.Chat.SkipWhile(c => c.Role != "customer")
            .Select(c => (c.Role == "customer" ? "user" : "assistant", ChatLine(c.Text, c.Attachments))).ToList();

        var (result, model) = await CallAsync(p, agent, "discovery", system, messages, ct);
        _store.Publish(p, "typing", new { agentId = "intake", on = false });

        string reply = result.Text;
        bool complete = false;
        try
        {
            var json = JsonNode.Parse(ExtractObject(result.Text))!.AsObject();
            reply = json["reply"]?.GetValue<string>() ?? reply;
            complete = json["complete"]?.GetValue<bool>() ?? false;
            if (json["slots"] is JsonObject slots)
                foreach (var (k, v) in slots)
                    if (v is JsonValue jv && jv.TryGetValue<string>(out var s) && !string.IsNullOrWhiteSpace(s))
                        lock (p) p.Brief[k] = s;
        }
        catch (Exception ex) when (ex is JsonException or InvalidOperationException)
        {
            _log.LogWarning("Intake reply was not JSON; showing it as text.");
        }

        AddChat(p, "agent", "intake", reply);
        complete = complete && Slots.All(p.Brief.ContainsKey);
        _store.Publish(p, "brief", new { slots = p.Brief, complete });
        Record(p, agent, "discovery", 1, model, result, "done", complete ? "Brief complete" : "Gathering needs", 0);

        if (complete)
        {
            p.Title = MakeTitle(p.Brief["problem"]);
            _store.Publish(p, "title", new { title = p.Title });
            StartPipeline(p);
        }
    }

    // ================= Pipeline =================

    private void StartPipeline(Project p, bool resume = false)
    {
        var rt = Rt(p);
        _ = Task.Run(() => RunPipelineAsync(p, rt, resume));
    }

    /// A stopped or failed project that already has its brief can continue from where it left off.
    // ================= Client handover on demand (projects that finished before the stage existed, or a rewrite) =================

    public bool CanWriteHandover(Project p) =>
        p.Status is ProjectStatus.Completed or ProjectStatus.Stopped or ProjectStatus.Failed
        && _reg.Stage("handover") != null && IsActive(Handover.WriterId) && p.StageStatus.ContainsKey("discovery");

    public void WriteHandover(Project p)
    {
        var st = _reg.Stage("handover") ?? throw new InvalidOperationException("There is no handover stage.");
        ProjectStatus before;
        lock (p)
        {
            if (!CanWriteHandover(p)) throw new InvalidOperationException(L("The handover can be written once the project has finished or is paused.", "Dokumen serah terima bisa dibuat setelah proyek selesai atau dijeda."));
            before = p.Status;
            p.Status = ProjectStatus.Running;
        }
        if (_rt.TryRemove(p.Id, out var old)) old.Cts.Cancel();
        var rt = Rt(p);
        _store.Publish(p, "status", new { status = nameof(ProjectStatus.Running) });
        _ = Task.Run(async () =>
        {
            try
            {
                await RunStageAsync(p, st, 1, null, rt.Cts.Token);
                _store.Publish(p, "log", new { level = "ok", text = L("The client handover document is ready (Documents tab).", "Dokumen serah terima klien sudah siap (tab Dokumen).") });
                SetStatus(p, before == ProjectStatus.Completed ? ProjectStatus.Completed : before);
            }
            catch (OperationCanceledException) { SetStatus(p, before); }
            catch (Exception ex)
            {
                _log.LogError(ex, "Handover failed for {Project}", p.Id);
                _store.Publish(p, "log", new { level = "error", text = L("The handover document could not be written: ", "Dokumen serah terima gagal dibuat: ") + ex.Message });
                SetStatus(p, before);
            }
            finally { _store.Save(p); }
        });
    }

    public bool CanResume(Project p) =>
        p.Status is ProjectStatus.Stopped or ProjectStatus.Failed
        && Slots.All(p.Brief.ContainsKey)
        && p.StageStatus.ContainsKey("discovery");

    public void Resume(Project p)
    {
        lock (p)
        {
            if (!CanResume(p)) throw new InvalidOperationException("This project can't be resumed.");
            p.Status = ProjectStatus.Running;   // claim it before the task starts, so a double click can't start two
        }
        if (_rt.TryRemove(p.Id, out var old)) old.Cts.Cancel();   // a fresh runtime: the old token is already cancelled
        _store.Publish(p, "status", new { status = nameof(ProjectStatus.Running) });
        _store.Publish(p, "log", new { level = "info", text = L("Resumed. Finished stages and approved gates are skipped.", "Dilanjutkan. Tahap yang selesai dan gate yang disetujui dilewati.") });
        StartPipeline(p, resume: true);
    }

    private bool GateApproved(Project p, StageDef st)
    {
        if (st.Gate == null) return true;
        List<VcEvent> events;
        lock (p) events = p.Events.ToList();
        return events.Any(e => e.Type == "gate"
            && e.Data.GetValueOrDefault("stageId")?.ToString() == st.Id
            && e.Data.GetValueOrDefault("gateId")?.ToString() == st.Gate.Id
            && e.Data.GetValueOrDefault("status")?.ToString() == "approved");
    }

    private string StatusReport(Project p)
    {
        var stages = _reg.Config.Pipeline;
        string Done(string id) => p.StageStatus.GetValueOrDefault(id, "");
        var finished = stages.Count(s => Done(s.Id) is "done" or "skipped");
        var current = stages.FirstOrDefault(s => Done(s.Id) == "running") ?? stages.FirstOrDefault(s => Done(s.Id) is not ("done" or "skipped"));
        var working = _reg.Config.Agents.Where(a => p.Runs.Count > 0 && current != null && current.Agents.Contains(a.Id) && !a.Disabled).Select(RoleName).ToList();
        var sb = new StringBuilder(L($"{finished} of {stages.Count} stages are finished", $"{finished} dari {stages.Count} tahap sudah selesai"));
        if (current != null && p.Status != ProjectStatus.Completed) sb.Append(L(". Now: ", ". Sekarang: ") + $"{StageName(current)}{(working.Count > 0 ? $" ({string.Join(", ", working)})" : "")}");
        sb.Append(L($". Cost so far: ${p.Cost:N2}. ", $". Biaya sejauh ini: ${p.Cost:N2}. "));
        sb.Append(p.Status switch
        {
            ProjectStatus.Running => L("The team is working; nothing is needed from you right now.", "Tim sedang bekerja; saat ini tidak ada yang perlu Anda lakukan."),
            ProjectStatus.WaitingGate => L($"It is waiting for an approval from the CEO: {p.PendingGate?.Label}.", $"Menunggu persetujuan CEO: {p.PendingGate?.Label}."),
            ProjectStatus.Stopped or ProjectStatus.Failed => L("The project is paused. Press Resume on the floor to continue.", "Proyek sedang dijeda. Tekan Lanjutkan di lantai operasi untuk meneruskan."),
            ProjectStatus.Completed => L("The project is delivered.", "Proyek sudah diserahkan."),
            _ => "",
        });
        return sb.ToString().Trim();
    }

    private async Task RunPipelineAsync(Project p, Runtime rt, bool resume)
    {
        var ct = rt.Cts.Token;
        try
        {
            SetStatus(p, ProjectStatus.Running);
            var stages = _reg.Config.Pipeline;
            StageDef? prev = null;
            for (var i = 0; i < stages.Count; i++)
            {
                var st = stages[i];
                if (st.Kind == "chat")
                {
                    SetStage(p, st.Id, "done", 1);
                }
                else
                {
                    // Agents can be switched off between stages; a stage with nobody active is skipped with its gate.
                    if (!st.Agents.Any(IsActive))
                    {
                        SetStage(p, st.Id, "skipped", 1);
                        _store.Publish(p, "log", new { level = "info", text = L($"{StageName(st)} skipped: all its agents are switched off.", $"{StageName(st)} dilewati: semua agentnya dimatikan.") });
                        continue;
                    }

                    // Resuming: a stage that finished its work is not run again; if its gate was never approved, only the gate is asked.
                    var workDone = resume && p.StageStatus.GetValueOrDefault(st.Id) == "done";
                    if (workDone && GateApproved(p, st)) { prev = st; continue; }

                    List<StageResult> results = new();
                    if (!workDone)
                    {
                        if (prev != null)
                            _store.Publish(p, "handoff", new { fromStage = prev.Id, toStage = st.Id });
                        if (resume) lock (p) p.Artifacts.RemoveAll(a => a.StageId == st.Id);   // half-finished attempt: files are rewritten
                        results = st.Loop != null ? await RunLoopStageAsync(p, st, ct) : await RunStageAsync(p, st, 1, null, ct);
                    }

                    var blocked = results.Where(r => r.Handoff.Status == "blocked").ToList();
                    if (blocked.Count > 0)
                    {
                        var d = await GateAsync(p, st, "blocked", L("Blocked: ", "Terblokir: ") + string.Join(" ", blocked.Select(b => b.Handoff.Summary)) + L(" Continue anyway?", " Tetap lanjutkan?"), ct);
                        if (d.Decision != "approve") { Stop(p, "Stopped at a blocking finding."); return; }
                    }

                    while (st.Gate != null)
                    {
                        var d = await GateAsync(p, st, st.Gate.Id, GateName(st.Gate), ct);
                        if (d.Decision == "approve") break;
                        if (d.Decision == "reject") { Stop(p, L($"Rejected at '{GateName(st.Gate)}'.", $"Ditolak di '{GateName(st.Gate)}'.")); return; }
                        await RunStageAsync(p, st, NextRound(p, st.Id), d.Note, ct);   // revise
                    }
                }
                prev = st;
                _store.Save(p);
            }

            await LaunchAppAsync(p, ct);
            var feedback = p.Runs.LastOrDefault(r => r.AgentId == "data_analyst");
            if (feedback != null)
                _store.Publish(p, "feedback", new { from = "data_analyst", to = "project_manager", summary = feedback.Summary });
            AddChat(p, "agent", IsActive("support") ? "support" : "intake", CompletionMessage(p));
            SetStatus(p, ProjectStatus.Completed);
        }
        catch (OperationCanceledException)
        {
            // A run that was replaced by Resume must not overwrite the new run's status.
            if (ReferenceEquals(Rt(p), rt)) SetStatus(p, ProjectStatus.Stopped);
        }
        catch (Exception ex)
        {
            _log.LogError(ex, "Pipeline failed for {Project}", p.Id);
            if (ReferenceEquals(Rt(p), rt))
            {
                _store.Publish(p, "log", new { level = "error", text = ex.Message });
                SetStatus(p, ProjectStatus.Failed);
            }
        }
        finally
        {
            _store.Save(p);
        }
    }

    private record StageResult(AgentDef Agent, int Instance, Handoff Handoff);

    private async Task<List<StageResult>> RunStageAsync(Project p, StageDef st, int round, string? note, CancellationToken ct)
    {
        SetStage(p, st.Id, "running", round);
        var sequential = Code && st.Agents.Where(IsActive).Select(_reg.Require).Any(UsesTools);
        if (Code && (sequential || st.Verify != null))
        {
            var scaffold = await _app.EnsureScaffoldAsync(p, ct);
            if (!scaffold.Ok) _store.Publish(p, "log", new { level = "error", text = L("Could not create the app project: ", "Proyek aplikasi tidak bisa dibuat: ") + AppWorkspace.Tail(scaffold.Output, 6) });
        }
        var jobs = new List<Func<Task<StageResult>>>();
        foreach (var agentId in st.Agents.Where(IsActive))
        {
            var def = _reg.Require(agentId);
            var count = 1;
            if (def.Spawnable && p.Plan?.Instances.TryGetValue(agentId, out var n) == true)
                count = Math.Clamp(n, 1, Math.Max(1, def.MaxInstances));

            var modules = def.Spawnable && p.Plan?.Modules.Count > 0 ? p.Plan.Modules : null;
            var assignments = Enumerable.Range(0, count)
                .Select(k => modules == null ? null : string.Join(", ", modules.Where((_, idx) => idx % count == k)))
                .ToList();
            NoteStaffed(p, agentId, count);
            if (count > 1)
                _store.Publish(p, "spawn", new { agentId, stageId = st.Id, count, modules = assignments });

            for (var k = 0; k < count; k++)
            {
                var inst = k + 1; var module = assignments[k];
                jobs.Add(() => RunAgentAsync(p, st, def, inst, module, round, note, ct));
            }
        }
        // QA tests a copy of the app that the orchestrator builds, starts on a free port and stops afterwards,
        // so the agent never manages processes or ports itself.
        var testsApp = Code && _llm.SupportsTools && st.Agents.Where(IsActive).Any(a => a == "qa");
        if (testsApp) await StartTestAppAsync(p, ct);
        List<StageResult> results;
        try { results = sequential ? await RunSequentialAsync(jobs) : (await Task.WhenAll(jobs.Select(j => j()))).ToList(); }
        finally { if (testsApp) StopTestApp(p); }
        await VerifyBuildAsync(p, st, round, ct);
        SetStage(p, st.Id, "done", round);
        return results;
    }

    private async Task StartTestAppAsync(Project p, CancellationToken ct)
    {
        var rt = Rt(p);
        rt.TestUrl = null; rt.TestError = null;
        _store.Publish(p, "log", new { level = "info", text = L("Building and starting the app for QA...", "Membangun dan menjalankan aplikasi untuk QA...") });
        try
        {
            rt.TestUrl = await _app.StartTestAsync(p, TestPort, ct);
            _store.Publish(p, "log", new { level = "ok", text = L($"The app is running for QA at {rt.TestUrl}.", $"Aplikasi berjalan untuk QA di {rt.TestUrl}.") });
            // What a real browser sees (pages, canvas/WebGL, console errors, missing files), for checks curl cannot do.
            rt.BrowserCheck = null;
            if (_llm is AgentSdkLlm sdk)
            {
                rt.BrowserCheck = await sdk.BrowseAsync(rt.TestUrl, Path.Combine(_app.Dir(p), ".qa"), ct);
                if (rt.BrowserCheck != null)
                {
                    var first = rt.BrowserCheck.Split('\n').Skip(1).FirstOrDefault() ?? "";
                    var bad = rt.BrowserCheck.Contains("errors:\n") || rt.BrowserCheck.Contains("requests (missing");
                    _store.Publish(p, "log", new { level = bad ? "warn" : "ok", text = L("Browser check for QA: ", "Cek browser untuk QA: ") + first.TrimStart('-', ' ') +
                        (bad ? L(" (errors found; see the QA report)", " (ada error; lihat laporan QA)") : "") });
                }
            }
        }
        catch (InvalidOperationException ex)
        {
            rt.TestError = AppWorkspace.Tail(ex.Message, 25);
            _store.Publish(p, "log", new { level = "error", text = L("The app could not be started for QA: ", "Aplikasi tidak bisa dijalankan untuk QA: ") + AppWorkspace.Tail(ex.Message, 6) });
        }
    }

    private void StopTestApp(Project p)
    {
        _app.StopTest(p);
        _app.KillOrphans(p);   // anything an agent started from the app folder anyway
        Rt(p).TestUrl = null;
    }

    // ================= Code mode: agents write, build and run a real app =================

    private bool Code => _reg.Config.CodeMode.Enabled;

    private string AppFileList(Project p)
    {
        var dir = _app.Dir(p);
        if (!Directory.Exists(dir)) return "(none yet)";
        var files = Directory.EnumerateFiles(dir, "*", SearchOption.AllDirectories)
            .Select(f => Path.GetRelativePath(dir, f).Replace('\\', '/'))
            .Where(f => !f.StartsWith("bin/") && !f.StartsWith("obj/") && !f.StartsWith(".qa/") && !f.StartsWith(".refs/") && !f.EndsWith(".db"))
            .OrderBy(f => f).Take(80).ToList();
        return files.Count == 0 ? "(none yet)" : string.Join(", ", files);
    }

    /// This role works with real files right now (code mode on, engine can run tools, role has tools).
    private bool UsesTools(AgentDef def) => Code && _llm.SupportsTools && def.Tools is { Count: > 0 };

    private int TestPort => _reg.Config.CodeMode.AppPort + 50;

    /// Tool-using agents share one folder, so they take turns instead of running in parallel.
    private async Task<List<StageResult>> RunSequentialAsync(IEnumerable<Func<Task<StageResult>>> jobs)
    {
        var results = new List<StageResult>();
        foreach (var job in jobs) results.Add(await job());
        return results;
    }

    /// After a coding stage: build the app; on errors send them back to a developer, at most twice.
    private async Task VerifyBuildAsync(Project p, StageDef st, int round, CancellationToken ct)
    {
        if (!Code || st.Verify != "dotnet-build") return;
        for (var attempt = 1; ; attempt++)
        {
            _store.Publish(p, "log", new { level = "info", text = L("Build check: running dotnet build on the app...", "Cek build: menjalankan dotnet build pada aplikasi...") });
            var b = await _app.BuildAsync(p, ct);
            if (b.Ok) { _store.Publish(p, "log", new { level = "ok", text = L("Build check passed: the app compiles.", "Cek build lolos: aplikasi berhasil dikompilasi.") }); return; }
            var errors = AppWorkspace.Tail(b.Output, 40);
            _store.Publish(p, "log", new { level = "error", text = L($"Build check failed (attempt {attempt}):", $"Cek build gagal (percobaan {attempt}):") + "\n" + AppWorkspace.Tail(b.Output, 6) });
            var fixer = new[] { "backend_dev", "frontend_dev", "db_dev" }.Select(_reg.Get).FirstOrDefault(d => d is { Disabled: false } && UsesTools(d));
            if (attempt > 2 || fixer == null)
            {
                _store.Publish(p, "log", new { level = "warn", text = L("The app still does not build; QA will report it.", "Aplikasi masih gagal di-build; QA akan melaporkannya.") });
                return;
            }
            await RunAgentAsync(p, st, fixer, 1, null, round + attempt, "BUILD FAILED. Fix every error below, then run `dotnet build` until it succeeds:\n" + errors, ct);
        }
    }

    /// Code mode: build and start the finished app so the owner can open it.
    private async Task LaunchAppAsync(Project p, CancellationToken ct)
    {
        if (!Code || !_app.Exists(p)) return;
        try
        {
            var url = await _app.StartAsync(p, _reg.Config.CodeMode.AppPort, ct);
            _store.Publish(p, "app", new { status = "running", url });
            AddChat(p, "agent", IsActive("devops") ? "devops" : "support", L($"Your app is running at {url}. Open it from the 'Open app' button on the floor to try it.", $"Aplikasi Anda berjalan di {url}. Buka lewat tombol 'Buka aplikasi' di lantai operasi untuk mencobanya."));
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _store.Publish(p, "app", new { status = "failed", error = ex.Message });
            _store.Publish(p, "log", new { level = "error", text = L("The app could not be started: ", "Aplikasi tidak bisa dijalankan: ") + AppWorkspace.Tail(ex.Message, 6) });
        }
    }

    public async Task<string> StartAppAsync(Project p)
    {
        var url = await _app.StartAsync(p, _reg.Config.CodeMode.AppPort, CancellationToken.None);
        _store.Publish(p, "app", new { status = "running", url });
        _store.Save(p);
        return url;
    }

    public void StopApp(Project p)
    {
        _app.Stop(p);
        _store.Publish(p, "app", new { status = "stopped" });
        _store.Save(p);
    }

    private async Task<List<StageResult>> RunLoopStageAsync(Project p, StageDef st, CancellationToken ct)
    {
        var loop = st.Loop!;
        var back = _reg.Stage(loop.BackTo) ?? throw new InvalidOperationException($"Loop target '{loop.BackTo}' not found");
        var round = 1;
        while (true)
        {
            var results = await RunStageAsync(p, st, round, null, ct);
            // Strict: the larger of the stated count and the defect list, and "not ready" counts even without a number.
            var bugs = results.Sum(r => QaDefectCount(r.Handoff));
            var defects = results.SelectMany(r => r.Handoff.Data?["defects"] is JsonArray a ? a.Select(d => d?.ToString() ?? "").Where(x => x.Length > 0) : []).ToList();
            if (bugs > 0 && defects.Count == 0) defects = results.Where(r => QaDefectCount(r.Handoff) > 0).Select(r => r.Handoff.Summary).ToList();
            SetOpenIssues(p, "QA", defects);
            if (bugs == 0) return results;

            if (round >= loop.MaxRounds)
            {
                var d = await GateAsync(p, st, "qa-limit", L($"QA still reports {bugs} defects after {round} rounds. Release anyway?", $"QA masih melaporkan {bugs} cacat setelah {round} ronde. Tetap rilis?"), ct);
                if (d.Decision == "approve") return results;   // released with the defects still listed as open issues
                throw new OperationCanceledException();
            }
            round++;
            _store.Publish(p, "loop", new { fromStage = st.Id, toStage = back.Id, round, bugs, defects });
            await RunStageAsync(p, back, round, "Fix these defects:\n- " + string.Join("\n- ", defects), ct);
            _store.Publish(p, "handoff", new { fromStage = back.Id, toStage = st.Id });
        }
    }

    // ================= Release verdicts and open issues =================

    /// QA's defect count, read strictly: the larger of "bugs" (number or text) and the "defects" list,
    /// and at least 1 when QA says the build is not ready.
    private static int QaDefectCount(Handoff h)
    {
        var d = h.Data;
        var n = 0;
        if (d?["bugs"] is JsonValue v)
        {
            if (v.TryGetValue<int>(out var i)) n = i;
            else if (v.TryGetValue<double>(out var f)) n = (int)Math.Ceiling(f);
            else if (v.TryGetValue<string>(out var s) && int.TryParse(s.Trim(), out var j)) n = j;
        }
        if (d?["defects"] is JsonArray list) n = Math.Max(n, list.Count(x => !string.IsNullOrWhiteSpace(x?.ToString())));
        var notReady = (d?["ready"] is JsonValue r && r.TryGetValue<bool>(out var ok) && !ok) || NoGo(h);
        return n == 0 && notReady ? 1 : n;
    }

    /// The role's release verdict: "release": "no-go" (or "blocked") in its handoff data.
    private static bool NoGo(Handoff h) =>
        h.Data?["release"] is JsonValue v && v.TryGetValue<string>(out var s)
        && s.Trim().ToLowerInvariant().Replace("_", "-") is "no-go" or "nogo" or "no go" or "blocked";

    // ================= Internet access on request: the owner chooses which sites an agent may download from =================

    public record AccessRequest(string Host, string Why, string? License);

    private List<string> ApprovedHosts(Project p)
    {
        lock (p) return _reg.Config.CodeMode.AllowedHosts.Concat(p.AllowedHosts).Distinct(StringComparer.OrdinalIgnoreCase).ToList();
    }

    /// "access_requests": [{"host", "why", "license", "alternatives": [...]}] -> options not approved or refused yet.
    private List<AccessRequest> AccessRequests(Handoff h, Project p)
    {
        if (h.Data?["access_requests"] is not JsonArray arr) return new();
        var approved = ApprovedHosts(p);
        List<string> refused; lock (p) refused = p.RefusedHosts.ToList();
        var list = new List<AccessRequest>();
        foreach (var x in arr)
        {
            var why = x?["why"]?.ToString() ?? x?["purpose"]?.ToString() ?? "";
            var lic = x?["license"]?.ToString();
            var hosts = new List<string?> { x is JsonValue ? x.ToString() : x?["host"]?.ToString() };
            if (x?["alternatives"] is JsonArray alts) hosts.AddRange(alts.Select(a => a?.ToString()));
            foreach (var raw in hosts)
            {
                var host = HostOf(raw);
                if (host == null || approved.Any(a => host == a || host.EndsWith("." + a, StringComparison.OrdinalIgnoreCase))
                    || refused.Contains(host, StringComparer.OrdinalIgnoreCase) || list.Any(l => l.Host == host)) continue;
                list.Add(new AccessRequest(host, why, lic));
            }
        }
        return list.Take(8).ToList();
    }

    private static string? HostOf(string? s)
    {
        if (string.IsNullOrWhiteSpace(s)) return null;
        s = s.Trim();
        if (!s.Contains("://")) s = "https://" + s;
        return Uri.TryCreate(s, UriKind.Absolute, out var u) && u.Host.Contains('.') ? u.Host.ToLowerInvariant() : null;
    }

    /// Asks the owner which of the requested sites may be used (numbered options). Returns true if any was allowed.
    private async Task<bool> AskAccessAsync(Project p, AgentDef def, List<AccessRequest> reqs, CancellationToken ct)
    {
        var lines = reqs.Select((r, i) => $"{i + 1}. {r.Host}" + (r.Why.Length > 0 ? $" - {r.Why}" : "") + (string.IsNullOrWhiteSpace(r.License) ? "" : $" ({r.License})")).ToList();
        lines.Add(L("Reply with the numbers to allow (e.g. 1 or 1,3), 'all', or 'none'.", "Balas dengan nomor yang diizinkan (mis. 1 atau 1,3), 'semua', atau 'tidak'."));
        var reply = await AskCustomerAsync(p, def, lines, ct,
            L($"Our {RoleName(def)} needs to download from a site that is not approved yet:", $"{RoleName(def)} kami perlu mengunduh dari situs yang belum diizinkan:"));
        var t = reply.ToLowerInvariant();
        var pick = new HashSet<int>();
        if (Regex.IsMatch(t, @"\b(all|semua|semuanya|ya|yes|boleh)\b") && !Regex.IsMatch(t, @"\b(none|tidak|jangan|no)\b"))
            pick.UnionWith(Enumerable.Range(0, reqs.Count));
        foreach (Match m in Regex.Matches(t, @"\b\d{1,2}\b")) if (int.TryParse(m.Value, out var n) && n >= 1 && n <= reqs.Count) pick.Add(n - 1);
        for (var i = 0; i < reqs.Count; i++) if (t.Contains(reqs[i].Host)) pick.Add(i);
        lock (p)
        {
            for (var i = 0; i < reqs.Count; i++)
                if (pick.Contains(i)) p.AllowedHosts.Add(reqs[i].Host); else p.RefusedHosts.Add(reqs[i].Host);
        }
        var allowed = pick.Select(i => reqs[i].Host).ToList();
        _store.Publish(p, "log", new { level = allowed.Count > 0 ? "ok" : "info", text = allowed.Count > 0
            ? L($"Allowed for this project: {string.Join(", ", allowed)}.", $"Diizinkan untuk proyek ini: {string.Join(", ", allowed)}.")
            : L("No new site allowed; the agent continues without it.", "Tidak ada situs baru yang diizinkan; agent melanjutkan tanpanya.") });
        _store.Save(p);
        return allowed.Count > 0;
    }

    /// Projects that ran before open issues were tracked: rebuild the list from the last QA / Security / DevOps reports.
    public void SeedOpenIssues(Project p)
    {
        lock (p) if (p.OpenIssues.Count > 0) return;
        Handoff? Last(string agentId)
        {
            ArtifactRef? a; lock (p) a = p.Artifacts.LastOrDefault(x => x.AgentId == agentId && !x.Helper);
            var text = a == null ? null : _store.ReadArtifact(p, a.Name);
            return text == null ? null : ParseHandoff(text);
        }
        var qa = Last("qa");
        if (qa != null && QaDefectCount(qa) > 0)
        {
            var defects = qa.Data?["defects"] is JsonArray d ? d.Select(x => x?.ToString() ?? "").Where(x => x.Length > 0).ToList() : new();
            lock (p) p.OpenIssues.AddRange((defects.Count > 0 ? defects : [qa.Summary]).Select(x => "QA: " + x));
        }
        foreach (var id in new[] { "security", "devops" })
            if (Last(id) is { } h && (NoGo(h) || h.Status == "blocked") && _reg.Get(id) is { } def)
                lock (p) p.OpenIssues.Add($"{RoleName(def)}: {h.Summary}");
        if (p.OpenIssues.Count > 0) _store.Save(p);
    }

    /// The closing message tells the truth: all stages ran, but are all modules done and is anything still open?
    private string CompletionMessage(Project p)
    {
        var mods = Handover.ModuleStatus(p);
        var done = mods.Count(m => m.State == "done");
        List<string> open; lock (p) open = p.OpenIssues.ToList();
        if (open.Count == 0 && (mods.Count == 0 || done == mods.Count))
            return L("Your system is live. Thank you for working with us; reply here any time you need something.",
                     "Sistem Anda sudah live. Terima kasih telah bekerja sama dengan kami; balas di sini kapan pun Anda butuh sesuatu.");
        var sb = new StringBuilder(L("All stages have run and the app is delivered, but it is not finished yet:",
                                     "Semua tahap sudah dijalankan dan aplikasi diserahkan, tetapi belum tuntas:"));
        if (mods.Count > 0) sb.Append('\n').Append(L($"- {done} of {mods.Count} modules are done.", $"- {done} dari {mods.Count} modul selesai."));
        foreach (var x in open.Take(8)) sb.Append("\n- ").Append(x);
        if (open.Count > 8) sb.Append('\n').Append(L($"- and {open.Count - 8} more open issues.", $"- dan {open.Count - 8} masalah terbuka lainnya."));
        sb.Append('\n').Append(L("Tell me what to fix next, or open the Modules tab for the details.", "Beri tahu apa yang perlu diperbaiki berikutnya, atau buka tab Modul untuk rinciannya."));
        _store.Publish(p, "log", new { level = "warn", text = L($"Delivered with {open.Count} open issues and {mods.Count - done} modules not done.", $"Diserahkan dengan {open.Count} masalah terbuka dan {mods.Count - done} modul belum selesai.") });
        return sb.ToString();
    }

    /// Open issues by source (QA, Security, DevOps...): replaced each time that source reports again.
    private void SetOpenIssues(Project p, string source, IEnumerable<string> issues)
    {
        lock (p)
        {
            p.OpenIssues.RemoveAll(x => x.StartsWith(source + ": "));
            p.OpenIssues.AddRange(issues.Where(x => !string.IsNullOrWhiteSpace(x)).Select(x => $"{source}: {x.Trim()}"));
        }
        _store.Publish(p, "issues", new { open = p.OpenIssues.ToList() });
    }

    private async Task<StageResult> RunAgentAsync(Project p, StageDef st, AgentDef def, int inst, string? module, int round, string? note, CancellationToken ct, int askRound = 0)
    {
        string? answers = null;   // the customer's replies reach every agent through p.CustomerAnswers (see BuildContext)
        await EnforceBudgetAsync(p, st, ct);

        var canDelegate = CanDelegate(p, def);
        var system = BuildSystem(def, canDelegate);
        var msg = BuildContext(p, st, def, inst, module, round, note, answers);

        _store.Publish(p, "agent", new { agentId = def.Id, instance = inst, stageId = st.Id, status = "working", module, round,
            model = _reg.ResolveModel(def.Id, p.ModelOverrides).Model, source = _reg.ResolveModel(def.Id, p.ModelOverrides).Source });
        if (module != null && askRound == 0)
            foreach (var code in ModCode.Matches(module).Select(m => m.Value).Distinct())
                _store.Publish(p, "module", new { module = code, agentId = def.Id, instance = inst, stageId = st.Id, round, state = "working",
                    text = round > 1 ? L($"started rework (round {round})", $"mulai perbaikan (ronde {round})") : L("started work", "mulai dikerjakan") });

        var sw = System.Diagnostics.Stopwatch.StartNew();
        LlmResult result; ResolvedModel model;
        try
        {
            (result, model) = await CallAsync(p, def, st.Id, system, [("user", msg)], ct, inst);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _store.Publish(p, "agent", new { agentId = def.Id, instance = inst, stageId = st.Id, status = "error", summary = ex.Message });
            throw;
        }
        var handoff = ParseHandoff(result.Text);
        if (result.StopReason is "max_tokens" or "length")
            _store.Publish(p, "log", new { level = "warn", text = L($"{RoleName(def)} hit its output limit ({OutputLimit(def):N0} tokens); the document may be cut short. Raise its limit in the agent settings.", $"{RoleName(def)} mencapai batas keluaran ({OutputLimit(def):N0} token); dokumennya mungkin terpotong. Naikkan batasnya di pengaturan agent.") });

        if (handoff.Status == "need_info" && def.CanAskCustomer && handoff.OpenQuestions.Count > 0 && askRound < MaxAskRounds)
        {
            Record(p, def, st.Id, inst, model, result, "need_info", handoff.Summary, sw.ElapsedMilliseconds);
            _store.Publish(p, "agent", new { agentId = def.Id, instance = inst, stageId = st.Id, status = "need_info", summary = handoff.Summary });
            await AskCustomerAsync(p, def, handoff.OpenQuestions, ct);
            return await RunAgentAsync(p, st, def, inst, module, round, note, ct, askRound + 1);
        }

        // The agent needs a site that is not approved yet: ask the owner, with the options, and run it again if any is allowed.
        var access = AccessRequests(handoff, p);
        if (access.Count > 0 && askRound < MaxAskRounds)
        {
            Record(p, def, st.Id, inst, model, result, "need_info", handoff.Summary, sw.ElapsedMilliseconds);
            _store.Publish(p, "agent", new { agentId = def.Id, instance = inst, stageId = st.Id, status = "need_info", summary = handoff.Summary });
            if (await AskAccessAsync(p, def, access, ct))
                return await RunAgentAsync(p, st, def, inst, module, round, note, ct, askRound + 1);
        }
        if (def.Id != "qa" && handoff.Data?["release"] != null)
        {
            // A release verdict: no-go blocks (the owner decides), and what blocks it stays listed as open issues.
            var blockers = handoff.Data?["blockers"] is JsonArray ba ? ba.Select(x => x?.ToString() ?? "").Where(x => x.Length > 0).ToList() : new();
            if (NoGo(handoff))
            {
                if (handoff.Status == "done") handoff.Status = "blocked";
                SetOpenIssues(p, RoleName(def), blockers.Count > 0 ? blockers : [handoff.Summary]);
            }
            else SetOpenIssues(p, RoleName(def), []);
        }

        if (handoff.Status == "delegate" && canDelegate)
        {
            Record(p, def, st.Id, inst, model, result, "delegate", handoff.Summary, sw.ElapsedMilliseconds);
            (result, model, handoff) = await DelegateAsync(p, st, def, inst, module, round, note, answers, handoff, msg, ct);
        }
        else if (handoff.Status == "delegate")
        {
            handoff.Status = "done";   // not allowed to delegate here; keep whatever it wrote
        }

        var name = $"{st.Id}-{def.Id}{(inst > 1 ? $"-{inst}" : "")}{(round > 1 ? $"-r{round}" : "")}.md";
        var title = RoleName(def) + (module != null ? $" · {module}" : "") + (round > 1 ? L($" (round {round})", $" (ronde {round})") : "");
        var art = new ArtifactRef { Name = name, Title = title, AgentId = def.Id, StageId = st.Id, Round = round, Instance = inst };
        _store.WriteArtifact(p, art, result.Text);
        _store.Publish(p, "artifact", art);

        if (def.Id == "project_manager" && handoff.Data != null)
        {
            var plan = new ProjectPlan
            {
                Modules = handoff.Data["modules"]?.AsArray().Select(ModuleName).Where(x => x.Length > 0).ToList() ?? new(),
                Instances = handoff.Data["instances"]?.AsObject().ToDictionary(kv => kv.Key, kv => kv.Value?.GetValue<int>() ?? 1) ?? new(),
            };
            lock (p) p.Plan = plan;
            _store.Publish(p, "plan", plan);
        }

        Record(p, def, st.Id, inst, model, result, handoff.Status, handoff.Summary, sw.ElapsedMilliseconds);
        PublishModuleLog(p, def, inst, st, round, handoff);
        var last = p.Runs.Last(r => r.AgentId == def.Id && r.Instance == inst);
        _store.Publish(p, "agent", new { agentId = def.Id, instance = inst, stageId = st.Id, status = handoff.Status == "blocked" ? "blocked" : "done",
            summary = handoff.Summary, model = model.Model, source = model.Source, tokensIn = last.TokensIn, tokensOut = last.TokensOut, cost = last.Cost, artifact = name });
        return new StageResult(def, inst, handoff);
    }

    // ================= Delegation: a role splits its own task across helpers of the same role and model =================

    /// A role may split its task when it is allowed more than one agent and is not already one of several
    /// parallel instances staffed by the Project Manager.
    /// Every agent of a role, also one of several the PM staffed in parallel, may call in helpers.
    private bool CanDelegate(Project p, AgentDef def) =>
        def.MaxInstances >= 2 && !UsesTools(def);   // tool-using helpers would write the same files at once

    /// Card numbers for extra agents of a role. A card held by a staffed agent, by the lead, or by a helper that is
    /// still working is never shared: the new agent takes the lowest free number above them, which is a new box on
    /// the floor whenever the existing ones are busy. Idle helper boxes from earlier splits are reused.
    private int[] ReserveInstances(Project p, string agentId, int lead, int count)
    {
        var rt = Rt(p);
        lock (rt.Busy)
        {
            var busy = rt.Busy.TryGetValue(agentId, out var b) ? b : rt.Busy[agentId] = new HashSet<int>();
            var staffed = rt.Staffed.GetValueOrDefault(agentId, 1);
            var picked = new List<int>();
            for (var n = 2; picked.Count < count; n++)
                if (n > staffed && n != lead && !busy.Contains(n)) picked.Add(n);
            busy.UnionWith(picked);
            return picked.ToArray();
        }
    }

    private void ReleaseInstances(Project p, string agentId, IEnumerable<int> cards)
    {
        var rt = Rt(p);
        lock (rt.Busy) if (rt.Busy.TryGetValue(agentId, out var b)) b.ExceptWith(cards);
    }

    /// The PM staffed `count` parallel agents of a role: cards 1..count belong to them.
    private void NoteStaffed(Project p, string agentId, int count)
    {
        var rt = Rt(p);
        lock (rt.Busy) rt.Staffed[agentId] = count;
    }

    private string BuildSystem(AgentDef def, bool canDelegate, string? extra = null)
    {
        var sb = new StringBuilder();
        sb.Append($"You are the {def.Role} at {_reg.Config.Company}, a full-stack digital company staffed by AI agents. {def.Persona}\n\n");
        sb.Append("Work only from the brief, the customer's answers and the prior work you are given. Never invent customer facts.\n");
        if (def.CanAskCustomer && extra == null)   // helpers and merges cannot pause to ask
            sb.Append("ASKING THE CUSTOMER: whenever something only the customer can know or decide would change your work (a business rule, a priority, " +
                      "a number or volume, a preference, an integration or data detail, a trade-off), do not guess. Reply with status \"need_info\", " +
                      "a one-line summary and the questions in open_questions, and nothing else; you will be called again with the reply and can ask again " +
                      "if it raises new questions. Ask in " + DocLanguage + ", at most 5 questions per round, each answerable " +
                      "in a sentence, offering options when that helps. Never ask what CUSTOMER ANSWERS already settle. " +
                      "For small details that do not change the outcome, choose a sensible default and state it as an assumption instead of asking.\n");
        else
            sb.Append("Where the customer has not said something, state your assumption explicitly.\n");
        sb.Append($"Write your deliverable in {DocLanguage} as a Markdown document (the json summary and questions too). End your reply with one fenced json block:\n");
        sb.Append("```json\n{\"status\": \"done | need_info | blocked\", \"summary\": \"<one sentence for the team>\", \"open_questions\": [], \"data\": {}}\n```\n");
        if (Code)
            sb.Append($"TARGET STACK (mandatory for every design and line of code): {_reg.Config.CodeMode.Stack}. One ASP.NET Core project, App.csproj, " +
                      "started with `dotnet run`; SQLite file database through EF Core; plain HTML/CSS/JavaScript pages in wwwroot (no npm or front-end build step). " +
                      "No Docker, no cloud services. External systems (WhatsApp, email, payment, SSO) sit behind an interface with a fake implementation that logs what it would send, " +
                      "plus a simple sign-in with seeded demo users per role.\n");
        if (UsesTools(def))
        {
            sb.Append("WORKSPACE: your current folder IS the application's source folder (it contains App.csproj). Use your tools to create and edit real files there; " +
                      "read the existing files first and build on them, do not start over. Never touch anything outside this folder. " +
                      "Before you finish, run `dotnet build` and fix every error. ");
            if (def.Id == "qa")
                sb.Append("TESTING: the app has already been built from the current code and is running at the TEST URL in your message (a fresh copy started for you). " +
                          "Do NOT build, start, stop or kill the app, and do not edit any file: only read the code and test the running app with curl. " +
                          "Work efficiently: first list the checks per module from the acceptance criteria, then run them, combining several curl calls in one command " +
                          "(for example a for-loop over URLs that prints the status code); aim for under 30 tool calls in total. " +
                          "If the TEST URL is missing because the app failed to build or start, do not try to start it yourself: report that as one blocking defect with the error shown. " +
                          "Your message may contain a BROWSER CHECK made with a real browser (screenshots in .qa/, console errors, failed requests): use it for what curl cannot see " +
                          "(pages, canvas/WebGL, scripts, missing assets), and Read the screenshots. " +
                          "Report each defect with the exact request and what came back. In the handoff data put {\"bugs\": n, \"defects\": [\"High: ...\", \"Low: ...\"], \"ready\": true|false, \"release\": \"go\"|\"no-go\"}: " +
                          "every open defect is in the list with its severity first, n equals the number of defects, and ready is true only when nothing must be fixed before release. ");
            sb.Append(def.Id == "qa"
                ? "Your final reply is a short test report (at most about 300 words): what you checked per module, what passed, the defects. End with the json block."
                : "Your final reply is a short report (at most about 300 words): what you built or changed, which files, how to try it, known gaps. End with the json block.");
        }
        else
        {
            sb.Append($"LENGTH: stay under about {TargetWords(def):N0} words in total. Be dense: tables and short bullets, no repetition, no restating the brief or other teams' documents. ");
            sb.Append("For code, give the key files and the non-obvious logic only, not boilerplate. The final json block is mandatory, so leave room for it.");
        }
        if (canDelegate)
            sb.Append($"\n\nSPLITTING WORK: if this task is clearly too large to do well in one reply, you may hand parts to up to {def.MaxInstances - 1} helpers " +
                      "who have your role and your model. Then reply with ONLY the json block: " +
                      "{\"status\": \"delegate\", \"summary\": \"<why>\", \"data\": {\"subtasks\": [{\"title\": \"...\", \"instructions\": \"...\"}]}} " +
                      "with 2 or more subtasks that do not overlap. Each helper writes one part; afterwards you merge the parts into the final document. " +
                      "Splitting costs more, so do the task yourself unless it is genuinely big.");
        if (def.Id is "security" or "devops" && extra == null)
            sb.Append("\n\nRELEASE VERDICT: in the json data add \"release\": \"go\" or \"no-go\". Say no-go when anything must be fixed before the client can rely on it " +
                      "(open High defects, missing required parts, unverified core features). Be consistent: if your summary says it is not ready or blocked, the verdict is no-go, " +
                      "and list what blocks it in \"blockers\": [...].");
        if (extra != null) sb.Append("\n\n" + extra);
        sb.Append(RulesBlock(def));
        return sb.ToString();
    }

    private async Task<(LlmResult, ResolvedModel, Handoff)> DelegateAsync(Project p, StageDef st, AgentDef def, int inst, string? module, int round,
        string? note, string? answers, Handoff plan, string leadContext, CancellationToken ct)
    {
        var subtasks = (plan.Data?["subtasks"]?.AsArray() ?? [])
            .Select(x => (Title: x?["title"]?.ToString() ?? "", Instructions: x?["instructions"]?.ToString() ?? ""))
            .Where(s => s.Title.Length > 0)
            .Take(def.MaxInstances - 1)
            .ToList();

        string mergeNote;
        if (subtasks.Count < 2)
        {
            mergeNote = "Splitting was not possible (fewer than two usable subtasks). Do the whole task yourself now.";
        }
        else
        {
            var helpers = ReserveInstances(p, def.Id, inst, subtasks.Count);
            string[] parts;
            try
            {
                // count = highest card the role needs now: the floor adds boxes up to it and keeps the existing ones
                _store.Publish(p, "spawn", new { agentId = def.Id, stageId = st.Id, count = helpers.Max(), helpers = helpers.Length, lead = inst, reason = "delegate", summary = plan.Summary,
                    modules = new[] { L("lead: plans and merges", "pemimpin: merencanakan dan menggabungkan") }.Concat(subtasks.Select(s => s.Title)).ToList() });
                parts = await Task.WhenAll(subtasks.Select((s, k) =>
                    RunHelperAsync(p, st, def, helpers[k], k + 1, subtasks.Count, s.Title, s.Instructions, module, round, note, answers, ct)));
            }
            finally { ReleaseInstances(p, def.Id, helpers); }

            var sbParts = new StringBuilder("PARTS FROM YOUR HELPERS. Merge them into ONE final deliverable: remove overlaps, fill gaps, keep one consistent numbering, and end with the json block.\n");
            for (var k = 0; k < parts.Length; k++)
                sbParts.AppendLine($"\n===== Part {k + 1}: {subtasks[k].Title} =====\n{parts[k]}");
            mergeNote = sbParts.ToString();
        }

        await EnforceBudgetAsync(p, st, ct);
        _store.Publish(p, "agent", new { agentId = def.Id, instance = inst, stageId = st.Id, status = "working", module = "merging the parts", round });
        var (result, model) = await CallAsync(p, def, st.Id, BuildSystem(def, canDelegate: false, "Merge now. Do not ask the customer anything in this step."),
            [("user", leadContext + "\n\n" + mergeNote)], ct, inst);
        var handoff = ParseHandoff(result.Text);
        if (handoff.Status == "delegate") handoff.Status = "done";
        return (result, model, handoff);
    }

    private async Task<string> RunHelperAsync(Project p, StageDef st, AgentDef def, int inst, int part, int of, string title, string instructions,
        string? module, int round, string? note, string? answers, CancellationToken ct)
    {
        await EnforceBudgetAsync(p, st, ct);
        _store.Publish(p, "agent", new { agentId = def.Id, instance = inst, stageId = st.Id, status = "working", module = title, round,
            model = _reg.ResolveModel(def.Id, p.ModelOverrides).Model, source = _reg.ResolveModel(def.Id, p.ModelOverrides).Source });

        var system = BuildSystem(def, canDelegate: false,
            $"You are helper {part} of {of} for the lead {def.Role}. Write ONLY your assigned part, as a section the lead will merge. Do not delegate.");
        var msg = BuildContext(p, st, def, 1, module, round, note, answers) + $"\n\nYOUR SUBTASK ({part} of {of}): {title}\n{instructions}";
        var sw = System.Diagnostics.Stopwatch.StartNew();
        LlmResult result; ResolvedModel model;
        try { (result, model) = await CallAsync(p, def, st.Id, system, [("user", msg)], ct, inst); }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _store.Publish(p, "agent", new { agentId = def.Id, instance = inst, stageId = st.Id, status = "error", summary = ex.Message });
            throw;
        }

        // Named by the helper's own card number: several leads of one role may split work in the same stage.
        var name = $"{st.Id}-{def.Id}{(round > 1 ? $"-r{round}" : "")}-part{inst}.md";
        var art = new ArtifactRef { Name = name, Title = RoleName(def) + L($" · part {part}: {title}", $" · bagian {part}: {title}"), AgentId = def.Id, StageId = st.Id, Round = round, Instance = inst, Helper = true };
        _store.WriteArtifact(p, art, result.Text);
        _store.Publish(p, "artifact", art);

        var h = ParseHandoff(result.Text);
        Record(p, def, st.Id, inst, model, result, "done", h.Summary, sw.ElapsedMilliseconds);
        var last = p.Runs.Last(r => r.AgentId == def.Id && r.Instance == inst);
        _store.Publish(p, "agent", new { agentId = def.Id, instance = inst, stageId = st.Id, status = "done", summary = $"Part {part}: {h.Summary}",
            model = model.Model, source = model.Source, tokensIn = last.TokensIn, tokensOut = last.TokensOut, cost = last.Cost, artifact = name });
        return result.Text;
    }

    private int OutputLimit(AgentDef def) => def.MaxOutputTokens is > 0 ? def.MaxOutputTokens.Value : _reg.Config.Defaults.MaxOutputTokens;

    /// Soft length target, far below the hard cap: thinking tokens count against the cap (a 300-word reply
    /// used about 800 thinking tokens in a test), and the final handoff block must fit.
    private int TargetWords(AgentDef def) => Math.Max(100, (int)(OutputLimit(def) * 0.25 / 50) * 50);

    private const int MaxDocChars = 40_000;   // ~10k tokens per document, a safety net for oversized replies

    /// Documents this agent should see: the newest version of each document from the roles it reads,
    /// plus its own previous work when it is redoing a task.
    private List<ArtifactRef> RelevantDocs(Project p, AgentDef def, int inst, int round)
    {
        List<ArtifactRef> all;
        lock (p) all = p.Artifacts.ToList();
        return all
            .Where(a => !a.Helper)
            .Where(a => a.AgentId == def.Id
                ? round > 1 && a.Instance == inst
                : def.Reads == null || def.Reads.Contains(a.AgentId))
            .GroupBy(a => (a.AgentId, a.Instance))
            .Select(g => g.OrderByDescending(a => a.Round).First())
            .OrderBy(a => all.IndexOf(a))
            .ToList();
    }

    private string BuildContext(Project p, StageDef st, AgentDef def, int inst, string? module, int round, string? note, string? answers)
    {
        var sb = new StringBuilder();
        sb.AppendLine($"PROJECT: {p.Title} ({p.Id})");
        sb.AppendLine($"STAGE: {st.Title}");
        if (module != null) sb.AppendLine($"ASSIGNED MODULE: {module}");
        List<string> planned;
        lock (p) planned = p.Plan?.Modules.ToList() ?? new();
        if (def.Id == Handover.WriterId) sb.AppendLine(_handover.FactsForWriter(p));
        else if (planned.Count > 0 && def.Id != "project_manager")
            sb.AppendLine("MODULE LOG: the project's modules are: " + string.Join("; ", planned) + ". In the json block's data, add " +
                          "\"modules\": {\"M01\": \"<one line: what you did or found for that module, ending with its state: done, partial, blocked or not started>\"} " +
                          $"for every module you worked on or checked, keyed by module code; skip modules you did not touch. Write these lines in {DocLanguage}.");
        if (UsesTools(def))
        {
            sb.AppendLine("APP FOLDER: your current directory (App.csproj). Files now: " + AppFileList(p));
            var hosts = ApprovedHosts(p);
            sb.AppendLine("DOWNLOADS: the internet is closed except " + (hosts.Count > 0 ? "these approved sites: " + string.Join(", ", hosts) : "nothing (no site approved yet)") +
                          ". Download libraries and open-licensed assets (CC0, CC-BY, MIT...) from them with curl only (GET), save them inside the app " +
                          "(e.g. wwwroot/vendor, wwwroot/assets) so the app works offline, never hotlink at runtime, and record each file's source URL and license in ASSETS.md. " +
                          "If you need any other site, do not try to get around the block: carry on with what you can, and add to your json data " +
                          "\"access_requests\": [{\"host\": \"site.org\", \"why\": \"what you need from it\", \"license\": \"its license\", \"alternatives\": [\"other.org\"]}]. " +
                          "The CEO is asked to choose, and you are called again if a site is allowed.");
            if (def.Id == "qa")
            {
                var rt = Rt(p);
                if (rt.TestUrl != null) sb.AppendLine($"TEST URL: {rt.TestUrl}  (already running; do not start or stop it)");
                else sb.AppendLine("TEST URL: none. The app could not be built or started for testing:\n" + (rt.TestError ?? "unknown error"));
                if (rt.BrowserCheck != null) sb.AppendLine(rt.BrowserCheck);
            }
        }
        if (round > 1) sb.AppendLine($"ROUND {round}");
        if (!string.IsNullOrWhiteSpace(note)) sb.AppendLine("NOTE FROM REVIEW:\n" + note);
        List<CustomerAnswer> qas;
        lock (p) qas = p.CustomerAnswers.ToList();
        if (qas.Count > 0)
        {
            sb.AppendLine("CUSTOMER ANSWERS (questions the team asked the customer, with the replies; treat these as decisions):");
            foreach (var qa in qas)
                sb.AppendLine($"- Asked by {qa.Role}: " + string.Join(" | ", qa.Questions) + "\n  Reply: " + qa.Reply);
        }
        if (answers != null) sb.AppendLine("CUSTOMER ANSWERS:\n" + answers);
        sb.AppendLine("\nCUSTOMER BRIEF:");
        foreach (var k in Slots) sb.AppendLine($"- {k}: {(p.Brief.TryGetValue(k, out var v) ? v : "(unknown)")}");
        sb.Append(ReferencesBlock(p, UsesTools(def)));

        var docs = RelevantDocs(p, def, inst, round);
        if (docs.Count > 0)
        {
            sb.AppendLine("\nRELEVANT WORK FROM THE TEAM (latest versions):");
            foreach (var a in docs)
            {
                var text = _store.ReadArtifact(p, a.Name) ?? "";
                if (text.Length > MaxDocChars) text = text[..MaxDocChars] + "\n[...document shortened to save tokens...]";
                sb.AppendLine($"\n===== {a.Title} [{a.Name}] =====\n{text}");
            }
        }
        return sb.ToString();
    }

    // ================= Gates, questions, budget =================

    private async Task<GateDecision> GateAsync(Project p, StageDef st, string gateId, string label, CancellationToken ct)
    {
        var arts = p.Artifacts.Where(a => a.StageId == st.Id).Select(a => a.Name).ToList();
        lock (p) p.PendingGate = new PendingGate { StageId = st.Id, GateId = gateId, Label = label, Artifacts = arts };
        SetStatus(p, ProjectStatus.WaitingGate);
        _store.Publish(p, "gate", new { stageId = st.Id, gateId, label, status = "waiting", artifacts = arts });

        GateDecision d;
        // Auto-approve covers the normal pipeline gates only; money and blocking findings always need you.
        // Auto-approve never covers money, blocking findings, the QA limit, or going to production with open issues.
        bool openIssues; lock (p) openIssues = p.OpenIssues.Count > 0;
        if (p.AutoApprove && gateId is not ("blocked" or "budget" or "qa-limit") && !(gateId == "production" && openIssues))
        {
            await Task.Delay(1800, ct);
            d = new GateDecision("approve", L("Auto-approved", "Disetujui otomatis"));
        }
        else
        {
            var tcs = new TaskCompletionSource<GateDecision>(TaskCreationOptions.RunContinuationsAsynchronously);
            Rt(p).Gate = tcs;
            using (ct.Register(() => tcs.TrySetCanceled()))
                d = await tcs.Task;
        }
        lock (p) p.PendingGate = null;
        _store.Publish(p, "gate", new { stageId = st.Id, gateId, label, status = d.Decision switch { "approve" => "approved", "revise" => "revised", _ => "rejected" }, note = d.Note });
        SetStatus(p, ProjectStatus.Running);
        return d;
    }

    public bool Decide(Project p, string decision, string? note)
    {
        var tcs = Rt(p).Gate;
        if (p.Status != ProjectStatus.WaitingGate || tcs == null) return false;
        return tcs.TrySetResult(new GateDecision(decision, note));
    }

    private async Task<string> AskCustomerAsync(Project p, AgentDef def, List<string> questions, CancellationToken ct, string? intro = null)
    {
        // Agents working in parallel take turns, so each question set gets its own reply.
        var rt = Rt(p);
        await rt.AskLock.WaitAsync(ct);
        try
        {
            lock (p) p.PendingQuestion = new PendingQuestion { AgentId = def.Id, Questions = questions };
            var text = intro != null
                ? intro + "\n" + string.Join("\n", questions)   // the caller already numbered its options
                : (questions.Count == 1 ? L($"Our {RoleName(def)} has a question:\n", $"{RoleName(def)} kami punya satu pertanyaan:\n")
                                        : L($"Our {RoleName(def)} has {questions.Count} questions:\n", $"{RoleName(def)} kami punya {questions.Count} pertanyaan:\n"))
                  + string.Join("\n", questions.Select((q, i) => $"{i + 1}. {q}"));
            AddChat(p, "agent", def.Id, text);
            _store.Publish(p, "question", new { agentId = def.Id, questions });
            SetStatus(p, ProjectStatus.WaitingCustomer);
            _store.Save(p);

            var tcs = new TaskCompletionSource<string>(TaskCreationOptions.RunContinuationsAsynchronously);
            rt.Answer = tcs;
            string answer;
            using (ct.Register(() => tcs.TrySetCanceled()))
                answer = await tcs.Task;
            rt.Answer = null;
            lock (p)
            {
                p.PendingQuestion = null;
                p.CustomerAnswers.Add(new CustomerAnswer { AgentId = def.Id, Role = def.Role, Questions = questions, Reply = answer });
            }
            AddChat(p, "agent", def.Id, L($"Thank you. The {RoleName(def)} is continuing with your answer.", $"Terima kasih. {RoleName(def)} melanjutkan dengan jawaban Anda."));
            SetStatus(p, ProjectStatus.Running);
            _store.Save(p);
            return answer;
        }
        finally { rt.AskLock.Release(); }
    }

    // ================= Pause: agents at work finish their step, nothing new starts until Continue =================

    public bool CanPause(Project p) => p.Status is ProjectStatus.Running or ProjectStatus.WaitingGate or ProjectStatus.WaitingCustomer && Rt(p).PauseGate == null;

    public void Pause(Project p)
    {
        var rt = Rt(p);
        lock (p)
        {
            if (!CanPause(p)) throw new InvalidOperationException(L("Only a running project can be paused.", "Hanya proyek yang sedang berjalan yang bisa dijeda."));
            rt.PauseGate = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        }
        if (p.Status == ProjectStatus.Running) SetStatus(p, ProjectStatus.Paused);
        if (_llm is AgentSdkLlm sdk) _ = sdk.SetPausedAsync(p.Id, true);
        _store.Publish(p, "log", new { level = "warn", text = L("Paused. Agents at work stop at their next action and wait; nothing new starts until you press Continue. (A reply already being written is finished first.)",
            "Dijeda. Agent yang sedang bekerja berhenti di aksi berikutnya dan menunggu; tidak ada yang baru dimulai sampai Anda menekan Teruskan. (Balasan yang sedang ditulis diselesaikan dulu.)") });
        _store.Save(p);
    }

    public void Unpause(Project p)
    {
        var rt = Rt(p);
        var gate = rt.PauseGate ?? throw new InvalidOperationException(L("The project is not paused.", "Proyek tidak sedang dijeda."));
        rt.PauseGate = null;
        if (_llm is AgentSdkLlm sdk) _ = sdk.SetPausedAsync(p.Id, false);
        if (p.Status == ProjectStatus.Paused) SetStatus(p, ProjectStatus.Running);
        _store.Publish(p, "log", new { level = "info", text = L("Continued.", "Diteruskan.") });
        gate.TrySetResult();
        _store.Save(p);
    }

    private static async Task WaitIfPausedAsync(Runtime rt, CancellationToken ct)
    {
        while (rt.PauseGate is { } gate) await gate.Task.WaitAsync(ct);
    }

    private async Task EnforceBudgetAsync(Project p, StageDef st, CancellationToken ct)
    {
        await WaitIfPausedAsync(Rt(p), ct);   // every agent passes here before it starts
        var step = _reg.Config.Budget.MaxTokensPerProject;
        var usdStep = _reg.Config.Budget.MaxUsdPerProject;
        bool OverTokens() => step > 0 && p.TokensIn + p.TokensOut >= step + p.ExtraBudget;
        bool OverUsd() => usdStep > 0 && p.Cost >= usdStep + p.ExtraUsd;
        if (!OverTokens() && !OverUsd()) return;
        var rt = Rt(p);
        await rt.BudgetLock.WaitAsync(ct);
        try
        {
            if (!OverTokens() && !OverUsd()) return;   // another agent's gate was already approved
            var used = p.TokensIn + p.TokensOut;
            var label = OverUsd()
                ? L($"Dollar budget reached (${p.Cost:N2} of ${usdStep + p.ExtraUsd:N2}). Approve to allow ${usdStep:N2} more.", $"Anggaran dolar tercapai (${p.Cost:N2} dari ${usdStep + p.ExtraUsd:N2}). Setujui untuk menambah ${usdStep:N2}.")
                : L($"Token budget reached ({used:N0} of {step + p.ExtraBudget:N0}, ${p.Cost:N2} so far). Approve to allow {step:N0} more tokens.", $"Anggaran token tercapai ({used:N0} dari {step + p.ExtraBudget:N0}, ${p.Cost:N2} sejauh ini). Setujui untuk menambah {step:N0} token.");
            var d = await GateAsync(p, st, "budget", label, ct);
            if (d.Decision != "approve") { Stop(p, L("Stopped at the budget.", "Dihentikan di batas anggaran.")); throw new OperationCanceledException(); }
            p.ExtraBudget = used;      // next stop: one more step from current usage
            p.ExtraUsd = p.Cost;
            PublishUsage(p);           // the HUD shows the new next stop
        }
        finally { rt.BudgetLock.Release(); }
    }

    public void Stop(Project p, string? reason = null)
    {
        if (reason != null) _store.Publish(p, "log", new { level = "warn", text = reason });
        Rt(p).Cts.Cancel();
        SetStatus(p, ProjectStatus.Stopped);
        _store.Save(p);
    }

    // ================= Helpers =================

    private bool IsActive(string agentId) => _reg.Get(agentId) is { Disabled: false };

    /// No sign of life for this long and the team is told the agent may be stuck (it keeps waiting).
    private const int StallSec = 180;

    private async Task<(LlmResult, ResolvedModel)> CallAsync(Project p, AgentDef def, string stageId, string system, List<(string, string)> messages, CancellationToken ct, int inst = 1)
    {
        var model = _reg.ResolveModel(def.Id, p.ModelOverrides);
        var tools = stageId != "chat" && UsesTools(def);
        var cm = _reg.Config.CodeMode;
        var who = RoleName(def) + (inst > 1 ? $" #{inst}" : "");
        bool warnedStall = false, warnedLimit = false; int warnedRetry = 0;
        void OnProgress(AgentProgress g)
        {
            // Live tick for the floor (not stored), plus one clear line in Activity when something is wrong.
            _store.PublishLive(p, "progress", new { agentId = def.Id, instance = inst, g.Phase, g.Tool, g.Detail, tokens = g.OutTokens, g.Turns,
                elapsed = g.ElapsedSec, idle = g.IdleSec, limit = g.MaxTokensHint(OutputLimit(def)), g.Retry, g.RateLimit });
            if (g.IdleSec >= StallSec && !warnedStall)
            {
                warnedStall = true;
                _store.Publish(p, "log", new { level = "warn", text = L($"{who} has shown no activity for {g.IdleSec / 60} min. It may be stuck; it keeps waiting. Press Stop, then Resume, to restart it.",
                    $"{who} tidak ada aktivitas selama {g.IdleSec / 60} menit. Mungkin macet; tetap ditunggu. Tekan Hentikan lalu Lanjutkan untuk mengulangnya.") });
            }
            if (g.IdleSec < StallSec / 2) warnedStall = false;
            if (g.Phase == "rate_limited" && !warnedLimit)
            {
                warnedLimit = true;
                var at = g.RateLimit?.ResetsAt is long ms ? DateTimeOffset.FromUnixTimeMilliseconds(ms).ToLocalTime().ToString("ddd HH:mm") : "?";
                _store.Publish(p, "log", new { level = "error", text = L($"{who}: the Claude usage limit is reached (resets {at}).", $"{who}: batas pemakaian Claude tercapai (reset {at}).") });
            }
            if (g.Phase == "retrying" && g.Retry is { } r && r.Attempt > warnedRetry && (r.Attempt == 1 || r.Attempt % 3 == 0))
            {
                warnedRetry = r.Attempt;
                _store.Publish(p, "log", new { level = "warn", text = L($"{who}: the Claude API answered '{r.Error}'{(r.Status is int s ? $" ({s})" : "")}; retrying {r.Attempt}/{r.Max}.",
                    $"{who}: API Claude menjawab '{r.Error}'{(r.Status is int s2 ? $" ({s2})" : "")}; mencoba ulang {r.Attempt}/{r.Max}.") });
            }
        }
        if (tools) CopyRefsTo(p, _app.Dir(p));
        var req = new LlmRequest(def.Id, model.Model, _reg.ResolveEffort(def.Id), OutputLimit(def), system, messages,
            Tools: tools ? def.Tools : null, Cwd: tools ? _app.Dir(p) : null, MaxTurns: tools ? cm.MaxTurns : 1, MaxBudgetUsd: tools ? cm.MaxCallUsd : null,
            AllowedHosts: tools ? ApprovedHosts(p) : null,
            OnProgress: OnProgress, Attachments: SeenRefs(p));
        var res = await _llm.CompleteAsync(req, p, ct);
        if (res.StopReason.StartsWith("error_max"))
            _store.Publish(p, "log", new { level = "warn", text = L($"{RoleName(def)} stopped early ({(res.StopReason == "error_max_turns" ? $"{cm.MaxTurns} steps" : $"${cm.MaxCallUsd} per call")}); its part may be incomplete.",
                $"{RoleName(def)} berhenti lebih awal ({(res.StopReason == "error_max_turns" ? $"{cm.MaxTurns} langkah" : $"${cm.MaxCallUsd} per panggilan")}); bagiannya mungkin belum lengkap.") });
        return (res, model);
    }

    private void Record(Project p, AgentDef def, string stageId, int inst, ResolvedModel model, LlmResult r, string status, string summary, long ms)
    {
        var cost = r.CostUsd ?? _reg.Cost(model.Model, r.InputTokens, r.OutputTokens);
        lock (p)
        {
            p.Runs.Add(new AgentRun { AgentId = def.Id, Instance = inst, StageId = stageId, Model = model.Model, ModelSource = model.Source,
                Status = status, Summary = summary, TokensIn = r.InputTokens, TokensOut = r.OutputTokens, TokensCacheRead = r.CacheReadTokens, Cost = cost, Ms = ms });
            p.TokensIn += r.InputTokens; p.TokensOut += r.OutputTokens; p.TokensCacheRead += r.CacheReadTokens; p.Cost += cost;
        }
        PublishUsage(p);
    }

    /// Totals for the HUD, plus where the next budget stop is (dollars first; tokens only when that budget is on).
    private void PublishUsage(Project p)
    {
        var b = _reg.Config.Budget;
        _store.Publish(p, "usage", new { tokensIn = p.TokensIn, tokensOut = p.TokensOut, cacheRead = p.TokensCacheRead, cost = p.Cost,
            budget = b.MaxTokensPerProject, usdStep = b.MaxUsdPerProject, usdStop = b.MaxUsdPerProject > 0 ? p.ExtraUsd + b.MaxUsdPerProject : (decimal?)null,
            tokenStop = b.MaxTokensPerProject > 0 ? p.ExtraBudget + b.MaxTokensPerProject : (long?)null });
    }

    // ================= Reference files from the customer =================

    private static readonly HashSet<string> SeenTypes = ["image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf"];
    private const int MaxSeen = 5;                 // the newest images / PDFs go with every call
    private const long MaxSeenBytes = 4_500_000;   // per image (API limit is about 5 MB); PDFs up to 20 MB

    /// A chat line as the agents read it: the text plus the names of the attached files.
    private static string ChatLine(string text, List<ChatAttachment>? files) =>
        files is { Count: > 0 } ? $"{text}\n[attached: {string.Join(", ", files.Select(f => f.Name))}]".Trim() : text;

    private static bool IsText(ChatAttachment a) => a.Type.StartsWith("text/") || a.Type is "application/json" or "application/xml" or "application/javascript"
        || new[] { ".md", ".txt", ".csv", ".json", ".xml", ".yaml", ".yml", ".html", ".css", ".js", ".ts", ".cs", ".py", ".sql", ".log" }.Contains(Path.GetExtension(a.Name).ToLowerInvariant());

    /// The images and PDFs the model sees directly with each call: the newest few.
    private List<LlmAttachment> SeenRefs(Project p)
    {
        List<ChatAttachment> all; lock (p) all = p.Attachments.ToList();
        var dir = _store.RefsDir(p);
        return all.Where(a => SeenTypes.Contains(a.Type) && (a.Type == "application/pdf" ? a.Size <= 20_000_000 : a.Size <= MaxSeenBytes))
            .TakeLast(MaxSeen).Select(a => new LlmAttachment(a.Name, a.Type, Path.Combine(dir, a.File))).ToList();
    }

    /// Every agent's prompt lists the customer's reference files; text files are included, images/PDFs are attached.
    private string ReferencesBlock(Project p, bool tools)
    {
        List<ChatAttachment> all; lock (p) all = p.Attachments.ToList();
        if (all.Count == 0) return "";
        var seen = SeenRefs(p).Select(s => Path.GetFileName(s.Path)).ToHashSet();
        var sb = new StringBuilder("\nCUSTOMER REFERENCES (files the customer attached in the chat as examples or references; follow them where they apply):\n");
        int budget = 24000;
        foreach (var a in all)
        {
            var where = tools ? $" (copy at .refs/{a.File})" : "";
            if (seen.Contains(a.File)) { sb.AppendLine($"- {a.Name}: {(a.Type == "application/pdf" ? "PDF" : "image")}, attached to this message so you can see it{where}"); continue; }
            if (IsText(a) && budget > 0)
            {
                string content;
                try { content = File.ReadAllText(Path.Combine(_store.RefsDir(p), a.File)); } catch { content = ""; }
                if (content.Length > Math.Min(8000, budget)) content = content[..Math.Min(8000, budget)] + "\n[...cut]";
                budget -= content.Length;
                sb.AppendLine($"- {a.Name}{where}:\n<<<\n{content}\n>>>");
                continue;
            }
            sb.AppendLine($"- {a.Name} ({a.Type}, {a.Size / 1024} KB){(tools ? where : ": not readable here; ask the customer if its content matters")}");
        }
        return sb.ToString();
    }

    /// Code agents can open the reference files themselves: a copy inside the app folder (never released).
    private void CopyRefsTo(Project p, string appDir)
    {
        var src = _store.RefsDir(p);
        if (!Directory.Exists(src) || !Directory.Exists(appDir)) return;
        var dst = Path.Combine(appDir, ".refs");
        Directory.CreateDirectory(dst);
        foreach (var f in Directory.GetFiles(src))
        {
            var to = Path.Combine(dst, Path.GetFileName(f));
            if (!File.Exists(to)) File.Copy(f, to);
        }
    }

    private void AddChat(Project p, string role, string? agentId, string text, List<ChatAttachment>? files = null)
    {
        var m = new ChatMessage { Role = role, AgentId = agentId, Text = text, Attachments = files };
        lock (p) p.Chat.Add(m);
        _store.Publish(p, "chat", m);
    }

    private void SetStatus(Project p, ProjectStatus s)
    {
        if (s == ProjectStatus.Running && Rt(p).PauseGate != null) s = ProjectStatus.Paused;   // e.g. a question answered while paused
        p.Status = s;
        _store.Publish(p, "status", new { status = s.ToString() });
    }

    private void SetStage(Project p, string stageId, string status, int round)
    {
        lock (p) p.StageStatus[stageId] = status;
        _store.Publish(p, "stage", new { stageId, status, round });
    }

    private static int NextRound(Project p, string stageId)
    {
        lock (p) return p.Artifacts.Where(a => a.StageId == stageId).Select(a => a.Round).DefaultIfEmpty(1).Max() + 1;
    }

    private static string MakeTitle(string problem)
    {
        var t = Regex.Replace(problem.Trim(), @"\s+", " ");
        return t.Length <= 60 ? t : t[..57].TrimEnd() + "...";
    }

    private static string ExtractObject(string text)
    {
        var a = text.IndexOf('{'); var b = text.LastIndexOf('}');
        if (a < 0 || b <= a) throw new InvalidOperationException("No JSON object");
        return text[a..(b + 1)];
    }

    public static Handoff ParseHandoff(string text)
    {
        var matches = Regex.Matches(text, "```json\\s*(\\{.*?\\})\\s*```", RegexOptions.Singleline);
        if (matches.Count == 0) return new Handoff { Status = "done", Summary = FirstLine(text) };
        try
        {
            var o = JsonNode.Parse(matches[^1].Groups[1].Value)!.AsObject();
            return new Handoff
            {
                Status = o["status"]?.GetValue<string>() is { } s && s is "done" or "need_info" or "blocked" or "delegate" ? s : "done",
                Summary = o["summary"]?.GetValue<string>() ?? FirstLine(text),
                OpenQuestions = o["open_questions"]?.AsArray().Select(x => x?.ToString() ?? "").Where(x => x.Length > 0).ToList() ?? new(),
                Data = o["data"] as JsonObject,
            };
        }
        catch (Exception ex) when (ex is JsonException or InvalidOperationException)
        {
            return new Handoff { Status = "done", Summary = FirstLine(text) };
        }
    }

    /// The PM may list modules as plain names or as objects like {"id": "M2", "name": "Import and Parser", "stories": [...]}.
    // ================= Module log: one line per module from every agent that touched it =================

    private static readonly Regex ModCode = new(@"\bM\d{1,3}\b");

    /// The agent's "modules" map in its handoff ({"M01": "what I did... done"}) becomes one log entry per module.
    private void PublishModuleLog(Project p, AgentDef def, int inst, StageDef st, int round, Handoff h)
    {
        if (def.Id == "project_manager" || h.Data?["modules"] is not JsonObject mods) return;
        foreach (var (key, val) in mods)
        {
            var code = ModCode.Match(key) is { Success: true } m ? m.Value : key.Trim();
            var text = val is JsonValue jv && jv.TryGetValue<string>(out var s) ? s.Trim() : val?.ToJsonString() ?? "";
            if (code.Length == 0 || text.Length == 0) continue;
            if (text.Length > 500) text = text[..500] + "…";
            _store.Publish(p, "module", new { module = code, agentId = def.Id, instance = inst, stageId = st.Id, round, text, state = ModuleState(text) });
        }
    }

    /// The state word the agent ended its line with (English or Indonesian).
    private static string ModuleState(string text)
    {
        var t = text.ToLowerInvariant();
        if (Regex.IsMatch(t, @"\b(blocked|terblokir|gagal|failed|broken|rusak)\b")) return "blocked";
        if (Regex.IsMatch(t, @"\b(not started|belum dimulai|belum dikerjakan)\b")) return "todo";
        if (Regex.IsMatch(t, @"\b(partial|sebagian|in progress|incomplete|belum lengkap)\b")) return "partial";
        if (Regex.IsMatch(t, @"\b(done|complete|completed|selesai|passed|lulus|ok)\b")) return "done";
        return "info";
    }

    private static string ModuleName(JsonNode? x)
    {
        if (x is JsonObject o)
        {
            var name = (o["name"] ?? o["title"])?.ToString() ?? "";
            var id = o["id"]?.ToString();
            return string.IsNullOrWhiteSpace(id) ? name : $"{id} {name}".Trim();
        }
        return x?.ToString() ?? "";
    }

    private static string FirstLine(string text) =>
        text.Split('\n').Select(l => l.Trim().TrimStart('#', ' ')).FirstOrDefault(l => l.Length > 0) ?? "";
}
