using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace VirtualCompany.Core;

/// Offline stand-in for Claude: returns role-specific documents in the same format a live
/// agent must produce (markdown + a ```json handoff block), so the orchestrator runs one code path.
public class SimulatedLlm : ILlmClient
{
    public bool IsLive => false;
    private static readonly string[] SlotOrder = ["problem", "users", "features", "integrations", "constraints"];

    public async Task<LlmResult> CompleteAsync(LlmRequest req, Project p, CancellationToken ct)
    {
        await Task.Delay(Random.Shared.Next(1400, 3600), ct);   // let the floor animation breathe
        var round = Regex.Match(req.Messages.Last().Text, @"ROUND (\d+)") is { Success: true } m ? int.Parse(m.Groups[1].Value) : 1;
        var module = Regex.Match(req.Messages.Last().Text, @"ASSIGNED MODULE: (.+)") is { Success: true } mm ? mm.Groups[1].Value.Trim() : null;
        var answered = req.Messages.Last().Text.Contains("CUSTOMER ANSWERS");

        var text = req.AgentId switch
        {
            "intake" => Intake(p),
            "bizdev" => BizDev(p),
            "business_analyst" => answered ? Brd(p) : BaQuestions(),
            "project_manager" => Plan(p),
            "uiux" => Ux(p),
            "architect" => Architecture(p),
            "finance_legal" => Contract(p),
            "frontend_dev" => Frontend(module ?? "Core", round),
            "backend_dev" => Backend(module ?? "Core", round),
            "db_dev" => Database(p, round),
            "qa" => Qa(p, round),
            "security" => Security(),
            "devops" => DevOps(p),
            "marketing" => Marketing(p),
            "support" => Support(),
            "data_analyst" => Data(p),
            _ => Generic(req.AgentId),
        };
        var input = (req.System.Length + req.Messages.Sum(x => x.Text.Length)) / 4;
        return new LlmResult(text, input, text.Length / 4 + Random.Shared.Next(200, 900), "end_turn");
    }

    // ---------- intake ----------

    private static string Intake(Project p)
    {
        var slots = new Dictionary<string, string>(p.Brief);
        var lastCustomer = p.Chat.LastOrDefault(c => c.Role == "customer")?.Text ?? "";
        var next = SlotOrder.FirstOrDefault(s => !slots.ContainsKey(s));
        if (next != null && lastCustomer.Length > 0) { slots[next] = lastCustomer; next = SlotOrder.FirstOrDefault(s => !slots.ContainsKey(s)); }

        string reply = next switch
        {
            "users" => "Thanks, that's clear. Who will use the system, and roughly how many people per role?",
            "features" => "Got it. If you could only have 3 to 5 features at launch, which ones would they be?",
            "integrations" => "Does it need to connect to other systems, for example SSO login, an ERP, or email notifications?",
            "constraints" => "Last question: when do you need it running, and is there a budget range we should plan for?",
            null => "Thank you, I have everything I need. I'm handing your request to our Business Development team now. You'll see each team pick it up on the floor.",
            _ => "Tell me about the problem you want solved.",
        };
        var json = JsonSerializer.Serialize(new { reply, slots, complete = next == null });
        return json;
    }

    // ---------- documents ----------

    private static string B(Project p, string k, string fallback = "-") => p.Brief.TryGetValue(k, out var v) ? v : fallback;

    private static List<string> Features(Project p)
    {
        var raw = B(p, "features", "Request, Approval, Reporting");
        var parts = Regex.Split(raw, @",|;|\band\b|\bdan\b|\n|\d\.").Select(s => s.Trim(' ', '.', '-')).Where(s => s.Length > 2).ToList();
        return parts.Count > 0 ? parts.Take(6).ToList() : ["Request", "Approval", "Reporting"];
    }

    private static string Handoff(string status, string summary, object? data = null, IEnumerable<string>? questions = null) =>
        "\n```json\n" + JsonSerializer.Serialize(new { status, summary, open_questions = questions ?? [], data }, new JsonSerializerOptions { WriteIndented = true }) + "\n```\n";

    private static string BizDev(Project p)
    {
        var f = Features(p);
        var weeks = Math.Max(8, f.Count * 2 + 4);
        var rate = 38_500_000;
        var sb = new StringBuilder();
        sb.AppendLine($"# Proposal: {p.Title}");
        sb.AppendLine("## Problem\n" + B(p, "problem"));
        sb.AppendLine("## Proposed solution\nA web application covering: " + string.Join(", ", f) + ".");
        sb.AppendLine("## Scope\n- In: " + string.Join("; ", f) + "; admin settings; audit trail.\n- Out: native mobile apps, data migration from paper records.");
        sb.AppendLine($"## Timeline ({weeks} weeks)\n| Phase | Weeks |\n|---|---|\n| Discovery & requirements | 1-2 |\n| Design | 3 |\n| Build | 4-{weeks - 4} |\n| QA & UAT | {weeks - 3}-{weeks - 2} |\n| Release & hypercare | {weeks - 1}-{weeks} |");
        sb.AppendLine("## Quotation (IDR)\n| Item | Amount |\n|---|---|");
        long total = 0;
        foreach (var (item, w) in new[] { ("Discovery & BRD", 2), ("UI/UX & architecture", 1), ("Development", weeks - 7), ("QA & UAT", 2), ("Release & hypercare", 2) })
        {
            var amt = (long)w * rate; total += amt;
            sb.AppendLine($"| {item} | {amt:N0} |");
        }
        sb.AppendLine($"| **Total** | **{total:N0}** |");
        sb.AppendLine("\nAssumptions: users sign in with existing corporate accounts; hosting is provided by the customer.");
        return sb + Handoff("done", $"Proposal for {f.Count} modules, {weeks} weeks, IDR {total:N0}.", new { weeks, total });
    }

    private static string BaQuestions() =>
        "# Requirements: open questions\nTwo answers change the design, so I need them before writing the BRD." +
        Handoff("need_info", "Need 2 answers before the BRD.", null, [
            "How many approval levels does a request need, and who approves at each level?",
            "Should users sign in with the company's Windows/Microsoft account (SSO), or with a separate username and password?",
        ]);

    private static string Brd(Project p)
    {
        var f = Features(p);
        var sb = new StringBuilder($"# Business Requirements Document: {p.Title}\n");
        sb.AppendLine("## Stakeholders\n" + B(p, "users"));
        sb.AppendLine("## To-be process\n1. Requester submits a request.\n2. Approver(s) review in order and approve or reject with a note.\n3. Fulfilment team processes approved requests.\n4. Requester confirms receipt; the request closes.");
        sb.AppendLine("## Business rules\n- BR-01 A request cannot skip an approval level.\n- BR-02 A rejected request needs a reason.\n- BR-03 Every status change is written to the audit trail.\n- BR-04 Only the assigned approver can decide.");
        sb.AppendLine("## User stories");
        var i = 1;
        foreach (var x in f)
        {
            sb.AppendLine($"**US-{i:00} {x}**: As a user I want {x.ToLower()} so that the process is faster and traceable.");
            sb.AppendLine($"- Given I am signed in, when I open {x}, then I only see records I am allowed to see.");
            i++;
        }
        sb.AppendLine("## Non-functional\n- Page load under 2 s for 95% of requests.\n- SSO sign-in.\n- Audit trail retained 5 years.");
        return sb + Handoff("done", $"BRD with {f.Count} user stories and 4 business rules.");
    }

    private static string Plan(Project p)
    {
        var f = Features(p);
        var be = Math.Clamp(f.Count, 1, 3);
        var fe = Math.Clamp((f.Count + 1) / 2, 1, 2);
        var sb = new StringBuilder("# Project plan\n## Modules\n");
        foreach (var x in f) sb.AppendLine("- " + x);
        sb.AppendLine("## Work breakdown\n| Work | Owner | Week |\n|---|---|---|\n| UX spec & architecture | UX, SA | 3 |\n| Database & API | DB, BE | 4-6 |\n| Screens | FE | 5-7 |\n| Test & fix | QA | 8-9 |\n| Release | DevOps | 10 |");
        sb.AppendLine($"## Staffing\n{be} backend and {fe} frontend developer instances, working in parallel per module.");
        sb.AppendLine("## Risks\n- Approval rules may change after UAT. Mitigation: rules kept in configuration.\n- SSO setup depends on customer IT.");
        return sb + Handoff("done", $"{f.Count} modules; staffing {be} BE + {fe} FE.", new { modules = f, instances = new Dictionary<string, int> { ["backend_dev"] = be, ["frontend_dev"] = fe, ["qa"] = 1 } });
    }

    private static string Ux(Project p) =>
        $"# UX specification\n## Screens\n" + string.Join("\n", Features(p).Select((f, i) => $"{i + 1}. {f}: list + detail drawer, filters on top, primary action top-right.")) +
        "\n## Wireframe: request form\n```\n[ Header: New request            ( Submit ) ]\n[ Item picker | Qty | Reason              ]\n[ Approver ▼                              ]\n```\n## Tokens\nPrimary #1F5FAD, radius 6 px, base font 14 px." +
        Handoff("done", "Screen inventory, wireframes and design tokens ready.");

    private static string Architecture(Project p) =>
        "# Architecture\n- Web app: ASP.NET Core 9 MVC\n- Database: SQL Server\n- Auth: Windows SSO (Negotiate)\n- Realtime: SignalR for approval notifications\n## Tables\n| Table | Key columns |\n|---|---|\n| Request | Id, RequesterId, Status, CreatedAt |\n| RequestItem | Id, RequestId, ItemId, Qty |\n| Approval | Id, RequestId, Level, ApproverId, Decision |\n| AuditLog | Id, Entity, EntityId, Action, By, At |\n## API\n| Method | Path |\n|---|---|\n| POST | /api/requests |\n| POST | /api/requests/{id}/approve |\n| GET | /api/reports/kpi |" +
        Handoff("done", "4 tables, 3 core endpoints, SSO + SignalR.");

    private static string Contract(Project p) =>
        "# Statement of work & payment\n| Milestone | Deliverable | % |\n|---|---|---|\n| M1 | Signed BRD | 30 |\n| M2 | UAT sign-off | 50 |\n| M3 | Go-live + 30 days | 20 |\nWarranty 90 days. Change requests are quoted separately. IP transfers to the customer on final payment." +
        Handoff("done", "3 payment milestones, 90-day warranty.");

    private static string Frontend(string module, int round) =>
        $"# Frontend: {module}{(round > 1 ? $" (fix round {round})" : "")}\n```html\n<section class=\"page\">\n  <h1>{module}</h1>\n  <table id=\"grid\"></table>\n</section>\n```" +
        Handoff("done", round > 1 ? $"{module}: UI defects fixed." : $"{module}: list, detail and form screens built.");

    private static string Backend(string module, int round) =>
        $"# Backend: {module}{(round > 1 ? $" (fix round {round})" : "")}\n```csharp\n[HttpPost(\"approve\")]\npublic async Task<IActionResult> Approve(int id) {{\n    // BR-01, BR-04\n    var r = await _svc.ApproveAsync(id, User);\n    return Ok(r);\n}}\n```" +
        Handoff("done", round > 1 ? $"{module}: defects fixed, tests green." : $"{module}: endpoints and rules implemented.");

    private static string Database(Project p, int round) =>
        "# Database\n```sql\nCREATE TABLE Request (Id INT IDENTITY PRIMARY KEY, RequesterId NVARCHAR(50) NOT NULL, Status NVARCHAR(20) NOT NULL, CreatedAt DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME());\nCREATE INDEX IX_Request_Status ON Request(Status);\n```" +
        Handoff("done", round > 1 ? "Index added for the slow report." : "Schema, indexes and KPI views created.");

    private static string Qa(Project p, int round)
    {
        var bugs = round == 1 ? 3 : 0;
        var defects = bugs > 0 ? new[] { "High: approver can approve own request (BR-04)", "Medium: reject without reason is accepted (BR-02)", "Low: report date filter ignores time zone" } : [];
        return $"# Test report, round {round}\n| Case | Result |\n|---|---|\n| UAT-01 Requester submits | Pass |\n| UAT-02 Approval level 1 | {(bugs > 0 ? "Fail" : "Pass")} |\n| UAT-03 Reject with reason | {(bugs > 0 ? "Fail" : "Pass")} |\n| UAT-04 Report | {(bugs > 0 ? "Fail" : "Pass")} |\n" +
               (bugs > 0 ? "## Defects\n" + string.Join("\n", defects.Select(d => "- " + d)) : "All acceptance criteria pass.") +
               Handoff("done", bugs > 0 ? $"{bugs} defects found, back to Build." : "All tests pass. Ready to release.", new { bugs, defects });
    }

    private static string Security() =>
        "# Security review\n| Finding | Severity | Fix |\n|---|---|---|\n| Connection string in appsettings | Medium | Move to secret store |\n| Missing rate limit on login | Low | Add rate limiter |\nNo critical findings." +
        Handoff("done", "2 findings (medium, low). Release not blocked.");

    private static string DevOps(Project p) =>
        "# Release plan\n1. CI: build, test, publish artifact.\n2. Run DB migrations on staging, smoke test.\n3. Deploy to production (IIS), keep previous build for rollback.\n4. Monitoring: uptime + error-rate alerts.\nBackup taken before migration." +
        Handoff("done", "Pipeline, staging verified, rollback plan ready.");

    private static string Marketing(Project p) =>
        "# Launch plan\n- Announcement email to all users on go-live day.\n- 30-minute training per role.\n- Adoption KPI: 80% of requests submitted in the system by week 4." +
        Handoff("done", "Launch email, training plan and adoption target set.");

    private static string Support() =>
        "# Support runbook\n| Priority | Response | Resolve |\n|---|---|---|\n| P1 outage | 30 min | 4 h |\n| P2 broken feature | 4 h | 2 days |\n| P3 question | 1 day | 5 days |\nEscalation: Support → Engineering on-call → Project Manager." +
        Handoff("done", "SLA tiers, escalation path and FAQ ready.");

    private static string Data(Project p) =>
        "# KPI dashboard\n| KPI | Formula |\n|---|---|\n| Approval lead time | AVG(approved_at - submitted_at) |\n| Fulfilment rate | fulfilled / approved |\n| On-time delivery | delivered_by_due / delivered |\n## Improvement hypotheses\n- Level-2 approvals take 3x longer than level 1: add reminders after 24 h." +
        Handoff("done", "3 KPIs defined; first improvement idea sent to the Project Manager.", new { feedback = "Add approval reminders after 24 h" });

    private static string Generic(string id) =>
        $"# {id} output\nWork completed." + Handoff("done", $"{id} finished its task.");
}
