// Operations floor drawn as an org chart: the owner (you, who approves the gates) on top, three
// divisions below the bus line, departments inside each division, agents as cards.
// Hand-offs travel along the org lines.
(function () {
  const NS = "http://www.w3.org/2000/svg";
  const DIVISIONS = [
    { id: "business", name: "Business", depts: ["business", "marketing", "finance"] },
    { id: "tech", name: "Product & Technology", depts: ["product", "design", "engineering", "infra"] },
    { id: "ops", name: "Operations & Data", depts: ["support", "data"] },
  ];
  const GATE_SHORT = { proposal: "Proposal", requirements: "Requirements", production: "Production" };
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

  // geometry
  const PAD = 12, DIV_W = 290, DIV_GAP = 18, CARD_H = 46, CARD_GAP = 8;
  const OWNER_Y = 12, OWNER_H = 44, BUS_Y = 78, DIV_Y = 90, DIV_H = 26;
  const CARD_W = (DIV_W - 24 - CARD_GAP) / 2;

  function el(tag, attrs, parent) {
    const e = document.createElementNS(NS, tag);
    for (const k in attrs || {}) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }

  function wrap(text, max) {
    const lines = [""];
    for (const w of text.split(" ")) {
      const cur = lines[lines.length - 1];
      if (cur && (cur + " " + w).length > max) lines.push(w); else lines[lines.length - 1] = cur ? cur + " " + w : w;
    }
    if (lines.length > 2) lines[1] = lines.slice(1).join(" ").slice(0, max - 1) + "\u2026";
    return lines.slice(0, 2);
  }

  const modelOf = (meta, id) => (meta.models || []).find(x => x.id === id);

  class FloorViz {
    constructor(svg) {
      this.svg = svg;
      this.nodes = {};
      this.packets = [];
      this._tick = this._tick.bind(this);
    }

    // Fresh floor for a project: one card per role, with the entrance animation.
    build(meta) {
      this.extra = {}; this._models = {};
      this._layout(meta);
      this.svg.classList.add("intro");
      clearTimeout(this._introTimer);
      this._introTimer = setTimeout(() => this.svg.classList.remove("intro"), 1600);
    }

    // Every node for a role: the lead card plus one card per extra instance.
    nodesOf(id) { return Object.values(this.nodes).filter(n => n.base === id); }

    _layout(meta) {
      this.meta = meta;
      const svg = this.svg;
      svg.innerHTML = "";
      this.nodes = {}; this.heads = {}; this.gateChips = {}; this.packets = [];
      const agents = Object.fromEntries(meta.agents.map(a => [a.id, a]));
      this.stages = meta.pipeline;
      this._stageMap(meta);

      // members per department, in pipeline order
      const members = {};
      // Running more than one instance of a role gives each instance its own card: "id", "id#2", "id#3"...
      meta.pipeline.forEach(s => s.agents.forEach(a => {
        const d = agents[a]?.department; if (!d) return;
        (members[d] ||= []).push(a);
        for (let k = 2; k <= (this.extra[a] || 1); k++) members[d].push(`${a}#${k}`);
      }));
      const divisions = DIVISIONS.map(v => ({ ...v, depts: v.depts.filter(d => members[d]) }));
      const known = new Set(DIVISIONS.flatMap(v => v.depts));
      Object.keys(members).filter(d => !known.has(d)).forEach(d => divisions[1].depts.push(d));   // new departments join Product & Technology

      // layout pass: department header centre y per division
      const layout = divisions.map(v => {
        let y = DIV_Y + DIV_H + 22;
        const depts = v.depts.map(d => {
          const rows = Math.ceil(members[d].length / 2);
          const block = { d, hy: y, rows };
          y += 15 + rows * (CARD_H + CARD_GAP) + 22;
          return block;
        });
        return { ...v, depts, bottom: y - 22 };
      });
      const W = PAD * 2 + divisions.length * DIV_W + (divisions.length - 1) * DIV_GAP;
      const H = Math.max(...layout.map(v => v.bottom)) + 6;
      svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
      svg.style.minWidth = Math.round(W * 0.68) + "px";
      this.ownerX = W / 2;

      const defs = el("defs", {}, svg);
      const glow = el("filter", { id: "pglow", x: "-200%", y: "-200%", width: "500%", height: "500%" }, defs);
      el("feGaussianBlur", { stdDeviation: "3" }, glow);
      const lines = el("g", {}, svg);
      this.traceLayer = el("g", {}, svg);
      const top = el("g", {}, svg);

      const trunks = layout.map((_, i) => PAD + i * (DIV_W + DIV_GAP) + 10);
      el("path", { d: `M${this.ownerX},${OWNER_Y + OWNER_H} V${BUS_Y}`, class: "org-line" }, lines);
      el("path", { d: `M${trunks[0]},${BUS_Y} H${trunks[trunks.length - 1]}`, class: "org-line" }, lines);

      let idx = 0;
      layout.forEach((v, vi) => {
        const x0 = PAD + vi * (DIV_W + DIV_GAP), tx = trunks[vi];
        const lastHy = v.depts.length ? v.depts[v.depts.length - 1].hy : DIV_Y + DIV_H;
        el("path", { d: `M${tx},${BUS_Y} V${lastHy}`, class: "org-line" }, lines);

        // division header
        const dg = el("g", { class: "div-head" }, top);
        el("rect", { x: x0, y: DIV_Y, width: DIV_W, height: DIV_H, rx: 7, class: "div-box" }, dg);
        el("text", { x: x0 + 22, y: DIV_Y + DIV_H / 2, class: "div-name" }, dg).textContent = v.name;
        const count = v.depts.reduce((n, b) => n + members[b.d].length, 0);
        el("text", { x: x0 + DIV_W - 10, y: DIV_Y + DIV_H / 2, class: "div-count" }, dg).textContent = `${v.depts.length} depts \u00b7 ${count} agents`;

        v.depts.forEach((b, bi) => {
          const d = b.d, hx = x0 + 24;
          el("path", { d: `M${tx},${b.hy} H${hx}`, class: "org-line" }, lines);
          const hg = el("g", { class: "dept-head", style: `--dc: var(--d-${d})` }, top);
          el("rect", { x: hx, y: b.hy - 10, width: DIV_W - 24, height: 20, rx: 6, class: "dept-box" }, hg);
          el("circle", { cx: hx + 10, cy: b.hy, r: 3.5, class: "dept-dot" }, hg);
          el("text", { x: hx + 19, y: b.hy, class: "dept-name" }, hg).textContent = meta.departments[d]?.name || d;
          this.heads[d] = hg;

          members[d].forEach((key, k) => {
            const a = key.split("#")[0], inst = Number(key.split("#")[1] || 1);
            const def = agents[a];
            const many = (this.extra[a] || 1) > 1;
            const x = hx + (k % 2) * (CARD_W + CARD_GAP), y = b.hy + 15 + Math.floor(k / 2) * (CARD_H + CARD_GAP);
            const g = el("g", { class: "node", style: `--dc: var(--d-${d}); --i: ${idx++}; --c: ${vi * 3 + bi}` }, top);
            el("rect", { x, y, width: CARD_W, height: CARD_H, rx: 8, class: "card" }, g);
            const ax = x + 18, ay = y + CARD_H / 2;
            el("circle", { cx: ax, cy: ay, r: 16, class: "ring" }, g);
            el("circle", { cx: ax, cy: ay, r: 12, class: "core" }, g);
            el("text", { x: ax, y: ay, class: "ini" }, g).textContent = def.initials || a.slice(0, 2).toUpperCase();
            const lines2 = wrap(many ? `${def.role} #${inst}` : def.role, 14);
            const t = el("text", { x: x + 36, y: y + (lines2.length > 1 ? 14 : 19), class: "role" }, g);
            lines2.forEach((ln, i) => { el("tspan", { x: x + 36, dy: i ? "1.15em" : 0 }, t).textContent = ln; });
            const mt = el("text", { x: x + 36, y: y + CARD_H - 7, class: "model" }, g);
            const tg = el("g", { class: "tick-g" }, g);
            el("circle", { cx: ax + 10, cy: ay - 10, r: 6, class: "tick-bg" }, tg);
            el("path", { d: `M${ax + 7.3},${ay - 10} l2,2 l3.6,-4`, class: "tick" }, tg);
            const bg = el("g", { class: "badge-g" }, g);
            el("rect", { x: x + CARD_W - 22, y: y - 7, width: 26, height: 14, rx: 7, class: "badge-bg" }, bg);
            const bt = el("text", { x: x + CARD_W - 9, y, class: "badge" }, bg);
            const sats = el("g", {}, g);
            el("title", {}, g).textContent = def.role;
            g.setAttribute("tabindex", "0"); g.setAttribute("role", "button");
            g.setAttribute("aria-label", `${def.role}${def.disabled ? " (off)" : ""}: settings`);
            g.addEventListener("click", () => this.onAgentClick?.(a));
            g.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); this.onAgentClick?.(a); } });
            this.nodes[key] = { g, x, y, cx: x + CARD_W / 2, ax, ay, hy: b.hy, trunk: tx, div: v.id, dept: d, sats, satEls: [], badge: bt, modelText: mt, def, base: a, inst };
            this.nodes[key].off = !!def.disabled;
            if (def.disabled) g.classList.add("off");
            this._model(this.nodes[key], def.resolvedModel, def.modelSource);
          });
        });
      });

      // owner (you) + gate chips
      const og = el("g", { class: "owner" }, top);
      const ow = 200, ox = this.ownerX - ow / 2;
      el("rect", { x: ox - 3, y: OWNER_Y - 3, width: ow + 6, height: OWNER_H + 6, rx: 11, class: "owner-ripple" }, og);
      el("rect", { x: ox, y: OWNER_Y, width: ow, height: OWNER_H, rx: 9, class: "owner-card" }, og);
      el("circle", { cx: ox + 22, cy: OWNER_Y + OWNER_H / 2, r: 13, class: "owner-av" }, og);
      el("text", { x: ox + 22, y: OWNER_Y + OWNER_H / 2, class: "owner-ini" }, og).textContent = "YOU";
      el("text", { x: ox + 42, y: OWNER_Y + 18, class: "owner-title" }, og).textContent = "Owner";
      this.ownerSub = el("text", { x: ox + 42, y: OWNER_Y + 33, class: "owner-sub" }, og);
      this.ownerSub.textContent = "Approves the gates";
      this.owner = og;

      meta.pipeline.filter(s => s.gate).forEach((s, k) => {
        const gx = ox + ow + 22 + k * 96, gy = OWNER_Y + OWNER_H / 2;
        const grp = el("g", { class: "gate-g" }, top);
        const rot = el("g", { transform: `rotate(45 ${gx} ${gy})` }, grp);
        el("rect", { x: gx - 6, y: gy - 6, width: 12, height: 12, class: "ripple" }, rot);
        el("rect", { x: gx - 7, y: gy - 7, width: 14, height: 14, rx: 2, class: "gate" }, rot);
        el("text", { x: gx + 13, y: gy, class: "gate-label" }, grp).textContent = GATE_SHORT[s.gate.id] || s.title;
        el("title", {}, grp).textContent = s.gate.label;
        this.gateChips[s.id] = grp;
      });

      this.packetLayer = el("g", {}, svg);
      if (!this._raf) this._raf = requestAnimationFrame(this._tick);
    }

    // ---------- state ----------

    _stageMap(meta) {
      const agents = Object.fromEntries(meta.agents.map(a => [a.id, a]));
      this.stageAgents = Object.fromEntries(meta.pipeline.map(s => [s.id, s.agents.filter(a => agents[a] && !agents[a].disabled)]));
    }

    // Registry changed (model or on/off) without rebuilding the floor.
    applyMeta(meta) {
      this.meta = meta;
      this._stageMap(meta);
      meta.agents.forEach(a => this.nodesOf(a.id).forEach(n => {
        n.off = !!a.disabled;
        n.g.classList.toggle("off", n.off);
        n.g.setAttribute("aria-label", `${a.role}${n.off ? " (off)" : ""}: settings`);
      }));
    }

    setModel(agentId, model, source) {
      (this._models ||= {})[agentId] = { model, source };
      this.nodesOf(agentId).forEach(n => this._model(n, model, source));
    }

    _model(n, model, source) {
      const remembered = this._models?.[n.base];
      if (remembered) ({ model, source } = remembered);
      if (!n || !model) return;
      const m = modelOf(this.meta, model);
      n.modelText.textContent = n.off ? "Off" : (m ? m.label : model.replace("claude-", "")) + (source && source.includes("override") ? " \u2605" : "");
      n.modelText.setAttribute("fill", `var(--t-${m ? m.tier : "sonnet"})`);
      n.g.querySelector("title").textContent = `${n.def.role}\n${model} (${source || "default"})`;
    }

    reset() {
      for (const id in this.nodes) { const n = this.nodes[id]; n.g.setAttribute("class", "node" + (n.off ? " off" : "")); n.sats.innerHTML = ""; n.satEls = []; }
      for (const id in this.gateChips) this.gateChips[id].setAttribute("class", "gate-g");
      this.owner?.setAttribute("class", "owner");
      this.packets.forEach(p => p.g.remove()); this.packets = [];
    }

    _busy() {
      for (const d in this.heads) {
        const busy = Object.values(this.nodes).some(n => n.dept === d && n.g.classList.contains("working"));
        this.heads[d].classList.toggle("busy", busy);
      }
    }

    setAgent(agentId, instance, status) {
      const n = (instance > 1 && this.nodes[`${agentId}#${instance}`]) || this.nodes[agentId];
      if (!n) return;
      n.g.setAttribute("class", "node " + status + (n.off ? " off" : ""));
      this._busy();
    }

    // More instances of a role are working: give each its own card. The floor is redrawn and every card,
    // gate and the owner box keep their current state.
    spawn(agentId, count) {
      if (!this.meta || count <= (this.extra[agentId] || 1)) return;
      const keep = {};
      for (const k in this.nodes) keep[k] = this.nodes[k].g.getAttribute("class");
      const chips = {};
      for (const k in this.gateChips) chips[k] = this.gateChips[k].getAttribute("class");
      const owner = this.owner?.getAttribute("class"), ownerSub = this.ownerSub?.textContent;
      this.packets.forEach(p => p.g.remove()); this.packets = [];
      this.extra[agentId] = count;
      this._layout(this.meta);
      for (const k in this.nodes) {
        if (keep[k]) this.nodes[k].g.setAttribute("class", keep[k]);
        else if (!this.quiet && !reduced) this.nodes[k].g.classList.add("spawned");   // only the new cards animate in
      }
      for (const k in chips) this.gateChips[k]?.setAttribute("class", chips[k]);
      if (owner) this.owner.setAttribute("class", owner);
      if (ownerSub) this.ownerSub.textContent = ownerSub;
      this._busy();
    }

    stage(stageId, status) {
      if (status !== "running") return;
      (this.stageAgents[stageId] || []).forEach(id => this.nodesOf(id).forEach(n => {
        if (!n.g.classList.contains("working")) n.g.setAttribute("class", "node" + (n.off ? " off" : ""));
      }));
    }

    gate(stageId, status) {
      const chip = this.gateChips[stageId];
      const cls = status === "waiting" ? "waiting" : status === "approved" ? "approved" : status === "rejected" ? "rejected" : "";
      if (chip) chip.setAttribute("class", "gate-g " + cls);
      this.owner.setAttribute("class", "owner " + (status === "waiting" ? "waiting" : status === "approved" ? "approved" : ""));
      if (status === "waiting") {
        const label = this.stages.find(s => s.id === stageId)?.gate?.label;
        this.ownerSub.textContent = label ? label.replace(/^Approve /, "Approve ").slice(0, 26) : "Your decision";
        (this.stageAgents[stageId] || []).flatMap(a => this.nodesOf(a)).forEach((n, i) => setTimeout(() => this._send(n, "owner", ""), i * 80));
      } else {
        this.ownerSub.textContent = "Approves the gates";
        if (status === "approved") setTimeout(() => this.owner.classList.remove("approved"), 1400);
      }
    }

    handoff(fromStage, toStage) {
      const viaOwner = !!this.stages.find(s => s.id === fromStage)?.gate;
      const to = (this.stageAgents[toStage] || []).flatMap(a => this.nodesOf(a));
      if (viaOwner) { to.forEach((b, i) => setTimeout(() => this._send("owner", b, ""), i * 80)); return; }
      const from = (this.stageAgents[fromStage] || []).flatMap(a => this.nodesOf(a));
      let k = 0;
      from.forEach(a => to.forEach(b => setTimeout(() => this._send(a, b, ""), (k++) * 70)));
    }

    loop(fromStage) {
      const st = this.stages.find(s => s.id === fromStage);
      const from = (this.stageAgents[fromStage] || []).flatMap(a => this.nodesOf(a));
      const to = (this.stageAgents[st?.loop?.backTo] || []).flatMap(a => this.nodesOf(a));
      from.forEach(a => to.forEach((b, i) => setTimeout(() => this._send(a, b, "loop", 1300), i * 120)));
    }

    feedback() {
      const a = this.nodes["data_analyst"], b = this.nodes["project_manager"];
      if (a && b) [0, 450, 900].forEach(d => setTimeout(() => this._send(a, b, "feedback", 2000), d));
    }

    celebrate() {
      for (const id in this.nodes) { const g = this.nodes[id].g; g.classList.remove("wave"); void g.getBBox(); g.classList.add("wave"); }
    }

    // ---------- routing along the org lines ----------

    _route(a, b) {
      // card top -> its department header row -> division trunk -> bus -> ... and back down
      const out = n => n === "owner"
        ? [[this.ownerX, OWNER_Y + OWNER_H], [this.ownerX, BUS_Y]]
        : [[n.cx, n.y], [n.cx, n.hy], [n.trunk, n.hy]];
      if (a !== "owner" && b !== "owner") {
        if (a.dept === b.dept) return [[a.cx, a.y], [a.cx, a.hy], [b.cx, b.hy], [b.cx, b.y]];
        if (a.div === b.div) return out(a).concat(out(b).reverse());
      }
      const up = n => n === "owner" ? out(n) : out(n).concat([[n.trunk, BUS_Y]]);
      return up(a).concat(up(b).reverse());
    }

    _send(a, b, kind, dur) {
      if (!a || !b) return;
      const d = "M" + this._route(a, b).map(p => p.join(",")).join(" L");
      const trace = el("path", { d, class: "trace " + kind }, this.traceLayer);
      setTimeout(() => trace.remove(), 1800);
      if (reduced || this.quiet) { trace.remove(); return; }
      this.fly(trace, kind, dur || 1100);
    }

    fly(path, kind, dur) {
      const g = el("g", {}, this.packetLayer);
      const trail = [];
      for (let i = 0; i < 6; i++) trail.push(el("circle", { r: 3.6 - i * 0.45, class: "packet " + kind, opacity: 1 - i * 0.15 }, g));
      const glowC = el("circle", { r: 9, class: "packet-glow " + kind, filter: "url(#pglow)" }, g);
      this.packets.push({ g, path, len: path.getTotalLength(), t0: performance.now(), dur, trail, glowC });
    }

    _tick(now) {
      this.packets = this.packets.filter(p => {
        const t = (now - p.t0) / p.dur;
        if (t >= 1.15) { p.g.remove(); return false; }
        p.trail.forEach((c, i) => {
          const tt = Math.max(0, Math.min(1, t - i * 0.025));
          const e = tt < .5 ? 2 * tt * tt : 1 - Math.pow(-2 * tt + 2, 2) / 2;
          const pt = p.path.getPointAtLength(e * p.len);
          c.setAttribute("cx", pt.x); c.setAttribute("cy", pt.y);
          if (i === 0) { p.glowC.setAttribute("cx", pt.x); p.glowC.setAttribute("cy", pt.y); }
        });
        if (t > 1) p.g.setAttribute("opacity", Math.max(0, 1 - (t - 1) / .15));
        return true;
      });
      this._raf = requestAnimationFrame(this._tick);
    }
  }

  window.FloorViz = FloorViz;
})();
