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
        // Let the floor animation breathe, reporting progress like the live engine does.
        var total = Random.Shared.Next(1400, 3600);
        for (var step = 1; step <= 4; step++)
        {
            await Task.Delay(total / 4, ct);
            req.OnProgress?.Invoke(new AgentProgress(step == 1 ? "thinking" : "writing", null, null, step * 180, 0, total * step / 4000, 0));
        }
        var round = Regex.Match(req.Messages.Last().Text, @"ROUND (\d+)") is { Success: true } m ? int.Parse(m.Groups[1].Value) : 1;
        var module = Regex.Match(req.Messages.Last().Text, @"ASSIGNED MODULE: (.+)") is { Success: true } mm ? mm.Groups[1].Value.Trim() : null;
        var answered = req.Messages.Last().Text.Contains("CUSTOMER ANSWERS");
        var last = req.Messages.Last().Text;

        // Customer questions after intake: answer from the facts in the prompt.
        var q = Regex.Match(last, @"CUSTOMER QUESTION: (.+)$", RegexOptions.Singleline);
        if (q.Success) return Done(req, AnswerQuestion(last, q.Groups[1].Value.Trim()));

        // Delegation demo: a role allowed to split does so once its questions are answered; helpers write parts; the lead merges.
        var part = Regex.Match(last, @"YOUR SUBTASK \((\d+) of (\d+)\): (.+)");
        if (part.Success)
            return Done(req, $"## Part {part.Groups[1].Value}: {part.Groups[3].Value.Trim()}\n- Draft section prepared by a helper.\n- Covers the items listed in the subtask." +
                             Handoff("done", $"Wrote part {part.Groups[1].Value} of {part.Groups[2].Value}."));
        var merging = last.Contains("PARTS FROM YOUR HELPERS");
        if (req.AgentId == "business_analyst" && answered && !merging && req.System.Contains("SPLITTING WORK"))
            return Done(req, Handoff("delegate", "The BRD covers many processes; splitting it into two parts.", new
            {
                subtasks = new[]
                {
                    new { title = "Process and business rules", instructions = "As-is and to-be process, business rules BR-xx." },
                    new { title = "User stories and acceptance criteria", instructions = "One story per feature with Given/When/Then." },
                },
            }));

        // A role the PM staffed in parallel can still call in helpers: each gets a new box after the staffed ones.
        if (req.AgentId == "backend_dev" && round == 1 && module != null && !merging && req.System.Contains("SPLITTING WORK"))
            return Done(req, Handoff("delegate", $"{module} has an API layer and a service layer; splitting it.", new
            {
                subtasks = new[]
                {
                    new { title = $"{module}: API endpoints", instructions = "Controllers, request/response models, validation." },
                    new { title = $"{module}: services and rules", instructions = "Business rules and data access for the module." },
                },
            }));

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
            "tech_writer" => HandoverDoc(p),
            _ => Generic(req.AgentId),
        };
        var input = (req.System.Length + req.Messages.Sum(x => x.Text.Length)) / 4;
        return new LlmResult(text, input, text.Length / 4 + Random.Shared.Next(200, 900), "end_turn");
    }

    private static string AnswerQuestion(string prompt, string question)
    {
        var indo = Regex.IsMatch(question, @"\b(dimana|di mana|mana|apa|bagaimana|hasil|sudah|kapan|berapa)\b", RegexOptions.IgnoreCase);
        var docs = Regex.Matches(prompt, @"^- (.+?) \[", RegexOptions.Multiline).Select(m => m.Groups[1].Value).ToList();
        var status = Regex.Match(prompt, @"^(\d+ of \d+ stages.+)$", RegexOptions.Multiline).Groups[1].Value;
        if (Regex.IsMatch(question, @"hasil|dokumen|result|document|output|deliverable|dimana|di mana|where", RegexOptions.IgnoreCase))
        {
            var top = string.Join(", ", docs.Take(5));
            return indo
                ? $"Semua hasil ada di tab Documents di sisi kanan halaman proyek ({docs.Count} dokumen). Klik salah satu untuk membacanya, atau tekan 'Download all (.zip)' untuk mengunduh semuanya sekaligus. Yang paling penting: {top}."
                : $"All results are in the Documents tab on the right of the project page ({docs.Count} documents). Click one to read it, or press 'Download all (.zip)' to save them all. The key ones: {top}.";
        }
        return indo ? $"Status terkini: {status}" : $"Current status: {status}";
    }

    private static LlmResult Done(LlmRequest req, string text) =>
        new(text, (req.System.Length + req.Messages.Sum(x => x.Text.Length)) / 4, text.Length / 4 + Random.Shared.Next(100, 400), "end_turn");

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
        return sb + Handoff("done", $"{f.Count} modules; staffing {be} BE + {fe} FE.", new { modules = f.Select((x, i) => $"M{i + 1:00} {x}").ToList(), instances = new Dictionary<string, int> { ["backend_dev"] = be, ["frontend_dev"] = fe, ["qa"] = 1 } });
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
        Handoff("done", round > 1 ? $"{module}: UI defects fixed." : $"{module}: list, detail and form screens built.",
            new { modules = Mods(module, round > 1 ? "UI defects fixed and re-checked; done" : "list, detail and form screens built; done") });

    private static string Backend(string module, int round) =>
        $"# Backend: {module}{(round > 1 ? $" (fix round {round})" : "")}\n```csharp\n[HttpPost(\"approve\")]\npublic async Task<IActionResult> Approve(int id) {{\n    // BR-01, BR-04\n    var r = await _svc.ApproveAsync(id, User);\n    return Ok(r);\n}}\n```" +
        Handoff("done", round > 1 ? $"{module}: defects fixed, tests green." : $"{module}: endpoints and rules implemented.",
            new { modules = Mods(module, round > 1 ? "defects fixed, unit tests green; done" : "endpoints and business rules implemented; partial (waiting for QA)") });

    private static string HandoverDoc(Project p)
    {
        var mods = p.Plan?.Modules ?? Features(p);
        var sb = new StringBuilder($"# Project summary\n\n## Executive summary\n{p.Title} replaces the paper process with a web application. " +
            $"All {mods.Count} modules were built and tested; the system is live and the support team runs it.\n\n" +
            "## Objectives and scope\n| In scope | Out of scope |\n|---|---|\n| Requests, two-level approval, purchase orders, receiving, dashboard | SAP integration (phase 2) |\n\n" +
            "## What was delivered\n");
        foreach (var m in mods) sb.AppendLine($"- **{m}**: built, tested and accepted.");
        sb.AppendLine("\n## Solution and architecture\nA web application (ASP.NET Core) with a SQL database. Users sign in with their Windows account. " +
            "Approvers get an e-mail and an in-app notification when a request waits for them.\n\n" +
            "## Quality and security\n- Acceptance tests: all passed in round 2 after 3 defects were fixed.\n- Security review: 2 findings (medium, low), both fixed before release.\n\n" +
            "## How to run it\n1. Install the .NET 9 runtime on the server.\n2. Copy the release folder and set the connection string in `appsettings.json`.\n3. Start the service and open the site address in a browser.\n\n" +
            "## Known limitations\n- Reports are refreshed every 15 minutes, not live.\n\n## Recommended next steps\n1. Connect SAP for purchase orders.\n2. Add a mobile view for approvers.\n\n" +
            "## Support and warranty\nWarranty 90 days. Support hours Mon-Fri 08:00-17:00, response within 4 hours for high priority.\n\n" +
            "# User handbook\n\n## Getting started\n1. Open the site address given by your IT team.\n2. Sign in with your Windows account; your role (requester, supervisor, manager, warehouse) is set by the administrator.\n\n" +
            "## Requester: create a material request\n1. Click **New request**.\n2. Pick the items and quantities, add a reason.\n3. Click **Submit**. The request shows *Waiting for supervisor*.\n\n" +
            "## Supervisor and manager: approve a request\n1. Open **Approvals**.\n2. Open a request, check the items, then click **Approve** or **Reject** (a reason is required to reject).\n\n" +
            "## Warehouse: receive goods\n1. Open **Receiving**, select the purchase order.\n2. Enter the received quantities and click **Confirm**.\n\n" +
            "## Troubleshooting and FAQ\n| Problem | What to do |\n|---|---|\n| I cannot sign in | Ask IT to add your Windows account to the application group. |\n| My request is stuck | Check the status line; the approver gets a reminder after 24 hours. |\n\n" +
            "## Glossary\n- **PO**: purchase order.\n- **BR-xx**: business rule number from the requirements.");
        return sb + Handoff("done", "Client handover: project summary and user handbook.");
    }

    /// {"M01": text, ...} for every module code in an assignment such as "M01 Request, M03 Report".
    private static Dictionary<string, string> Mods(string module, string text) =>
        Regex.Matches(module, @"\bM\d+\b").Select(m => m.Value).Distinct().ToDictionary(c => c, _ => text);

    private static string Database(Project p, int round) =>
        "# Database\n```sql\nCREATE TABLE Request (Id INT IDENTITY PRIMARY KEY, RequesterId NVARCHAR(50) NOT NULL, Status NVARCHAR(20) NOT NULL, CreatedAt DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME());\nCREATE INDEX IX_Request_Status ON Request(Status);\n```" +
        Handoff("done", round > 1 ? "Index added for the slow report." : "Schema, indexes and KPI views created.");

    private static string Qa(Project p, int round)
    {
        var bugs = round == 1 ? 3 : 0;
        var defects = bugs > 0 ? new[] { "High: approver can approve own request (BR-04)", "Medium: reject without reason is accepted (BR-02)", "Low: report date filter ignores time zone" } : [];
        return $"# Test report, round {round}\n| Case | Result |\n|---|---|\n| UAT-01 Requester submits | Pass |\n| UAT-02 Approval level 1 | {(bugs > 0 ? "Fail" : "Pass")} |\n| UAT-03 Reject with reason | {(bugs > 0 ? "Fail" : "Pass")} |\n| UAT-04 Report | {(bugs > 0 ? "Fail" : "Pass")} |\n" +
               (bugs > 0 ? "## Defects\n" + string.Join("\n", defects.Select(d => "- " + d)) : "All acceptance criteria pass.") +
               Handoff("done", bugs > 0 ? $"{bugs} defects found, back to Build." : "All tests pass. Ready to release.", new { bugs, defects,
                   modules = (p.Plan?.Modules ?? []).Select((m, i) => (Code: m.Split(' ')[0], Text: bugs > 0 && i == 0 ? "3 defects: own-request approval, reject without reason, report time zone; blocked" : "acceptance tests pass; done"))
                       .ToDictionary(x => x.Code, x => x.Text) });
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
