using System.Text.Json.Serialization;

namespace VirtualCompany.Core;

// ---------- Registry (agents.json) ----------

public class RegistryConfig
{
    public string Company { get; set; } = "Virtual Company";
    public DefaultsDef Defaults { get; set; } = new();
    public List<ModelDef> Models { get; set; } = new();
    public BudgetDef Budget { get; set; } = new();
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
    public long MaxTokensPerProject { get; set; } = 3_000_000;
}

public class DepartmentDef
{
    public string Name { get; set; } = "";
    public string? Model { get; set; }
}

public class AgentDef
{
    public string Id { get; set; } = "";
    public string Role { get; set; } = "";
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
    /// Temporarily switched off: the orchestrator skips this agent (and a stage with no active agents).
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingDefault)]
    public bool Disabled { get; set; }
    public string? Greeting { get; set; }
    public string Persona { get; set; } = "";
    public List<string> Outputs { get; set; } = new();
}

public class StageDef
{
    public string Id { get; set; } = "";
    public string Title { get; set; } = "";
    public string Kind { get; set; } = "agents";
    public List<string> Agents { get; set; } = new();
    public GateDef? Gate { get; set; }
    public LoopDef? Loop { get; set; }
}

public class GateDef
{
    public string Id { get; set; } = "";
    public string Label { get; set; } = "";
}

public class LoopDef
{
    public string BackTo { get; set; } = "";
    public int MaxRounds { get; set; } = 3;
}

public record ResolvedModel(string Model, string Source);

// ---------- Project state ----------

public enum ProjectStatus { Intake, Running, WaitingGate, WaitingCustomer, Completed, Stopped, Failed }

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
    public ProjectPlan? Plan { get; set; }
    /// Tokens added on top of budget.maxTokensPerProject each time you approve the budget gate.
    public long ExtraBudget { get; set; }
    public long TokensIn { get; set; }
    public long TokensOut { get; set; }
    public decimal Cost { get; set; }
    public List<VcEvent> Events { get; set; } = new();
}

public class ChatMessage
{
    public string Role { get; set; } = "customer";   // customer | agent
    public string? AgentId { get; set; }
    public string Text { get; set; } = "";
    public DateTime At { get; set; } = DateTime.UtcNow;
}

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

public record LlmRequest(string AgentId, string Model, string Effort, int MaxTokens, string System, List<(string Role, string Text)> Messages);

/// CostUsd is set when the engine reports its own cost (Agent SDK); otherwise it is computed from agents.json prices.
public record LlmResult(string Text, int InputTokens, int OutputTokens, string StopReason, decimal? CostUsd = null);
