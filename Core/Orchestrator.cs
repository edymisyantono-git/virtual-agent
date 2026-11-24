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
    }

    private readonly AppWorkspace _app;

    public Orchestrator(AgentRegistry reg, ProjectStore store, ILlmClient llm, AppWorkspace app, ILogger<Orchestrator> log)
    {
        _reg = reg; _store = store; _llm = llm; _app = app; _log = log;
    }

    public bool IsLive => _llm.IsLive;

    private Runtime Rt(Project p) => _rt.GetOrAdd(p.Id, _ => new Runtime());

    // ================= Intake =================

    public Project StartProject(bool autoApprove)
    {
        var p = _store.Create();
        p.AutoApprove = autoApprove;
        var greeting = _reg.Get("intake")?.Greeting ?? "Hi! What can we build for you?";
        AddChat(p, "agent", "intake", greeting);
        _store.Save(p);
        return p;
    }

    public async Task CustomerMessageAsync(Project p, string text)
    {
        AddChat(p, "customer", null, text);
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
                         "If a fact is not given, say you will check with the team. Reply with plain text only, no json block.";
            var msg = $"PROJECT FACTS\n{ProjectFacts(p)}\n\nRECENT CHAT\n" +
                      string.Join("\n", p.Chat.TakeLast(8).Select(c => $"{(c.Role == "customer" ? "Customer" : "Team")}: {c.Text}")) +
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
        if (p.PendingGate != null) sb.AppendLine($"Waiting for the owner's approval: {p.PendingGate.Label}");
        if (Code)
            sb.AppendLine(p.AppUrl != null
                ? $"THE APP IS RUNNING for the customer to test at {p.AppUrl} (also the 'Open app' button above the floor). Source code is included in 'Download all (.zip)'."
                : _app.Exists(p) ? "The app's source exists; it can be started with the 'Start app' button above the floor, then opened with 'Open app'."
                : "No runnable app has been built yet.");
        List<VcEvent> events;
        lock (p) events = p.Events.Where(e => e.Type == "gate" && e.Data.GetValueOrDefault("status")?.ToString() != "waiting").ToList();
        if (events.Count > 0)
        {
            sb.AppendLine("OWNER DECISIONS (approval gates):");
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
                     "Copy known facts into slots and add what the customer just told you; leave unknown slots empty. Set complete to true only when all five slots are filled.";
        var messages = p.Chat.SkipWhile(c => c.Role != "customer")
            .Select(c => (c.Role == "customer" ? "user" : "assistant", c.Text)).ToList();

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
        _store.Publish(p, "log", new { level = "info", text = "Resumed. Finished stages and approved gates are skipped." });
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
        var working = _reg.Config.Agents.Where(a => p.Runs.Count > 0 && current != null && current.Agents.Contains(a.Id) && !a.Disabled).Select(a => a.Role).ToList();
        var sb = new StringBuilder($"{finished} of {stages.Count} stages are finished");
        if (current != null && p.Status != ProjectStatus.Completed) sb.Append($". Now: {current.Title}{(working.Count > 0 ? $" ({string.Join(", ", working)})" : "")}");
        sb.Append($". Cost so far: ${p.Cost:N2}. ");
        sb.Append(p.Status switch
        {
            ProjectStatus.Running => "The team is working; nothing is needed from you right now.",
            ProjectStatus.WaitingGate => $"It is waiting for an approval from the owner: {p.PendingGate?.Label}.",
            ProjectStatus.Stopped or ProjectStatus.Failed => "The project is paused. Press Resume on the floor to continue.",
            ProjectStatus.Completed => "The project is delivered.",
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
                        _store.Publish(p, "log", new { level = "info", text = $"{st.Title} skipped: all its agents are switched off." });
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
                        var d = await GateAsync(p, st, "blocked", "Blocked: " + string.Join(" ", blocked.Select(b => b.Handoff.Summary)) + " Continue anyway?", ct);
                        if (d.Decision != "approve") { Stop(p, "Stopped at a blocking finding."); return; }
                    }

                    while (st.Gate != null)
                    {
                        var d = await GateAsync(p, st, st.Gate.Id, st.Gate.Label, ct);
                        if (d.Decision == "approve") break;
                        if (d.Decision == "reject") { Stop(p, $"Rejected at '{st.Gate.Label}'."); return; }
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
            AddChat(p, "agent", IsActive("support") ? "support" : "intake", "Your system is live. Thank you for working with us; reply here any time you need something.");
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
            if (!scaffold.Ok) _store.Publish(p, "log", new { level = "error", text = "Could not create the app project: " + AppWorkspace.Tail(scaffold.Output, 6) });
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
            if (count > 1)
                _store.Publish(p, "spawn", new { agentId, stageId = st.Id, count, modules = assignments });

            for (var k = 0; k < count; k++)
            {
                var inst = k + 1; var module = assignments[k];
                jobs.Add(() => RunAgentAsync(p, st, def, inst, module, round, note, ct));
            }
        }
        var results = sequential ? await RunSequentialAsync(jobs) : (await Task.WhenAll(jobs.Select(j => j()))).ToList();
        await VerifyBuildAsync(p, st, round, ct);
        SetStage(p, st.Id, "done", round);
        return results;
    }

    // ================= Code mode: agents write, build and run a real app =================

    private bool Code => _reg.Config.CodeMode.Enabled;

    private string AppFileList(Project p)
    {
        var dir = _app.Dir(p);
        if (!Directory.Exists(dir)) return "(none yet)";
        var files = Directory.EnumerateFiles(dir, "*", SearchOption.AllDirectories)
            .Select(f => Path.GetRelativePath(dir, f).Replace('\\', '/'))
            .Where(f => !f.StartsWith("bin/") && !f.StartsWith("obj/") && !f.EndsWith(".db"))
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
            _store.Publish(p, "log", new { level = "info", text = "Build check: running dotnet build on the app..." });
            var b = await _app.BuildAsync(p, ct);
            if (b.Ok) { _store.Publish(p, "log", new { level = "ok", text = "Build check passed: the app compiles." }); return; }
            var errors = AppWorkspace.Tail(b.Output, 40);
            _store.Publish(p, "log", new { level = "error", text = $"Build check failed (attempt {attempt}):\n{AppWorkspace.Tail(b.Output, 6)}" });
            var fixer = new[] { "backend_dev", "frontend_dev", "db_dev" }.Select(_reg.Get).FirstOrDefault(d => d is { Disabled: false } && UsesTools(d));
            if (attempt > 2 || fixer == null)
            {
                _store.Publish(p, "log", new { level = "warn", text = "The app still does not build; QA will report it." });
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
            AddChat(p, "agent", IsActive("devops") ? "devops" : "support", $"Your app is running at {url}. Open it from the 'Open app' button on the floor to try it.");
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _store.Publish(p, "app", new { status = "failed", error = ex.Message });
            _store.Publish(p, "log", new { level = "error", text = "The app could not be started: " + AppWorkspace.Tail(ex.Message, 6) });
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
            var bugs = results.Sum(r => r.Handoff.Data?["bugs"]?.GetValue<int>() ?? 0);
            if (bugs == 0) return results;

            var defects = results.SelectMany(r => r.Handoff.Data?["defects"]?.AsArray().Select(d => d?.ToString() ?? "") ?? []).ToList();
            if (round >= loop.MaxRounds)
            {
                var d = await GateAsync(p, st, "qa-limit", $"QA still reports {bugs} defects after {round} rounds. Release anyway?", ct);
                if (d.Decision == "approve") return results;
                throw new OperationCanceledException();
            }
            round++;
            _store.Publish(p, "loop", new { fromStage = st.Id, toStage = back.Id, round, bugs, defects });
            await RunStageAsync(p, back, round, "Fix these defects:\n- " + string.Join("\n- ", defects), ct);
            _store.Publish(p, "handoff", new { fromStage = back.Id, toStage = st.Id });
        }
    }

    private async Task<StageResult> RunAgentAsync(Project p, StageDef st, AgentDef def, int inst, string? module, int round, string? note, CancellationToken ct, string? answers = null)
    {
        await EnforceBudgetAsync(p, st, ct);

        var canDelegate = CanDelegate(p, def);
        var system = BuildSystem(def, canDelegate);
        var msg = BuildContext(p, st, def, inst, module, round, note, answers);

        _store.Publish(p, "agent", new { agentId = def.Id, instance = inst, stageId = st.Id, status = "working", module, round,
            model = _reg.ResolveModel(def.Id, p.ModelOverrides).Model, source = _reg.ResolveModel(def.Id, p.ModelOverrides).Source });

        var sw = System.Diagnostics.Stopwatch.StartNew();
        LlmResult result; ResolvedModel model;
        try
        {
            (result, model) = await CallAsync(p, def, st.Id, system, [("user", msg)], ct);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _store.Publish(p, "agent", new { agentId = def.Id, instance = inst, stageId = st.Id, status = "error", summary = ex.Message });
            throw;
        }
        var handoff = ParseHandoff(result.Text);
        if (result.StopReason is "max_tokens" or "length")
            _store.Publish(p, "log", new { level = "warn", text = $"{def.Role} hit its output limit ({OutputLimit(def):N0} tokens); the document may be cut short. Raise its limit in the agent settings." });

        if (handoff.Status == "need_info" && def.CanAskCustomer && handoff.OpenQuestions.Count > 0 && answers == null)
        {
            Record(p, def, st.Id, inst, model, result, "need_info", handoff.Summary, sw.ElapsedMilliseconds);
            _store.Publish(p, "agent", new { agentId = def.Id, instance = inst, stageId = st.Id, status = "need_info", summary = handoff.Summary });
            var reply = await AskCustomerAsync(p, def, handoff.OpenQuestions, ct);
            var qa = string.Join("\n", handoff.OpenQuestions.Select((q, i) => $"Q{i + 1}: {q}")) + "\nCustomer reply: " + reply;
            return await RunAgentAsync(p, st, def, inst, module, round, note, ct, qa);
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
        var title = def.Role + (module != null ? $" · {module}" : "") + (round > 1 ? $" (round {round})" : "");
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
        var last = p.Runs.Last(r => r.AgentId == def.Id && r.Instance == inst);
        _store.Publish(p, "agent", new { agentId = def.Id, instance = inst, stageId = st.Id, status = handoff.Status == "blocked" ? "blocked" : "done",
            summary = handoff.Summary, model = model.Model, source = model.Source, tokensIn = last.TokensIn, tokensOut = last.TokensOut, cost = last.Cost, artifact = name });
        return new StageResult(def, inst, handoff);
    }

    // ================= Delegation: a role splits its own task across helpers of the same role and model =================

    /// A role may split its task when it is allowed more than one agent and is not already one of several
    /// parallel instances staffed by the Project Manager.
    private bool CanDelegate(Project p, AgentDef def)
    {
        if (def.MaxInstances < 2 || UsesTools(def)) return false;   // helpers would write the same files at once
        var staffed = def.Spawnable && p.Plan?.Instances.TryGetValue(def.Id, out var n) == true ? Math.Clamp(n, 1, def.MaxInstances) : 1;
        return staffed == 1;
    }

    private string BuildSystem(AgentDef def, bool canDelegate, string? extra = null)
    {
        var sb = new StringBuilder();
        sb.Append($"You are the {def.Role} at {_reg.Config.Company}, a full-stack digital company staffed by AI agents. {def.Persona}\n\n");
        sb.Append("Work only from the brief and the prior work you are given; state assumptions instead of inventing customer facts.\n");
        sb.Append("Write your deliverable in English as a Markdown document. End your reply with one fenced json block:\n");
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
                sb.Append($"TESTING: build, then start the app in the background with `dotnet run --no-build --urls http://localhost:{TestPort} & PID=$!`, wait until it answers, " +
                          "check the acceptance criteria with curl against the running app (pages and API), then `kill $PID`. Report each defect with the exact request and what came back; " +
                          "put {\"bugs\": n, \"defects\": [...]} in the handoff data. ");
            sb.Append("Your final reply is a short report (at most about 300 words): what you built or changed, which files, how to try it, known gaps. End with the json block.");
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
        if (extra != null) sb.Append("\n\n" + extra);
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
            var count = subtasks.Count + 1;
            _store.Publish(p, "spawn", new { agentId = def.Id, stageId = st.Id, count, reason = "delegate", summary = plan.Summary,
                modules = new[] { "lead: plans and merges" }.Concat(subtasks.Select(s => s.Title)).ToList() });

            var parts = await Task.WhenAll(subtasks.Select((s, k) =>
                RunHelperAsync(p, st, def, inst + k + 1, k + 1, subtasks.Count, s.Title, s.Instructions, module, round, note, answers, ct)));

            var sbParts = new StringBuilder("PARTS FROM YOUR HELPERS. Merge them into ONE final deliverable: remove overlaps, fill gaps, keep one consistent numbering, and end with the json block.\n");
            for (var k = 0; k < parts.Length; k++)
                sbParts.AppendLine($"\n===== Part {k + 1}: {subtasks[k].Title} =====\n{parts[k]}");
            mergeNote = sbParts.ToString();
        }

        await EnforceBudgetAsync(p, st, ct);
        _store.Publish(p, "agent", new { agentId = def.Id, instance = inst, stageId = st.Id, status = "working", module = "merging the parts", round });
        var (result, model) = await CallAsync(p, def, st.Id, BuildSystem(def, canDelegate: false), [("user", leadContext + "\n\n" + mergeNote)], ct);
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
        try { (result, model) = await CallAsync(p, def, st.Id, system, [("user", msg)], ct); }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _store.Publish(p, "agent", new { agentId = def.Id, instance = inst, stageId = st.Id, status = "error", summary = ex.Message });
            throw;
        }

        var name = $"{st.Id}-{def.Id}{(round > 1 ? $"-r{round}" : "")}-part{part}.md";
        var art = new ArtifactRef { Name = name, Title = $"{def.Role} · part {part}: {title}", AgentId = def.Id, StageId = st.Id, Round = round, Instance = inst, Helper = true };
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
        if (UsesTools(def))
        {
            sb.AppendLine("APP FOLDER: your current directory (App.csproj). Files now: " + AppFileList(p));
            if (def.Id == "qa") sb.AppendLine($"TEST URL: http://localhost:{TestPort}");
        }
        if (round > 1) sb.AppendLine($"ROUND {round}");
        if (!string.IsNullOrWhiteSpace(note)) sb.AppendLine("NOTE FROM REVIEW:\n" + note);
        if (answers != null) sb.AppendLine("CUSTOMER ANSWERS:\n" + answers);
        sb.AppendLine("\nCUSTOMER BRIEF:");
        foreach (var k in Slots) sb.AppendLine($"- {k}: {(p.Brief.TryGetValue(k, out var v) ? v : "(unknown)")}");

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
        if (p.AutoApprove && gateId is not ("blocked" or "budget" or "qa-limit"))
        {
            await Task.Delay(1800, ct);
            d = new GateDecision("approve", "Auto-approved");
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

    private async Task<string> AskCustomerAsync(Project p, AgentDef def, List<string> questions, CancellationToken ct)
    {
        lock (p) p.PendingQuestion = new PendingQuestion { AgentId = def.Id, Questions = questions };
        var text = $"Our {def.Role} needs a little more detail:\n" + string.Join("\n", questions.Select((q, i) => $"{i + 1}. {q}"));
        AddChat(p, "agent", def.Id, text);
        _store.Publish(p, "question", new { agentId = def.Id, questions });
        SetStatus(p, ProjectStatus.WaitingCustomer);

        var tcs = new TaskCompletionSource<string>(TaskCreationOptions.RunContinuationsAsynchronously);
        Rt(p).Answer = tcs;
        string answer;
        using (ct.Register(() => tcs.TrySetCanceled()))
            answer = await tcs.Task;
        Rt(p).Answer = null;
        lock (p) p.PendingQuestion = null;
        AddChat(p, "agent", def.Id, "Thank you, that settles it. Continuing with the requirements.");
        SetStatus(p, ProjectStatus.Running);
        return answer;
    }

    private async Task EnforceBudgetAsync(Project p, StageDef st, CancellationToken ct)
    {
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
                ? $"Dollar budget reached (${p.Cost:N2} of ${usdStep + p.ExtraUsd:N2}). Approve to allow ${usdStep:N2} more."
                : $"Token budget reached ({used:N0} of {step + p.ExtraBudget:N0}, ${p.Cost:N2} so far). Approve to allow {step:N0} more tokens.";
            var d = await GateAsync(p, st, "budget", label, ct);
            if (d.Decision != "approve") { Stop(p, "Stopped at the budget."); throw new OperationCanceledException(); }
            p.ExtraBudget = used;      // next stop: one more step from current usage
            p.ExtraUsd = p.Cost;
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

    private async Task<(LlmResult, ResolvedModel)> CallAsync(Project p, AgentDef def, string stageId, string system, List<(string, string)> messages, CancellationToken ct)
    {
        var model = _reg.ResolveModel(def.Id, p.ModelOverrides);
        var tools = stageId != "chat" && UsesTools(def);
        var cm = _reg.Config.CodeMode;
        var req = new LlmRequest(def.Id, model.Model, _reg.ResolveEffort(def.Id), OutputLimit(def), system, messages,
            Tools: tools ? def.Tools : null, Cwd: tools ? _app.Dir(p) : null, MaxTurns: tools ? cm.MaxTurns : 1, MaxBudgetUsd: tools ? cm.MaxCallUsd : null);
        var res = await _llm.CompleteAsync(req, p, ct);
        if (res.StopReason.StartsWith("error_max"))
            _store.Publish(p, "log", new { level = "warn", text = $"{def.Role} stopped early ({(res.StopReason == "error_max_turns" ? $"{cm.MaxTurns} steps" : $"${cm.MaxCallUsd} per call")}); its part may be incomplete." });
        return (res, model);
    }

    private void Record(Project p, AgentDef def, string stageId, int inst, ResolvedModel model, LlmResult r, string status, string summary, long ms)
    {
        var cost = r.CostUsd ?? _reg.Cost(model.Model, r.InputTokens, r.OutputTokens);
        lock (p)
        {
            p.Runs.Add(new AgentRun { AgentId = def.Id, Instance = inst, StageId = stageId, Model = model.Model, ModelSource = model.Source,
                Status = status, Summary = summary, TokensIn = r.InputTokens, TokensOut = r.OutputTokens, Cost = cost, Ms = ms });
            p.TokensIn += r.InputTokens; p.TokensOut += r.OutputTokens; p.Cost += cost;
        }
        _store.Publish(p, "usage", new { tokensIn = p.TokensIn, tokensOut = p.TokensOut, cost = p.Cost, budget = _reg.Config.Budget.MaxTokensPerProject });
    }

    private void AddChat(Project p, string role, string? agentId, string text)
    {
        var m = new ChatMessage { Role = role, AgentId = agentId, Text = text };
        lock (p) p.Chat.Add(m);
        _store.Publish(p, "chat", m);
    }

    private void SetStatus(Project p, ProjectStatus s)
    {
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
