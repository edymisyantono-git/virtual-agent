using System.Diagnostics;
using System.Net.Http.Json;
using System.Text;

namespace VirtualCompany.Core;

/// Runs each agent turn through the Claude Agent SDK via the local Node runner (agent-runner/server.mjs).
/// The runner is started with the app and stopped with it.
public class AgentSdkLlm : ILlmClient, IDisposable
{
    private readonly HttpClient _http;
    private readonly string _runnerDir;
    private Process? _runner;

    public bool IsLive => true;

    public AgentSdkLlm(string runnerDir, int port = 5081)
    {
        _runnerDir = runnerDir;
        _http = new HttpClient { BaseAddress = new Uri($"http://127.0.0.1:{port}"), Timeout = TimeSpan.FromMinutes(15) };
    }

    /// Starts the Node runner unless one is already answering on the port.
    public async Task EnsureRunnerAsync(ILogger log)
    {
        if (await HealthyAsync()) return;
        if (!Directory.Exists(Path.Combine(_runnerDir, "node_modules")))
            throw new InvalidOperationException($"Run 'npm install' in {_runnerDir} first.");
        _runner = Process.Start(new ProcessStartInfo("node", "server.mjs")
        {
            WorkingDirectory = _runnerDir,
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true,
        });
        if (_runner == null) throw new InvalidOperationException("Could not start node. Is Node.js installed and on PATH?");
        _runner.OutputDataReceived += (_, e) => { if (e.Data != null) log.LogInformation("[runner] {Line}", e.Data); };
        _runner.ErrorDataReceived += (_, e) => { if (e.Data != null) log.LogWarning("[runner] {Line}", e.Data); };
        _runner.BeginOutputReadLine();
        _runner.BeginErrorReadLine();
        for (var i = 0; i < 30; i++)
        {
            await Task.Delay(500);
            if (await HealthyAsync()) return;
        }
        throw new InvalidOperationException("The agent runner did not start within 15 seconds.");
    }

    private async Task<bool> HealthyAsync()
    {
        try { return (await _http.GetAsync("/health")).IsSuccessStatusCode; }
        catch (HttpRequestException) { return false; }
    }

    public async Task<LlmResult> CompleteAsync(LlmRequest req, Project project, CancellationToken ct)
    {
        var job = new { agentId = req.AgentId, model = req.Model, effort = req.Effort, maxOutputTokens = req.MaxTokens, system = req.System, prompt = Flatten(req.Messages) };
        var res = await _http.PostAsJsonAsync("/run", job, ct);
        var body = await res.Content.ReadFromJsonAsync<RunnerResult>(cancellationToken: ct)
                   ?? throw new InvalidOperationException("Empty answer from the agent runner.");
        if (!body.Ok) throw new InvalidOperationException($"Agent SDK error: {body.Error}");
        return new LlmResult(body.Text ?? "", body.InputTokens, body.OutputTokens, body.StopReason ?? "end_turn", body.CostUsd);
    }

    /// The SDK takes one prompt, so a multi-turn chat is passed as a transcript.
    private static string Flatten(List<(string Role, string Text)> messages)
    {
        if (messages.Count == 1) return messages[0].Text;
        var sb = new StringBuilder("Conversation so far:\n\n");
        foreach (var (role, text) in messages)
            sb.AppendLine($"{(role == "assistant" ? "You" : "Customer")}: {text}\n");
        sb.Append("Write your next reply now, following your instructions.");
        return sb.ToString();
    }

    public void Dispose()
    {
        try { if (_runner is { HasExited: false }) _runner.Kill(entireProcessTree: true); } catch (InvalidOperationException) { }
        _http.Dispose();
    }

    private record RunnerResult(bool Ok, string? Text, string? Error, int InputTokens, int OutputTokens, decimal? CostUsd, string? StopReason);
}
