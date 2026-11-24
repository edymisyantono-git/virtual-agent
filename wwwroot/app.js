// Virtual Company UI. Talks to the ASP.NET API (live/simulation) or, when window.VC_DEMO is set,
// replays a recorded project so the floor can be shown without a server.
(function () {
  const DEMO = !!window.VC_DEMO;
  const $ = (s, r = document) => r.querySelector(s);
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const SLOTS = [["problem", "Problem"], ["users", "Users"], ["features", "Features"], ["integrations", "Integrations"], ["constraints", "Deadline & budget"]];
  const SAMPLE = [
    "Our workshop tracks material requests on paper. Approvals take days and nobody knows where a request is.",
    "About 200 requesters, 15 supervisors, 5 managers and 6 warehouse staff.",
    "Material request, two-level approval, purchase order, goods receiving, reporting dashboard",
    "Windows SSO login and email notifications. Later maybe SAP.",
    "We need it live in 3 months. Budget is around 500 million rupiah.",
  ];
  const SAMPLE_ANSWER = "Two levels: the supervisor first, then the department manager. Please use Windows SSO.";

  const S = {
    meta: null, id: null, es: null, replaying: false, status: "Intake", title: "",
    brief: {}, artifacts: [], tokens: 0, cost: 0, firstTs: null, lastTs: null, gate: null,
    overrides: {}, sample: false, sampleIdx: 0, view: "floor", sub: "activity", stageIdx: {},
  };
  let viz;

  // ---------------- transport ----------------
  const api = {
    async get(p) { const r = await fetch("/api" + p); if (!r.ok) throw new Error(await errText(r)); return r.json(); },
    async send(method, p, body) {
      const r = await fetch("/api" + p, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) });
      if (!r.ok) throw new Error(await errText(r));
      const t = await r.text(); return t ? JSON.parse(t) : null;
    },
  };
  async function errText(r) { try { const j = await r.json(); return j.error || j.detail || j.title || r.statusText; } catch { return r.statusText; } }

  // ---------------- shell ----------------
  function shell() {
    const logo = `<svg width="30" height="30" viewBox="0 0 30 30" aria-hidden="true"><circle cx="6" cy="15" r="4" fill="var(--d-support)"/><circle cx="16" cy="7" r="4" fill="var(--d-product)"/><circle cx="16" cy="23" r="4" fill="var(--d-engineering)"/><circle cx="26" cy="15" r="4" fill="var(--d-data)"/><path d="M9.5 13 13 9.5M9.5 17 13 20.5M19.5 9.5 23 13M19.5 20.5 23 17" stroke="var(--signal)" stroke-width="1.6" stroke-linecap="round"/></svg>`;
    document.getElementById("app").innerHTML = `
<header class="topbar">
  <div class="brand">${logo}<div><b id="company">Virtual Company</b><small>AI-agent company floor</small></div></div>
  <nav class="tabs" role="tablist" aria-label="View">
    <button role="tab" data-view="floor" aria-selected="true">Floor</button>
    <button role="tab" data-view="registry" aria-selected="false">Registry</button>
  </nav>
  <span class="spacer"></span>
  <span id="mode" class="pill sim">SIMULATION</span>
  ${DEMO ? `
  <label class="check">Speed <select id="speed" class="field"><option value="1" selected>1\u00d7</option><option value="2">2\u00d7</option><option value="4">4\u00d7</option></select></label>
  <button class="btn primary" id="replayBtn">Replay</button>` : `
  <select id="projectPick" class="field" aria-label="Open project"></select>
  <label class="check"><input type="checkbox" id="autoApprove"> Auto-approve gates</label>
  <button class="btn" id="sampleBtn">Run sample request</button>
  <button class="btn primary" id="newBtn">New request</button>`}
</header>

<main id="floorView" class="floor">
  <section class="panel chat" aria-label="Customer chat">
    <header><div><div class="eyebrow">Customer</div><h2>Request chat</h2></div></header>
    <div class="slots" id="slots"></div>
    <div class="messages" id="messages" aria-live="polite"></div>
    <form class="composer" id="composer">
      <textarea id="chatInput" class="field" placeholder="Describe what you need\u2026" aria-label="Message"></textarea>
      <button class="btn signal" id="sendBtn" type="submit">Send</button>
    </form>
    <p class="composer-note" id="composerNote"></p>
  </section>
  <div class="splitter" data-side="left" role="separator" aria-orientation="vertical" aria-label="Resize chat panel" tabindex="0" title="Drag to resize. Double-click to reset."></div>

  <section class="panel stage" aria-label="Operations floor">
    <div class="hud">
      <div class="title"><div class="eyebrow" id="projId">No project yet</div><h1 id="projTitle">Start a request to staff the floor</h1></div>
      <div class="stat"><span class="eyebrow">Status</span><span class="status-row"><span class="status-chip" id="statusChip" data-s="Intake">Intake</span><button class="btn signal sm" id="resumeBtn" type="button" hidden>Resume</button><button class="btn sm" id="stopBtn" type="button" hidden>Stop</button></span></div>
      <div class="stat"><span class="eyebrow">Agents on it</span><b id="activeAgents">0</b></div>
      <div class="stat"><span class="eyebrow">Tokens</span><b id="tokens">0</b></div>
      <div class="stat"><span class="eyebrow">Cost (USD)</span><b id="cost">0.0000</b></div>
      <div class="stat"><span class="eyebrow">Elapsed</span><b id="elapsed">0:00</b></div>
    </div>
    <div class="viz-wrap"><svg id="floor" role="img" aria-label="Pipeline of agents by department"></svg></div>
    <div class="ribbon" id="ribbon"></div>
  </section>
  <div class="splitter" data-side="right" role="separator" aria-orientation="vertical" aria-label="Resize control panel" tabindex="0" title="Drag to resize. Double-click to reset."></div>

  <section class="panel side" aria-label="Control">
    <div id="gateSlot"></div>
    <div class="subtabs" role="tablist">
      <button role="tab" data-sub="activity" aria-selected="true">Activity</button>
      <button role="tab" data-sub="docs" aria-selected="false">Documents <span id="docCount" class="mono"></span></button>
      <button role="tab" data-sub="models" aria-selected="false">Models</button>
    </div>
    <div class="pane" id="pane-activity"><ul class="feed" id="feed"></ul></div>
    <div class="pane" id="pane-docs" hidden><div class="doclist" id="docs"></div></div>
    <div class="pane" id="pane-models" hidden><div class="modelrows" id="modelRows"></div></div>
  </section>
</main>

<main id="registryView" class="registry" hidden>
  <section class="panel">
    <header><div><div class="eyebrow">agents.json</div><h2>Positions & models</h2></div><span class="spacer"></span>
      <label class="check">Override every agent <select id="globalAll" class="field"></select></label></header>
    <div class="tablewrap"><table class="reg"><thead><tr><th>Active</th><th>Agent</th><th>Department</th><th>Stage</th><th>Default model</th><th>Global override</th><th>Effort</th><th title="Lead plus helpers when the role splits its work, or parallel instances staffed by the PM">Max agents</th><th>Uses now</th></tr></thead><tbody id="regBody"></tbody></table></div>
  </section>
  <div style="display:grid;gap:14px">
    <section class="panel">
      <header><h2>Add a position</h2></header>
      <form class="form" id="addForm">
        <div class="two"><label>Role<input class="field" id="nRole" required placeholder="Technical Writer"></label><label>Id<input class="field" id="nId" placeholder="technical_writer"></label></div>
        <div class="two"><label>Department<select class="field" id="nDept"></select></label><label>Model<select class="field" id="nModel"></select></label></div>
        <label>Joins stage<select class="field" id="nStage"></select></label>
        <label>\u2026or add a new stage after it, named<input class="field" id="nNewStage" placeholder="Leave empty to join the stage"></label>
        <div class="two"><label class="check"><input type="checkbox" id="nSpawn"> Can be staffed in parallel</label><label>Max instances<input class="field" id="nMax" type="number" min="1" value="1"></label></div>
        <label>Instructions (persona)<textarea class="field" id="nPersona" rows="4" placeholder="You write the user guide and release notes\u2026"></textarea></label>
        <button class="btn primary" type="submit">Add position</button>
        <p class="note" id="addMsg"></p>
      </form>
    </section>
    <section class="panel">
      <header><h2>Which model runs?</h2></header>
      <ol class="order">
        <li><b>Project override</b> for that agent (Models tab on the floor)</li>
        <li><b>Project override</b> for all agents</li>
        <li><b>Global override</b> for that agent</li>
        <li><b>Global override</b> for every agent</li>
        <li><b>Agent default</b> model</li>
        <li><b>Department</b> model</li>
        <li><b>Company default</b></li>
      </ol>
    </section>
  </div>
</main>

<dialog class="viewer" id="viewer"><header><h3 id="viewerTitle"></h3><button class="btn" id="viewerClose">Close</button></header><div class="md" id="viewerBody"></div></dialog>

<dialog class="viewer agentdlg" id="agentDlg">
  <header><span class="av-sm" id="adAv"></span><div style="flex:1;min-width:0"><div class="eyebrow" id="adDept"></div><h3 id="adTitle"></h3></div><button class="btn" id="adClose" type="button">Close</button></header>
  <form class="form" id="adForm">
    <div class="ad-now"><span class="eyebrow">Uses now</span><span id="adNow"></span></div>
    <label class="check ad-active"><input type="checkbox" id="adActive"> <span><b>Active</b> <small>Off = this position is skipped on every project until you switch it back on</small></span></label>
    <label>Default model for all projects <small>saved to agents.json</small><select class="field" id="adModel"></select></label>
    <label>Override for this project only<select class="field" id="adOverride"></select></label>
    <label>Effort<select class="field" id="adEffort"><option value="">Company default</option><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option><option value="max">Max</option></select></label>
    <label>Max agents for this role <small>1 = works alone. 2 or more = may split a big task across helpers with the same role and model, then merges</small><input class="field mono" type="number" id="adMaxAgents" min="1" max="10" step="1"></label>
    <label>Max output tokens per reply <small>hard cap, thinking included. Lower = cheaper</small><input class="field mono" type="number" id="adMaxOut" min="500" max="64000" step="500"></label>
    <p class="note">Which one runs: project override, then global override (Registry), then this default, then the department, then the company default.</p>
    <div class="row"><button class="btn primary" type="submit" id="adSave">Save</button><button class="btn" type="button" id="adOpenReg">Open Registry</button></div>
    <p class="note" id="adMsg"></p>
  </form>
</dialog>`;
  }

  // ---------------- helpers ----------------
  const agent = id => S.meta.agents.find(a => a.id === id);
  const dept = id => agent(id)?.department || "infra";
  const modelInfo = id => S.meta.models.find(m => m.id === id);
  const chip = model => { const m = modelInfo(model); return `<span class="chip tier-${m?.tier || "sonnet"}">${esc(m?.label || model)}</span>`; };
  const fmtTime = ts => { const d = new Date(ts); return d.toTimeString().slice(0, 5); };
  const stageTitle = id => S.meta.pipeline.find(s => s.id === id)?.title || id;

  function toast(text) {
    const t = document.createElement("div"); t.className = "toast"; t.textContent = text;
    document.body.appendChild(t); setTimeout(() => t.remove(), 3800);
  }

  const tweens = {};
  function tweenNum(id, to, fmt) {
    const elx = document.getElementById(id); const from = tweens[id] ?? 0; tweens[id] = to;
    if (S.replaying) { elx.textContent = fmt(to); return; }
    const t0 = performance.now();
    const step = now => { const t = Math.min(1, (now - t0) / 700); const v = from + (to - from) * (1 - Math.pow(1 - t, 3)); elx.textContent = fmt(v); if (t < 1) requestAnimationFrame(step); };
    requestAnimationFrame(step);
  }

  function md(src) {
    const lines = String(src).replace(/\r/g, "").split("\n"); let out = "", i = 0;
    const inline = s => esc(s).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/`([^`]+)`/g, "<code>$1</code>");
    while (i < lines.length) {
      const l = lines[i];
      if (l.startsWith("```")) { let code = ""; i++; while (i < lines.length && !lines[i].startsWith("```")) code += lines[i++] + "\n"; i++; out += `<pre>${esc(code)}</pre>`; continue; }
      if (/^\|/.test(l)) {
        const rows = []; while (i < lines.length && /^\|/.test(lines[i])) rows.push(lines[i++]);
        const cells = r => r.replace(/^\||\|$/g, "").split("|").map(c => c.trim());
        out += "<table>" + rows.filter(r => !/^\|[\s|:-]+\|$/.test(r)).map((r, k) => "<tr>" + cells(r).map(c => k === 0 ? `<th>${inline(c)}</th>` : `<td>${inline(c)}</td>`).join("") + "</tr>").join("") + "</table>";
        continue;
      }
      const h = l.match(/^(#{1,3})\s+(.*)/); if (h) { out += `<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`; i++; continue; }
      if (/^\s*([-*]|\d+\.)\s+/.test(l)) {
        const ordered = /^\s*\d+\./.test(l); let items = "";
        while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i])) items += `<li>${inline(lines[i++].replace(/^\s*([-*]|\d+\.)\s+/, ""))}</li>`;
        out += ordered ? `<ol>${items}</ol>` : `<ul>${items}</ul>`; continue;
      }
      if (l.trim()) out += `<p>${inline(l)}</p>`; i++;
    }
    return out;
  }

  // ---------------- rendering ----------------
  function renderSlots() {
    $("#slots").innerHTML = SLOTS.map(([k, label]) => `<span class="slot ${S.brief[k] ? "filled" : ""}" title="${esc(S.brief[k] || "Not known yet")}">${S.brief[k] ? "\u2713 " : ""}${label}</span>`).join("");
  }

  function renderRibbon() {
    $("#ribbon").innerHTML = S.meta.pipeline.map((s, i) => `<div class="st ${S.stageIdx[s.id] || ""}" title="${esc(s.title)}">${String(i + 1).padStart(2, "0")} ${esc(s.title)}</div>`).join("");
  }

  function addMsg(m) {
    hideTyping();
    const a = m.agentId ? agent(m.agentId) : null;
    const div = document.createElement("div");
    div.className = "msg " + (m.role === "customer" ? "customer" : "agent");
    const av = m.role === "customer" ? "YOU" : (a?.initials || "AI");
    const color = m.role === "customer" ? "" : `style="background:var(--d-${a?.department || "support"})"`;
    div.innerHTML = `<span class="av" ${color}>${esc(av)}</span><div><div class="who">${m.role === "customer" ? "You" : esc(a?.role || "Agent")}</div><div class="bubble">${esc(m.text)}</div></div>`;
    $("#messages").appendChild(div);
    $("#messages").scrollTop = $("#messages").scrollHeight;
  }

  function showTyping(agentId) {
    hideTyping();
    const a = agent(agentId);
    const div = document.createElement("div"); div.className = "msg agent"; div.id = "typing";
    div.innerHTML = `<span class="av" style="background:var(--d-${a?.department || "support"})">${esc(a?.initials || "AI")}</span><div class="bubble typing"><i></i><i></i><i></i></div>`;
    $("#messages").appendChild(div); $("#messages").scrollTop = $("#messages").scrollHeight;
  }
  function hideTyping() { $("#typing")?.remove(); }

  function feed(kind, agentId, text, sub, ts) {
    const a = agentId ? agent(agentId) : null;
    const li = document.createElement("li"); li.className = "k-" + kind;
    const dot = a ? `<span class="dot" style="background:var(--d-${a.department})">${esc(a.initials)}</span>`
      : `<span class="dot" style="background:var(--${kind === "gate" ? "gate" : kind === "loop" ? "danger" : kind === "ok" ? "ok" : "muted"})">${kind === "gate" ? "\u25c6" : "\u2022"}</span>`;
    li.innerHTML = `<time>${fmtTime(ts || Date.now())}</time>${dot}<div class="txt">${esc(text)}${sub ? `<small>${esc(sub)}</small>` : ""}</div>`;
    const f = $("#feed"); f.prepend(li);
    while (f.children.length > 250) f.lastChild.remove();
  }

  function renderDocs() {
    $("#docCount").textContent = S.artifacts.length ? `(${S.artifacts.length})` : "";
    if (!S.artifacts.length) { $("#docs").innerHTML = `<p class="empty">Documents appear here as each agent finishes: proposal, BRD, plan, designs, code, test reports.</p>`; return; }
    const by = {};
    S.artifacts.forEach(a => (by[a.stageId] ||= []).push(a));
    $("#docs").innerHTML = S.meta.pipeline.filter(s => by[s.id]).map(s => `<div><h4 class="eyebrow">${esc(s.title)}</h4>${by[s.id].map(a => {
      const ag = agent(a.agentId);
      return `<button data-doc="${esc(a.name)}" data-title="${esc(a.title)}"><span class="av-sm" style="background:var(--d-${ag?.department})">${esc(ag?.initials)}</span><span>${esc(a.title)}</span></button>`;
    }).join("")}</div>`).join("");
  }

  function renderGate() {
    const g = S.gate, slot = $("#gateSlot");
    if (!g) { slot.innerHTML = ""; return; }
    const docs = (g.artifacts || []).map(n => `<button class="doclink" data-doc="${esc(n)}" data-title="${esc(n)}">${esc(n)}</button>`).join("");
    slot.innerHTML = `<div class="gatecard" role="alert"><div class="eyebrow">Your decision \u00b7 ${esc(stageTitle(g.stageId))}</div><h3>${esc(g.label)}</h3>
      ${docs ? `<div class="docs">${docs}</div>` : ""}
      ${DEMO ? `<p class="note">In the live app you approve, request changes or reject here. The replay approves after a pause.</p>` : `
      <textarea id="gateNote" class="field" placeholder="What should change? (needed for Request changes)"></textarea>
      <div class="row"><button class="btn signal" data-gate="approve">Approve</button><button class="btn" data-gate="revise">Request changes</button><button class="btn" data-gate="reject">Reject</button></div>`}</div>`;
  }

  function renderModels() {
    if (!S.meta) return;
    const opts = sel => `<option value="">Inherit</option>` + S.meta.models.map(m => `<option value="${m.id}" ${sel === m.id ? "selected" : ""}>${esc(m.label)}</option>`).join("");
    const dis = DEMO || !S.id ? "disabled" : "";
    $("#modelRows").innerHTML = `<p class="note">Overrides for this project only. Registry sets the company-wide defaults.</p>
      <div class="modelrow"><div><b>All agents</b><small>forces one model everywhere</small></div><select class="field" data-ov="*" ${dis}>${opts(S.overrides["*"])}</select></div>` +
      S.meta.agents.map(a => `<div class="modelrow"><div>${esc(a.role)}<small>default ${esc(modelInfo(a.resolvedModel)?.label || a.resolvedModel)} \u00b7 ${esc(a.modelSource)}</small></div><select class="field" data-ov="${a.id}" ${dis}>${opts(S.overrides[a.id])}</select></div>`).join("");
  }

  function renderRegistry() {
    const m = S.meta, models = m.models;
    const stageOf = id => m.pipeline.find(s => s.agents.includes(id))?.title || "-";
    const opt = (sel, emptyLabel) => `<option value="">${emptyLabel}</option>` + models.map(x => `<option value="${x.id}" ${sel === x.id ? "selected" : ""}>${esc(x.label)}</option>`).join("");
    const dis = DEMO ? "disabled" : "";
    $("#globalAll").innerHTML = opt(m.overrides["*"], "No override"); $("#globalAll").disabled = DEMO;
    $("#regBody").innerHTML = m.agents.map(a => `<tr class="${a.disabled ? "off" : ""}">
      <td><input type="checkbox" data-agent="${a.id}" data-field="active" aria-label="${esc(a.role)} active" ${a.disabled ? "" : "checked"} ${a.id === "intake" || DEMO ? "disabled" : ""}></td>
      <td class="role"><span class="av-sm" style="background:var(--d-${a.department})">${esc(a.initials)}</span>${esc(a.role)}${a.spawnable ? ` <span class="src">parallel</span>` : ""}</td>
      <td><span style="color:var(--d-${a.department})">${esc(m.departments[a.department]?.name || a.department)}</span></td>
      <td>${esc(stageOf(a.id))}</td>
      <td><select class="field" data-agent="${a.id}" data-field="model" ${dis}>${opt(a.model, "Department / default")}</select></td>
      <td><select class="field" data-agent="${a.id}" data-field="override" ${dis}>${opt(m.overrides[a.id], "None")}</select></td>
      <td><select class="field" data-agent="${a.id}" data-field="effort" ${dis}>${["", "low", "medium", "high", "max"].map(e => `<option value="${e}" ${(a.effort || "") === e ? "selected" : ""}>${e || "default"}</option>`).join("")}</select></td>
      <td><input class="field mono" style="width:56px" type="number" min="1" value="${a.maxInstances}" data-agent="${a.id}" data-field="maxInstances" ${a.id === "intake" ? "disabled" : ""} ${dis}></td>
      <td>${a.disabled ? `<span class="src">off</span>` : `${chip(a.resolvedModel)} <span class="src">${esc(a.modelSource)}</span>`}</td></tr>`).join("");
    $("#nDept").innerHTML = Object.entries(m.departments).map(([k, d]) => `<option value="${k}">${esc(d.name)}</option>`).join("");
    $("#nModel").innerHTML = opt("", "Department / default");
    $("#nStage").innerHTML = m.pipeline.map(s => `<option value="${s.id}">${esc(s.title)}</option>`).join("");
    $("#addForm").querySelectorAll("input,select,textarea,button").forEach(x => x.disabled = DEMO);
    if (DEMO) $("#addMsg").textContent = "Read-only in the replay. Run the app locally to edit positions and models.";
  }

  function setStatus(s) {
    S.status = s;
    const chipEl = $("#statusChip");
    const label = { Intake: "Intake", Running: "Running", WaitingGate: "Waiting for you", WaitingCustomer: "Waiting for customer", Completed: "Live", Stopped: "Stopped", Failed: "Failed" }[s] || s;
    chipEl.dataset.s = s; chipEl.textContent = label;
    if (s === "Stopped" || s === "Failed" || s === "Completed") { S.gate = null; renderGate(); }
    const paused = (s === "Stopped" || s === "Failed") && SLOTS.every(([k]) => S.brief[k]);
    $("#resumeBtn").hidden = DEMO || !paused;
    $("#stopBtn").hidden = DEMO || !(s === "Running" || s === "WaitingGate" || s === "WaitingCustomer");
    updateComposer();
  }

  function updateComposer() {
    const can = !DEMO && S.id && ["Intake", "WaitingCustomer", "Running", "WaitingGate", "Completed", "Stopped", "Failed"].includes(S.status);
    $("#chatInput").disabled = !can; $("#sendBtn").disabled = !can;
    $("#composerNote").textContent = DEMO ? "This is a recorded run. Start the app locally to chat as the customer."
      : !S.id ? "Press New request, or Run sample request to watch a full project."
      : S.status === "WaitingCustomer" ? "An agent asked you something above. Your reply goes straight to them."
      : S.status === "Intake" ? "The intake agent fills the five chips above as you answer."
      : S.status === "Stopped" || S.status === "Failed" ? "The project is paused. Press Resume to continue from the last finished step, or ask for its status here."
      : "";
  }

  function activeCount() {
    $("#activeAgents").textContent = document.querySelectorAll("#floor .node.working").length + document.querySelectorAll("#floor .sat.working").length;
  }

  // ---------------- events ----------------
  function onEvent(ev) {
    const d = ev.data || {}; const ts = ev.ts;
    S.firstTs ??= new Date(ts).getTime(); S.lastTs = new Date(ts).getTime();
    switch (ev.type) {
      case "chat": addMsg(d); if (S.sample && !S.replaying) sampleNext(d); break;
      case "typing": d.on ? showTyping(d.agentId) : hideTyping(); viz.setAgent(d.agentId, 0, d.on ? "working" : ""); break;
      case "brief": S.brief = d.slots || {}; renderSlots();
        if (d.complete) { viz.setAgent("intake", 0, "done"); feed("ok", "intake", "Brief complete. Handing over to Business Development.", null, ts); }
        break;
      case "title": S.title = d.title; $("#projTitle").textContent = d.title; if (!DEMO && !S.replaying) refreshProjects(S.id); break;
      case "status":
        setStatus(d.status);
        if (d.status === "Completed") { viz.celebrate(); feed("ok", null, "Project is live. The cycle continues with usage data.", null, ts); if (!S.replaying) toast("Project delivered. Support and Data now run the service."); }
        if (d.status === "Failed" || d.status === "Stopped") feed("loop", null, d.status === "Failed" ? "The pipeline stopped with an error." : "Project stopped.", null, ts);
        break;
      case "stage":
        S.stageIdx[d.stageId] = d.status; renderRibbon(); viz.stage(d.stageId, d.status);
        if (d.status === "running") feed("info", null, `${stageTitle(d.stageId)} started${d.round > 1 ? ` \u00b7 round ${d.round}` : ""}`, null, ts);
        break;
      case "agent": {
        const a = agent(d.agentId); const inst = d.instance > 1 || viz.nodes[d.agentId]?.satEls.length ? ` #${d.instance}` : "";
        viz.setAgent(d.agentId, d.instance, d.status);
        if (d.model) viz.setModel(d.agentId, d.model, d.source);
        if (d.status === "working") feed("info", d.agentId, `${a?.role}${inst} is working${d.module ? ` on ${d.module}` : ""}`, `${modelInfo(d.model)?.label || d.model} \u00b7 ${d.source}`, ts);
        if (d.status === "done" || d.status === "blocked") feed(d.status === "blocked" ? "loop" : "info", d.agentId, d.summary || `${a?.role} finished`, d.tokensOut != null ? `${(d.tokensIn + d.tokensOut).toLocaleString()} tokens \u00b7 $${Number(d.cost).toFixed(4)}` : null, ts);
        if (d.status === "need_info") feed("gate", d.agentId, `${a?.role} needs answers from the customer`, null, ts);
        if (d.status === "error") feed("loop", d.agentId, `${a?.role} failed: ${d.summary}`, null, ts);
        activeCount(); break;
      }
      case "spawn":
        viz.spawn(d.agentId, d.count);
        if (d.reason === "delegate") feed("info", d.agentId, `${agent(d.agentId)?.role} split its work across ${d.count - 1} helpers (same role and model)${d.summary ? `: ${d.summary}` : ""}`, (d.modules || []).slice(1).join(" | "), ts);
        else feed("info", "project_manager", `Staffed ${d.count} \u00d7 ${agent(d.agentId)?.role} in parallel`, (d.modules || []).filter(Boolean).join(" | "), ts);
        break;
      case "plan": feed("info", "project_manager", `Plan: ${(d.modules || []).length} modules`, (d.modules || []).join(", "), ts); break;
      case "handoff": viz.handoff(d.fromStage, d.toStage); break;
      case "artifact": S.artifacts.push(d); renderDocs(); break;
      case "gate":
        viz.gate(d.stageId, d.status);
        S.stageIdx[d.stageId] = d.status === "waiting" ? "waiting" : "done"; renderRibbon();
        if (d.status === "waiting") { S.gate = d; feed("gate", null, `Waiting for you: ${d.label}`, null, ts); }
        else { S.gate = null; feed(d.status === "approved" ? "ok" : "loop", null, `${d.label}: ${d.status}${d.note ? ` (${d.note})` : ""}`, null, ts); }
        renderGate(); break;
      case "loop": viz.loop(d.fromStage); feed("loop", "qa", `${d.bugs} defects. Back to ${stageTitle(d.toStage)}, round ${d.round}`, (d.defects || []).join(" | "), ts); break;
      case "question": feed("gate", d.agentId, "Asked the customer a question", (d.questions || []).join(" | "), ts); if (S.sample && !S.replaying) setTimeout(() => typeAndSend(SAMPLE_ANSWER), 1400); break;
      case "usage": S.tokens = d.tokensIn + d.tokensOut; S.cost = d.cost;
        tweenNum("tokens", S.tokens, v => Math.round(v).toLocaleString()); tweenNum("cost", S.cost, v => v.toFixed(4)); break;
      case "feedback": viz.feedback(); feed("ok", "data_analyst", `Feedback to Project Manager: ${d.summary}`, "continuous improvement", ts); break;
      case "log": feed(d.level === "error" ? "loop" : "info", null, d.text, null, ts); break;
    }
  }

  setInterval(() => {
    if (!S.firstTs) return;
    const end = ["Completed", "Stopped", "Failed"].includes(S.status) ? S.lastTs : (DEMO ? S.lastTs : Date.now());
    const sec = Math.max(0, Math.round((end - S.firstTs) / 1000));
    $("#elapsed").textContent = `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
  }, 500);

  // ---------------- project lifecycle ----------------
  function resetFloor() {
    Object.assign(S, { status: "Intake", title: "", brief: {}, artifacts: [], tokens: 0, cost: 0, firstTs: null, lastTs: null, gate: null, stageIdx: {} });
    for (const k in tweens) delete tweens[k];
    $("#messages").innerHTML = ""; $("#feed").innerHTML = "";
    $("#tokens").textContent = "0"; $("#cost").textContent = "0.0000"; $("#elapsed").textContent = "0:00";
    viz.build(S.meta); renderSlots(); renderRibbon(); renderDocs(); renderGate(); setStatus("Intake");
  }

  async function openProject(id) {
    S.es?.close(); S.id = id;
    resetFloor();
    if (!id) { S.overrides = {}; $("#projId").textContent = "No project yet"; $("#projTitle").textContent = "Start a request to staff the floor"; renderModels(); return; }
    const p = await api.get(`/projects/${id}`);
    S.overrides = p.modelOverrides || {}; $("#autoApprove").checked = !!p.autoApprove;
    $("#projId").textContent = p.id; $("#projTitle").textContent = p.title;
    renderModels(); refreshModelLabels();
    S.replaying = true; viz.quiet = true;
    const es = new EventSource(`/api/projects/${id}/events`); S.es = es;
    es.onmessage = e => onEvent(JSON.parse(e.data));
    es.addEventListener("replayed", () => { S.replaying = false; viz.quiet = false; });
  }

  async function refreshProjects(selectId) {
    const list = await api.get("/projects");
    $("#projectPick").innerHTML = `<option value="">Open a project\u2026</option>` + list.map(p => `<option value="${p.id}">${esc(p.id)} \u00b7 ${esc(p.title)} (${esc(p.status)})</option>`).join("");
    if (selectId) $("#projectPick").value = selectId;
  }

  async function newProject(sample) {
    const p = await api.send("POST", "/projects", { autoApprove: $("#autoApprove").checked });
    S.sample = sample; S.sampleIdx = 0;
    await refreshProjects(p.id);
    await openProject(p.id);
    if (sample) setTimeout(() => typeAndSend(SAMPLE[S.sampleIdx++]), 900);
    else $("#chatInput").focus();
  }

  function sampleNext(m) {
    if (m.role !== "agent" || m.agentId !== "intake" || S.status !== "Intake") return;
    if (S.sampleIdx < SAMPLE.length) setTimeout(() => typeAndSend(SAMPLE[S.sampleIdx++]), 1100);
  }

  function typeAndSend(text) {
    const box = $("#chatInput"); let i = 0; box.value = "";
    const step = () => { i += 3; box.value = text.slice(0, i); if (i < text.length) setTimeout(step, 16); else setTimeout(send, 250); };
    step();
  }

  async function send() {
    const box = $("#chatInput"); const text = box.value.trim(); if (!text || !S.id) return;
    box.value = "";
    if (S.status === "Intake") showTyping("intake");
    try { await api.send("POST", `/projects/${S.id}/chat`, { text }); }
    catch (e) { hideTyping(); toast(e.message); box.value = text; }
  }

  // ---------------- demo replay ----------------
  let replayTimer = null;
  function replay() {
    clearTimeout(replayTimer);
    resetFloor();
    $("#projId").textContent = window.VC_DEMO_PROJECT?.id || "Recorded run";
    $("#projTitle").textContent = "Customer request coming in\u2026";
    const evs = window.VC_DEMO_EVENTS || []; let i = 0;
    const next = () => {
      if (i >= evs.length) return;
      const ev = evs[i++]; onEvent(ev);
      const speed = Number($("#speed").value) || 2;
      const gap = i < evs.length ? new Date(evs[i].ts) - new Date(ev.ts) : 0;
      let wait = Math.min(Math.max(gap, 60), ev.type === "gate" && ev.data.status === "waiting" ? 2600 : 1600);
      if (evs[i]?.type === "chat" && evs[i].data.role === "customer") wait = Math.max(wait, 1500);
      replayTimer = setTimeout(next, wait / speed);
    };
    next();
  }

  // ---------------- per-agent model settings ----------------
  function effectiveModel(id) {
    const a = agent(id);
    if (S.overrides[id]) return { model: S.overrides[id], source: "project override" };
    if (S.overrides["*"]) return { model: S.overrides["*"], source: "project override (all agents)" };
    return { model: a.resolvedModel, source: a.modelSource };
  }

  function refreshModelLabels() {
    if (!S.meta) return;
    viz.applyMeta(S.meta);
    S.meta.agents.forEach(a => { const m = effectiveModel(a.id); viz.setModel(a.id, m.model, m.source); });
  }

  const modelOption = (m, sel) => `<option value="${m.id}" ${sel === m.id ? "selected" : ""}>${esc(m.label)} \u00b7 $${m.inputPrice} / $${m.outputPrice} per 1M tokens</option>`;

  function openAgentSettings(id) {
    const a = agent(id); if (!a) return;
    const dept = S.meta.departments[a.department];
    $("#adAv").textContent = a.initials; $("#adAv").style.background = `var(--d-${a.department})`;
    $("#adDept").textContent = dept?.name || a.department;
    $("#adTitle").textContent = a.role;
    const now = effectiveModel(id);
    $("#adNow").innerHTML = `${chip(now.model)} <span class="src">${esc(now.source)}</span>`;
    const inherited = dept?.model ? `Department default (${modelInfo(dept.model)?.label})` : `Company default (${modelInfo(S.meta.defaults?.model)?.label || "Sonnet"})`;
    $("#adModel").innerHTML = `<option value="">${esc(inherited)}</option>` + S.meta.models.map(m => modelOption(m, a.model)).join("");
    $("#adOverride").innerHTML = `<option value="">No override</option>` + S.meta.models.map(m => modelOption(m, S.overrides[id])).join("");
    $("#adEffort").value = a.effort || "";
    $("#adMaxOut").value = a.maxOutputTokens || "";
    $("#adMaxOut").disabled = DEMO;
    $("#adMaxAgents").value = a.maxInstances || 1;
    $("#adMaxAgents").disabled = DEMO || id === "intake";
    $("#adActive").checked = !a.disabled;
    $("#adActive").disabled = DEMO || id === "intake";
    $("#adActive").closest("label").title = id === "intake" ? "Customer Intake starts every request, so it can't be switched off." : "";
    $("#adOverride").disabled = DEMO || !S.id;
    ["adModel", "adEffort", "adSave"].forEach(k => $("#" + k).disabled = DEMO);
    $("#adMsg").textContent = DEMO ? "Read-only in the replay. Run the app locally to change models." : !S.id ? "Open or start a project to set a project override." : "";
    $("#agentDlg").dataset.agent = id;
    $("#agentDlg").showModal();
  }

  async function saveAgentSettings(e) {
    e.preventDefault();
    const id = $("#agentDlg").dataset.agent, a = agent(id);
    try {
      const model = $("#adModel").value, effort = $("#adEffort").value, disabled = !$("#adActive").checked;
      const maxOutputTokens = Number($("#adMaxOut").value) || a.maxOutputTokens;
      const maxInstances = Math.min(10, Math.max(1, Number($("#adMaxAgents").value) || a.maxInstances || 1));
      if ((a.model || "") !== model || (a.effort || "") !== effort || !!a.disabled !== disabled || maxOutputTokens !== a.maxOutputTokens || maxInstances !== a.maxInstances)
        S.meta = await api.send("PUT", `/registry/agents/${id}`, { model, effort, disabled, maxOutputTokens, maxInstances });
      const ov = $("#adOverride").value || null;
      if (S.id && (S.overrides[id] || null) !== ov)
        S.overrides = await api.send("PUT", `/projects/${S.id}/overrides`, { ...S.overrides, [id]: ov });
      renderRegistry(); renderModels(); refreshModelLabels();
      $("#agentDlg").close();
      const now = effectiveModel(id);
      if (disabled) { toast(`${a.role} is switched off. Stages with no active agent are skipped.`); return; }
      toast(`${a.role} now uses ${modelInfo(now.model)?.label || now.model} (${now.source}). Applies from the next task it starts.`);
    } catch (err) { $("#adMsg").textContent = err.message; }
  }

  // ---------------- resizable side panels ----------------
  function initSplitters() {
    const floor = $("#floorView"), KEY = "vc.panelWidths";
    const LIMITS = { left: [220, 560], right: [240, 620] }, DEFAULTS = { left: 300, right: 330 }, MIN_CENTRE = 420;
    const w = { ...DEFAULTS };
    try { Object.assign(w, JSON.parse(localStorage.getItem(KEY) || "{}")); } catch { /* storage blocked: use defaults */ }
    const save = () => { try { localStorage.setItem(KEY, JSON.stringify(w)); } catch { /* not persisted */ } };
    const apply = (side) => {
      for (const k in LIMITS) w[k] = Math.round(Math.min(LIMITS[k][1], Math.max(LIMITS[k][0], w[k])));
      // keep the floor at least MIN_CENTRE wide: shrink the panel that is not being dragged first
      const room = floor.clientWidth - 32 - 2 * 10 - 4 * 2;
      let over = w.left + w.right + MIN_CENTRE - room;
      if (over > 0) {
        const other = side === "left" ? "right" : "left";
        for (const k of [other, side || "right"]) { const cut = Math.min(over, w[k] - LIMITS[k][0]); w[k] -= cut; over -= cut; }
      }
      floor.style.setProperty("--lw", w.left + "px");
      floor.style.setProperty("--rw", w.right + "px");
      document.querySelectorAll(".splitter").forEach(sp => sp.setAttribute("aria-valuenow", w[sp.dataset.side]));
    };
    document.querySelectorAll(".splitter").forEach(sp => {
      const side = sp.dataset.side, dir = side === "left" ? 1 : -1;
      let lastDown = 0;
      sp.addEventListener("pointerdown", e => {
        e.preventDefault();
        // preventDefault suppresses the native dblclick, so detect a double press here
        if (e.timeStamp - lastDown < 350) { lastDown = 0; w[side] = DEFAULTS[side]; apply(side); save(); return; }
        lastDown = e.timeStamp;
        sp.setPointerCapture(e.pointerId);
        const x0 = e.clientX, w0 = w[side];
        floor.classList.add("resizing"); sp.classList.add("active");
        const move = ev => { w[side] = w0 + dir * (ev.clientX - x0); apply(side); };
        const up = () => {
          sp.removeEventListener("pointermove", move); sp.removeEventListener("pointerup", up); sp.removeEventListener("pointercancel", up);
          floor.classList.remove("resizing"); sp.classList.remove("active"); save();
        };
        sp.addEventListener("pointermove", move); sp.addEventListener("pointerup", up); sp.addEventListener("pointercancel", up);
      });
      sp.addEventListener("keydown", e => {
        const step = e.shiftKey ? 48 : 16, d = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
        if (!d) return;
        e.preventDefault(); w[side] += dir * d; apply(side); save();
      });
    });
    addEventListener("resize", () => apply());
    apply();
  }

  // ---------------- wiring ----------------
  function wire() {
    initSplitters();
    document.querySelectorAll(".tabs button").forEach(b => b.onclick = () => {
      S.view = b.dataset.view;
      document.querySelectorAll(".tabs button").forEach(x => x.setAttribute("aria-selected", x === b));
      $("#floorView").hidden = S.view !== "floor"; $("#registryView").hidden = S.view !== "registry";
      if (S.view === "registry") renderRegistry();
    });
    document.querySelectorAll(".subtabs button").forEach(b => b.onclick = () => {
      document.querySelectorAll(".subtabs button").forEach(x => x.setAttribute("aria-selected", x === b));
      ["activity", "docs", "models"].forEach(k => $("#pane-" + k).hidden = k !== b.dataset.sub);
    });
    document.addEventListener("click", async e => {
      const doc = e.target.closest("[data-doc]");
      if (doc) {
        const name = doc.dataset.doc;
        $("#viewerTitle").textContent = doc.dataset.title; $("#viewerBody").innerHTML = "<p>Loading\u2026</p>"; $("#viewer").showModal();
        try {
          const text = DEMO ? (window.VC_DEMO_ARTIFACTS?.[name] ?? "Not included in the replay.") : await (await fetch(`/api/projects/${S.id}/artifacts/${encodeURIComponent(name)}`)).text();
          $("#viewerBody").innerHTML = md(text);
        } catch (err) { $("#viewerBody").textContent = "Could not load the document: " + err.message; }
      }
      const g = e.target.closest("[data-gate]");
      if (g) {
        const note = $("#gateNote")?.value.trim();
        if (g.dataset.gate === "revise" && !note) { toast("Write what should change, then press Request changes."); $("#gateNote").focus(); return; }
        try { await api.send("POST", `/projects/${S.id}/gate`, { decision: g.dataset.gate, note }); } catch (err) { toast(err.message); }
      }
    });
    $("#viewerClose").onclick = () => $("#viewer").close();
    viz.onAgentClick = openAgentSettings;
    $("#adClose").onclick = () => $("#agentDlg").close();
    $("#adForm").onsubmit = saveAgentSettings;
    $("#adOpenReg").onclick = () => { $("#agentDlg").close(); document.querySelector('.tabs button[data-view="registry"]').click(); };
    $("#composer").onsubmit = e => { e.preventDefault(); send(); };
    $("#chatInput").addEventListener("keydown", e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } });

    if (DEMO) { $("#replayBtn").onclick = replay; return; }

    $("#resumeBtn").onclick = async () => {
      try { await api.send("POST", `/projects/${S.id}/resume`); } catch (e) { toast(e.message); }
    };
    $("#stopBtn").onclick = async () => {
      try { await api.send("POST", `/projects/${S.id}/stop`); } catch (e) { toast(e.message); }
    };
    $("#newBtn").onclick = () => newProject(false);
    $("#sampleBtn").onclick = () => newProject(true);
    $("#projectPick").onchange = e => { S.sample = false; openProject(e.target.value); };
    $("#autoApprove").onchange = e => S.id && api.send("PUT", `/projects/${S.id}/autoapprove`, { on: e.target.checked });

    $("#modelRows").addEventListener("change", async e => {
      const k = e.target.dataset.ov; if (!k) return;
      S.overrides[k] = e.target.value || null;
      try { S.overrides = await api.send("PUT", `/projects/${S.id}/overrides`, S.overrides); refreshModelLabels(); toast("Project models updated. They apply to the next agent that starts."); }
      catch (err) { toast(err.message); }
    });

    $("#regBody").addEventListener("change", async e => {
      const t = e.target, id = t.dataset.agent, f = t.dataset.field; if (!id) return;
      try {
        if (f === "override") { const o = { ...S.meta.overrides, [id]: t.value || null }; S.meta = await api.send("PUT", "/registry/overrides", o); }
        else S.meta = await api.send("PUT", `/registry/agents/${id}`, f === "maxInstances" ? { maxInstances: Number(t.value) } : f === "active" ? { disabled: !t.checked } : { [f]: t.value });
        renderRegistry(); renderModels(); refreshModelLabels(); toast("Saved to agents.json");
      } catch (err) { toast(err.message); }
    });
    $("#globalAll").onchange = async e => {
      S.meta = await api.send("PUT", "/registry/overrides", { ...S.meta.overrides, "*": e.target.value || null });
      renderRegistry(); renderModels(); refreshModelLabels(); toast(e.target.value ? `Every agent now uses ${modelInfo(e.target.value).label}` : "Global override removed");
    };
    $("#nRole").addEventListener("input", e => { $("#nId").placeholder = e.target.value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_") || "technical_writer"; });
    $("#addForm").onsubmit = async e => {
      e.preventDefault();
      const body = { id: $("#nId").value.trim() || $("#nId").placeholder, role: $("#nRole").value.trim(), department: $("#nDept").value, model: $("#nModel").value || null,
        stageId: $("#nStage").value, newStageTitle: $("#nNewStage").value.trim() || null, spawnable: $("#nSpawn").checked, maxInstances: Number($("#nMax").value) || 1, persona: $("#nPersona").value.trim() || null };
      try {
        S.meta = await api.send("POST", "/registry/agents", body);
        $("#addMsg").textContent = `${body.role} added. It takes part in the next project you start.`;
        e.target.reset(); renderRegistry(); renderModels();
        if (!S.id) viz.build(S.meta);
      } catch (err) { $("#addMsg").textContent = err.message; }
    };
  }

  // ---------------- boot ----------------
  async function boot() {
    shell();
    viz = new FloorViz($("#floor"));
    S.meta = DEMO ? window.VC_DEMO_META : await api.get("/meta");
    $("#company").textContent = S.meta.company;
    const mode = $("#mode");
    if (DEMO) { mode.className = "pill sim"; mode.textContent = "RECORDED RUN"; }
    else if (S.meta.live) { mode.className = "pill live"; mode.textContent = S.meta.engine === "agent-sdk" ? "LIVE \u00b7 AGENT SDK" : "LIVE \u00b7 CLAUDE API"; }
    else { mode.className = "pill sim"; mode.textContent = "SIMULATION"; mode.title = "Set ANTHROPIC_API_KEY and restart to use real Claude models."; }
    wire();
    resetFloor(); renderModels();
    if (DEMO) { replay(); return; }
    await refreshProjects();
    const first = (await api.get("/projects"))[0];
    if (first) { $("#projectPick").value = first.id; await openProject(first.id); } else updateComposer();
  }

  boot().catch(e => { document.getElementById("app").innerHTML = `<p style="padding:24px">The app could not start: ${esc(e.message)}. Is the server running?</p>`; });
})();
