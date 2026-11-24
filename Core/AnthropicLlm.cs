using Anthropic;
using Anthropic.Models.Beta.Messages;

namespace VirtualCompany.Core;

public interface ILlmClient
{
    bool IsLive { get; }
    Task<LlmResult> CompleteAsync(LlmRequest req, Project project, CancellationToken ct);
}

/// Calls the Claude Messages API through the official Anthropic SDK.
public class AnthropicLlm : ILlmClient
{
    // Models that accept server-side refusal fallbacks ("default" routing).
    private static readonly HashSet<string> FallbackModels = ["claude-fable-5-1", "claude-opus-5-5", "claude-sonnet-5-5"];

    private readonly AnthropicClient _client = new();   // reads ANTHROPIC_API_KEY
    public bool IsLive => true;

    public async Task<LlmResult> CompleteAsync(LlmRequest req, Project project, CancellationToken ct)
    {
        var p = new MessageCreateParams
        {
            Model = req.Model,
            MaxTokens = req.MaxTokens,
            System = req.System,
            OutputConfig = new BetaOutputConfig { Effort = ParseEffort(req.Effort) },
            Messages = req.Messages
                .Select(m => m.Role == "assistant"
                    ? (BetaMessageParam)new BetaAssistantMessageParam { Content = m.Text }
                    : new BetaUserMessageParam { Content = m.Text })
                .ToList(),
        };
        if (FallbackModels.Contains(req.Model))
        {
            p = p with { Betas = ["server-side-fallback-2026-07-01"], Fallbacks = new Default() };
        }

        var res = await _client.Beta.Messages.Create(p, ct);
        var text = string.Join("\n", res.Content.Select(b => b.Value).OfType<BetaTextBlock>().Select(t => t.Text));
        var stop = res.StopReason?.ToString() ?? "";
        if (stop == "refusal")
            text = "The model declined this request.\n```json\n{\"status\":\"blocked\",\"summary\":\"Model refused the request\"}\n```";
        return new LlmResult(text, (int)res.Usage.InputTokens, (int)res.Usage.OutputTokens, stop);
    }

    private static Effort ParseEffort(string e) => e switch
    {
        "low" => Effort.Low,
        "high" => Effort.High,
        "max" => Effort.Max,
        _ => Effort.Medium,
    };
}
