// 3D operations floor: a dark stage with the owner's core in the middle and the three divisions on glass platforms
// around it. Agents are semi-transparent crystals with neon edges in their department colour; agents at work rise,
// glow and get a beam of light from the owner, so the eye goes to them. Rotate, zoom and pan with the mouse.
//
// It mirrors the 2D floor (viz.js): the 2D view stays the single source of truth for every card's state, and this
// view reads it each frame, so switching between 2D and 3D never loses anything.
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";

const DIVS = [
  { id: "business", angle: -52 },
  { id: "tech", angle: 0 },
  { id: "ops", angle: 52 },
];
const ROOM_R = 9.5;         // CEO -> inner edge of the rooms (grows when many rooms need more room)
const COL = 3.7, ROW = 3.1; // agent spacing on a platform
const COLS = { business: 2, tech: 3, ops: 2 };
const WHITE = new THREE.Color("#ffffff");
const LIFT = 4.6;            // how high a working agent rises above the others
const TEXT_K = 0.0175;       // world units per label pixel: the same for every label, so all text is one size
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
const t = (k, ...a) => (window.I18N ? I18N.t(k, ...a) : k);
const nm = (o, f) => (window.I18N ? I18N.name(o, f) : (o && o[f]) || "");

// The department colours are tuned for a light page; on the night-blue stage they get a neon version:
// same hue, high saturation, bright, so each department is easy to tell apart.
function neon(c) {
  const hsl = {}; c.getHSL(hsl);
  return c.setHSL(hsl.h, Math.min(1, Math.max(0.8, hsl.s * 1.25)), Math.min(0.66, Math.max(0.58, hsl.l * 1.35)));
}

function cssColor(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  try { return new THREE.Color(v || fallback); } catch { return new THREE.Color(fallback); }
}

// Text on a canvas, as a sprite that always faces the camera.
function textSprite(lines, { size = 40, color = "#e8f1ff", bg = "rgba(6,14,28,0.55)", border = null, width = 460 } = {}) {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  const pad = 18, lh = size * 1.18;
  canvas.width = width; canvas.height = Math.ceil(pad * 2 + lh * lines.length);
  const draw = (ls, c = color, b = border) => {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (bg) {
      ctx.fillStyle = bg; const r = 22;
      ctx.beginPath(); ctx.roundRect(2, 2, canvas.width - 4, canvas.height - 4, r); ctx.fill();
      if (b) { ctx.strokeStyle = b; ctx.lineWidth = 3; ctx.stroke(); }
    }
    ls.forEach((l, i) => {
      ctx.font = `${i === 0 ? 700 : 500} ${size}px "Segoe UI", system-ui, sans-serif`;
      ctx.fillStyle = i === 0 ? c : "rgba(200,220,245,0.85)";
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText(l, canvas.width / 2, pad + lh * (i + 0.5), canvas.width - pad * 2);
    });
  };
  draw(lines);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false });
  const sprite = new THREE.Sprite(mat);
  const aspect = canvas.width / canvas.height;
  sprite.userData = { draw, tex, lines, aspect };
  sprite.scale.set(canvas.width * TEXT_K, canvas.height * TEXT_K, 1);   // same pixel size -> same text size
  sprite.renderOrder = 10;
  return sprite;
}

function setSpriteText(sprite, lines, color, border) {
  const key = lines.join("\n") + color + border;
  if (sprite.userData.key === key) return;
  sprite.userData.key = key;
  sprite.userData.draw(lines, color, border);
  sprite.userData.tex.needsUpdate = true;
}

// Grid cells for a department's cards: cards of one role (Backend #1, #2...) are kept next to each other.
// A role's group starts a new row when it would not fit in what is left of the current row.
function gridCells(list, cols) {
  const groups = [];
  for (const [, n] of list) {
    const g = groups.at(-1);
    if (g && g.base === n.base) g.size++; else groups.push({ base: n.base, size: 1 });
  }
  const cells = []; let r = 0, c = 0;
  for (const g of groups) {
    if (c > 0 && c + g.size > cols && g.size <= cols) { r++; c = 0; }
    for (let k = 0; k < g.size; k++) { cells.push({ r, c }); c++; if (c >= cols) { c = 0; r++; } }
  }
  return cells;
}

export class Floor3D {
  constructor(container, viz) {
    this.container = container;
    this.viz = viz;
    this.agents = new Map();      // node key -> { group, crystal, edges, halo, ring, label, beam, ... }
    this.packets = [];
    this.layoutKey = "";
    this.clock = new THREE.Clock();
    this.lastInteract = -1e9;
    this.focus = new THREE.Vector3(0, 0, -7);

    const w = container.clientWidth || 800, h = container.clientHeight || 600;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.setSize(w, h);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.4;
    this.renderer.domElement.className = "floor3d-canvas";
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    // night-blue sky: lighter at the top, deep at the horizon
    const sky = document.createElement("canvas"); sky.width = 2; sky.height = 256;
    const g = sky.getContext("2d").createLinearGradient(0, 0, 0, 256);
    g.addColorStop(0, "#1b3f86"); g.addColorStop(0.55, "#0e2452"); g.addColorStop(1, "#081633");
    const sc = sky.getContext("2d"); sc.fillStyle = g; sc.fillRect(0, 0, 2, 256);
    const skyTex = new THREE.CanvasTexture(sky); skyTex.colorSpace = THREE.SRGBColorSpace;
    this.scene.background = skyTex;
    this.scene.fog = new THREE.FogExp2("#0c1f45", 0.011);

    this.camera = new THREE.PerspectiveCamera(45, w / h, 0.1, 400);
    this.camera.position.set(0, 42, 33);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    Object.assign(this.controls, { enableDamping: true, dampingFactor: 0.07, minDistance: 12, maxDistance: 90, maxPolarAngle: Math.PI * 0.49, rotateSpeed: 0.7 });
    this.controls.target.set(0, 0, -7);
    this.controls.addEventListener("start", () => { this.lastInteract = this.clock.elapsedTime; this.userMoved = true; });
    this.controls.addEventListener("end", () => { this.lastInteract = this.clock.elapsedTime; });

    // light: a cool ambient, a key light, and a coloured rim
    this.scene.add(new THREE.HemisphereLight("#ffffff", "#2a3350", 1.15));
    this.scene.add(new THREE.AmbientLight("#ffffff", 0.35));
    const key = new THREE.DirectionalLight("#ffffff", 1.4); key.position.set(10, 30, 20); this.scene.add(key);
    const fill = new THREE.DirectionalLight("#ffffff", 0.45); fill.position.set(-20, 12, -30); this.scene.add(fill);
    const rim = new THREE.PointLight("#3ae8ff", 18, 60, 2); rim.position.set(0, 14, -10); this.scene.add(rim);

    // bloom makes the neon edges and the working agents glow
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(w, h), 0.7, 0.45, 0.6);   // threshold keeps text crisp
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());

    this.buildStage();

    // click a crystal: the same agent settings as on the 2D floor
    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    let down = null;
    this.renderer.domElement.addEventListener("pointerdown", e => { down = [e.clientX, e.clientY]; });
    this.renderer.domElement.addEventListener("pointerup", e => {
      if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 5) return;   // that was a drag
      const hit = this.pick(e);
      if (hit) this.viz.onAgentClick?.(hit.base);
    });
    this.renderer.domElement.addEventListener("pointermove", e => {
      const hit = this.pick(e);
      this.hover = hit?.key || null;
      this.renderer.domElement.style.cursor = hit ? "pointer" : "grab";
    });

    this.resizeObs = new ResizeObserver(() => this.resize());
    this.resizeObs.observe(container);
    this.running = true;
    this.tick = this.tick.bind(this);
    requestAnimationFrame(this.tick);
  }

  // ---------- static stage ----------
  buildStage() {
    const grid = new THREE.GridHelper(140, 70, "#4aa3ff", "#1d4f93");
    grid.material.transparent = true; grid.material.opacity = 0.6; grid.position.y = -0.02;
    this.scene.add(grid);
    const floor = new THREE.Mesh(new THREE.CircleGeometry(70, 96), new THREE.MeshStandardMaterial({ color: "#0d2148", roughness: 0.95, metalness: 0.05, transparent: true, opacity: 0.9 }));
    floor.rotation.x = -Math.PI / 2; floor.position.y = -0.05; this.scene.add(floor);

    // owner core: a glowing icosahedron inside a slowly turning wire shell, on a pillar
    this.owner = new THREE.Group();
    const pillar = new THREE.Mesh(new THREE.CylinderGeometry(1.6, 2.2, 3, 6, 1, true),
      new THREE.MeshStandardMaterial({ color: "#0b2340", emissive: "#0b3d73", emissiveIntensity: 0.6, transparent: true, opacity: 0.55, side: THREE.DoubleSide }));
    pillar.position.y = 1.5;
    this.ownerCore = new THREE.Mesh(new THREE.IcosahedronGeometry(1.15, 1), new THREE.MeshStandardMaterial({ color: "#ff7a3d", emissive: "#ff5a1f", emissiveIntensity: 2.2, roughness: 0.2, metalness: 0.1 }));
    this.ownerCore.position.y = 4.4;
    this.ownerShell = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.IcosahedronGeometry(2.1, 1)), new THREE.LineBasicMaterial({ color: "#ffb37a", transparent: true, opacity: 0.55 }));
    this.ownerShell.position.y = 4.4;
    const ownerLight = new THREE.PointLight("#ff7a3d", 14, 16, 2); ownerLight.position.y = 4.4;
    this.ownerLabel = textSprite([t("CEO"), t("Approves the gates")], { color: "#ffd2b8" });
    this.ownerLabel.position.set(0, 7.0, 0);
    this.owner.add(pillar, this.ownerCore, this.ownerShell, ownerLight, this.ownerLabel);
    this.scene.add(this.owner);
    this.ownerTop = new THREE.Vector3(0, 4.4, 0);

    this.dynamic = new THREE.Group();   // rebuilt when the set of cards changes
    this.scene.add(this.dynamic);
  }

  // ---------- layout from the 2D floor's cards ----------
  // Every department is its own room (a glass platform in its colour). The rooms stand in an arc around the CEO,
  // close together, in division order (business, product & technology, operations & data), leaving the side
  // toward the camera open so the CEO stays in view.
  syncLayout() {
    const nodes = this.viz.nodes || {};
    // The 2D floor makes a new card set on every (re)build: follow the object, not only the names.
    const key = Object.keys(nodes).join("|") + "@" + (this.viz.meta?.agents?.length || 0);
    if (key === this.layoutKey && nodes === this.nodesObj) return;
    this.layoutKey = key; this.nodesObj = nodes;
    this.dynamic.clear();
    this.agents.clear();
    this.packets.forEach(p => this.scene.remove(p.mesh)); this.packets = [];
    const meta = this.viz.meta; if (!meta) return;

    const byDiv = {};
    for (const [k, n] of Object.entries(nodes)) ((byDiv[n.div] ||= {})[n.dept] ||= []).push([k, n]);

    // rooms in division order, each sized to its agents
    const rooms = [];
    for (const d of DIVS) for (const [dept, list] of Object.entries(byDiv[d.id] || {})) {
      const cols = list.length >= 5 ? 3 : list.length >= 2 ? 2 : 1;
      const cells = gridCells(list, cols);
      const rows = Math.max(...cells.map(x => x.r)) + 1;
      rooms.push({ div: d.id, dept, list, cells, cols, rows, width: Math.max(4.6, cols * COL + 1.4), depth: rows * ROW + 1.8 });
    }
    if (!rooms.length) return;

    // angles: each room takes the arc its width needs at the inner radius, with a little more space between divisions
    const GAP = 1.4, DIV_GAP = 3.2, MAX_ARC = THREE.MathUtils.degToRad(215);
    const spans = rooms.map((r, i) => r.width + (i === 0 ? 0 : rooms[i - 1].div === r.div ? GAP : DIV_GAP));
    const total = spans.reduce((a, b) => a + b, 0);
    const R = Math.max(ROOM_R, total / MAX_ARC);            // grow the circle only if the rooms would not fit
    let cursor = -total / R / 2;                               // the arc is centred behind the CEO
    rooms.forEach((r, i) => {
      if (i > 0) cursor += (spans[i] - r.width) / R;           // the gap before this room
      r.angle = cursor + r.width / 2 / R;
      cursor += r.width / R;
    });

    for (const room of rooms) {
      const a = room.angle;
      const out = new THREE.Vector3(Math.sin(a), 0, -Math.cos(a));          // from the CEO to the room
      const across = new THREE.Vector3(Math.cos(a), 0, Math.sin(a));
      const color = neon(cssColor(`--d-${room.dept}`, "#4aa3ff"));
      const centre = out.clone().multiplyScalar(R + room.depth / 2);

      // the room: a glass floor in the department colour with a neon rim
      const plat = new THREE.Mesh(new THREE.BoxGeometry(room.width, 0.22, room.depth),
        new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.22, transparent: true, opacity: 0.13, roughness: 0.9, metalness: 0, depthWrite: false }));
      plat.position.copy(centre).setY(0.12);
      plat.rotation.y = -a;
      const rim = new THREE.LineSegments(new THREE.EdgesGeometry(plat.geometry), new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.9 }));
      rim.position.copy(plat.position); rim.rotation.copy(plat.rotation);
      this.dynamic.add(plat, rim);

      // its name on the outer edge, and a link from the CEO to its door
      const title = textSprite([nm(meta.departments[room.dept], "name") || room.dept], { color: "#" + color.getHexString(), bg: "rgba(4,10,20,0.5)" });
      title.position.copy(out.clone().multiplyScalar(R + room.depth + 0.9)).setY(0.7);
      this.dynamic.add(title);
      this.dynamic.add(this.arc(this.ownerTop, out.clone().multiplyScalar(R).setY(0.3), "#" + color.getHexString(), 0.55, 3));

      // agents: rows away from the CEO; the cards of one role side by side
      const first = out.clone().multiplyScalar(R + 0.9 + ROW * 0.5);
      room.list.forEach(([k, n], i) => {
        const { c, r } = room.cells[i];
        const pos = first.clone().add(out.clone().multiplyScalar(r * ROW)).add(across.clone().multiplyScalar((c - (room.cols - 1) / 2) * COL));
        // each role its own colour (same hue as on the 2D floor), as a bright neon tone
        const roleColor = new THREE.Color().setHSL((window.vcRoleHue?.(n.base) ?? 210) / 360, 0.95, 0.5);
        this.agents.set(k, this.makeAgent(k, n, pos, roleColor));
      });
    }
  }

  // a curved neon line between two points
  arc(from, to, color, opacity = 0.5, lift = 4) {
    const mid = from.clone().add(to).multiplyScalar(0.5); mid.y += lift;
    const curve = new THREE.QuadraticBezierCurve3(from.clone(), mid, to.clone());
    const geo = new THREE.BufferGeometry().setFromPoints(curve.getPoints(40));
    const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color, transparent: true, opacity }));
    line.userData.curve = curve;
    return line;
  }

  makeAgent(key, n, pos, color) {
    const group = new THREE.Group();
    group.position.copy(pos);
    const geo = new THREE.OctahedronGeometry(0.7, 0);   // small enough that the platforms do not feel crowded
    const crystal = new THREE.Mesh(geo, new THREE.MeshPhysicalMaterial({
      color, emissive: color, emissiveIntensity: 0.25, transparent: true, opacity: 0.8, roughness: 0.4, metalness: 0.0,
      transmission: 0.05, thickness: 0.6,
    }));
    crystal.scale.set(1, 1.35, 1);
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo), new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.9 }));
    edges.scale.copy(crystal.scale);
    // base disc and a ring that spins while the agent works
    const disc = new THREE.Mesh(new THREE.RingGeometry(0.48, 0.66, 40), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.35, side: THREE.DoubleSide }));
    disc.rotation.x = -Math.PI / 2; disc.position.y = -1.15;
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.95, 0.04, 8, 64), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0 }));
    ring.rotation.x = Math.PI / 2;
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 1, 8, 1, true),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
    stem.position.y = -1.15;
    const body = new THREE.Group(); body.position.y = 1.4;
    body.add(crystal, edges, ring);
    const label = textSprite([nm(n.def, "role") + (n.inst > 1 || (this.viz.extra?.[n.base] || 1) > 1 ? ` #${n.inst}` : ""), ""]);
    label.position.y = 2.6;
    group.add(disc, stem, body, label);
    crystal.userData.key = key;
    this.dynamic.add(group);
    // beam from the owner (shown while working): a dashed line whose dashes run toward the agent
    const beamCurve = new THREE.QuadraticBezierCurve3(this.ownerTop.clone(), this.ownerTop.clone().add(pos).multiplyScalar(0.5).setY(12), pos.clone().setY(1.4 + LIFT));
    const beamGeo = new THREE.BufferGeometry().setFromPoints(beamCurve.getPoints(60));
    const beam = new THREE.Line(beamGeo, new THREE.LineDashedMaterial({ color, dashSize: 0.6, gapSize: 0.45, transparent: true, opacity: 0 }));
    beam.computeLineDistances();
    // WebGL lines are always 1 px: a soft glowing tube gives the beam real thickness
    const tube = new THREE.Mesh(new THREE.TubeGeometry(beamCurve, 72, 0.1, 8, false),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
    const tubeGlow = new THREE.Mesh(new THREE.TubeGeometry(beamCurve, 72, 0.22, 8, false),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.dynamic.add(tubeGlow, tube, beam);
    // orbs running along the beam toward the agent: a bright core inside a coloured halo
    const sparks = [0, 1, 2, 3, 4].map(i => {
      const core = new THREE.Mesh(new THREE.SphereGeometry(0.17, 14, 14), new THREE.MeshBasicMaterial({ color: "#ffffff", transparent: true, opacity: 0 }));
      const halo = new THREE.Mesh(new THREE.SphereGeometry(0.42, 16, 16), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
      core.add(halo); core.userData = { offset: i / 5, halo };
      this.dynamic.add(core); return core;
    });
    return { key, base: n.base, node: n, group, body, crystal, edges, disc, stem, ring, label, beam, tube, tubeGlow, beamCurve, sparks, color, glow: 0, lift: 0, phase: Math.random() * 6 };
  }

  pick(e) {
    const r = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster.intersectObjects([...this.agents.values()].map(a => a.crystal), false);
    return hits.length ? this.agents.get(hits[0].object.userData.key) : null;
  }

  // a glowing packet flying from one card (or the owner) to another, like the 2D hand-offs
  pulse(a, b, kind) {
    const pos = x => { if (x === "owner") return this.ownerTop.clone(); const ag = this.agents.get(this.keyOf(x)); return ag ? ag.group.position.clone().setY(ag.body.position.y + 0.4) : null; };
    const from = pos(a), to = pos(b);
    if (!from || !to) return;
    const color = kind === "loop" ? "#ff5a5a" : kind === "feedback" ? "#4cff9a" : "#ffb347";
    const mid = from.clone().add(to).multiplyScalar(0.5); mid.y += 5 + from.distanceTo(to) * 0.15;
    const curve = new THREE.QuadraticBezierCurve3(from, mid, to);
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(0.3, 16, 16), new THREE.MeshBasicMaterial({ color: "#ffffff" }));
    mesh.add(new THREE.Mesh(new THREE.SphereGeometry(0.75, 16, 16), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.45, blending: THREE.AdditiveBlending, depthWrite: false })));
    this.scene.add(mesh);
    this.packets.push({ mesh, curve, t0: this.clock.elapsedTime, dur: 1.4 });
  }

  keyOf(n) { for (const [k, v] of Object.entries(this.viz.nodes || {})) if (v === n) return k; return null; }

  celebrate() { this.celebrateAt = this.clock.elapsedTime; }

  // ---------- frame ----------
  tick() {
    if (!this.running) return;
    requestAnimationFrame(this.tick);
    if (!this.container.offsetParent) return;   // hidden: skip the work
    const dt = Math.min(this.clock.getDelta(), 0.05), time = this.clock.elapsedTime;
    this.syncLayout();

    const working = [];
    for (const a of this.agents.values()) {
      const cls = a.node.g.classList;
      const isWorking = cls.contains("working"), done = cls.contains("done"), off = cls.contains("off");
      const stalled = cls.contains("stalled") || cls.contains("retrying"), limited = cls.contains("limited"), hover = this.hover === a.key;
      if (isWorking) working.push(a.group.position);
      const tint = limited ? new THREE.Color("#ff4d4d") : stalled ? new THREE.Color("#ffc23d") : a.color;
      // ease toward the state: working agents rise and glow, idle ones sit back, switched-off ones fade out
      a.glow += ((isWorking ? 1 : hover ? 0.5 : 0) - a.glow) * Math.min(1, dt * 4);
      a.lift += ((isWorking ? 1 : 0) - a.lift) * Math.min(1, dt * 3);
      const bob = reduced ? 0 : Math.sin(time * 1.6 + a.phase) * 0.12 * (0.35 + a.glow);
      a.body.position.y = 1.4 + a.lift * LIFT + bob;
      const h = Math.max(0.001, a.body.position.y - 1.4 + 1.2);      // pillar: base disc -> crystal
      a.stem.scale.y = h; a.stem.position.y = -1.15 + h / 2;
      a.stem.material.opacity = a.lift * 0.55; a.stem.material.color.copy(tint);
      const s = 1 + a.lift * 0.18 + (hover ? 0.1 : 0);
      a.body.scale.setScalar(s);
      a.crystal.rotation.y += dt * (0.25 + a.glow * 1.6);
      a.edges.rotation.y = a.crystal.rotation.y;
      a.crystal.material.emissive.copy(tint);
      a.edges.material.color.copy(tint).lerp(WHITE, 0.12);
      a.crystal.material.emissiveIntensity = off ? 0.05 : 0.5 + a.glow * 0.45;
      a.crystal.material.opacity = off ? 0.2 : 0.82 + a.glow * 0.15;
      a.edges.material.opacity = off ? 0.2 : 0.85 + a.glow * 0.15;
      a.disc.material.color.copy(done && !isWorking ? new THREE.Color("#3dff8f") : tint);
      a.disc.material.opacity = off ? 0.08 : done && !isWorking ? 0.7 : 0.45 + a.glow * 0.45;
      a.ring.material.color.copy(tint);
      a.ring.material.opacity = a.glow * 0.85;
      a.ring.rotation.z += dt * 2.2;
      a.ring.rotation.x = Math.PI / 2 + Math.sin(time * 1.3 + a.phase) * 0.35;
      // beam from the owner while working
      a.beam.material.opacity = a.glow;
      a.beam.material.color.copy(tint).lerp(WHITE, 0.35);
      a.beam.material.dashOffset = -time * 2.4;
      const breathe = 0.85 + 0.15 * Math.sin(time * 3 + a.phase);
      a.tube.material.opacity = a.glow * 0.8 * breathe;
      a.tube.material.color.copy(tint);
      a.tubeGlow.material.opacity = a.glow * 0.26 * breathe;
      a.tubeGlow.material.color.copy(tint);
      a.sparks.forEach(sp => {
        const u = (time * 0.42 + sp.userData.offset) % 1;
        sp.position.copy(a.beamCurve.getPoint(u));
        const fade = Math.min(1, u * 6, (1 - u) * 6);          // appear at the CEO, fade into the agent
        sp.material.opacity = a.glow * fade;
        sp.userData.halo.material.opacity = a.glow * fade * 0.45;
        sp.userData.halo.material.color.copy(tint);
        sp.scale.setScalar(0.85 + 0.25 * Math.sin(time * 6 + sp.userData.offset * 9));
      });
      // label: role + the live line from the 2D card (tokens, tool, elapsed...)
      const role = nm(a.node.def, "role") + (a.node.inst > 1 || (this.viz.extra?.[a.base] || 1) > 1 ? ` #${a.node.inst}` : "");
      // idle cards show only the role; the live line (tokens, tool, time) appears while the agent works
      const sub = off ? t("Off") : isWorking || stalled || limited ? (a.node.modelText?.textContent || "") : "";
      setSpriteText(a.label, sub ? [role, sub] : [role], isWorking ? "#ffffff" : off ? "#7d8ba0" : "#e2ecff",
        isWorking ? "#" + tint.getHexString() : null);
      a.label.material.opacity = off ? 0.45 : 0.85 + a.glow * 0.15;
      a.label.position.y = 2.6 + a.lift * LIFT;
    }

    // owner: pulses amber while a decision waits for you
    const waiting = this.viz.owner?.classList.contains("waiting");
    const pulse = 0.5 + 0.5 * Math.sin(time * (waiting ? 5 : 1.5));
    this.ownerCore.material.emissive.set(waiting ? "#ffb000" : "#ff5a1f");
    this.ownerCore.material.emissiveIntensity = 1.6 + pulse * (waiting ? 2.4 : 0.9);
    this.ownerCore.rotation.y += dt * 0.6; this.ownerCore.rotation.x += dt * 0.25;
    this.ownerShell.rotation.y -= dt * 0.2;
    setSpriteText(this.ownerLabel, [t("CEO"), this.viz.ownerSub?.textContent || t("Approves the gates")], waiting ? "#ffd27a" : "#ffd2b8", waiting ? "#ffb000" : null);

    // packets in flight
    this.packets = this.packets.filter(p => {
      const u = (time - p.t0) / p.dur;
      if (u >= 1) { this.scene.remove(p.mesh); p.mesh.traverse(o => { o.geometry?.dispose(); o.material?.dispose(); }); return false; }
      p.mesh.position.copy(p.curve.getPoint(u));
      p.mesh.scale.setScalar(1 + Math.sin(u * Math.PI) * 0.6);
      return true;
    });

    // celebrate: a short burst of brightness when the project goes live
    const since = time - (this.celebrateAt ?? -99);
    this.bloom.strength = 0.7 + (since < 2.5 ? (1 - since / 2.5) * 0.9 : 0);

    // camera: no automatic rotation; when you leave it alone it only leans gently toward the agents at work
    const idle = time - this.lastInteract > 8;
    this.controls.autoRotate = false;   // the camera only turns when you drag it
    if (idle) {
      const goal = working.length ? working.reduce((acc, v) => acc.add(v), new THREE.Vector3()).multiplyScalar(1 / working.length).multiplyScalar(0.6).add(new THREE.Vector3(0, 0, -5)) : new THREE.Vector3(0, 0, -7);
      this.focus.lerp(goal, Math.min(1, dt * 0.8));
      this.controls.target.lerp(this.focus, Math.min(1, dt * 1.2));
    }
    this.controls.update();
    this.composer.render();
  }

  resetView() {
    this.camera.position.set(0, 42, 33);
    this.controls.target.set(0, 0, -7);
    this.focus.set(0, 0, -7);
    this.lastInteract = this.clock.elapsedTime;
  }

  resize() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    if (!w || !h) return;
    this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h); this.composer.setSize(w, h); this.bloom.setSize(w, h);
  }

  dispose() {
    this.running = false;
    this.resizeObs.disconnect();
    this.controls.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}

window.Floor3D = Floor3D;
window.dispatchEvent(new Event("floor3d-ready"));

// shared with the office view (office3d.js)
export { textSprite, setSpriteText, gridCells, TEXT_K };
