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

    public Orchestrator(AgentRegistry reg, ProjectStore store, ILlmClient llm, ILogger<Orchestrator> log)
    {
        _reg = reg; _store = store; _llm = llm; _log = log;
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
            AddChat(p, "agent", IsActive("support") ? "support" : "intake", StatusReport(p));
        }
        _store.Save(p);
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
        var tasks = new List<Task<StageResult>>();
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
                tasks.Add(RunAgentAsync(p, st, def, inst, module, round, note, ct));
            }
        }
        var results = (await Task.WhenAll(tasks)).ToList();
        SetStage(p, st.Id, "done", round);
        return results;
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

        var system = $"You are the {def.Role} at {_reg.Config.Company}, a full-stack digital company staffed by AI agents. {def.Persona}\n\n" +
                     "Work only from the brief and the prior work you are given; state assumptions instead of inventing customer facts.\n" +
                     "Write your deliverable in English as a Markdown document. End your reply with one fenced json block:\n" +
                     "```json\n{\"status\": \"done | need_info | blocked\", \"summary\": \"<one sentence for the team>\", \"open_questions\": [], \"data\": {}}\n```\n" +
                     $"LENGTH: stay under about {TargetWords(def):N0} words in total. Be dense: tables and short bullets, no repetition, no restating the brief or other teams' documents. " +
                     "For code, give the key files and the non-obvious logic only, not boilerplate. The final json block is mandatory, so leave room for it.";
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

        var name = $"{st.Id}-{def.Id}{(inst > 1 ? $"-{inst}" : "")}{(round > 1 ? $"-r{round}" : "")}.md";
        var title = def.Role + (module != null ? $" · {module}" : "") + (round > 1 ? $" (round {round})" : "");
        var art = new ArtifactRef { Name = name, Title = title, AgentId = def.Id, StageId = st.Id, Round = round, Instance = inst };
        _store.WriteArtifact(p, art, result.Text);
        _store.Publish(p, "artifact", art);

        if (def.Id == "project_manager" && handoff.Data != null)
        {
            var plan = new ProjectPlan
            {
                Modules = handoff.Data["modules"]?.AsArray().Select(x => x?.ToString() ?? "").Where(x => x.Length > 0).ToList() ?? new(),
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
        bool Over() => step > 0 && p.TokensIn + p.TokensOut >= step + p.ExtraBudget;
        if (!Over()) return;
        var rt = Rt(p);
        await rt.BudgetLock.WaitAsync(ct);
        try
        {
            if (!Over()) return;   // another agent's gate was already approved
            var used = p.TokensIn + p.TokensOut;
            var d = await GateAsync(p, st, "budget", $"Token budget reached ({used:N0} of {step + p.ExtraBudget:N0}, ${p.Cost:N2} so far). Approve to allow {step:N0} more tokens.", ct);
            if (d.Decision != "approve") { Stop(p, "Stopped at the token budget."); throw new OperationCanceledException(); }
            p.ExtraBudget = used;   // next stop: one more budget step from current usage
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
        var req = new LlmRequest(def.Id, model.Model, _reg.ResolveEffort(def.Id), OutputLimit(def), system, messages);
        var res = await _llm.CompleteAsync(req, p, ct);
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
                Status = o["status"]?.GetValue<string>() is { } s && s is "done" or "need_info" or "blocked" ? s : "done",
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

    private static string FirstLine(string text) =>
        text.Split('\n').Select(l => l.Trim().TrimStart('#', ' ')).FirstOrDefault(l => l.Length > 0) ?? "";
}
