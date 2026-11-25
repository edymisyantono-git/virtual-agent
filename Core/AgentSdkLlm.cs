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
    public bool SupportsTools => true;

    public AgentSdkLlm(string runnerDir, int port = 5081)
    {
        _runnerDir = runnerDir;
        _http = new HttpClient { BaseAddress = new Uri($"http://127.0.0.1:{port}"), Timeout = TimeSpan.FromMinutes(60) };   // stuck calls are cut off by the runner's stall watchdog, not here
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
            // Agents run `dotnet build`; put the SDK this server runs on first, ahead of an SDK-less dotnet on PATH.
            Environment =
            {
                ["PATH"] = Path.GetDirectoryName(AppWorkspace.Dotnet) is { Length: > 0 } sdkDir ? sdkDir + Path.PathSeparator + Environment.GetEnvironmentVariable("PATH") : Environment.GetEnvironmentVariable("PATH"),
                ["DOTNET_CLI_TELEMETRY_OPTOUT"] = "1",
                ["DOTNET_NOLOGO"] = "1",
            },
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

    /// Hold (or release) every agent of a project at its next action: a real pause, not only "nothing new starts".
    public async Task SetPausedAsync(string projectId, bool paused)
    {
        try { await _http.PostAsJsonAsync("/pause", new { project = projectId, paused }); }
        catch (HttpRequestException) { /* runner not running: nothing to hold */ }
    }

    private async Task<bool> HealthyAsync()
    {
        try { return (await _http.GetAsync("/health")).IsSuccessStatusCode; }
        catch (HttpRequestException) { return false; }
    }

    public async Task<LlmResult> CompleteAsync(LlmRequest req, Project project, CancellationToken ct)
    {
        var jobId = $"{project.Id}:{req.AgentId}:{Guid.NewGuid():N}";
        var job = new { agentId = req.AgentId, model = req.Model, effort = req.Effort, maxOutputTokens = req.MaxTokens, system = req.System, prompt = Flatten(req.Messages),
            tools = req.Tools, cwd = req.Cwd, maxTurns = req.MaxTurns, maxBudgetUsd = req.MaxBudgetUsd, jobId, allowedHosts = req.AllowedHosts ?? [],
            attachments = (req.Attachments ?? []).Where(a => File.Exists(a.Path))
                .Select(a => new { name = a.Name, mediaType = a.MediaType, data = Convert.ToBase64String(File.ReadAllBytes(a.Path)) }).ToList() };

        // While the runner works, ask it every 2 s what the agent is doing and pass that on.
        using var pollCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        var poll = req.OnProgress == null ? Task.CompletedTask : PollAsync(jobId, req.OnProgress, pollCts.Token);
        try
        {
            var res = await _http.PostAsJsonAsync("/run", job, ct);
            var body = await res.Content.ReadFromJsonAsync<RunnerResult>(cancellationToken: ct)
                       ?? throw new InvalidOperationException("Empty answer from the agent runner.");
            if (!body.Ok) throw new InvalidOperationException(body.Code == "rate_limit" ? body.Error : $"Agent SDK error: {body.Error}");
            return new LlmResult(body.Text ?? "", body.InputTokens, body.OutputTokens, body.StopReason ?? "end_turn", body.CostUsd, body.CacheReadTokens);
        }
        finally
        {
            pollCts.Cancel();
            try { await poll; } catch (OperationCanceledException) { }
        }
    }

    /// Opens `url` in a headless browser (through the runner) and returns what it saw, as text for QA.
    /// Screenshots are written to `outDir` (inside the app folder, so QA can Read them).
    public async Task<string?> BrowseAsync(string url, string outDir, CancellationToken ct)
    {
        try
        {
            var res = await _http.PostAsJsonAsync("/browse", new { url, outDir }, ct);
            var r = await res.Content.ReadFromJsonAsync<BrowseResult>(cancellationToken: ct);
            if (r == null) return null;
            if (!r.Ok) return $"BROWSER CHECK: could not run ({r.Error}).";
            var sb = new StringBuilder($"BROWSER CHECK (real headless browser, 1280x800, on {url}):\n");
            sb.AppendLine($"- Title: {r.Title}; canvas: {(r.Canvas.Count == 0 ? "none" : string.Join(", ", r.Canvas))}; WebGL: {r.Webgl}; frame rate: about {r.Fps} fps");
            sb.AppendLine($"- Visible text: {r.Text}");
            sb.AppendLine(r.Exceptions.Count == 0 ? "- Uncaught JavaScript errors: none" : "- Uncaught JavaScript errors:\n  - " + string.Join("\n  - ", r.Exceptions));
            sb.AppendLine(r.Console.Count == 0 ? "- Console errors/warnings: none" : "- Console errors/warnings:\n  - " + string.Join("\n  - ", r.Console));
            sb.AppendLine(r.Failed.Count == 0 ? "- Failed requests: none" : "- Failed requests (missing files or broken calls):\n  - " + string.Join("\n  - ", r.Failed));
            sb.AppendLine("- Screenshots (Read them): .qa/screen-1-loaded.png (after load), .qa/screen-2-after-input.png (after a click in the middle, Enter and Space)");
            return sb.ToString();
        }
        catch (Exception ex) when (ex is HttpRequestException or System.Text.Json.JsonException or TaskCanceledException && !ct.IsCancellationRequested)
        {
            return $"BROWSER CHECK: could not run ({ex.Message}).";
        }
    }

    private record BrowseResult(bool Ok, string? Error, string? Title, List<string> Console, List<string> Exceptions, List<string> Failed,
        List<string> Canvas, string? Webgl, int? Fps, string? Text);

    private async Task PollAsync(string jobId, Action<AgentProgress> onProgress, CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            await Task.Delay(2000, ct);
            try
            {
                var r = await _http.GetAsync("/progress/" + Uri.EscapeDataString(jobId), ct);
                if (!r.IsSuccessStatusCode) continue;   // not registered yet, or just finished
                var s = await r.Content.ReadFromJsonAsync<RunnerProgress>(cancellationToken: ct);
                if (s == null) continue;
                onProgress(new AgentProgress(s.Phase ?? "starting", s.Tool, s.Detail, s.OutTokens, s.Turns, s.ElapsedSec, s.IdleSec,
                    s.Retry == null ? null : new RetryInfo(s.Retry.Attempt, s.Retry.Max, s.Retry.WaitMs, s.Retry.Error, s.Retry.Status),
                    s.RateLimit == null ? null : new RateLimitInfo(s.RateLimit.Status, s.RateLimit.ResetsAt, s.RateLimit.Type, s.RateLimit.Utilization)));
            }
            catch (HttpRequestException) { /* runner busy or restarting: try again next tick */ }
            catch (System.Text.Json.JsonException) { }
        }
    }

    private record RunnerProgress(string? Phase, string? Tool, string? Detail, int OutTokens, int Turns, int ElapsedSec, int IdleSec,
        RunnerRetry? Retry, RunnerRateLimit? RateLimit);
    private record RunnerRetry(int Attempt, int Max, int WaitMs, string? Error, int? Status);
    private record RunnerRateLimit(string? Status, long? ResetsAt, string? Type, double? Utilization);

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

    private record RunnerResult(bool Ok, string? Text, string? Error, int InputTokens, int OutputTokens, decimal? CostUsd, string? StopReason, string? Code = null, long CacheReadTokens = 0);
}
