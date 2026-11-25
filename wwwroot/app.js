// Virtual Company UI. Talks to the ASP.NET API (live/simulation) or, when window.VC_DEMO is set,
// replays a recorded project so the floor can be shown without a server.
(function () {
  const DEMO = !!window.VC_DEMO;
  const $ = (s, r = document) => r.querySelector(s);
  const t = I18N.t, nm = I18N.name;
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
    overrides: {}, sample: false, sampleIdx: 0, view: "floor", sub: "activity", stageIdx: {}, live: {}, modules: [], modLog: {},
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
  <div class="brand">${logo}<div><b id="company">Virtual Company</b><small>${t("AI-agent company floor")}</small></div></div>
  <nav class="tabs" role="tablist" aria-label="${t("View")}">
    <button role="tab" data-view="floor" aria-selected="true">${t("Floor")}</button>
    <button role="tab" data-view="registry" aria-selected="false">${t("Registry")}</button>
  </nav>
  <span class="spacer"></span>
  <span id="mode" class="pill sim">${t("SIMULATION")}</span>
  <label class="check" title="${t("Language")}"><span class="sr-only">${t("Language")}</span><select id="langPick" class="field" aria-label="${t("Language")}"><option value="en">EN</option><option value="id">ID</option></select></label>
  ${DEMO ? `
  <label class="check">${t("Speed")} <select id="speed" class="field"><option value="1" selected>1\u00d7</option><option value="2">2\u00d7</option><option value="4">4\u00d7</option></select></label>
  <button class="btn primary" id="replayBtn">${t("Replay")}</button>` : `
  <select id="projectPick" class="field" aria-label="${t("Open project")}"></select>
  <label class="check"><input type="checkbox" id="autoApprove"> ${t("Auto-approve gates")}</label>
  <button class="btn" id="sampleBtn">${t("Run sample request")}</button>
  <button class="btn primary" id="newBtn">${t("New request")}</button>`}
</header>

<main id="floorView" class="floor">
  <section class="panel chat" aria-label="${t("Customer chat")}">
    <button class="rail" type="button" data-rail="left" title="${t("Show the chat")}" aria-label="${t("Show the chat")}"><svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M12 3C6.5 3 2 6.6 2 11c0 2.2 1.1 4.2 2.9 5.6L4 21l4.6-2.4c1.1.3 2.2.4 3.4.4 5.5 0 10-3.6 10-8s-4.5-8-10-8" fill="currentColor"/></svg><span>${t("Request chat")}</span><i class="rail-dot"></i></button>
    <header class="chat-head"><span class="chat-av" aria-hidden="true"><svg viewBox="0 0 24 24" width="22" height="22"><path d="M16 11a3 3 0 1 0-3-3 3 3 0 0 0 3 3m-8 0a3 3 0 1 0-3-3 3 3 0 0 0 3 3m0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5C15 14.17 10.33 13 8 13m8 0c-.29 0-.62.02-.97.05A4.2 4.2 0 0 1 17 16.5V19h6v-2.5c0-2.33-4.67-3.5-7-3.5" fill="currentColor"/></svg></span>
      <div><h2>${t("Request chat")}</h2><div class="chat-sub">${t("You and the project team")}</div></div><span class="spacer"></span><button class="icon-btn collapse-btn" type="button" data-collapse="left" title="${t("Minimize the chat")}" aria-label="${t("Minimize the chat")}">«</button></header>
    <div class="slots" id="slots"></div>
    <div class="messages" id="messages" aria-live="polite"></div>
    <div class="attach-tray" id="attachTray" hidden></div>
    <form class="composer" id="composer">
      <button class="attach-btn" id="attachBtn" type="button" title="${t("Attach a file or picture (you can also paste or drop it here)")}" aria-label="${t("Attach a file")}"><svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M16.5 6.5v10.6a4.5 4.5 0 0 1-9 0V5.8a3 3 0 0 1 6 0v10.3a1.5 1.5 0 0 1-3 0V6.5H9v9.6a3 3 0 0 0 6 0V5.8a4.5 4.5 0 0 0-9 0v11.3a6 6 0 0 0 12 0V6.5z" fill="currentColor"/></svg></button>
      <input type="file" id="attachInput" multiple hidden>
      <textarea id="chatInput" rows="1" placeholder="${t("Type a message")}" aria-label="${t("Message")}"></textarea>
      <button class="send-btn" id="sendBtn" type="submit" title="${t("Send")}" aria-label="${t("Send")}"><svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M3.4 20.4 21 12 3.4 3.6l-.01 6.53L15 12 3.39 13.87z" fill="currentColor"/></svg></button>
    </form>
    <p class="composer-note" id="composerNote"></p>
  </section>
  <div class="splitter" data-side="left" role="separator" aria-orientation="vertical" aria-label="${t("Resize chat panel")}" tabindex="0" title="${t("Drag to resize. Double-click to reset.")}"></div>

  <section class="panel stage" aria-label="${t("Operations floor")}">
    <div class="hud">
      <div class="title"><div class="eyebrow" id="projId">${t("No project yet")}</div><div class="title-row"><h1 id="projTitle">${t("Start a request to staff the floor")}</h1><button class="icon-btn" id="editTitle" type="button" hidden title="${t("Edit title")}" aria-label="${t("Edit title")}"><svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M3 17.25V21h3.75L17.8 9.94l-3.75-3.75zM20.7 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75z" fill="currentColor"/></svg></button></div></div>
      <div class="stat"><span class="eyebrow">${t("Status")}</span><span class="status-row"><span class="status-chip" id="statusChip" data-s="Intake">${t("Intake")}</span><button class="btn signal sm" id="resumeBtn" type="button" hidden>${t("Resume")}</button><button class="btn sm" id="pauseBtn" type="button" hidden title="${t("Agents at work finish their step; nothing new starts")}">${t("Pause")}</button><button class="btn signal sm" id="unpauseBtn" type="button" hidden>${t("Continue")}</button><button class="btn sm" id="stopBtn" type="button" hidden title="${t("Cancels the agents at work")}">${t("Stop")}</button><a class="btn primary sm" id="openAppBtn" target="_blank" rel="noopener" hidden>${t("Open app")}</a><button class="btn sm" id="startAppBtn" type="button" hidden>${t("Start app")}</button><button class="btn sm" id="stopAppBtn" type="button" hidden>${t("Stop app")}</button></span></div>
      <div class="stat"><span class="eyebrow">${t("Agents on it")}</span><b id="activeAgents">0</b></div>
      <div class="stat"><span class="eyebrow">${t("Tokens")}</span><b id="tokens">0</b></div>
      <div class="stat"><span class="eyebrow">${t("Cost (USD)")}</span><b id="cost">0.0000</b></div>
      <div class="stat"><span class="eyebrow">${t("Elapsed")}</span><b id="elapsed">00:00:00</b></div>
      <button class="stat modstat" id="modStat" type="button" hidden title="${t("Open the module log")}"><span class="eyebrow">${t("Modules")}</span><b id="modPct">0%</b><span class="pbar"><i id="modBar"></i></span></button>
    </div>
    <div class="viz-wrap"><svg id="floor" role="img" aria-label="${t("Pipeline of agents by department")}"></svg>
      <div class="floor3d" id="floor3d" hidden aria-label="${t("3D floor: drag to rotate, scroll to zoom, right-drag to pan, click an agent for its settings")}"></div>
      <div class="floor3d office3d" id="office3d3" hidden aria-label="${t("Office view: the agents as people at work; drag to move, scroll to zoom, click a person for their settings")}"></div>
      <div class="floor3d office3d" id="office3d2" hidden aria-label="${t("Office view: the agents as people at work; drag to move, scroll to zoom, click a person for their settings")}"></div>
      <div class="view-toggle" role="group" aria-label="${t("Floor view")}">
        <button type="button" data-floorview="2d" aria-pressed="true">2D</button><button type="button" data-floorview="3d" aria-pressed="false">3D</button><button type="button" data-floorview="office2" aria-pressed="false" title="${t("Office with a room per department; the CEO in the front right corner")}">${t("Office")} 1</button><button type="button" data-floorview="office3" aria-pressed="false" title="${t("Open-plan office with cubicles; only the CEO has a glass room")}">${t("Office")} 2</button>
        <button type="button" id="officeHQ" hidden aria-pressed="true" title="${t("Picture quality: High (soft shading, smooth edges) or Normal (lighter for slower computers)")}">HQ</button>
        <button type="button" id="reset3d" hidden title="${t("Reset the 3D view")}" aria-label="${t("Reset the 3D view")}">⟲</button>
      </div>
      <div class="hint3d" id="hint3d" hidden>${t("Drag to rotate · scroll to zoom · right-drag to pan · click an agent")}</div></div>
    <div class="ribbon" id="ribbon"></div>
  </section>
  <div class="splitter" data-side="right" role="separator" aria-orientation="vertical" aria-label="${t("Resize control panel")}" tabindex="0" title="${t("Drag to resize. Double-click to reset.")}"></div>

  <section class="panel side" aria-label="${t("Control")}">
    <button class="rail" type="button" data-rail="right" title="${t("Show the side panel")}" aria-label="${t("Show the side panel")}"><svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M3 5h18v2H3zm0 6h18v2H3zm0 6h12v2H3z" fill="currentColor"/></svg><span>${t("Activity")} · ${t("Documents")} · ${t("Modules")}</span><i class="rail-dot"></i></button>
    <div class="side-bar"><button class="icon-btn collapse-btn" type="button" data-collapse="right" title="${t("Minimize the side panel")}" aria-label="${t("Minimize the side panel")}">»</button></div>
    <div id="gateSlot"></div>
    <div class="subtabs" role="tablist">
      <button role="tab" data-sub="activity" aria-selected="true">${t("Activity")}</button>
      <button role="tab" data-sub="docs" aria-selected="false">${t("Documents")} <span id="docCount" class="mono"></span></button>
      <button role="tab" data-sub="mods" aria-selected="false">${t("Modules")} <span id="modCount" class="mono"></span></button>
      <button role="tab" data-sub="models" aria-selected="false">${t("Models")}</button>
    </div>
    <div class="pane" id="pane-activity"><div class="live" id="live" hidden></div><ul class="feed" id="feed"></ul></div>
    <div class="pane" id="pane-docs" hidden><div class="doclist" id="docs"></div></div>
    <div class="pane" id="pane-mods" hidden><div class="modlog" id="modlog"></div></div>
    <div class="pane" id="pane-models" hidden><div class="modelrows" id="modelRows"></div></div>
  </section>
</main>

<main id="registryView" class="registry" hidden>
  <section class="panel">
    <header><div><div class="eyebrow">agents.json</div><h2>${t("Positions & models")}</h2></div><span class="spacer"></span>
      <label class="check">${t("Override every agent")} <select id="globalAll" class="field"></select></label></header>
    <div class="tablewrap"><table class="reg"><thead><tr><th>${t("Active")}</th><th>${t("Agent")}</th><th>${t("Department")}</th><th>${t("Stage")}</th><th>${t("Default model")}</th><th>${t("Global override")}</th><th>${t("Effort")}</th><th title="${t("Lead plus helpers when the role splits its work, or parallel instances staffed by the PM")}">${t("Max agents")}</th><th>${t("Uses now")}</th><th>${t("Rules")}</th></tr></thead><tbody id="regBody"></tbody></table></div>
  </section>
  <div style="display:grid;gap:14px">
    <section class="panel">
      <header><h2>${t("Add a position")}</h2></header>
      <form class="form" id="addForm">
        <div class="two"><label>${t("Role")}<input class="field" id="nRole" required placeholder="Technical Writer"></label><label>${t("Id")}<input class="field" id="nId" placeholder="technical_writer"></label></div>
        <div class="two"><label>${t("Department")}<select class="field" id="nDept"></select></label><label>${t("Model")}<select class="field" id="nModel"></select></label></div>
        <label>${t("Joins stage")}<select class="field" id="nStage"></select></label>
        <label>${t("\u2026or add a new stage after it, named")}<input class="field" id="nNewStage" placeholder="${t("Leave empty to join the stage")}"></label>
        <div class="two"><label class="check"><input type="checkbox" id="nSpawn"> ${t("Can be staffed in parallel")}</label><label>${t("Max instances")}<input class="field" id="nMax" type="number" min="1" value="1"></label></div>
        <label>${t("Instructions (persona)")}<textarea class="field" id="nPersona" rows="4" placeholder="${t("You write the user guide and release notes\u2026")}"></textarea></label>
        <button class="btn primary" type="submit">${t("Add position")}</button>
        <p class="note" id="addMsg"></p>
      </form>
    </section>
    <section class="panel">
      <header><h2>${t("Budget")}</h2></header>
      <form class="form" id="budgetForm">
        <div class="two"><label>${t("Pause every (USD)")}<input class="field mono" id="bUsd" type="number" min="0" step="1"></label>
          <label>${t("Pause every (tokens)")}<input class="field mono" id="bTok" type="number" min="0" step="100000"></label></div>
        <p class="note">${t("A project stops for your approval each time it has spent this much more; approving allows the same amount again. 0 = off. Tokens count fresh input and output only; context re-read from the cache is not counted (it costs about a tenth). This stop always waits for you, also with auto-approve.")}</p>
        <button class="btn primary" type="submit">${t("Save")}</button>
        <p class="note" id="budgetMsg"></p>
      </form>
    </section>
    <section class="panel">
      <header><h2>${t("Which model runs?")}</h2></header>
      <ol class="order">
        <li><b>${t("Project override")}</b> ${t("for that agent (Models tab on the floor)")}</li>
        <li><b>${t("Project override")}</b> ${t("for all agents")}</li>
        <li><b>${t("Global override")}</b> ${t("for that agent")}</li>
        <li><b>${t("Global override")}</b> ${t("for every agent")}</li>
        <li><b>${t("Agent default")}</b> ${t("model")}</li>
        <li><b>${t("Department")}</b> ${t("model")}</li>
        <li><b>${t("Company default")}</b></li>
      </ol>
    </section>
  </div>
</main>

<dialog class="viewer" id="viewer"><header><h3 id="viewerTitle"></h3><button class="btn" id="viewerClose">${t("Close")}</button></header><div class="md" id="viewerBody"></div></dialog>

<dialog class="viewer agentdlg" id="agentDlg">
  <header><span class="av-sm" id="adAv"></span><div style="flex:1;min-width:0"><div class="eyebrow" id="adDept"></div><h3 id="adTitle"></h3></div><button class="btn" id="adClose" type="button">${t("Close")}</button></header>
  <form class="form" id="adForm">
    <div class="ad-now"><span class="eyebrow">${t("Uses now")}</span><span id="adNow"></span></div>
    <label class="check ad-active"><input type="checkbox" id="adActive"> <span><b>${t("Active")}</b> <small>${t("Off = this position is skipped on every project until you switch it back on")}</small></span></label>
    <label>${t("Default model for all projects")} <small>${t("saved to agents.json")}</small><select class="field" id="adModel"></select></label>
    <label>${t("Override for this project only")}<select class="field" id="adOverride"></select></label>
    <label>${t("Effort")}<select class="field" id="adEffort"><option value="">${t("Company default")}</option><option value="low">${t("Low")}</option><option value="medium">${t("Medium")}</option><option value="high">${t("High")}</option><option value="max">${t("Max")}</option></select></label>
    <label>${t("Max agents for this role")} <small>${t("1 = works alone. 2 or more = may split a big task across helpers with the same role and model, then merges")}</small><input class="field mono" type="number" id="adMaxAgents" min="1" max="10" step="1"></label>
    <label>${t("Max output tokens per reply")} <small>${t("hard cap, thinking included. Lower = cheaper")}</small><input class="field mono" type="number" id="adMaxOut" min="500" max="64000" step="500"></label>
    <p class="note">${t("Which one runs: project override, then global override (Registry), then this default, then the department, then the company default.")}</p>
    <fieldset class="rules" id="adRules"><legend>${t("Rules & limits")}</legend>
      <label>${t("Instructions (persona)")} <small>${t("what this role does")}</small><textarea class="field" id="adPersona" rows="3"></textarea></label>
      <label>${t("Always do")} <small>${t("one rule per line")}</small><textarea class="field" id="adMustDo" rows="3" placeholder="${t("e.g. State every price in IDR")}"></textarea></label>
      <label>${t("Never do")} <small>${t("one rule per line")}</small><textarea class="field" id="adMustNot" rows="3" placeholder="${t("e.g. Never propose paid third-party services")}"></textarea></label>
      <label class="check ad-active"><input type="checkbox" id="adAsk"> <span><b>${t("May ask you questions")}</b> <small>${t("off = it states assumptions instead")}</small></span></label>
      <div class="ad-tools"><span>${t("Tools it may use in code mode")}</span><div id="adTools"></div><small id="adToolsNote"></small></div>
      <p class="note">${t("Always/never rules are instructions the agent is told to put first; the app does not check them. Asking questions and tools are enforced by the app.")}</p>
    </fieldset>
    <div class="row"><button class="btn primary" type="submit" id="adSave">${t("Save")}</button><button class="btn" type="button" id="adOpenReg">${t("Open Registry")}</button></div>
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
  const stageTitle = id => nm(S.meta.pipeline.find(s => s.id === id), "title") || id;
  const roleName = id => nm(agent(id), "role") || id;
  const roleCol = id => window.vcRoleColor ? window.vcRoleColor(id) : "var(--muted)";   // the role's own colour (viz.js)
  const deptName = d => nm(S.meta.departments[d], "name") || d;

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
    $("#slots").innerHTML = SLOTS.map(([k, label]) => `<span class="slot ${S.brief[k] ? "filled" : ""}" title="${esc(S.brief[k] || t("Not known yet"))}">${S.brief[k] ? "\u2713 " : ""}${t(label)}</span>`).join("");
  }

  function renderRibbon() {
    $("#ribbon").innerHTML = S.meta.pipeline.map((s, i) => `<div class="st ${S.stageIdx[s.id] || ""}" title="${esc(nm(s, "title"))}">${String(i + 1).padStart(2, "0")} ${esc(nm(s, "title"))}</div>`).join("");
  }

  // Agents answer in light Markdown; show bold, inline code and bullets without turning the bubble into a document.
  const chatText = t => esc(t).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/`([^`]+)`/g, "<code>$1</code>").replace(/^\s*[-*] /gm, "\u2022 ");

  // WhatsApp-style chat: your messages green on the right with ticks, the team's white on the left with the
  // sender's name in their department colour; consecutive messages from one sender are grouped; a chip per day.
  const msgTime = d => d.toLocaleTimeString(I18N.lang === "id" ? "id-ID" : "en-GB", { hour: "2-digit", minute: "2-digit" });
  function dayChip(d) {
    const today = new Date(), y = new Date(Date.now() - 864e5);
    const label = d.toDateString() === today.toDateString() ? t("Today") : d.toDateString() === y.toDateString() ? t("Yesterday")
      : d.toLocaleDateString(I18N.lang === "id" ? "id-ID" : "en-GB", { day: "numeric", month: "long", year: "numeric" });
    const c = document.createElement("div"); c.className = "day-chip"; c.innerHTML = `<span>${esc(label)}</span>`;
    $("#messages").appendChild(c);
  }

  function addMsg(m) {
    hideTyping();
    const at = new Date(m.at || Date.now());
    if (S.chatDay !== at.toDateString()) { S.chatDay = at.toDateString(); dayChip(at); }
    const mine = m.role === "customer";
    const a = m.agentId ? agent(m.agentId) : null;
    const sender = mine ? "me" : (m.agentId || "agent");
    const prev = $("#messages").lastElementChild;
    const cont = prev?.classList.contains("msg") && prev.dataset.sender === sender;
    const div = document.createElement("div");
    div.className = `msg ${mine ? "customer" : "agent"}${cont ? " cont" : ""}`;
    div.dataset.sender = sender;
    const dept = a?.department || "support";
    const av = mine ? "" : `<span class="av" style="background:${roleCol(m.agentId)}" title="${esc(nm(a, "role"))}">${esc(a?.initials || "AI")}</span>`;
    const who = mine || cont ? "" : `<div class="who" style="color:${roleCol(m.agentId)}">${esc(nm(a, "role") || t("Agent"))}</div>`;
    const ticks = mine ? `<svg class="ticks" viewBox="0 0 16 11" width="16" height="11" aria-label="${t("Delivered")}"><path d="M11.1.6 5.3 6.9 3 4.6 2 5.6l3.3 3.3L12.1 1.6zM15.1.6 9.3 6.9l-.7-.7-1 1L9.3 8.9 16.1 1.6z" fill="currentColor"/></svg>` : "";
    const files = (m.attachments || []).map(f => {
      const url = `/api/projects/${encodeURIComponent(S.id || "")}/attachments/${encodeURIComponent(f.file)}`;
      return f.type?.startsWith("image/")
        ? `<a class="att-img" href="${url}" target="_blank" rel="noopener" title="${esc(f.name)}"><img src="${url}" alt="${esc(f.name)}" loading="lazy"></a>`
        : `<a class="att-file" href="${url}" target="_blank" rel="noopener"><span class="att-ic">${esc(fileExt(f.name))}</span><span><b>${esc(f.name)}</b><small>${fmtSize(f.size)}</small></span></a>`;
    }).join("");
    div.innerHTML = `${av}<div class="bubble">${who}${files ? `<div class="atts">${files}</div>` : ""}${m.text ? `<span class="body">${chatText(m.text)}</span>` : ""}<span class="meta">${msgTime(at)}${ticks}</span></div>`;
    $("#messages").appendChild(div);
    $("#messages").scrollTop = $("#messages").scrollHeight;
  }

  function showTyping(agentId) {
    hideTyping();
    const a = agent(agentId);
    const div = document.createElement("div"); div.className = "msg agent"; div.id = "typing";
    div.innerHTML = `<span class="av" style="background:${roleCol(agentId)}">${esc(a?.initials || "AI")}</span><div class="bubble typing" aria-label="${t("typing")}"><i></i><i></i><i></i></div>`;
    $("#messages").appendChild(div); $("#messages").scrollTop = $("#messages").scrollHeight;
  }
  function hideTyping() { $("#typing")?.remove(); }

  function feed(kind, agentId, text, sub, ts) {
    const a = agentId ? agent(agentId) : null;
    const li = document.createElement("li"); li.className = "k-" + kind;
    const dot = a ? `<span class="dot" style="background:${roleCol(agentId)}">${esc(a.initials)}</span>`
      : `<span class="dot" style="background:var(--${kind === "gate" ? "gate" : kind === "loop" ? "danger" : kind === "ok" ? "ok" : "muted"})">${kind === "gate" ? "\u25c6" : "\u2022"}</span>`;
    li.innerHTML = `<time>${fmtTime(ts || Date.now())}</time>${dot}<div class="txt">${esc(text)}${sub ? `<small>${esc(sub)}</small>` : ""}</div>`;
    const f = $("#feed"); f.prepend(li);
    while (f.children.length > 250) f.lastChild.remove();
  }

  function renderDocs() {
    $("#docCount").textContent = S.artifacts.length ? `(${S.artifacts.length})` : "";
    if (!S.artifacts.length) { $("#docs").innerHTML = `<p class="empty">${t("Documents appear here as each agent finishes: proposal, BRD, plan, designs, code, test reports.")}</p>`; return; }
    S.canWriteHandover = !DEMO && !!S.id && ["Completed", "Stopped", "Failed"].includes(S.status) && !!S.meta.pipeline.find(s => s.id === "handover")
      && !!agent("tech_writer") && !agent("tech_writer").disabled && !!S.stageIdx.discovery;
    const by = {};
    S.artifacts.forEach(a => (by[a.stageId] ||= []).push(a));
    const dl = DEMO || !S.id ? "" : `<a class="btn primary dl-all" href="/api/projects/${encodeURIComponent(S.id)}/export" download>${t("Download all (.zip)")}</a>`;
    // Client handover: project summary + user handbook, as a page to print and as a PDF.
    const pid = encodeURIComponent(S.id || "");
    const hand = DEMO || !S.id ? "" : S.handover
      ? `<div class="handover"><div><b>${t("Client handover")}</b><small>${t("Project summary and user handbook, ready to give to the client.")}</small></div>
          <div class="row"><a class="btn sm" href="/api/projects/${pid}/handover" target="_blank" rel="noopener">${t("View")}</a>
          <a class="btn primary sm" href="/api/projects/${pid}/handover.pdf">${t("Download PDF")}</a>
          ${S.canWriteHandover ? `<button class="btn sm" type="button" id="handoverBtn">${t("Rewrite")}</button>` : ""}</div></div>`
      : S.canWriteHandover
        ? `<div class="handover"><div><b>${t("Client handover")}</b><small>${t("Write the project summary and user handbook for the client (PDF).")}</small></div>
            <div class="row"><button class="btn primary sm" type="button" id="handoverBtn">${t("Create handover document")}</button></div></div>`
        : "";
    // Release package for the client: app + its own .NET runtime + start script + handover PDF, as one zip.
    const busy = ["Running", "WaitingCustomer"].includes(S.status);
    const r = S.release;
    const rel = DEMO || !S.id || !S.appExists ? "" : `<div class="handover release"><div><b>${t("Release package for the client")}</b>
        <small>${r ? t("{0} MB, built {1}. Extract and double-click Start.bat; nothing to install.", (r.size / 1048576).toFixed(0), new Date(r.at).toLocaleString(I18N.lang === "id" ? "id-ID" : "en-GB", { dateStyle: "medium", timeStyle: "short" }))
                  : t("The app with its own runtime, a start script and the handover PDF in one zip. The client extracts it and double-clicks; nothing to install.")}</small></div>
        <div class="row">${r ? `<a class="btn primary sm" href="/api/projects/${pid}/release.zip">${t("Download package")}</a>` : ""}
        <button class="btn sm${r ? "" : " primary"}" type="button" id="releaseBtn" ${busy ? `disabled title="${t("Agents are still changing the app; pause the project or wait until it finishes.")}"` : ""}>${r ? t("Rebuild") : t("Build package")}</button></div></div>`;
    $("#docs").innerHTML = hand + rel + dl + S.meta.pipeline.filter(s => by[s.id]).map(s => `<div><h4 class="eyebrow">${esc(nm(s, "title"))}</h4>${by[s.id].map(a => {
      const ag = agent(a.agentId);
      return `<button data-doc="${esc(a.name)}" data-title="${esc(a.title)}"><span class="av-sm" style="background:${roleCol(a.agentId)}">${esc(ag?.initials)}</span><span>${esc(a.title)}</span></button>`;
    }).join("")}</div>`).join("");
  }

  function renderGate() {
    const g = S.gate, slot = $("#gateSlot");
    if (!g) { slot.innerHTML = ""; return; }
    const docs = (g.artifacts || []).map(n => `<button class="doclink" data-doc="${esc(n)}" data-title="${esc(n)}">${esc(n)}</button>`).join("");
    slot.innerHTML = `<div class="gatecard" role="alert"><div class="eyebrow">${esc(t("Your decision \u00b7 {0}", stageTitle(g.stageId)))}</div><h3>${esc(g.label)}</h3>
      ${docs ? `<div class="docs">${docs}</div>` : ""}
      ${DEMO ? `<p class="note">${t("In the live app you approve, request changes or reject here. The replay approves after a pause.")}</p>` : `
      <textarea id="gateNote" class="field" placeholder="${t("What should change? (needed for Request changes)")}"></textarea>
      <div class="row"><button class="btn signal" data-gate="approve">${t("Approve")}</button><button class="btn" data-gate="revise">${t("Request changes")}</button><button class="btn" data-gate="reject">${t("Reject")}</button></div>`}</div>`;
  }

  function renderModels() {
    if (!S.meta) return;
    const opts = sel => `<option value="">${t("Inherit")}</option>` + S.meta.models.map(m => `<option value="${m.id}" ${sel === m.id ? "selected" : ""}>${esc(m.label)}</option>`).join("");
    const dis = DEMO || !S.id ? "disabled" : "";
    $("#modelRows").innerHTML = `<p class="note">${t("Overrides for this project only. Registry sets the company-wide defaults.")}</p>
      <div class="modelrow"><div><b>${t("All agents")}</b><small>${t("forces one model everywhere")}</small></div><select class="field" data-ov="*" ${dis}>${opts(S.overrides["*"])}</select></div>` +
      S.meta.agents.map(a => `<div class="modelrow"><div>${esc(nm(a, "role"))}<small>${esc(t("default {0} \u00b7 {1}", modelInfo(a.resolvedModel)?.label || a.resolvedModel, t(a.modelSource)))}</small></div><select class="field" data-ov="${a.id}" ${dis}>${opts(S.overrides[a.id])}</select></div>`).join("");
  }

  function renderRegistry() {
    const m = S.meta, models = m.models;
    const stageOf = id => nm(m.pipeline.find(s => s.agents.includes(id)), "title") || "-";
    const opt = (sel, emptyLabel) => `<option value="">${emptyLabel}</option>` + models.map(x => `<option value="${x.id}" ${sel === x.id ? "selected" : ""}>${esc(x.label)}</option>`).join("");
    const dis = DEMO ? "disabled" : "";
    $("#globalAll").innerHTML = opt(m.overrides["*"], t("No override")); $("#globalAll").disabled = DEMO;
    $("#regBody").innerHTML = m.agents.map(a => `<tr class="${a.disabled ? "off" : ""}">
      <td><input type="checkbox" data-agent="${a.id}" data-field="active" aria-label="${esc(nm(a, "role"))} ${t("active")}" ${a.disabled ? "" : "checked"} ${a.id === "intake" || DEMO ? "disabled" : ""}></td>
      <td class="role"><span class="av-sm" style="background:${roleCol(a.id)}">${esc(a.initials)}</span>${esc(nm(a, "role"))}${a.spawnable ? ` <span class="src">${t("parallel")}</span>` : ""}</td>
      <td><span style="color:var(--d-${a.department})">${esc(deptName(a.department))}</span></td>
      <td>${esc(stageOf(a.id))}</td>
      <td><select class="field" data-agent="${a.id}" data-field="model" ${dis}>${opt(a.model, t("Department / default"))}</select></td>
      <td><select class="field" data-agent="${a.id}" data-field="override" ${dis}>${opt(m.overrides[a.id], t("None"))}</select></td>
      <td><select class="field" data-agent="${a.id}" data-field="effort" ${dis}>${["", "low", "medium", "high", "max"].map(e => `<option value="${e}" ${(a.effort || "") === e ? "selected" : ""}>${e ? t(e[0].toUpperCase() + e.slice(1)) : t("default")}</option>`).join("")}</select></td>
      <td><input class="field mono" style="width:56px" type="number" min="1" value="${a.maxInstances}" data-agent="${a.id}" data-field="maxInstances" ${a.id === "intake" ? "disabled" : ""} ${dis}></td>
      <td>${a.disabled ? `<span class="src">${t("off")}</span>` : `${chip(a.resolvedModel)} <span class="src">${esc(t(a.modelSource))}</span>`}</td>
      <td><button class="btn sm rules-btn" type="button" data-rules="${a.id}" title="${esc(t("Rules & limits"))}">${t("Edit")}${(a.mustDo?.length || 0) + (a.mustNot?.length || 0) ? ` <span class="mono">${(a.mustDo?.length || 0)}✓ ${(a.mustNot?.length || 0)}✗</span>` : ""}</button></td></tr>`).join("");
    $("#nDept").innerHTML = Object.entries(m.departments).map(([k, d]) => `<option value="${k}">${esc(nm(d, "name"))}</option>`).join("");
    $("#nModel").innerHTML = opt("", t("Department / default"));
    $("#nStage").innerHTML = m.pipeline.map(s => `<option value="${s.id}">${esc(nm(s, "title"))}</option>`).join("");
    $("#bUsd").value = m.budget?.maxUsdPerProject ?? 0; $("#bTok").value = m.budget?.maxTokensPerProject ?? 0;
    $("#budgetForm").querySelectorAll("input,button").forEach(x => x.disabled = DEMO);
    $("#addForm").querySelectorAll("input,select,textarea,button").forEach(x => x.disabled = DEMO);
    if (DEMO) $("#addMsg").textContent = t("Read-only in the replay. Run the app locally to edit positions and models.");
  }

  function setStatus(s) {
    S.status = s;
    const chipEl = $("#statusChip");
    const label = t({ Intake: "Intake", Running: "Running", WaitingGate: "Waiting for you", WaitingCustomer: "Waiting for customer", Completed: "Live", Stopped: "Stopped", Failed: "Failed", Paused: "Paused" }[s] || s);
    const issues = (S.openIssues || []).length;
    const withIssues = s === "Completed" && issues > 0;
    chipEl.dataset.s = withIssues ? "CompletedIssues" : s;
    chipEl.textContent = withIssues ? t("Live · {0} open issues", issues) : label;
    chipEl.title = withIssues ? S.openIssues.join("\n") : "";
    // A minimized panel still shows that something waits for you there.
    document.querySelector('.rail[data-rail="left"]')?.classList.toggle("attention", s === "WaitingCustomer");
    document.querySelector('.rail[data-rail="right"]')?.classList.toggle("attention", s === "WaitingGate");
    if (s === "Stopped" || s === "Failed" || s === "Completed") {
      S.gate = null; renderGate();
      for (const k in S.live) viz?.setLive(S.live[k].agentId, S.live[k].inst, null);
      S.live = {}; renderLive();
    }
    const paused = (s === "Stopped" || s === "Failed") && SLOTS.every(([k]) => S.brief[k]);
    $("#resumeBtn").hidden = DEMO || !paused;
    $("#stopBtn").hidden = DEMO || !(s === "Running" || s === "WaitingGate" || s === "WaitingCustomer" || s === "Paused");
    $("#pauseBtn").hidden = DEMO || !(s === "Running" || s === "WaitingGate" || s === "WaitingCustomer");
    $("#unpauseBtn").hidden = DEMO || s !== "Paused";
    renderApp();
    updateComposer();
    if (S.meta) renderDocs();   // the handover button depends on the status
  }

  function renderApp() {
    const open = $("#openAppBtn");
    open.hidden = DEMO || !S.appUrl;
    if (S.appUrl) open.href = S.appUrl;
    $("#startAppBtn").hidden = DEMO || !S.appExists || !!S.appUrl || ["Running", "WaitingGate", "WaitingCustomer", "Paused"].includes(S.status);
    $("#stopAppBtn").hidden = DEMO || !S.appUrl;
  }

  function updateComposer() {
    const can = !DEMO && S.id && ["Intake", "WaitingCustomer", "Running", "WaitingGate", "Completed", "Stopped", "Failed", "Paused"].includes(S.status);
    $("#chatInput").disabled = !can; $("#sendBtn").disabled = !can;
    $("#composerNote").textContent = t(DEMO ? "This is a recorded run. Start the app locally to chat as the customer."
      : !S.id ? "Press New request, or Run sample request to watch a full project."
      : S.status === "WaitingCustomer" ? "An agent asked you something above. Your reply goes straight to them."
      : S.status === "Intake" ? "The intake agent fills the five chips above as you answer."
      : S.status === "Stopped" || S.status === "Failed" ? "The project is paused. Press Resume to continue from the last finished step, or ask for its status here."
      : "");
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
        if (d.complete) { viz.setAgent("intake", 0, "done"); feed("ok", "intake", t("Brief complete. Handing over to Business Development."), null, ts); }
        break;
      case "title": S.title = d.title; $("#projTitle").textContent = d.title; if (!DEMO && !S.replaying) refreshProjects(S.id); break;
      case "status": {
        // Elapsed counts working time only: while paused or stopped the clock stands still (also when replayed)
        const at = new Date(ts).getTime(), still = ["Paused", "Stopped", "Failed"].includes(d.status);
        if (still && S.idleSince == null) S.idleSince = at;
        else if (!still && S.idleSince != null) { S.idleMs += at - S.idleSince; S.idleSince = null; }
        setStatus(d.status);
        if (d.status === "Completed") { viz.celebrate(); feed("ok", null, t("Project is live. The cycle continues with usage data."), null, ts); if (!S.replaying) toast(t("Project delivered. Support and Data now run the service.")); }
        if (d.status === "Failed" || d.status === "Stopped") feed("loop", null, t(d.status === "Failed" ? "The pipeline stopped with an error." : "Project stopped."), null, ts);
        break;
      }
      case "stage":
        S.stageIdx[d.stageId] = d.status; renderRibbon(); viz.stage(d.stageId, d.status);
        if (d.status === "running") feed("info", null, t("{0} started", stageTitle(d.stageId)) + (d.round > 1 ? t(" \u00b7 round {0}", d.round) : ""), null, ts);
        break;
      case "agent": {
        const inst = d.instance > 1 || (viz.extra?.[d.agentId] || 1) > 1 ? ` #${d.instance}` : "";
        viz.setAgent(d.agentId, d.instance, d.status);
        if (d.model) viz.setModel(d.agentId, d.model, d.source);
        const lk = `${d.agentId}#${d.instance || 1}`;
        if (d.status === "working") S.live[lk] = { agentId: d.agentId, inst: d.instance || 1, phase: "starting", tokens: 0, module: d.module,
          startedAt: new Date(ts).getTime(), lastAt: S.replaying ? Date.now() : new Date(ts).getTime() };
        else { delete S.live[lk]; viz.setLive(d.agentId, d.instance, null); }
        renderLive();
        if (d.status === "working") feed("info", d.agentId, t("{0} is working", roleName(d.agentId) + inst) + (d.module ? t(" on {0}", d.module) : ""), `${modelInfo(d.model)?.label || d.model} \u00b7 ${t(d.source || "")}`, ts);
        if (d.status === "done" || d.status === "blocked") feed(d.status === "blocked" ? "loop" : "info", d.agentId, d.summary || t("{0} finished", roleName(d.agentId)), d.tokensOut != null ? t("{0} tokens \u00b7 ${1}", (d.tokensIn + d.tokensOut).toLocaleString(), Number(d.cost).toFixed(4)) : null, ts);
        if (d.status === "need_info") feed("gate", d.agentId, t("{0} needs answers from the customer", roleName(d.agentId)), null, ts);
        if (d.status === "error") feed("loop", d.agentId, t("{0} failed: {1}", roleName(d.agentId), d.summary), null, ts);
        activeCount(); break;
      }
      case "spawn":
        viz.spawn(d.agentId, d.count);
        if (d.reason === "delegate") feed("info", d.agentId, t("{0} split its work across {1} helpers (same role and model)", roleName(d.agentId) + (d.lead > 1 ? ` #${d.lead}` : ""), d.helpers ?? d.count - 1) + (d.summary ? `: ${d.summary}` : ""), (d.modules || []).slice(1).join(" | "), ts);
        else feed("info", "project_manager", t("Staffed {0} \u00d7 {1} in parallel", d.count, roleName(d.agentId)), (d.modules || []).filter(Boolean).join(" | "), ts);
        break;
      case "plan": feed("info", "project_manager", t("Plan: {0} modules", (d.modules || []).length), (d.modules || []).join(", "), ts);
        S.modules = d.modules || []; renderModules(); break;
      case "module": (S.modLog[d.module] ||= []).push({ ...d, ts }); renderModules(); break;
      case "issues": S.openIssues = d.open || []; renderModules(); setStatus(S.status); break;
      case "handoff": viz.handoff(d.fromStage, d.toStage); break;
      case "artifact": S.artifacts.push(d); if (d.agentId === "tech_writer" && !d.helper) S.handover = d.name; renderDocs(); break;
      case "gate":
        viz.gate(d.stageId, d.status);
        S.stageIdx[d.stageId] = d.status === "waiting" ? "waiting" : "done"; renderRibbon();
        if (d.status === "waiting") { S.gate = d; feed("gate", null, t("Waiting for you: {0}", d.label), null, ts); if (!S.replaying) S.expandPanel?.("right"); }
        else { S.gate = null; feed(d.status === "approved" ? "ok" : "loop", null, `${d.label}: ${t(d.status)}${d.note ? ` (${d.note})` : ""}`, null, ts); }
        renderGate(); break;
      case "loop": viz.loop(d.fromStage); feed("loop", "qa", t("{0} defects. Back to {1}, round {2}", d.bugs, stageTitle(d.toStage), d.round), (d.defects || []).join(" | "), ts); break;
      case "question": if (!S.replaying) S.expandPanel?.("left");
        feed("gate", d.agentId, t("Asked the customer a question"), (d.questions || []).join(" | "), ts); if (S.sample && !S.replaying) setTimeout(() => typeAndSend(SAMPLE_ANSWER), 1400); break;
      case "usage": S.tokens = d.tokensIn + d.tokensOut; S.cost = d.cost; S.usdStop = d.usdStop ?? null;
        $("#tokens").title = d.cacheRead ? t("Fresh input and output tokens. Another {0} tokens were re-read from the cache (about a tenth of the price).", Number(d.cacheRead).toLocaleString()) : "";
        $("#cost").title = d.usdStop ? t("Next budget stop at ${0}", Number(d.usdStop).toFixed(2)) : "";
        tweenNum("tokens", S.tokens, v => Math.round(v).toLocaleString()); tweenNum("cost", S.cost, v => v.toFixed(4)); break;
      case "progress": {   // live tick from a working agent (every ~2 s, never stored)
        const lk = `${d.agentId}#${d.instance || 1}`, now = Date.now();
        // A call without an "agent working" event (a chat reply by Intake or Customer Support) gets no "done" event
        // either: such a row lives only while its ticks keep coming (see renderLive).
        const l = S.live[lk] ||= { agentId: d.agentId, inst: d.instance || 1, tickOnly: true };
        Object.assign(l, { phase: d.phase, tool: d.tool, detail: d.detail, tokens: d.tokens || 0, limit: d.limit, retry: d.retry, rateLimit: d.rateLimit,
          startedAt: l.startedAt ?? now - (d.elapsed || 0) * 1000, lastAt: now - (d.idle || 0) * 1000, tickAt: now });
        renderLive(); break;
      }
      case "feedback": viz.feedback(); feed("ok", "data_analyst", t("Feedback to Project Manager: {0}", d.summary), t("continuous improvement"), ts); break;
      case "log": feed(d.level === "error" ? "loop" : d.level === "ok" ? "ok" : d.level === "warn" ? "gate" : "info", null, d.text, null, ts); break;
      case "app":
        S.appExists = true;
        S.appUrl = d.status === "running" ? d.url : null;
        renderApp();
        if (d.status === "running") feed("ok", null, t("The app is running at {0}", d.url), t("Open app (top of the floor) to try it"), ts);
        if (d.status === "failed") feed("loop", null, t("The app could not be started"), (d.error || "").split("\n").slice(0, 3).join(" | "), ts);
        break;
    }
  }

  // ---------------- live view: is each working agent really working? ----------------
  const STALL_SEC = 60;   // no sign of life for this long: shown amber as possibly stuck
  const fmtDur = s => { s = Math.max(0, Math.round(s)); const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, x = String(s % 60).padStart(2, "0"); return h ? `${h}:${String(m).padStart(2, "0")}:${x}` : `${m}:${x}`; };
  const fmtTok = n => n >= 1000 ? (n / 1000).toFixed(1).replace(/\.0$/, "") + t("k") : String(n);
  const fmtClock = ms => ms ? new Date(ms).toLocaleTimeString(I18N.lang === "id" ? "id-ID" : "en-GB", { weekday: "short", hour: "2-digit", minute: "2-digit" }) : "?";

  function liveState(l, now) {
    const idle = (now - (l.lastAt || now)) / 1000;
    if (l.phase === "paused") return "paused";                                  // held on purpose by Pause: not stuck
    if (l.phase === "rate_limited") return "limited";
    if (l.phase === "retrying") return "retrying";
    // Only an agent we get live ticks for can be judged stuck (the API engine and older servers send none).
    if (l.tickAt && idle >= STALL_SEC) return "stalled";
    return "";
  }

  // Short text for the card (it replaces the model name while the agent works).
  function liveShort(l, now) {
    const el = fmtDur((now - l.startedAt) / 1000), st = liveState(l, now);
    if (st === "paused") return `⏸ ${t("paused")}`;
    if (st === "limited") return `⏸ ${t("limit")} ${l.rateLimit?.resetsAt ? new Date(l.rateLimit.resetsAt).toTimeString().slice(0, 5) : "?"}`;
    if (st === "retrying") return `⟳ ${t("retry {0}/{1}", l.retry?.attempt ?? "?", l.retry?.max ?? "?")}`;
    if (st === "stalled") return `⚠ ${t("silent {0}", fmtDur((now - l.lastAt) / 1000))}`;
    if (l.phase === "tool") return `⚙ ${l.tool || t("tool")} · ${el}`;
    if (l.phase === "writing") return `✎ ${fmtTok(l.tokens)} ${t("tok")} · ${el}`;
    if (l.phase === "thinking") return `… ${t("thinking")} · ${el}`;
    return `${t("starting")} · ${el}`;
  }

  // Full sentence for the "Working now" panel.
  function liveLong(l, now) {
    const st = liveState(l, now);
    if (st === "paused") return t("Paused: waits at its next step until you press Continue.");
    if (st === "limited") return t("Claude usage limit reached; resets {0}. Press Resume after that.", fmtClock(l.rateLimit?.resetsAt));
    if (st === "retrying") return t("Claude API busy ({0}); retry {1}/{2} in {3}s", l.retry?.error || "?", l.retry?.attempt ?? "?", l.retry?.max ?? "?", Math.round((l.retry?.waitMs || 0) / 1000));
    let s = l.phase === "tool" ? t("Running {0}", l.tool || t("tool")) + (l.detail ? `: ${l.detail}` : "")
      : l.phase === "writing" ? (l.limit ? t("Writing: {0} of max {1} tokens", l.tokens.toLocaleString(), l.limit.toLocaleString()) : t("Writing: {0} tokens", l.tokens.toLocaleString()))
      : l.phase === "thinking" ? t("Thinking") : t("Waiting for Claude's first reply");
    if (st === "stalled") s = t("No activity for {0}; it may be stuck.", fmtDur((now - l.lastAt) / 1000)) + " " + s;
    else if (l.limit && l.tokens > l.limit * 0.9) s += " · " + t("close to its output limit");
    return s;
  }

  function renderLive() {
    const box = $("#live"); if (!box) return;
    const now = Date.now();
    // the runner ticks every ~2 s while a call runs: a tick-only row that has gone quiet has finished, it is not stuck
    for (const [k, l] of Object.entries(S.live)) if (l.tickOnly && now - (l.tickAt || 0) > 12000) { delete S.live[k]; viz.setLive(l.agentId, l.inst, null); }
    const rows = Object.values(S.live);
    for (const l of rows) { const st = liveState(l, now); viz.setLive(l.agentId, l.inst, liveShort(l, now), st); }
    box.hidden = rows.length === 0;
    if (!rows.length) { box.innerHTML = ""; return; }
    const stop = S.usdStop ?? (S.meta?.budget?.maxUsdPerProject ? S.meta.budget.maxUsdPerProject : null);
    const head = `<div class="live-head"><b>${t("Working now ({0})", rows.length)}</b>${stop ? `<span class="mono">${t("spent ${0} · budget stop at ${1}", Number(S.cost).toFixed(2), Number(stop).toFixed(2))}</span>` : ""}</div>`;
    box.innerHTML = head + rows.sort((a, b) => a.startedAt - b.startedAt).map(l => {
      const a = agent(l.agentId), st = liveState(l, now), ago = Math.round((now - l.lastAt) / 1000);
      return `<div class="live-row ${st}"><span class="dot" style="background:${roleCol(l.agentId)}">${esc(a?.initials || "AI")}</span>
        <div><div class="live-who">${esc(roleName(l.agentId))}${l.inst > 1 || (viz.extra?.[l.agentId] || 1) > 1 ? ` #${l.inst}` : ""}<span class="mono">${fmtDur((now - l.startedAt) / 1000)}</span></div>
        <div class="live-what">${esc(liveLong(l, now))}</div>
        <div class="live-meta mono">${l.tickAt ? esc(t("last sign of life {0} ago", fmtDur(ago))) : esc(t("no live progress from this engine"))}${l.tokens ? ` · ${esc(t("{0} tokens out", l.tokens.toLocaleString()))}` : ""}</div></div></div>`;
    }).join("");
  }
  setInterval(renderLive, 1000);

  // ---------------- module log + progress (plan from the Project Manager, lines from every agent) ----------------
  // How far a module is, from the last state an agent reported for it.
  const MOD_WEIGHT = { done: 1, partial: 0.6, blocked: 0.5, info: 0.4, working: 0.15, todo: 0 };
  const modCode = name => (String(name).match(/\bM\d{1,3}\b/) || [String(name).split(" ")[0]])[0];

  function moduleStatus(code) {
    const log = S.modLog[code] || [];
    const last = log.at(-1);
    if (!last) return { state: "todo", pct: 0, rework: false, last: null };
    // A new round of work keeps what was reached before, marked as being reworked.
    const settled = [...log].reverse().find(e => e.state !== "working");
    const state = last.state === "working" && settled ? settled.state : last.state;
    return { state, pct: Math.round((MOD_WEIGHT[state] ?? 0.4) * 100), rework: last.state === "working" && !!settled, working: last.state === "working", last: settled || last };
  }

  function renderModules() {
    const box = $("#modlog"); if (!box) return;
    const names = S.modules.length ? S.modules : Object.keys(S.modLog);
    const rows = names.map(n => ({ name: n, code: modCode(n), ...moduleStatus(modCode(n)) }));
    const total = rows.length, done = rows.filter(r => r.state === "done").length;
    const pct = total ? Math.round(rows.reduce((s, r) => s + r.pct, 0) / total) : 0;
    $("#modCount").textContent = total ? `${pct}%` : "";
    $("#modStat").hidden = !total; $("#modPct").textContent = `${pct}%`; $("#modBar").style.width = pct + "%";
    const open = S.openIssues || [];
    const issuesHtml = open.length ? `<div class="open-issues"><b>${t("Open issues ({0})", open.length)}</b><ul>${open.map(x => `<li>${esc(x)}</li>`).join("")}</ul></div>` : "";
    if (!total) { box.innerHTML = issuesHtml + `<p class="empty">${t("The Project Manager splits the work into modules (M01, M02, ...) in the Planning stage. Each agent then reports what it did per module, and the progress shows here.")}</p>`; return; }
    const stateLabel = r => r.working ? (r.rework ? t("rework") : t("in progress")) : t({ done: "done", partial: "partial", blocked: "blocked", info: "reported", todo: "not started" }[r.state] || r.state);
    const who = e => esc(roleName(e.agentId)) + (e.instance > 1 ? ` #${e.instance}` : "");
    box.innerHTML = issuesHtml + `<div class="mod-total"><div><b>${t("{0}% complete", pct)}</b><span class="mono">${t("{0} of {1} modules done", done, total)}</span></div>
        <span class="pbar big"><i style="width:${pct}%"></i></span>
        <button class="btn sm" type="button" id="modCopy">${t("Copy as text")}</button></div>` +
      rows.map(r => `<details class="mod ${r.state}${r.working ? " working" : ""}">
        <summary><span class="mod-code mono">${esc(r.code)}</span>
          <span class="mod-main"><span class="mod-name">${esc(r.name.replace(r.code, "").trim() || r.code)}</span>
            <span class="mod-line">${r.last ? esc(r.last.text) : esc(t("not started yet"))}</span></span>
          <span class="mod-side"><span class="mod-state">${esc(stateLabel(r))}</span><span class="pbar"><i style="width:${r.pct}%"></i></span></span></summary>
        <ol class="mod-hist">${(S.modLog[r.code] || []).map(e => `<li><time>${fmtTime(e.ts)}</time> <b>${who(e)}</b> <span class="src">${esc(stageTitle(e.stageId))}${e.round > 1 ? " · " + t("round {0}", e.round) : ""}</span><div>${esc(e.text)}</div></li>`).join("") || `<li>${t("No reports yet.")}</li>`}</ol>
      </details>`).join("");
  }

  // "M01: ..." lines, ready to paste.
  function modulesAsText() {
    const names = S.modules.length ? S.modules : Object.keys(S.modLog);
    return names.map(n => { const c = modCode(n), s = moduleStatus(c); return `${c}: ${s.last ? s.last.text : t("not started yet")}`; }).join("\n");
  }

  setInterval(() => {
    if (!S.firstTs) return;
    const end = S.idleSince ?? (["Completed", "Stopped", "Failed"].includes(S.status) ? S.lastTs : (DEMO ? S.lastTs : Date.now()));
    const sec = Math.max(0, Math.round((end - S.firstTs - (S.idleMs || 0)) / 1000));
    const two = n => String(n).padStart(2, "0");
    $("#elapsed").textContent = `${two(Math.floor(sec / 3600))}:${two(Math.floor(sec / 60) % 60)}:${two(sec % 60)}`;
  }, 500);

  // ---------------- project lifecycle ----------------
  function resetFloor() {
    Object.assign(S, { status: "Intake", title: "", brief: {}, artifacts: [], tokens: 0, cost: 0, firstTs: null, lastTs: null, idleMs: 0, idleSince: null, gate: null, stageIdx: {}, appExists: false, appUrl: null, live: {}, modules: [], modLog: {}, usdStop: null, handover: null, release: null });
    renderModules();
    renderApp();
    for (const k in tweens) delete tweens[k];
    $("#messages").innerHTML = ""; $("#feed").innerHTML = ""; S.chatDay = null; S.openIssues = [];
    $("#tokens").textContent = "0"; $("#cost").textContent = "0.0000"; $("#elapsed").textContent = "00:00:00";
    viz.build(S.meta); renderSlots(); renderRibbon(); renderDocs(); renderGate(); setStatus("Intake");
  }

  async function openProject(id) {
    S.es?.close(); S.id = id;
    resetFloor();
    if (!id) { S.overrides = {}; $("#editTitle").hidden = true; $("#projId").textContent = t("No project yet"); $("#projTitle").textContent = t("Start a request to staff the floor"); renderModels(); return; }
    const p = await api.get(`/projects/${id}`);
    S.overrides = p.modelOverrides || {}; $("#autoApprove").checked = !!p.autoApprove;
    S.appExists = !!p.appExists; S.appUrl = p.appUrl || null; S.handover = p.handover || null; S.openIssues = p.openIssues || []; S.release = p.release || null;
    $("#editTitle").hidden = DEMO;
    $("#projId").textContent = p.id; $("#projTitle").textContent = p.title;
    renderModels(); refreshModelLabels();
    S.replaying = true; viz.quiet = true;
    const es = new EventSource(`/api/projects/${id}/events`); S.es = es;
    es.onmessage = e => onEvent(JSON.parse(e.data));
    es.addEventListener("replayed", () => { S.replaying = false; viz.quiet = false; });
  }

  async function refreshProjects(selectId) {
    const list = await api.get("/projects");
    $("#projectPick").innerHTML = `<option value="">${t("Open a project\u2026")}</option>` + list.map(p => `<option value="${p.id}">${esc(p.id)} \u00b7 ${esc(p.title)} (${esc(t(p.status === "Completed" ? "Live" : p.status === "WaitingGate" ? "Waiting for you" : p.status === "WaitingCustomer" ? "Waiting for customer" : p.status))})</option>`).join("");
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
    const box = $("#chatInput"); const text = box.value.trim();
    const pending = S.pendingFiles || [];
    if ((!text && !pending.length) || !S.id || S.sending) return;
    S.sending = true; $("#sendBtn").disabled = true;
    box.value = "";
    try {
      let attachments = [];
      if (pending.length) {
        const fd = new FormData();
        for (const f of pending) fd.append("files", f.file, f.name);
        const r = await fetch(`/api/projects/${S.id}/attachments`, { method: "POST", body: fd });
        if (!r.ok) throw new Error(await errText(r));
        attachments = (await r.json()).map(x => x.file);
        clearPending();
      }
      if (S.status === "Intake") showTyping("intake");
      await api.send("POST", `/projects/${S.id}/chat`, { text, attachments });
    }
    catch (e) { hideTyping(); toast(e.message); box.value = text; }
    finally { S.sending = false; $("#sendBtn").disabled = false; }
  }

  // ---------------- attachments: paste, drop or pick files as references for the team ----------------
  const MAX_FILE = 20 * 1024 * 1024;
  function fileExt(n) { return (String(n).split(".").pop() || "file").slice(0, 4).toUpperCase(); }
  function fmtSize(b) { return b >= 1048576 ? (b / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(b / 1024)) + " KB"; }
  function addPending(list) {
    S.pendingFiles ||= [];
    for (const file of list) {
      if (file.size > MAX_FILE) { toast(t("{0} is larger than 20 MB.", file.name)); continue; }
      // a pasted screenshot has no useful name: give it one with the time
      const name = file.name && file.name !== "image.png" ? file.name
        : `screenshot-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.${(file.type.split("/")[1] || "png").replace("jpeg", "jpg")}`;
      S.pendingFiles.push({ file, name, url: file.type.startsWith("image/") ? URL.createObjectURL(file) : null });
    }
    renderPending();
  }
  function clearPending() { for (const f of S.pendingFiles || []) if (f.url) URL.revokeObjectURL(f.url); S.pendingFiles = []; renderPending(); }
  function renderPending() {
    const tray = $("#attachTray"), list = S.pendingFiles || [];
    tray.hidden = list.length === 0;
    tray.innerHTML = list.map((f, i) => `<div class="att-chip">${f.url ? `<img src="${f.url}" alt="">` : `<span class="att-ic">${esc(fileExt(f.name))}</span>`}
      <span class="att-name" title="${esc(f.name)}">${esc(f.name)}<small>${fmtSize(f.file.size)}</small></span>
      <button type="button" data-rm="${i}" title="${t("Remove")}" aria-label="${t("Remove")} ${esc(f.name)}">×</button></div>`).join("");
    tray.querySelectorAll("[data-rm]").forEach(b => b.onclick = () => {
      const [f] = S.pendingFiles.splice(+b.dataset.rm, 1); if (f?.url) URL.revokeObjectURL(f.url); renderPending();
    });
  }
  function initAttachments() {
    $("#attachBtn").onclick = () => $("#attachInput").click();
    $("#attachInput").onchange = e => { addPending([...e.target.files]); e.target.value = ""; };
    // paste a screenshot (or copied files) straight into the message box
    $("#chatInput").addEventListener("paste", e => {
      const files = [...(e.clipboardData?.files || [])];
      if (files.length) { e.preventDefault(); addPending(files); }
    });
    // drop files anywhere on the chat panel
    const panel = $("#composer").closest("section") || $("#composer");
    panel.addEventListener("dragover", e => { if ([...(e.dataTransfer?.types || [])].includes("Files")) { e.preventDefault(); panel.classList.add("drop-on"); } });
    panel.addEventListener("dragleave", e => { if (!panel.contains(e.relatedTarget)) panel.classList.remove("drop-on"); });
    panel.addEventListener("drop", e => {
      panel.classList.remove("drop-on");
      const files = [...(e.dataTransfer?.files || [])];
      if (files.length) { e.preventDefault(); addPending(files); }
    });
  }

  // ---------------- demo replay ----------------
  let replayTimer = null;
  function replay() {
    clearTimeout(replayTimer);
    resetFloor();
    $("#projId").textContent = window.VC_DEMO_PROJECT?.id || t("Recorded run");
    $("#projTitle").textContent = t("Customer request coming in\u2026");
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
    if (S.overrides[id]) return { model: S.overrides[id], source: t("project override") };
    if (S.overrides["*"]) return { model: S.overrides["*"], source: t("project override (all agents)") };
    return { model: a.resolvedModel, source: t(a.modelSource) };
  }

  function refreshModelLabels() {
    if (!S.meta) return;
    viz.applyMeta(S.meta);
    S.meta.agents.forEach(a => { const m = effectiveModel(a.id); viz.setModel(a.id, m.model, m.source); });
  }

  const modelOption = (m, sel) => `<option value="${m.id}" ${sel === m.id ? "selected" : ""}>${esc(t("{0} \u00b7 ${1} / ${2} per 1M tokens", m.label, m.inputPrice, m.outputPrice))}</option>`;

  function openAgentSettings(id, focusRules = false) {
    const a = agent(id); if (!a) return;
    const dept = S.meta.departments[a.department];
    $("#adAv").textContent = a.initials; $("#adAv").style.background = roleCol(a.id);
    $("#adDept").textContent = deptName(a.department);
    $("#adTitle").textContent = nm(a, "role");
    const now = effectiveModel(id);
    $("#adNow").innerHTML = `${chip(now.model)} <span class="src">${esc(now.source)}</span>`;
    const inherited = dept?.model ? t("Department default ({0})", modelInfo(dept.model)?.label) : t("Company default ({0})", modelInfo(S.meta.defaults?.model)?.label || "Sonnet");
    $("#adModel").innerHTML = `<option value="">${esc(inherited)}</option>` + S.meta.models.map(m => modelOption(m, a.model)).join("");
    $("#adOverride").innerHTML = `<option value="">${t("No override")}</option>` + S.meta.models.map(m => modelOption(m, S.overrides[id])).join("");
    $("#adEffort").value = a.effort || "";
    $("#adMaxOut").value = a.maxOutputTokens || "";
    $("#adMaxOut").disabled = DEMO;
    $("#adMaxAgents").value = a.maxInstances || 1;
    $("#adMaxAgents").disabled = DEMO || id === "intake";
    $("#adActive").checked = !a.disabled;
    $("#adActive").disabled = DEMO || id === "intake";
    $("#adActive").closest("label").title = id === "intake" ? t("Customer Intake starts every request, so it can't be switched off.") : "";
    $("#adOverride").disabled = DEMO || !S.id;
    ["adModel", "adEffort", "adSave"].forEach(k => $("#" + k).disabled = DEMO);
    $("#adMsg").textContent = DEMO ? t("Read-only in the replay. Run the app locally to change models.") : !S.id ? t("Open or start a project to set a project override.") : "";
    // rules & limits
    $("#adPersona").value = a.persona || "";
    $("#adMustDo").value = (a.mustDo || []).join("\n");
    $("#adMustNot").value = (a.mustNot || []).join("\n");
    $("#adAsk").checked = !!a.canAskCustomer;
    $("#adAsk").disabled = DEMO || id === "intake";
    $("#adAsk").closest("label").title = id === "intake" ? t("Customer Intake already talks to the customer directly.") : "";
    const tools = a.tools || [];
    $("#adTools").innerHTML = (S.meta.knownTools || []).map(x => `<label class="check"><input type="checkbox" value="${x}" ${tools.includes(x) ? "checked" : ""} ${DEMO ? "disabled" : ""}> ${x}</label>`).join("");
    $("#adToolsNote").textContent = !S.meta.codeMode ? t("Code mode is off, so no agent uses tools now.")
      : tools.length ? t("Works on real files in the app folder; Bash is limited to a safe command list.") : t("No tools: this role writes documents only.");
    ["adPersona", "adMustDo", "adMustNot"].forEach(k => $("#" + k).disabled = DEMO);
    $("#agentDlg").dataset.agent = id;
    $("#agentDlg").showModal();
    if (focusRules) $("#adRules").scrollIntoView({ block: "start" }), $("#adMustDo").focus();
  }

  async function saveAgentSettings(e) {
    e.preventDefault();
    const id = $("#agentDlg").dataset.agent, a = agent(id);
    try {
      const model = $("#adModel").value, effort = $("#adEffort").value, disabled = !$("#adActive").checked;
      const maxOutputTokens = Number($("#adMaxOut").value) || a.maxOutputTokens;
      const maxInstances = Math.min(10, Math.max(1, Number($("#adMaxAgents").value) || a.maxInstances || 1));
      const lines = s => s.split("\n").map(x => x.trim()).filter(Boolean);
      const persona = $("#adPersona").value.trim(), mustDo = lines($("#adMustDo").value), mustNot = lines($("#adMustNot").value);
      const canAskCustomer = $("#adAsk").checked;
      const tools = [...$("#adTools").querySelectorAll("input:checked")].map(x => x.value);
      const same = (x, y) => JSON.stringify(x || []) === JSON.stringify(y || []);
      const rulesChanged = (persona && persona !== (a.persona || "")) || !same(mustDo, a.mustDo) || !same(mustNot, a.mustNot)
        || canAskCustomer !== !!a.canAskCustomer || !same(tools, a.tools);
      if ((a.model || "") !== model || (a.effort || "") !== effort || !!a.disabled !== disabled || maxOutputTokens !== a.maxOutputTokens || maxInstances !== a.maxInstances || rulesChanged)
        S.meta = await api.send("PUT", `/registry/agents/${id}`, { model, effort, disabled, maxOutputTokens, maxInstances,
          persona: persona || null, mustDo, mustNot, canAskCustomer: id === "intake" ? null : canAskCustomer, tools });
      const ov = $("#adOverride").value || null;
      if (S.id && (S.overrides[id] || null) !== ov)
        S.overrides = await api.send("PUT", `/projects/${S.id}/overrides`, { ...S.overrides, [id]: ov });
      renderRegistry(); renderModels(); refreshModelLabels();
      $("#agentDlg").close();
      const now = effectiveModel(id);
      if (disabled) { toast(t("{0} is switched off. Stages with no active agent are skipped.", nm(a, "role"))); return; }
      toast(t("{0} saved: {1} ({2}), {3} rules. Applies from the next task it starts.", nm(a, "role"), modelInfo(now.model)?.label || now.model, now.source,
        (agent(id).mustDo?.length || 0) + (agent(id).mustNot?.length || 0)));
    } catch (err) { $("#adMsg").textContent = err.message; }
  }

  // ---------------- 2D / 3D floor switch (remembered per browser) ----------------
  function initFloorView() {
    const KEY = "vc.floorView";
    let mode = "2d";   // a saved "office" (the old Office 1, now removed) opens the room office instead
    try { const v = localStorage.getItem(KEY); mode = v === "office" ? "office2" : ["3d", "office2", "office3"].includes(v) ? v : "2d"; } catch { /* default */ }
    const set = m => {
      mode = m;
      try { localStorage.setItem(KEY, m); } catch { /* not persisted */ }
      document.querySelectorAll("[data-floorview]").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.floorview === m)));
      const is3d = m === "3d", isOffice = m === "office2" || m === "office3", any = is3d || isOffice;
      $(".viz-wrap").classList.toggle("is3d", is3d);
      $(".viz-wrap").classList.toggle("isoffice", isOffice);
      $("#floor3d").hidden = !is3d; $("#office3d2").hidden = m !== "office2"; $("#office3d3").hidden = m !== "office3";
      $("#reset3d").hidden = !any; $("#hint3d").hidden = !any; $("#officeHQ").hidden = !isOffice;
      $("#hint3d").textContent = isOffice ? t("Drag to move · scroll to zoom · click a person") : t("Drag to rotate · scroll to zoom · right-drag to pan · click an agent");
      if (!any) return;
      const [Cls, ev, slot, box, glob, opts] = is3d ? ["Floor3D", "floor3d-ready", "f3", "#floor3d", "vcFloor3D"]
        : m === "office2" ? ["OfficeView", "office-ready", "office2", "#office3d2", "vcOffice2", { layout: "rect", quality: officeQuality() }]   // one rectangle, CEO front right
        : ["OfficeView", "office-ready", "office3", "#office3d3", "vcOffice3", { layout: "cubicle", quality: officeQuality() }];   // open plan, cubicles
      const start = () => {
        if (S[slot] || !window[Cls]) return;
        try { S[slot] = new window[Cls]($(box), viz, opts); window[glob] = S[slot]; }
        catch (e) { toast(t("The 3D view could not start: {0}", e.message)); set("2d"); }
      };
      if (window[Cls]) start(); else window.addEventListener(ev, start, { once: true });
      setTimeout(() => S[slot]?.resize(), 50);
      setTimeout(() => { $("#hint3d").hidden = true; }, 6000);
    };
    document.querySelectorAll("[data-floorview]").forEach(b => b.onclick = () => set(b.dataset.floorview));
    // Office picture quality (remembered per browser): High = soft shading + smooth edges, Normal = lighter
    function officeQuality() { try { return localStorage.getItem("vc.officeQuality") === "normal" ? "normal" : "high"; } catch { return "high"; } }
    const showQ = () => { const q = officeQuality(); $("#officeHQ").setAttribute("aria-pressed", String(q === "high")); $("#officeHQ").textContent = q === "high" ? "HQ" : "SD"; };
    $("#officeHQ").onclick = () => {
      const q = officeQuality() === "high" ? "normal" : "high";
      try { localStorage.setItem("vc.officeQuality", q); } catch { /* not persisted */ }
      S.office2?.setQuality(q); S.office3?.setQuality(q); showQ();
    };
    showQ();
    $("#reset3d").onclick = () => ({ office2: S.office2, office3: S.office3 }[mode] || S.f3)?.resetView();
    set(mode);
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
      // A minimized panel is a narrow rail; the floor takes the room.
      floor.style.setProperty("--lw", (collapsed.left ? RAIL : w.left) + "px");
      floor.style.setProperty("--rw", (collapsed.right ? RAIL : w.right) + "px");
      floor.classList.toggle("lw-collapsed", collapsed.left);
      floor.classList.toggle("rw-collapsed", collapsed.right);
      document.querySelectorAll(".splitter").forEach(sp => sp.setAttribute("aria-valuenow", w[sp.dataset.side]));
    };
    // Minimize / restore the side panels (remembered per browser).
    const RAIL = 44, CKEY = "vc.panelCollapsed";
    const collapsed = { left: false, right: false };
    try { Object.assign(collapsed, JSON.parse(localStorage.getItem(CKEY) || "{}")); } catch { /* defaults */ }
    const toggle = side => {
      collapsed[side] = !collapsed[side];
      try { localStorage.setItem(CKEY, JSON.stringify(collapsed)); } catch { /* not persisted */ }
      apply(side);
      requestAnimationFrame(() => (collapsed[side] ? document.querySelector(`.rail[data-rail="${side}"]`) : document.querySelector(`[data-collapse="${side}"]`))?.focus());
    };
    document.querySelectorAll("[data-collapse]").forEach(b => b.onclick = () => toggle(b.dataset.collapse));
    // Something needs the owner: open the minimized panel where it is (gate: right; question: chat on the left).
    S.expandPanel = side => { if (collapsed[side]) toggle(side); };
    document.querySelectorAll(".rail").forEach(b => b.onclick = () => toggle(b.dataset.rail));
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
      ["activity", "docs", "mods", "models"].forEach(k => $("#pane-" + k).hidden = k !== b.dataset.sub);
    });
    document.addEventListener("click", async e => {
      const doc = e.target.closest("[data-doc]");
      if (doc) {
        const name = doc.dataset.doc;
        $("#viewerTitle").textContent = doc.dataset.title; $("#viewerBody").innerHTML = `<p>${t("Loading\u2026")}</p>`; $("#viewer").showModal();
        try {
          const text = DEMO ? (window.VC_DEMO_ARTIFACTS?.[name] ?? t("Not included in the replay.")) : await (await fetch(`/api/projects/${S.id}/artifacts/${encodeURIComponent(name)}`)).text();
          $("#viewerBody").innerHTML = md(text);
        } catch (err) { $("#viewerBody").textContent = t("Could not load the document: {0}", err.message); }
      }
      if (e.target.closest("#modCopy")) {
        try { await navigator.clipboard.writeText(modulesAsText()); toast(t("Module log copied.")); }
        catch { toast(t("Could not copy; select the text instead.")); }
        return;
      }
      if (e.target.closest("#releaseBtn")) {
        const b = e.target.closest("#releaseBtn"); b.disabled = true; b.textContent = t("Building\u2026");
        toast(t("Building the release package; this takes about a minute."));
        try { S.release = await api.send("POST", `/projects/${S.id}/release`); toast(t("The release package is ready.")); }
        catch (err) { toast(err.message.split("\n")[0]); }
        renderDocs();
        return;
      }
      if (e.target.closest("#handoverBtn")) {
        try { await api.send("POST", `/projects/${S.id}/handover`); toast(t("The Technical Writer is writing the handover document.")); }
        catch (err) { toast(err.message); }
        return;
      }
      if (e.target.closest("#modStat")) { document.querySelector('.subtabs button[data-sub="mods"]').click(); return; }
      const rb = e.target.closest("[data-rules]");
      if (rb) { openAgentSettings(rb.dataset.rules, true); return; }
      const g = e.target.closest("[data-gate]");
      if (g) {
        const note = $("#gateNote")?.value.trim();
        if (g.dataset.gate === "revise" && !note) { toast(t("Write what should change, then press Request changes.")); $("#gateNote").focus(); return; }
        try { await api.send("POST", `/projects/${S.id}/gate`, { decision: g.dataset.gate, note }); } catch (err) { toast(err.message); }
      }
    });
    $("#viewerClose").onclick = () => $("#viewer").close();

    // Rename the project in place: Enter saves, Esc cancels.
    $("#editTitle").onclick = () => {
      if (!S.id || DEMO) return;
      const h = $("#projTitle"), old = h.textContent;
      const input = document.createElement("input");
      input.className = "field title-input"; input.value = old; input.maxLength = 120; input.setAttribute("aria-label", t("Project title"));
      h.replaceWith(input); input.focus(); input.select();
      let done = false;
      const finish = async save => {
        if (done) return; done = true;
        const title = input.value.trim();
        input.replaceWith(h);
        if (!save || !title || title === old) return;
        h.textContent = title;
        try { await api.send("PUT", `/projects/${S.id}/title`, { title }); refreshProjects(S.id); toast(t("Project title saved.")); }
        catch (err) { h.textContent = old; toast(err.message); }
      };
      input.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); finish(true); } if (e.key === "Escape") finish(false); });
      input.addEventListener("blur", () => finish(true));
    };
    viz.onAgentClick = openAgentSettings;
    $("#adClose").onclick = () => $("#agentDlg").close();
    $("#adForm").onsubmit = saveAgentSettings;
    $("#adOpenReg").onclick = () => { $("#agentDlg").close(); document.querySelector('.tabs button[data-view="registry"]').click(); };
    $("#composer").onsubmit = e => { e.preventDefault(); send(); };
    initAttachments();
    $("#chatInput").addEventListener("keydown", e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } });
    // The message box grows with the text, like WhatsApp, up to about six lines.
    $("#chatInput").addEventListener("input", e => { const b = e.target; b.style.height = "auto"; b.style.height = Math.min(b.scrollHeight, 132) + "px"; });

    $("#langPick").value = I18N.lang;
    $("#langPick").onchange = async e => {
      const lang = e.target.value;
      try { if (!DEMO) await api.send("PUT", "/settings", { language: lang }); I18N.set(lang); location.reload(); }
      catch (err) { toast(err.message); e.target.value = I18N.lang; }
    };

    if (DEMO) { $("#replayBtn").onclick = replay; return; }

    $("#resumeBtn").onclick = async () => {
      try { await api.send("POST", `/projects/${S.id}/resume`); } catch (e) { toast(e.message); }
    };
    $("#startAppBtn").onclick = async () => {
      const b = $("#startAppBtn"); b.disabled = true; b.textContent = t("Starting\u2026");
      try { const r = await api.send("POST", `/projects/${S.id}/app/start`); S.appUrl = r.url; renderApp(); toast(t("The app is running at {0}", r.url)); }
      catch (e) { toast(t("The app could not start: {0}", e.message.split("\n")[0])); }
      finally { b.disabled = false; b.textContent = t("Start app"); }
    };
    $("#stopAppBtn").onclick = async () => {
      try { await api.send("POST", `/projects/${S.id}/app/stop`); S.appUrl = null; renderApp(); } catch (e) { toast(e.message); }
    };
    $("#pauseBtn").onclick = async () => {
      try { await api.send("POST", `/projects/${S.id}/pause`); } catch (e) { toast(e.message); }
    };
    $("#unpauseBtn").onclick = async () => {
      try { await api.send("POST", `/projects/${S.id}/unpause`); } catch (e) { toast(e.message); }
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
      try { S.overrides = await api.send("PUT", `/projects/${S.id}/overrides`, S.overrides); refreshModelLabels(); toast(t("Project models updated. They apply to the next agent that starts.")); }
      catch (err) { toast(err.message); }
    });

    $("#regBody").addEventListener("change", async e => {
      const box = e.target, id = box.dataset.agent, f = box.dataset.field; if (!id) return;
      try {
        if (f === "override") { const o = { ...S.meta.overrides, [id]: box.value || null }; S.meta = await api.send("PUT", "/registry/overrides", o); }
        else S.meta = await api.send("PUT", `/registry/agents/${id}`, f === "maxInstances" ? { maxInstances: Number(box.value) } : f === "active" ? { disabled: !box.checked } : { [f]: box.value });
        renderRegistry(); renderModels(); refreshModelLabels(); toast(t("Saved to agents.json"));
      } catch (err) { toast(err.message); }
    });
    $("#budgetForm").onsubmit = async e => {
      e.preventDefault();
      try {
        S.meta = await api.send("PUT", "/settings", { maxUsdPerProject: Number($("#bUsd").value) || 0, maxTokensPerProject: Number($("#bTok").value) || 0 });
        $("#budgetMsg").textContent = t("Saved. Running projects use it from their next agent.");
      } catch (err) { $("#budgetMsg").textContent = err.message; }
    };
    $("#globalAll").onchange = async e => {
      S.meta = await api.send("PUT", "/registry/overrides", { ...S.meta.overrides, "*": e.target.value || null });
      renderRegistry(); renderModels(); refreshModelLabels(); toast(e.target.value ? t("Every agent now uses {0}", modelInfo(e.target.value).label) : t("Global override removed"));
    };
    $("#nRole").addEventListener("input", e => { $("#nId").placeholder = e.target.value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_") || "technical_writer"; });
    $("#addForm").onsubmit = async e => {
      e.preventDefault();
      const body = { id: $("#nId").value.trim() || $("#nId").placeholder, role: $("#nRole").value.trim(), department: $("#nDept").value, model: $("#nModel").value || null,
        stageId: $("#nStage").value, newStageTitle: $("#nNewStage").value.trim() || null, spawnable: $("#nSpawn").checked, maxInstances: Number($("#nMax").value) || 1, persona: $("#nPersona").value.trim() || null };
      try {
        S.meta = await api.send("POST", "/registry/agents", body);
        $("#addMsg").textContent = t("{0} added. It takes part in the next project you start.", body.role);
        e.target.reset(); renderRegistry(); renderModels();
        if (!S.id) viz.build(S.meta);
      } catch (err) { $("#addMsg").textContent = err.message; }
    };
  }

  // ---------------- boot ----------------
  async function boot() {
    S.meta = DEMO ? window.VC_DEMO_META : await api.get("/meta");
    I18N.set(S.meta.defaults?.language || "en");
    shell();
    viz = new FloorViz($("#floor"));
    // The 3D floor mirrors the 2D one; hand-offs and the go-live burst are forwarded to it.
    const send2d = viz._send.bind(viz), celebrate2d = viz.celebrate.bind(viz);
    viz._send = (a, b, kind, dur) => { send2d(a, b, kind, dur); if (!viz.quiet) { S.f3?.pulse(a, b, kind); S.office2?.pulse(a, b, kind); S.office3?.pulse(a, b, kind); } };
    viz.celebrate = () => { celebrate2d(); S.f3?.celebrate(); S.office2?.celebrate(); S.office3?.celebrate(); };
    $("#company").textContent = S.meta.company;
    const mode = $("#mode");
    if (DEMO) { mode.className = "pill sim"; mode.textContent = t("RECORDED RUN"); }
    else if (S.meta.live) {
      mode.className = "pill live"; mode.textContent = t(S.meta.engine === "agent-sdk" ? "LIVE \u00b7 AGENT SDK" : "LIVE \u00b7 CLAUDE API");
      mode.title = t(S.meta.auth === "claude-login" ? "Signed in with this computer's Claude Code login (no API key). Usage counts against that plan; costs shown are API-price estimates."
        : "Using ANTHROPIC_API_KEY.");
    }
    else { mode.className = "pill sim"; mode.textContent = t("SIMULATION"); mode.title = t("Set ANTHROPIC_API_KEY, or sign in to Claude Code on this computer, and restart to use real Claude models."); }
    wire();
    initFloorView();
    resetFloor(); renderModels();
    if (DEMO) { replay(); return; }
    await refreshProjects();
    const first = (await api.get("/projects"))[0];
    if (first) { $("#projectPick").value = first.id; await openProject(first.id); } else updateComposer();
  }

  boot().catch(e => { document.getElementById("app").innerHTML = `<p style="padding:24px">${esc(I18N.t("The app could not start: {0}. Is the server running?", e.message))}</p>`; });
})();
