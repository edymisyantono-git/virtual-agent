using System.Text.Json.Nodes;

namespace VirtualCompany.Core;

/// The USD → IDR exchange rate, locked into a project when its budget is given, so every agent converts with the
/// same, real rate instead of assuming one. Source: the European Central Bank's daily reference rate through
/// Frankfurter (free, no key). Chosen by the owner; no other site is contacted.
public class FxRates
{
    private static readonly string[] Urls =
    [
        "https://api.frankfurter.app/latest?from=USD&to=IDR",
        "https://api.frankfurter.dev/v1/latest?base=USD&symbols=IDR",   // the same service under its newer address
    ];
    private readonly HttpClient _http = new() { Timeout = TimeSpan.FromSeconds(10) };
    private readonly ILogger<FxRates> _log;
    private FxRate? _cached;

    public FxRates(ILogger<FxRates> log) { _log = log; }

    /// The latest rate (cached for an hour), or null when the service cannot be reached.
    public async Task<FxRate?> UsdIdrAsync(CancellationToken ct)
    {
        if (_cached is { } c && DateTime.UtcNow - c.LockedAt < TimeSpan.FromHours(1)) return c with { LockedAt = DateTime.UtcNow };
        foreach (var url in Urls)
        {
            try
            {
                var json = JsonNode.Parse(await _http.GetStringAsync(url, ct));
                var rate = json?["rates"]?["IDR"]?.GetValue<decimal>() ?? 0;
                if (rate <= 0) continue;
                _cached = new FxRate(rate, json?["date"]?.GetValue<string>() ?? "", "ECB reference rate via Frankfurter", DateTime.UtcNow);
                return _cached;
            }
            catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or System.Text.Json.JsonException or InvalidOperationException)
            {
                _log.LogWarning("Exchange rate from {Url} failed: {Error}", url, ex.Message);
            }
        }
        return null;
    }
}
