using System.Text.Json.Serialization;

namespace VirtualCompany.Core;

// ---------- Registry (agents.json) ----------

public class RegistryConfig
{
    public string Company { get; set; } = "Virtual Company";
    public DefaultsDef Defaults { get; set; } = new();
    public List<ModelDef> Models { get; set; } = new();
    public BudgetDef Budget { get; set; } = new();
    public CodeModeDef CodeMode { get; set; } = new();
    public Dictionary<string, DepartmentDef> Departments { get; set; } = new();
    public Dictionary<string, string?> Overrides { get; set; } = new();
    public List<AgentDef> Agents { get; set; } = new();
    public List<StageDef> Pipeline { get; set; } = new();
}

public class DefaultsDef
{
    public string Model { get; set; } = "claude-sonnet-5-5";
    public string Effort { get; set; } = "medium";
    public int MaxTokens { get; set; } = 16000;
    /// Hard cap on one agent reply (thinking included) when the agent has no limit of its own.
    public int MaxOutputTokens { get; set; } = 8000;
    /// Language of the whole app: the UI, messages from the team, and the documents agents write. "en" or "id".
    public string Language { get; set; } = "en";
}

public class ModelDef
{
    public string Id { get; set; } = "";
    public string Label { get; set; } = "";
    public string Tier { get; set; } = "";
    public decimal InputPrice { get; set; }
    public decimal OutputPrice { get; set; }
}

public class BudgetDef
{
    /// Fresh input + output tokens per step (0 = off). Cache reads are not counted.
    public long MaxTokensPerProject { get; set; }
    /// Dollar budget per project (0 = off). Tool-using agents re-read cached context every turn, so dollars
    /// are a better stop signal than raw token counts.
    public decimal MaxUsdPerProject { get; set; }
}

/// Engineering agents write and run a real application in data/projects/{id}/app.
public class CodeModeDef
{
    public bool Enabled { get; set; }
    public string Stack { get; set; } = "ASP.NET Core 9 + SQLite";
    /// Hard dollar cap for one tool-using agent call (Agent SDK maxBudgetUsd).
    public decimal MaxCallUsd { get; set; } = 3m;
    public int MaxTurns { get; set; } = 60;
    /// Ports: the running app for you starts here; QA test runs use AppPort + 50.
    public int AppPort { get; set; } = 5300;
    /// Sites agents may download libraries and open-licensed assets from (GET only; subdomains included).
    /// Everything else stays blocked except localhost.
    public List<string> AllowedHosts { get; set; } = new();
}

public class DepartmentDef
{
    public string Name { get; set; } = "";
    /// Translated display names by language code, e.g. {"id": "..."}; the English field is the fallback.
    public Dictionary<string, string>? Names { get; set; }
    public string? Model { get; set; }
}

public class AgentDef
{
    public string Id { get; set; } = "";
    public string Role { get; set; } = "";
    /// Translated display names by language code, e.g. {"id": "..."}; the English field is the fallback.
    public Dictionary<string, string>? Names { get; set; }
    public string Initials { get; set; } = "";
    public string Department { get; set; } = "";
    public string? Model { get; set; }
    public string? Effort { get; set; }
    public int MaxInstances { get; set; } = 1;
    public bool Spawnable { get; set; }
    public bool CanAskCustomer { get; set; }
    /// Agent ids whose documents this role reads. null = everything produced so far; [] = only the customer brief.
    /// Only the newest version of each document is sent, plus this agent's own previous work on a rework round.
    public List<string>? Reads { get; set; }
    /// Hard cap on one reply from this agent; falls back to defaults.maxOutputTokens.
    public int? MaxOutputTokens { get; set; }
    /// Agent SDK tools this role may use in code mode, e.g. ["Read","Write","Edit","Glob","Grep","Bash"].
    public List<string>? Tools { get; set; }
    /// Temporarily switched off: the orchestrator skips this agent (and a stage with no active agents).
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingDefault)]
    public bool Disabled { get; set; }
    public string? Greeting { get; set; }
    public Dictionary<string, string>? Greetings { get; set; }
    public string Persona { get; set; } = "";
    /// Owner's rules for this role, one per item: what it must always do, and what it must never do.
    /// They go into every prompt of the role with high priority (the model follows them; the app does not check them).
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public List<string>? MustDo { get; set; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public List<string>? MustNot { get; set; }
    public List<string> Outputs { get; set; } = new();
}

public class StageDef
{
    public string Id { get; set; } = "";
    public string Title { get; set; } = "";
    /// Translated display names by language code, e.g. {"id": "..."}; the English field is the fallback.
    public Dictionary<string, string>? Names { get; set; }
    public string Kind { get; set; } = "agents";
    public List<string> Agents { get; set; } = new();
    public GateDef? Gate { get; set; }
    public LoopDef? Loop { get; set; }
    /// "dotnet-build": after this stage the orchestrator builds the app and sends errors back for fixing.
    public string? Verify { get; set; }
}

public class GateDef
{
    public string Id { get; set; } = "";
    public string Label { get; set; } = "";
    /// Translated display names by language code, e.g. {"id": "..."}; the English field is the fallback.
    public Dictionary<string, string>? Names { get; set; }
}

public class LoopDef
{
    public string BackTo { get; set; } = "";
    public int MaxRounds { get; set; } = 3;
}

public record ResolvedModel(string Model, string Source);

// ---------- Project state ----------

public enum ProjectStatus { Intake, Running, WaitingGate, WaitingCustomer, Completed, Stopped, Failed, Paused }

public class Project
{
    public string Id { get; set; } = "";
    public string Title { get; set; } = "New request";
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    [JsonConverter(typeof(JsonStringEnumConverter))]
    public ProjectStatus Status { get; set; } = ProjectStatus.Intake;
    public List<ChatMessage> Chat { get; set; } = new();
    public Dictionary<string, string> Brief { get; set; } = new();
    public Dictionary<string, string?> ModelOverrides { get; set; } = new();
    public bool AutoApprove { get; set; }
    public List<ArtifactRef> Artifacts { get; set; } = new();
    public List<AgentRun> Runs { get; set; } = new();
    public Dictionary<string, string> StageStatus { get; set; } = new();
    public PendingGate? PendingGate { get; set; }
    public PendingQuestion? PendingQuestion { get; set; }
    /// Every question an agent asked the customer, with the reply. All later agents read these, so nobody asks twice.
    public List<CustomerAnswer> CustomerAnswers { get; set; } = new();
    /// What is still wrong, by source ("QA: ...", "Security: ..."): shown to the owner, the support agent and the handover.
    public List<string> OpenIssues { get; set; } = new();
    /// Download sites the owner allowed / refused for this project when an agent asked (on top of codeMode.allowedHosts).
    public List<string> AllowedHosts { get; set; } = new();
    public List<string> RefusedHosts { get; set; } = new();
    /// Every reference file the customer attached in the chat, oldest first (all agents get them).
    public List<ChatAttachment> Attachments { get; set; } = new();
    public ProjectPlan? Plan { get; set; }
    /// Tokens added on top of budget.maxTokensPerProject each time you approve the budget gate.
    public long ExtraBudget { get; set; }
    public decimal ExtraUsd { get; set; }
    /// Where the generated app runs for you, when it is running.
    public string? AppUrl { get; set; }
    public long TokensIn { get; set; }
    public long TokensOut { get; set; }
    /// Context re-read from the prompt cache (about a tenth of the price of fresh input); kept apart from TokensIn.
    public long TokensCacheRead { get; set; }
    public decimal Cost { get; set; }
    public List<VcEvent> Events { get; set; } = new();
}

public class ChatMessage
{
    public string Role { get; set; } = "customer";   // customer | agent
    public string? AgentId { get; set; }
    public string Text { get; set; } = "";
    public DateTime At { get; set; } = DateTime.UtcNow;
    /// Files the customer pasted or attached to this message (screenshots, documents) as references for the team.
    public List<ChatAttachment>? Attachments { get; set; }
}

/// A reference file from the customer, stored in data/projects/{id}/refs/{File}.
public class ChatAttachment
{
    public string Name { get; set; } = "";   // the original file name
    public string File { get; set; } = "";   // the stored file name (unique in the project)
    public string Type { get; set; } = "";   // media type, e.g. image/png
    public long Size { get; set; }
}

/// A file sent to the model with a call (images and PDFs are seen directly).
public record LlmAttachment(string Name, string MediaType, string Path);

public class ArtifactRef
{
    public string Name { get; set; } = "";
    public string Title { get; set; } = "";
    public string AgentId { get; set; } = "";
    public string StageId { get; set; } = "";
    public int Round { get; set; } = 1;
    public int Instance { get; set; } = 1;
    /// A helper's part of a split task; the lead merges it, so other roles read only the merged document.
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingDefault)]
    public bool Helper { get; set; }
}

public class AgentRun
{
    public string AgentId { get; set; } = "";
    public int Instance { get; set; } = 1;
    public string StageId { get; set; } = "";
    public string Model { get; set; } = "";
    public string ModelSource { get; set; } = "";
    public string Status { get; set; } = "";
    public string Summary { get; set; } = "";
    public int TokensIn { get; set; }
    public int TokensOut { get; set; }
    public long TokensCacheRead { get; set; }
    public decimal Cost { get; set; }
    public long Ms { get; set; }
}

public class PendingGate
{
    public string StageId { get; set; } = "";
    public string GateId { get; set; } = "";
    public string Label { get; set; } = "";
    public List<string> Artifacts { get; set; } = new();
}

public class PendingQuestion
{
    public string AgentId { get; set; } = "";
    public List<string> Questions { get; set; } = new();
}

public class CustomerAnswer
{
    public string AgentId { get; set; } = "";
    public string Role { get; set; } = "";
    public List<string> Questions { get; set; } = new();
    public string Reply { get; set; } = "";
}

public class ProjectPlan
{
    public List<string> Modules { get; set; } = new();
    public Dictionary<string, int> Instances { get; set; } = new();
}

public class VcEvent
{
    public long Seq { get; set; }
    public string Type { get; set; } = "";
    public DateTime Ts { get; set; } = DateTime.UtcNow;
    public Dictionary<string, object?> Data { get; set; } = new();
}

// ---------- Agent I/O ----------

public class Handoff
{
    public string Status { get; set; } = "done";          // done | need_info | blocked
    public string Summary { get; set; } = "";
    public List<string> OpenQuestions { get; set; } = new();
    public System.Text.Json.Nodes.JsonObject? Data { get; set; }
}

public record LlmRequest(string AgentId, string Model, string Effort, int MaxTokens, string System, List<(string Role, string Text)> Messages,
    List<string>? Tools = null, string? Cwd = null, int MaxTurns = 1, decimal? MaxBudgetUsd = null, Action<AgentProgress>? OnProgress = null,
    List<string>? AllowedHosts = null, List<LlmAttachment>? Attachments = null);

/// What a running agent is doing right now, reported every couple of seconds while it works.
/// Phase: starting | thinking | writing | tool | retrying | rate_limited.
public record AgentProgress(string Phase, string? Tool, string? Detail, int OutTokens, int Turns, int ElapsedSec, int IdleSec,
    RetryInfo? Retry = null, RateLimitInfo? RateLimit = null)
{
    /// The per-reply output cap the tokens count toward (one reply; a tool run has many replies, so no cap is shown).
    public int? MaxTokensHint(int cap) => Turns == 0 ? cap : null;
}
public record RetryInfo(int Attempt, int Max, int WaitMs, string? Error, int? Status);
public record RateLimitInfo(string? Status, long? ResetsAt, string? Type, double? Utilization);

/// CostUsd is set when the engine reports its own cost (Agent SDK); otherwise it is computed from agents.json prices.
public record LlmResult(string Text, int InputTokens, int OutputTokens, string StopReason, decimal? CostUsd = null, long CacheReadTokens = 0);
