using System.Text.Json;
using System.Text.Json.Serialization;

namespace VirtualCompany.Core;

/// Loads agents.json and answers "which model does this agent use, and why".
public class AgentRegistry
{
    public static readonly JsonSerializerOptions Json = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        ReadCommentHandling = JsonCommentHandling.Skip,
        AllowTrailingCommas = true,
        WriteIndented = true,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    private readonly string _path;
    private readonly object _lock = new();
    private string _header = "";
    public RegistryConfig Config { get; private set; } = new();

    public AgentRegistry(string path)
    {
        _path = path;
        Load();
    }

    public void Load()
    {
        lock (_lock)
        {
            var text = File.ReadAllText(_path);
            // Keep the leading comment block so saving does not erase the documentation.
            _header = string.Concat(text.Split('\n').TakeWhile(l => l.TrimStart().StartsWith("//")).Select(l => l + "\n"));
            Config = JsonSerializer.Deserialize<RegistryConfig>(text, Json) ?? new();
        }
    }

    public void Save()
    {
        lock (_lock)
            File.WriteAllText(_path, _header + JsonSerializer.Serialize(Config, Json));
    }

    public AgentDef? Get(string id) => Config.Agents.FirstOrDefault(a => a.Id == id);

    public AgentDef Require(string id) => Get(id) ?? throw new InvalidOperationException($"Unknown agent '{id}'");

    public StageDef? Stage(string id) => Config.Pipeline.FirstOrDefault(s => s.Id == id);

    public ModelDef? ModelInfo(string id) => Config.Models.FirstOrDefault(m => m.Id == id);

    public ResolvedModel ResolveModel(string agentId, IDictionary<string, string?>? projectOverrides = null)
    {
        var agent = Require(agentId);
        if (Pick(projectOverrides, agentId) is { } p1) return new(p1, "project override");
        if (Pick(projectOverrides, "*") is { } p2) return new(p2, "project override (all agents)");
        if (Pick(Config.Overrides, agentId) is { } g1) return new(g1, "global override");
        if (Pick(Config.Overrides, "*") is { } g2) return new(g2, "global override (all agents)");
        if (!string.IsNullOrWhiteSpace(agent.Model)) return new(agent.Model!, "agent");
        if (Config.Departments.TryGetValue(agent.Department, out var d) && !string.IsNullOrWhiteSpace(d.Model))
            return new(d.Model!, "department");
        return new(Config.Defaults.Model, "default");
    }

    public string ResolveEffort(string agentId) => Get(agentId)?.Effort ?? Config.Defaults.Effort;

    public decimal Cost(string model, int tokensIn, int tokensOut)
    {
        var m = ModelInfo(model);
        if (m == null) return 0;
        return tokensIn * m.InputPrice / 1_000_000m + tokensOut * m.OutputPrice / 1_000_000m;
    }

    private static string? Pick(IDictionary<string, string?>? map, string key) =>
        map != null && map.TryGetValue(key, out var v) && !string.IsNullOrWhiteSpace(v) ? v : null;
}
