// Office view: the company as one clean isometric office building, seen from a fixed angle (zoom and pan only).
// The lobby with the CEO is in the middle; every department is a room around it, furnished for its work, and the
// rooms are joined by doors. The agents are people at desks, dressed for their department: working agents type and
// their screens light up with code, new colleagues walk in from the entrance through the doors to a desk next to the
// others of their role, a steady stream of papers flies between the CEO and the people at work (and between desks
// on hand-offs), the CEO stands and raises a hand when a decision waits, and everyone cheers when the project goes live.
//
// It mirrors the 2D floor (viz.js): every person's state is read from the 2D card each frame.
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { GTAOPass } from "three/addons/postprocessing/GTAOPass.js";
import { SMAAPass } from "three/addons/postprocessing/SMAAPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { gridCells } from "./viz3d.js";

const t = (k, ...a) => (window.I18N ? I18N.t(k, ...a) : k);
const nm = (o, f) => (window.I18N ? I18N.name(o, f) : (o && o[f]) || "");
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

const DESK_W = 2.5, DESK_D = 2.7;          // one workplace: desk, chair and person
const RIM = 0.9;                           // thickness of a platform's dark rim
const LABEL_PX = 11.5;                     // on-screen text size of every label, whatever the zoom
const LABELS = new Set();
const PAPER_GEO = new THREE.BoxGeometry(0.55, 0.04, 0.7);
const PAPER_EDGE = new THREE.EdgesGeometry(PAPER_GEO), PAPER_LINE = new THREE.LineBasicMaterial({ color: "#2d3442" });
const SKIN = ["#f1c6a5", "#e0a982", "#c68863", "#a8704a", "#8a5a3c", "#f5d2b8"];
const HAIR = ["#2b2118", "#4a3020", "#1d1d1f", "#6b4a2b", "#9a6a35", "#3b2c28"];
const STICKY = ["#ffd84d", "#7fd3ff", "#ff9bb3", "#9be58f", "#ffb35c"];

function cssColor(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  try { return new THREE.Color(v || fallback); } catch { return new THREE.Color(fallback); }
}
const roleColor = id => new THREE.Color().setHSL((window.vcRoleHue?.(id) ?? 210) / 360, 0.6, 0.45);
const hash = s => [...String(s)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
const mats = new Map();
const toon = color => {      // shared matte materials (one per colour), lit by the room's soft environment light
  const k = new THREE.Color(color).getHexString();
  if (!mats.has(k)) mats.set(k, new THREE.MeshStandardMaterial({ color: "#" + k, roughness: 0.72, metalness: 0 }));
  return mats.get(k);
};
// boxes with slightly rounded edges (like real furniture); tiny parts stay plain boxes; one geometry per size
const geos = new Map();
const boxGeo = (w, h, d) => {
  const k = `${w.toFixed(3)}|${h.toFixed(3)}|${d.toFixed(3)}`;
  if (!geos.has(k)) {
    const r = Math.min(0.05, Math.min(w, h, d) * 0.3);
    geos.set(k, r > 0.012 ? new RoundedBoxGeometry(w, h, d, 2, r) : new THREE.BoxGeometry(w, h, d));
  }
  return geos.get(k);
};
const box = (w, h, d, color, x = 0, y = 0, z = 0, shadow = true) => {
  const m = new THREE.Mesh(boxGeo(w, h, d), toon(color));
  m.position.set(x, y, z); m.castShadow = shadow; m.receiveShadow = true; return m;
};

// a light wood floor (planks with grain), drawn once in code and repeated per room
let WOOD = null;
function woodTexture() {
  if (WOOD) return WOOD;
  const c = document.createElement("canvas"); c.width = c.height = 1024;
  const g = c.getContext("2d"), rows = 8, ph = c.height / rows;
  let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let r = 0; r < rows; r++) {
    let x = -rnd() * 400;
    while (x < c.width) {
      const len = 300 + rnd() * 300, l = 74 + rnd() * 8;
      g.fillStyle = `hsl(33, ${38 + rnd() * 10}%, ${l}%)`;
      g.fillRect(x, r * ph, len, ph);
      for (let k = 0; k < 14; k++) {                                              // grain
        g.strokeStyle = `rgba(120, 80, 40, ${0.04 + rnd() * 0.06})`; g.lineWidth = 1 + rnd() * 2;
        const yy = r * ph + rnd() * ph; g.beginPath(); g.moveTo(x, yy);
        g.bezierCurveTo(x + len * 0.3, yy + (rnd() - 0.5) * 8, x + len * 0.6, yy + (rnd() - 0.5) * 8, x + len, yy + (rnd() - 0.5) * 6); g.stroke();
      }
      g.fillStyle = "rgba(90, 60, 30, 0.35)"; g.fillRect(x, r * ph, 2, ph);      // plank ends
      x += len;
    }
    g.fillStyle = "rgba(90, 60, 30, 0.3)"; g.fillRect(0, r * ph, c.width, 2);    // seams
  }
  WOOD = new THREE.CanvasTexture(c); WOOD.colorSpace = THREE.SRGBColorSpace;
  WOOD.wrapS = WOOD.wrapT = THREE.RepeatWrapping; WOOD.anisotropy = 8;
  return WOOD;
}
function woodFloor(w, d) {
  const t = woodTexture().clone(); t.needsUpdate = true; t.repeat.set(w / 6, d / 6);
  return new THREE.MeshStandardMaterial({ map: t, roughness: 0.6, metalness: 0 });
}

// ---------- labels: dark text on a white pill, one size everywhere ----------
// A name on the floor (like a floor sticker): flat, lying on the floor, its top toward the back of the room. It is
// part of the room, so it zooms with it, and nothing else ever covers it but the people walking over it.
const FLOOR_LINE = 0.8;                     // world height of one line of floor text: the same in every room
function floorLabel(text, color, maxW) {
  const h = FLOOR_LINE;
  const size = 96, pad = 34, lh = size * 1.18, canvas = document.createElement("canvas"), ctx = canvas.getContext("2d");
  const font = `700 ${size}px "Segoe UI", system-ui, sans-serif`;
  ctx.font = font;
  // a long name in a narrow room goes on two lines rather than shrinking
  let lines = [text];
  const oneW = ctx.measureText(text).width + pad * 2;
  const words = text.split(" ");
  if (words.length > 1 && h * oneW / (lh + pad) > maxW) {
    let best = null;
    for (let i = 1; i < words.length; i++) {
      const a = words.slice(0, i).join(" "), b = words.slice(i).join(" ");
      const w = Math.max(ctx.measureText(a).width, ctx.measureText(b).width);
      if (!best || w < best.w) best = { w, lines: [a, b] };
    }
    lines = best.lines;
  }
  canvas.width = Math.ceil(Math.max(...lines.map(l => ctx.measureText(l).width)) + pad * 2);
  canvas.height = Math.ceil(lh * lines.length + pad);
  const c = new THREE.Color(color), ink = "#" + c.clone().multiplyScalar(0.62).getHexString();
  ctx.fillStyle = `rgba(${c.r * 255 | 0},${c.g * 255 | 0},${c.b * 255 | 0},0.14)`;
  ctx.beginPath(); ctx.roundRect(4, 4, canvas.width - 8, canvas.height - 8, 30); ctx.fill();
  ctx.strokeStyle = "#" + c.getHexString(); ctx.lineWidth = 6; ctx.stroke();
  ctx.font = font; ctx.fillStyle = ink; ctx.textAlign = "center"; ctx.textBaseline = "middle";
  lines.forEach((l, i) => ctx.fillText(l, canvas.width / 2, pad / 2 + lh * (i + 0.5) + 4));
  const tex = new THREE.CanvasTexture(canvas); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8;
  const hh = h * canvas.height / (lh + pad), w = hh * canvas.width / canvas.height;   // same text size everywhere
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, hh), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 }));
  m.rotation.x = -Math.PI / 2; m.receiveShadow = true;
  return m;
}

// A plaque on a wall (facing the room, +z): a title and a status line, same font as the other labels.
function wallPlaque(w, h = 0.95) {
  const canvas = document.createElement("canvas"), ctx = canvas.getContext("2d");
  canvas.width = 720; canvas.height = Math.round(720 * h / w);
  const tex = new THREE.CanvasTexture(canvas); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8;
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: tex, transparent: true }));
  m.userData.set = (lines, border, alert) => {
    const key = lines.join("\n") + border + alert;
    if (m.userData.key === key) return; m.userData.key = key;
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = alert ? "#fff7e6" : "#ffffff";
    ctx.beginPath(); ctx.roundRect(6, 6, W - 12, H - 12, 26); ctx.fill();
    ctx.strokeStyle = border; ctx.lineWidth = 10; ctx.stroke();
    ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillStyle = "#1f2a3a";
    ctx.font = `700 92px "Segoe UI", system-ui, sans-serif`; ctx.fillText(lines[0], W / 2, lines[1] ? H * 0.33 : H * 0.52, W - 50);
    ctx.fillStyle = "#4b5b70"; ctx.font = `600 66px "Segoe UI", system-ui, sans-serif`; ctx.fillText(lines[1] || "", W / 2, H * 0.7, W - 50);
    tex.needsUpdate = true;
  };
  m.userData.set(["CEO", ""], "#f28c38", false);
  return m;
}

function labelSprite(lines, { color = "#1f2a3a", border = null, width = 420, size = 34 } = {}) {
  const canvas = document.createElement("canvas"), ctx = canvas.getContext("2d");
  const pad = 14, lh = size * 1.2;
  canvas.width = width;
  const tex = new THREE.CanvasTexture(canvas); tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, depthTest: false }));
  sprite.renderOrder = 20; sprite.layers.set(1);
  sprite.center.set(0.5, 0);
  const draw = (ls, c, b) => {
    canvas.height = Math.ceil(pad * 2 + lh * ls.length);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "rgba(255,255,255,0.94)";
    ctx.beginPath(); ctx.roundRect(3, 3, canvas.width - 6, canvas.height - 6, 18); ctx.fill();
    ctx.strokeStyle = b || "rgba(30,50,80,0.2)"; ctx.lineWidth = b ? 5 : 2; ctx.stroke();
    ls.forEach((l, i) => {
      ctx.font = `${i === 0 ? 700 : 500} ${size}px "Segoe UI", system-ui, sans-serif`;
      ctx.fillStyle = i === 0 ? c : "#4b5b70";
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText(l, canvas.width / 2, pad + lh * (i + 0.5), canvas.width - pad * 2);
    });
    tex.dispose();                                   // the canvas changed size: upload it afresh
    tex.needsUpdate = true;
    sprite.userData.px = [canvas.width / size, canvas.height / size];   // size in "font heights"
  };
  sprite.userData.set = (ls, c = color, b = border) => {
    const key = ls.join("\n") + c + b;
    if (sprite.userData.key !== key) { sprite.userData.key = key; draw(ls, c, b); }
  };
  sprite.userData.mult = 1;
  sprite.userData.set(lines);
  LABELS.add(sprite);
  return sprite;
}

// ---------- a person in office clothes, posed by joint angles ----------
// style.outfit: "suit" (jacket, shirt and tie), "smart" (shirt with an open collar), "hoodie" (casual, with a hood);
// style.headset (support), style.glasses, style.beret (design)
function makePerson(jacket, seed, style = {}) {
  const skin = SKIN[seed % SKIN.length], hair = HAIR[(seed >> 3) % HAIR.length];
  const longHair = (seed >> 5) % 3 === 0;
  const outfit = style.outfit || "suit";
  const g = new THREE.Group(), body = new THREE.Group(); g.add(body);
  const hips = new THREE.Group(); hips.position.y = 0.95; body.add(hips);
  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.26, 0.42, 4, 10), toon(jacket));
  torso.position.y = 0.42; torso.castShadow = true; hips.add(torso);
  if (outfit === "suit") {
    hips.add(box(0.16, 0.3, 0.05, "#f4f6fa", 0, 0.62, 0.245, false));                     // shirt
    hips.add(box(0.06, 0.24, 0.03, new THREE.Color(jacket).offsetHSL(0.5, 0.1, 0.1), 0, 0.6, 0.27, false));   // tie
  } else if (outfit === "smart") {
    hips.add(box(0.2, 0.08, 0.05, "#ffffff", 0, 0.74, 0.23, false));                      // open collar
    for (let i = 0; i < 3; i++) hips.add(box(0.03, 0.03, 0.02, "#ffffff", 0, 0.62 - i * 0.12, 0.27, false));   // buttons
  } else {                                                                                  // hoodie: hood, pocket, strings
    hips.add(box(0.42, 0.22, 0.16, new THREE.Color(jacket).offsetHSL(0, 0, -0.06), 0, 0.8, -0.2, false));
    hips.add(box(0.3, 0.14, 0.04, new THREE.Color(jacket).offsetHSL(0, 0, -0.08), 0, 0.3, 0.26, false));
    hips.add(box(0.02, 0.16, 0.02, "#f4f6fa", -0.06, 0.66, 0.27, false), box(0.02, 0.16, 0.02, "#f4f6fa", 0.06, 0.66, 0.27, false));
  }
  const neck = new THREE.Group(); neck.position.y = 0.86; hips.add(neck);
  if (style.headset) {
    const band = new THREE.Mesh(new THREE.TorusGeometry(0.25, 0.025, 6, 16, Math.PI), toon("#20242c"));
    band.position.y = 0.22; neck.add(band);
    neck.add(box(0.06, 0.12, 0.1, "#20242c", -0.25, 0.2, 0, false), box(0.06, 0.12, 0.1, "#20242c", 0.25, 0.2, 0, false));
    const mic = box(0.03, 0.03, 0.22, "#20242c", -0.2, 0.1, 0.12, false); mic.rotation.y = 0.5; neck.add(mic);
  }
  if (style.glasses) for (const x of [-0.08, 0.08]) {
    const lens = new THREE.Mesh(new THREE.TorusGeometry(0.05, 0.012, 6, 12), toon("#1d1d1f")); lens.position.set(x, 0.22, 0.225); neck.add(lens);
  }
  if (style.beret) { const b = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.25, 0.08, 16), toon("#c0392b")); b.position.set(0.04, 0.43, -0.02); b.rotation.z = 0.25; neck.add(b); }
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.23, 18, 14), toon(skin)); head.position.y = 0.2; head.castShadow = true; neck.add(head);
  const cap = new THREE.Mesh(new THREE.SphereGeometry(0.245, 18, 10, 0, Math.PI * 2, 0, Math.PI * 0.55), toon(hair));
  cap.position.y = 0.22; cap.rotation.x = -0.3; neck.add(cap);
  if (longHair) neck.add(box(0.4, 0.38, 0.12, hair, 0, 0.08, -0.17, false));
  for (const x of [-0.08, 0.08]) {
    const e = new THREE.Mesh(new THREE.SphereGeometry(0.028, 6, 6), toon("#1d1d1f")); e.position.set(x, 0.22, 0.205); neck.add(e);
  }
  const limb = (len, r, color) => {
    const piv = new THREE.Group();
    const m = new THREE.Mesh(new THREE.CapsuleGeometry(r, len, 3, 8), toon(color));
    m.position.y = -len / 2 - r * 0.5; m.castShadow = true; piv.add(m);
    return piv;
  };
  const armL = limb(0.42, 0.072, jacket), armR = limb(0.42, 0.072, jacket);
  armL.position.set(-0.33, 0.7, 0); armR.position.set(0.33, 0.7, 0);
  for (const a of [armL, armR]) { const h = new THREE.Mesh(new THREE.SphereGeometry(0.072, 8, 6), toon(skin)); h.position.y = -0.62; a.add(h); }
  const legL = limb(0.5, 0.088, "#2a3346"), legR = limb(0.5, 0.088, "#2a3346");
  legL.position.set(-0.13, 0.02, 0); legR.position.set(0.13, 0.02, 0);
  for (const l of [legL, legR]) l.add(box(0.16, 0.09, 0.28, "#161a22", 0, -0.66, 0.06, false));
  hips.add(armL, armR, legL, legR);
  return { g, body, hips, torso, neck, armL, armR, legL, legR };
}
function poseSit(p) {
  p.hips.position.y = 0.62;
  p.legL.rotation.x = p.legR.rotation.x = -Math.PI / 2;
  p.armL.rotation.set(-1.05, 0, 0.12); p.armR.rotation.set(-1.05, 0, -0.12);
}
function poseStand(p) {
  p.hips.position.y = 0.95;
  p.legL.rotation.x = p.legR.rotation.x = 0;
  p.armL.rotation.set(0, 0, 0.06); p.armR.rotation.set(0, 0, -0.06);
}
// Office 3 (game style): a bigger head and a baseball cap in the department's colour, like a tycoon game's staff
function chibi(p, capColor) {
  p.neck.scale.setScalar(1.38);
  const cap = new THREE.Mesh(new THREE.SphereGeometry(0.255, 16, 8, 0, Math.PI * 2, 0, Math.PI * 0.5), toon(capColor));
  cap.position.y = 0.25; cap.castShadow = true; p.neck.add(cap);
  p.neck.add(box(0.34, 0.035, 0.24, capColor, 0, 0.26, 0.2, false));          // the brim, over the face (+z)
}

// a desk with a monitor (screen toward the chair at +z) and a chair
function makeDesk(accent, dept) {
  const g = new THREE.Group();
  g.add(box(1.7, 0.08, 0.9, "#ffffff", 0, 0.92, 0));
  g.add(box(0.06, 0.88, 0.8, "#c7ced9", -0.8, 0.46, 0), box(0.06, 0.88, 0.8, "#c7ced9", 0.8, 0.46, 0));
  g.add(box(1.7, 0.5, 0.05, "#e6eaf0", 0, 0.62, -0.42, false));                    // modesty panel
  const mon = new THREE.Group(); mon.position.set(0, 0.96, -0.22); g.add(mon);
  mon.add(box(0.08, 0.3, 0.08, "#3b4254", 0, 0.15, 0, false));
  mon.add(box(0.95, 0.58, 0.06, "#262b38", 0, 0.56, 0));
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(0.86, 0.48), new THREE.MeshBasicMaterial({ color: "#1b2233" }));
  screen.position.set(0, 0.56, 0.032); mon.add(screen);
  const lines = new THREE.Group(); lines.position.set(0, 0.56, 0.036); mon.add(lines);
  for (let i = 0; i < 5; i++) {
    const w = 0.22 + ((i * 37) % 40) / 100;
    const l = new THREE.Mesh(new THREE.PlaneGeometry(w, 0.045), new THREE.MeshBasicMaterial({ color: accent, transparent: true, opacity: 0 }));
    l.position.set(-0.36 + w / 2, 0.17 - i * 0.085, 0); lines.add(l);
  }
  g.add(box(0.6, 0.03, 0.2, "#d6dae2", 0, 0.975, 0.2, false));                     // keyboard
  const chair = new THREE.Group(); chair.position.set(0, 0, 0.85); g.add(chair);
  chair.add(box(0.6, 0.08, 0.56, "#30384a", 0, 0.55, 0), box(0.6, 0.6, 0.08, "#30384a", 0, 0.9, 0.27), box(0.07, 0.5, 0.07, "#8a93a5", 0, 0.27, 0, false));
  const screens = [screen];
  // the department's own things on the desk
  const extra = DESK_EXTRAS[dept] || DESK_EXTRAS.default;
  extra(g, accent, screens, mon);
  return { g, screen, screens, lines };
}

// what lies on a desk, by department
const DESK_EXTRAS = {
  default(g, accent) { g.add(box(0.12, 0.13, 0.12, accent.clone().lerp(new THREE.Color("#fff"), 0.4), 0.62, 1.02, 0.15, false)); },
  engineering(g, accent, screens) {           // a second monitor turned toward the chair, an energy drink
    const m2 = new THREE.Group(); m2.position.set(0.62, 0.96, -0.12); m2.rotation.y = -0.5; g.add(m2);
    m2.add(box(0.06, 0.3, 0.06, "#3b4254", 0, 0.15, 0, false), box(0.62, 0.5, 0.05, "#262b38", 0, 0.5, 0));
    const s = new THREE.Mesh(new THREE.PlaneGeometry(0.55, 0.42), new THREE.MeshBasicMaterial({ color: "#1b2233" })); s.position.set(0, 0.5, 0.03); m2.add(s);
    screens.push(s);
    g.add(new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.16, 10), toon("#39d353")).translateX(-0.65).translateY(1.04).translateZ(0.2));
  },
  infra(g, accent, screens) {                 // a terminal with a second screen and a small server tower beside the desk
    DESK_EXTRAS.engineering(g, accent, screens);
    g.add(box(0.35, 0.7, 0.6, "#20242c", -1.05, 0.35, 0));
    g.add(box(0.2, 0.03, 0.02, "#39d353", -1.05, 0.55, 0.31, false));
  },
  design(g) {                                 // a drawing tablet with a pen, and colour swatches
    g.add(box(0.55, 0.03, 0.38, "#15181f", 0.55, 0.975, 0.18, false));
    const pen = box(0.03, 0.03, 0.3, "#e0e4ea", 0.55, 1.0, 0.18, false); pen.rotation.y = 0.6; g.add(pen);
    ["#ff6b6b", "#ffd84d", "#4dabf7", "#69db7c"].forEach((c, i) => g.add(box(0.1, 0.02, 0.14, c, -0.7 + i * 0.12, 0.97, 0.25, false)));
  },
  finance(g) {                                // stacks of paper and a calculator
    for (let i = 0; i < 3; i++) g.add(box(0.36, 0.05, 0.46, i % 2 ? "#ffffff" : "#f0ede4", -0.6, 0.98 + i * 0.05, 0.12, false));
    g.add(box(0.22, 0.04, 0.3, "#2d3442", 0.6, 0.98, 0.15, false), box(0.18, 0.01, 0.08, "#9be58f", 0.6, 1.005, 0.07, false));
  },
  support(g) {                                // a desk phone and a ticket tray
    g.add(box(0.3, 0.08, 0.24, "#2d3442", 0.6, 1.0, 0.12, false), box(0.08, 0.06, 0.24, "#15181f", 0.52, 1.07, 0.12, false));
    g.add(box(0.36, 0.08, 0.3, "#ffd84d", -0.62, 0.99, 0.12, false));
  },
  data(g, accent, screens) {                  // a wide monitor (the chart screen) and a notebook
    DESK_EXTRAS.engineering(g, accent, screens);
  },
  marketing(g) {                              // a phone on a stand and a few product samples
    g.add(box(0.1, 0.2, 0.02, "#15181f", 0.6, 1.07, 0.1, false));
    ["#ff7a59", "#ffd84d"].forEach((c, i) => g.add(box(0.12, 0.22, 0.12, c, -0.55 - i * 0.16, 1.07, 0.15, false)));
  },
  business(g) {                               // a leather folder and a pen
    g.add(box(0.4, 0.03, 0.5, "#6e4527", -0.55, 0.975, 0.12, false), box(0.02, 0.02, 0.2, "#c9a227", 0.55, 0.98, 0.15, false));
  },
  product(g) {                                // sticky notes on the desk and a mug
    ["#ffd84d", "#7fd3ff", "#ff9bb3"].forEach((c, i) => g.add(box(0.12, 0.01, 0.12, c, -0.7 + i * 0.15, 0.97, 0.22, false)));
    DESK_EXTRAS.default(g, new THREE.Color("#7fd3ff"));
  },
};

// how the people of a department dress
const OUTFITS = {
  business: { outfit: "suit" }, finance: { outfit: "suit", glasses: true },
  product: { outfit: "smart" }, marketing: { outfit: "smart" }, support: { outfit: "smart", headset: true },
  design: { outfit: "hoodie", beret: true }, engineering: { outfit: "hoodie" }, infra: { outfit: "hoodie" },
  data: { outfit: "smart", glasses: true },
};

function makePlant(scale = 1) {
  const g = new THREE.Group();
  g.add(box(0.36, 0.42, 0.36, "#2d3442", 0, 0.21, 0));
  const leaf = new THREE.Mesh(new THREE.SphereGeometry(0.36, 12, 10), toon("#6cc04a")); leaf.position.y = 0.95; leaf.castShadow = true; g.add(leaf);
  g.add(box(0.05, 0.4, 0.05, "#5a4632", 0, 0.6, 0, false));
  g.scale.setScalar(scale);
  return g;
}
function makeSofa(color = "#f2f2f2") {
  const g = new THREE.Group();
  g.add(box(1.8, 0.4, 0.8, color, 0, 0.3, 0), box(1.8, 0.5, 0.2, color, 0, 0.7, -0.3), box(0.2, 0.55, 0.8, color, -0.9, 0.45, 0), box(0.2, 0.55, 0.8, color, 0.9, 0.45, 0));
  return g;
}
function makeWhiteboard(seed) {
  const g = new THREE.Group();
  g.add(box(2.2, 1.3, 0.06, "#ffffff", 0, 1.7, 0), box(2.3, 0.06, 0.1, "#2d3442", 0, 1.04, 0.02, false));
  g.add(box(0.06, 1.1, 0.06, "#7b8496", -0.9, 0.55, 0, false), box(0.06, 1.1, 0.06, "#7b8496", 0.9, 0.55, 0, false));
  for (let i = 0; i < 9; i++) g.add(box(0.26, 0.22, 0.02, STICKY[(i + seed) % STICKY.length], -0.75 + (i % 4) * 0.45 + ((i * 7) % 3) * 0.04, 2.05 - Math.floor(i / 4) * 0.33, 0.05, false));
  return g;
}
function makeShelf() {
  const g = new THREE.Group();
  g.add(box(1.6, 2, 0.45, "#f4f6f9", 0, 1, 0));
  for (let r = 0; r < 3; r++) for (let i = 0; i < 4; i++)
    g.add(box(0.22, 0.38, 0.3, ["#2f9c95", "#3d7fd1", "#e0a43a", "#2f9c95"][(r + i) % 4], -0.52 + i * 0.36, 0.42 + r * 0.6, 0.12, false));
  return g;
}

function makeMeetingTable(seats = 6, color = "#ffffff") {
  const g = new THREE.Group();
  g.add(box(1.3, 0.08, 2.6, color, 0, 0.82, 0), box(0.3, 0.8, 1.6, "#c7ced9", 0, 0.4, 0, false));
  for (let i = 0; i < seats; i++) {
    const side = i % 2 ? 1 : -1, z = -0.9 + Math.floor(i / 2) * 0.9;
    g.add(box(0.45, 0.08, 0.45, "#30384a", side * 0.95, 0.5, z), box(0.08, 0.5, 0.45, "#30384a", side * 1.17, 0.8, z));
  }
  return g;
}
function makeChartBoard(bars, color = "#3d7fd1") {      // a presentation board with a bar chart
  const g = new THREE.Group();
  g.add(box(1.6, 1.1, 0.05, "#ffffff", 0, 1.75, 0), box(0.05, 1.3, 0.05, "#7b8496", -0.55, 0.65, 0.1, false), box(0.05, 1.3, 0.05, "#7b8496", 0.55, 0.65, 0.1, false));
  for (let i = 0; i < 5; i++) { const b = box(0.18, 0.2 + i * 0.15, 0.03, i === 4 ? "#ff7a59" : color, -0.55 + i * 0.27, 1.32 + (0.2 + i * 0.15) / 2, 0.04, false); g.add(b); bars?.push(b); }
  return g;
}
function makeServerRack(view) {
  const g = new THREE.Group();
  g.add(box(0.9, 2.3, 0.8, "#1e222b", 0, 1.15, 0));
  for (let r = 0; r < 7; r++) {
    g.add(box(0.8, 0.22, 0.02, "#2c323e", 0, 0.35 + r * 0.29, 0.41, false));
    for (let k = 0; k < 3; k++) {
      const led = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.05, 0.02), new THREE.MeshBasicMaterial({ color: k === 2 ? "#4dabf7" : "#39d353" }));
      led.position.set(0.2 + k * 0.09, 0.35 + r * 0.29, 0.43); g.add(led);
      const ph = Math.random() * 10, sp = 2 + Math.random() * 6;
      view.anim.push((time, busy) => { led.visible = Math.sin(time * sp * (busy ? 2.5 : 1) + ph) > -0.3; });
    }
  }
  return g;
}
function makeWallScreen(view, dept) {     // a big dashboard on the wall: bars that move with the work
  const g = new THREE.Group();
  g.add(box(3.2, 1.8, 0.08, "#15181f", 0, 1.9, 0));
  const scr = new THREE.Mesh(new THREE.PlaneGeometry(3.0, 1.6), new THREE.MeshBasicMaterial({ color: "#10233d" })); scr.position.set(0, 1.9, 0.045); g.add(scr);
  for (let i = 0; i < 8; i++) {
    const bar = new THREE.Mesh(new THREE.PlaneGeometry(0.22, 1), new THREE.MeshBasicMaterial({ color: i % 3 === 0 ? "#ffb35c" : "#4dd4ff" }));
    bar.position.set(-1.2 + i * 0.34, 1.3, 0.05); g.add(bar);
    view.anim.push((time, busy) => { const h = 0.25 + 0.9 * (0.5 + 0.5 * Math.sin(time * (busy ? 2.2 : 0.4) + i * 1.3)); bar.scale.y = h; bar.position.y = 1.15 + h / 2; });
  }
  g.add(box(0.1, 1.1, 0.1, "#4a5262", 0, 0.55, -0.05, false));
  return g;
}
function makeEasel() {
  const g = new THREE.Group();
  for (const x of [-0.35, 0.35]) { const l = box(0.06, 1.9, 0.06, "#8a5a33", x, 0.95, 0, false); l.rotation.z = -x * 0.25; g.add(l); }
  const back = box(0.06, 1.9, 0.06, "#8a5a33", 0, 0.9, -0.35, false); back.rotation.x = 0.25; g.add(back);
  g.add(box(1.0, 0.8, 0.04, "#ffffff", 0, 1.45, 0.06));
  ["#ff6b6b", "#ffd84d", "#4dabf7", "#69db7c", "#b197fc"].forEach((c, i) => g.add(box(0.28 - i * 0.03, 0.18, 0.02, c, -0.25 + (i % 3) * 0.25, 1.65 - Math.floor(i / 3) * 0.3, 0.09, false)));
  g.add(box(0.8, 0.05, 0.12, "#8a5a33", 0, 1.02, 0.1, false));
  return g;
}
function makeMoodBoard() {
  const g = new THREE.Group();
  g.add(box(2.0, 1.3, 0.05, "#e9e2d0", 0, 1.7, 0));
  ["#ff6b6b", "#ffd84d", "#4dabf7", "#69db7c", "#b197fc", "#ff9bb3", "#2f9c95", "#ffb35c"].forEach((c, i) =>
    g.add(box(0.38, 0.3, 0.02, c, -0.7 + (i % 4) * 0.47, 1.95 - Math.floor(i / 4) * 0.5, 0.04, false)));
  g.add(box(0.05, 1.1, 0.05, "#7b8496", -0.8, 0.55, 0, false), box(0.05, 1.1, 0.05, "#7b8496", 0.8, 0.55, 0, false));
  return g;
}
function makeFilingCabinets() {
  const g = new THREE.Group();
  for (let i = 0; i < 3; i++) {
    g.add(box(0.6, 1.5, 0.65, "#9aa3b2", -0.65 + i * 0.65, 0.75, 0));
    for (let k = 0; k < 4; k++) g.add(box(0.18, 0.04, 0.02, "#e0e4ea", -0.65 + i * 0.65, 0.3 + k * 0.35, 0.34, false));
  }
  return g;
}
function makeSafe() {
  const g = new THREE.Group();
  g.add(box(0.8, 0.9, 0.7, "#3b4254", 0, 0.45, 0));
  const dial = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.04, 14), toon("#c9a227")); dial.rotation.x = Math.PI / 2; dial.position.set(0.1, 0.5, 0.36); g.add(dial);
  g.add(box(0.05, 0.3, 0.04, "#c9a227", -0.2, 0.5, 0.36, false));
  return g;
}
function makeBillboard(view) {             // a campaign poster with a rising arrow, and a megaphone
  const g = new THREE.Group();
  g.add(box(2.2, 1.3, 0.06, "#ff7a59", 0, 1.8, 0), box(1.9, 1.05, 0.02, "#fff4ec", 0, 1.8, 0.04, false));
  g.add(box(0.7, 0.18, 0.02, "#ff7a59", -0.45, 2.1, 0.06, false), box(0.9, 0.08, 0.02, "#2d3442", -0.35, 1.85, 0.06, false));
  const arrow = box(1.0, 0.08, 0.02, "#2f9c95", 0.35, 1.6, 0.06, false); arrow.rotation.z = 0.6; g.add(arrow);
  g.add(box(0.05, 1.2, 0.05, "#7b8496", -0.9, 0.6, 0, false), box(0.05, 1.2, 0.05, "#7b8496", 0.9, 0.6, 0, false));
  const mega = new THREE.Mesh(new THREE.ConeGeometry(0.22, 0.55, 14, 1, true), toon("#ffd84d"));
  mega.rotation.z = Math.PI / 2; mega.position.set(1.4, 1.0, 0.3); g.add(mega);
  g.add(box(0.3, 1.0, 0.3, "#d9d2c5", 1.4, 0.5, 0.3, false));
  view.anim.push((time, busy) => { mega.rotation.x = busy ? Math.sin(time * 6) * 0.15 : 0; });
  return g;
}
function makeCounter(label) {              // a help desk counter
  const g = new THREE.Group();
  g.add(box(2.4, 1.0, 0.6, "#2f9c95", 0, 0.5, 0), box(2.6, 0.08, 0.8, "#ffffff", 0, 1.04, 0));
  return g;                                                                       // its name hangs on the wall (see wallSigns)
}
function makeBeanBag(color) {
  const m = new THREE.Mesh(new THREE.SphereGeometry(0.45, 14, 10), toon(color)); m.scale.y = 0.6; m.position.y = 0.27; m.castShadow = true;
  const g = new THREE.Group(); g.add(m); return g;
}
function makeCoffeeBar() {
  const g = new THREE.Group();
  g.add(box(1.4, 0.95, 0.6, "#8a5a33", 0, 0.47, 0), box(1.5, 0.06, 0.7, "#f4f1ea", 0, 0.98, 0));
  g.add(box(0.4, 0.55, 0.4, "#2d3442", -0.35, 1.3, 0), box(0.1, 0.12, 0.1, "#ffffff", 0.3, 1.07, 0.1, false), box(0.1, 0.12, 0.1, "#ff7a59", 0.48, 1.07, 0.1, false));
  return g;
}
function makeKanban() {                    // a whiteboard with three columns of sticky notes
  const g = new THREE.Group();
  g.add(box(2.4, 1.4, 0.06, "#ffffff", 0, 1.75, 0), box(2.5, 0.06, 0.1, "#2d3442", 0, 1.03, 0.02, false));
  for (let c = 0; c < 3; c++) {
    if (c < 2) g.add(box(0.02, 1.2, 0.02, "#c7ced9", -0.4 + c * 0.8, 1.75, 0.04, false));
    for (let r = 0; r < 3 - c % 2; r++) g.add(box(0.28, 0.22, 0.02, STICKY[(c * 3 + r) % STICKY.length], -0.8 + c * 0.8, 2.2 - r * 0.32, 0.05, false));
  }
  g.add(box(0.06, 1.0, 0.06, "#7b8496", -1.0, 0.5, 0, false), box(0.06, 1.0, 0.06, "#7b8496", 1.0, 0.5, 0, false));
  return g;
}

// Each department's room: what hangs on the back wall, what stands in the free space beside the desks (side: how much
// wider the room is made for it), and how its floor looks.
const ROOMS = {
  business:    { side: 3.2, back: v => makeChartBoard(null, "#c9a227"), aside: () => makeMeetingTable(6, "#8a5a33"), floor: "#e9dcc0" },
  finance:     { side: 2.6, back: () => makeFilingCabinets(), aside: () => makeSafe(), floor: "#e7e2d4" },
  product:     { side: 3.2, back: () => makeKanban(), aside: () => makeMeetingTable(4), floor: null },
  design:      { side: 2.6, back: () => makeMoodBoard(), aside: () => makeEasel(), floor: "#f3e6f0" },
  engineering: { side: 2.6, back: () => makeKanban(), aside: () => { const g = makeCoffeeBar(); const b1 = makeBeanBag("#ff7a59"); b1.position.set(-0.4, 0, 1.4); const b2 = makeBeanBag("#4dabf7"); b2.position.set(0.5, 0, 1.6); g.add(b1, b2); return g; }, floor: "#d9e3ee" },
  infra:       { side: 2.6, back: v => { const g = new THREE.Group(); [-1.0, 0, 1.0].forEach(x => { const r = makeServerRack(v); r.position.x = x; g.add(r); }); return g; }, aside: v => makeServerRack(v), floor: "#d4d9e0" },
  data:        { side: 2.4, back: v => makeWallScreen(v), aside: () => makeChartBoard(null, "#2f9c95"), floor: "#d8ecef" },
  marketing:   { side: 2.6, back: v => makeBillboard(v), aside: () => makeMeetingTable(4, "#ffd84d"), floor: "#fbe7dc" },
  support:     { side: 3.0, back: () => makeWhiteboard(4), aside: () => { const g = makeCounter(t("Help desk")); const s = makeSofa("#cfe8e5"); s.position.set(0, 0, 1.6); s.rotation.y = Math.PI; g.add(s); return g; }, floor: "#dff1ee" },
};

export class OfficeView {
  // opts.layout: "bands" (Office 1: the lobby in the middle, rooms around it), "rect" (Office 2: one rectangle,
  // rooms packed in rows, the CEO in the front right corner) or "cubicle" (Office 3: the same rectangle as one open
  // floor; every agent works in a cubicle, departments are carpet areas, only the CEO has a room, with glass walls)
  // opts.style "town" (Office 3 on screen): the open-plan floor as a game-style shop on a street, with a road,
  // neighbours, trees, parked motorbikes and a neon sign; chunky staff in caps; the camera can rotate around it.
  constructor(container, viz, opts = {}) {
    this.layout = opts.layout || "bands";
    this.town = opts.style === "town";
    this.container = container;
    this.viz = viz;
    this.people = new Map();       // node key -> workplace
    this.flights = [];
    this.clock = new THREE.Clock();
    this.layoutKey = "";

    const w = container.clientWidth || 800, h = container.clientHeight || 600;
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.toneMapping = THREE.NeutralToneMapping; this.renderer.toneMappingExposure = 1.0;
    this.renderer.setSize(w, h);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.domElement.className = "floor3d-canvas";
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    {   // a soft light-grey backdrop, a little lighter at the top
      const c = document.createElement("canvas"); c.width = 4; c.height = 256;
      const g = c.getContext("2d"), gr = g.createLinearGradient(0, 0, 0, 256);
      gr.addColorStop(0, "#f6f7f8"); gr.addColorStop(1, "#dfe3e8"); g.fillStyle = gr; g.fillRect(0, 0, 4, 256);
      const bg = new THREE.CanvasTexture(c); bg.colorSpace = THREE.SRGBColorSpace; this.scene.background = bg;
    }
    // light bouncing around a room: soft, even, with gentle reflections
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.55;
    this.frustum = 40;
    this.camera = new THREE.OrthographicCamera(-20, 20, 20, -20, 1, 600);
    this.camera.layers.enable(1);                                                  // labels
    this.aoCamera = this.camera.clone(); this.aoCamera.layers.set(0);             // ambient occlusion: no labels
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    Object.assign(this.controls, { enableDamping: true, dampingFactor: 0.08, minZoom: 1, maxZoom: 5, enableRotate: false, enablePan: true, screenSpacePanning: true, autoRotate: false, zoomToCursor: true });
    this.controls.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
    this.controls.touches = { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_PAN };

    this.scene.add(new THREE.HemisphereLight("#ffffff", "#e6dccf", 0.7));
    this.sun = new THREE.DirectionalLight("#fff1dc", 1.7);                       // warm daylight
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0004; this.sun.shadow.normalBias = 0.02; this.sun.shadow.radius = 5;
    this.scene.add(this.sun, this.sun.target);
    if (this.town) this.townLook();

    // post-processing for "High" quality: ambient occlusion (soft shading where things meet), SMAA edges
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.gtao = new GTAOPass(this.scene, this.aoCamera, w, h);
    this.gtao.updateGtaoMaterial({ radius: 0.6, distanceExponent: 1.5, thickness: 1.5, scale: 1.0, samples: 16 });
    this.gtao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, rings: 2, samples: 16 });
    this.gtao.blendIntensity = 1.0;
    this.composer.addPass(this.gtao);
    this.smaa = new SMAAPass(w * this.renderer.getPixelRatio(), h * this.renderer.getPixelRatio());
    this.composer.addPass(this.smaa);
    this.composer.addPass(new OutputPass());
    this.setQuality(opts.quality || "high");

    this.world = new THREE.Group(); this.scene.add(this.world);

    this.raycaster = new THREE.Raycaster(); this.pointer = new THREE.Vector2();
    let down = null;
    const el = this.renderer.domElement;
    el.addEventListener("pointerdown", e => { down = [e.clientX, e.clientY]; });
    el.addEventListener("pointerup", e => {
      if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 5) return;
      const hit = this.pick(e); if (hit) this.viz.onAgentClick?.(hit.base);
    });
    el.addEventListener("pointermove", e => { const hit = this.pick(e); this.hover = hit?.key || null; el.style.cursor = hit ? "pointer" : "grab"; });

    this.resizeObs = new ResizeObserver(() => this.resize());
    this.resizeObs.observe(container);
    this.running = true;
    this.tick = this.tick.bind(this);
    requestAnimationFrame(this.tick);
  }

  // ---------- the building (rebuilt when the set of agents changes) ----------
  syncLayout() {
    const nodes = this.viz.nodes || {};
    const key = Object.keys(nodes).join("|");
    if (key === this.layoutKey && nodes === this.nodesObj) return;
    const before = new Set(this.people.keys()), firstBuild = !this.layoutKey;
    this.layoutKey = key; this.nodesObj = nodes;
    this.world.clear(); this.people.clear(); this.anim = []; LABELS.clear(); this.signs = []; this.obstacles = [];
    const meta = this.viz.meta; if (!meta) return;

    let LW = 10, LD = 8;
    this.lobby = { x: 0, z: 0, y: 0, w: LW, d: LD };
    this.entrance = new THREE.Vector3(3.4, 0, 3.4);

    // ----- the departments: one room each, around the lobby -----
    const byDept = {};
    for (const [k, n] of Object.entries(nodes)) (byDept[n.dept] ||= []).push([k, n]);
    const order = Object.keys(meta.departments || {}).filter(d => byDept[d]);
    for (const d of Object.keys(byDept)) if (!order.includes(d)) order.push(d);
    const rooms = order.map((dept, i) => {
      const list = byDept[dept];
      const cols = list.length >= 5 ? 3 : list.length >= 2 ? 2 : 1;
      const cells = gridCells(list, cols);
      const rows = Math.max(...cells.map(c => c.r)) + 1;
      const theme = ROOMS[dept] || { side: 0, back: () => makeWhiteboard(hash(dept)), aside: null, floor: null };
      const deskW = Math.max(3.8, cols * DESK_W + 1.2);
      return { dept, list, cols, cells, rows, theme, deskW, w: deskW + 1.4 + theme.side, d: Math.max(rows * DESK_D + 3.2, 6.4) };
    });
    if (this.layout === "rect" || this.layout === "cubicle") { [LW, LD] = this.packRect(rooms, LW, LD); }
    else {
      // One tidy building in three bands: the lobby in the middle band with one room on each side, the other rooms in
      // a band behind it and a band in front of it. Each room is as wide as its people and furniture need, so a room
      // with more agents is bigger; the rooms of a band stand side by side and share their walls, and all rooms of a
      // band are as deep as its deepest room, so the bands fit together. Doors in the shared walls lead to the lobby.
      const side = rooms.slice(2, 4), rest = [...rooms.slice(0, 2), ...rooms.slice(4)];
      const bands = [[], []];                                          // 0: behind the lobby, 1: in front of it
      const widthOf = b => b.reduce((a, r) => a + r.w, 0);
      for (const r of rest) bands[widthOf(bands[0]) <= widthOf(bands[1]) ? 0 : 1].push(r);
      LD = Math.max(LD, ...side.map(r => r.d));
      LW = 11;
      const D0 = Math.max(0, ...bands[0].map(r => r.d)), D2 = Math.max(0, ...bands[1].map(r => r.d));
      const pack = (band, z, d) => { let x = -widthOf(band) / 2; for (const r of band) { Object.assign(r, { x: x + r.w / 2, z, d, y: 0, band }); x += r.w; } };
      pack(bands[0], -LD / 2 - D0 / 2, D0);
      pack(bands[1], LD / 2 + D2 / 2, D2);
      if (side[0]) Object.assign(side[0], { x: -LW / 2 - side[0].w / 2, z: 0, d: LD, y: 0, band: null });
      if (side[1]) Object.assign(side[1], { x: LW / 2 + side[1].w / 2, z: 0, d: LD, y: 0, band: null });
      for (const r of rooms) r.front = !!r.band && r.band === bands[1];
    }
    Object.assign(this.lobby, { w: LW, d: LD });
    // ----- the lobby with the CEO, in the middle -----
    const lobby = new THREE.Group(); this.world.add(lobby);
    const ceoDesk = new THREE.Group(); ceoDesk.position.set(-LW / 2 + 3.4, 0, -1.2); lobby.add(ceoDesk);
    ceoDesk.add(box(2.6, 0.1, 1.2, "#8a5a33", 0, 0.92, 0), box(2.6, 0.88, 0.12, "#6e4527", 0, 0.46, -0.54), box(0.12, 0.88, 1.1, "#6e4527", -1.24, 0.46, 0), box(0.12, 0.88, 1.1, "#6e4527", 1.24, 0.46, 0));
    ceoDesk.add(box(0.9, 0.6, 0.06, "#1d222c", 0.5, 1.3, -0.35), box(0.08, 0.3, 0.08, "#3b4254", 0.5, 1.0, -0.35, false));
    ceoDesk.add(box(0.7, 1.1, 0.12, "#22262f", 0, 0.95, 1.35), box(0.7, 0.1, 0.6, "#22262f", 0, 0.55, 1.05));
    this.ceo = makePerson("#2b3040", 11);
    if (this.town) chibi(this.ceo, "#f2b705");
    poseSit(this.ceo); this.ceo.g.position.set(-LW / 2 + 3.4, 0, -0.15); this.ceo.g.rotation.y = Math.PI; lobby.add(this.ceo.g);
    lobby.add(box(1.8, 1.0, 0.1, "#151922", -LW / 2 + 3.4, 1.6, -LD / 2 + 0.5), box(1.9, 0.5, 0.5, "#8a5a33", -LW / 2 + 3.4, 0.25, -LD / 2 + 0.5));   // TV wall
    const sofa1 = makeSofa("#f2a33a"); sofa1.position.set(LW / 2 - 2.6, 0, -1.6); lobby.add(sofa1);
    const sofa2 = makeSofa("#f2a33a"); sofa2.position.set(LW / 2 - 2.6, 0, 1.4); sofa2.rotation.y = Math.PI; lobby.add(sofa2);
    lobby.add(box(1.3, 0.08, 0.9, "#f28c38", LW / 2 - 2.6, 0.45, -0.1), box(1.2, 0.04, 0.8, "#2d3442", LW / 2 - 2.6, 0.1, -0.1, false));
    lobby.add(box(2.8, 1.0, 0.6, "#2b6f7a", -0.6, 0.5, LD / 2 - 1.3), box(3.0, 0.08, 0.8, "#ffffff", -0.6, 1.04, LD / 2 - 1.3));   // reception
    for (const [x, z] of [[-LW / 2 + 0.6, -LD / 2 + 0.6], [LW / 2 - 0.6, -LD / 2 + 0.6], [LW / 2 - 0.6, LD / 2 - 0.6], [-LW / 2 + 0.6, LD / 2 - 0.6]]) { const p = makePlant(); p.position.set(x, 0, z); lobby.add(p); }
    this.obstacles.push(...lobby.children.filter(c => !c.isSprite));            // the CEO, desk, sofas, tables, reception...
    this.ceoPos = new THREE.Vector3(-LW / 2 + 3.4, 1.5, -0.15);
    this.entrance.set(LW / 2 - 1.5, 0, LD / 2 - 0.8);


    // where each room's door leads: the lobby when the room touches it, otherwise the neighbour toward the middle
    const overlapX = (a, b) => Math.min(a.x + a.w / 2, b.x + b.w / 2) - Math.max(a.x - a.w / 2, b.x - b.w / 2);
    const open = this.layout === "cubicle";                                    // one open floor: no walls, no doors
    if (open) for (const room of rooms) room.link = this.lobby;
    else if (this.layout === "rect") this.linkByWalls(rooms);
    else for (const room of rooms) {
      if (!room.band) { room.link = this.lobby; continue; }
      if (overlapX(room, this.lobby) >= 1.8) { room.link = this.lobby; continue; }
      const i = room.band.indexOf(room);
      room.link = room.band[room.x < 0 ? i + 1 : i - 1] || this.lobby;
    }
    for (const r of [this.lobby, ...rooms]) r.doors = { back: [], left: [] };
    this.lobby.route = [this.entrance.clone()];
    for (const room of rooms) {
      if (open) { room.doorIn = []; room.front = true; continue; }
      // the shared wall belongs to the room on the right (its left wall) or in front (its back wall)
      const a = room, b = room.link, v = new THREE.Vector3();
      const side = Math.abs(Math.abs(a.x - b.x) - (a.w + b.w) / 2) < 0.01;
      let inA, inB;
      if (side) {
        const owner = a.x > b.x ? a : b, wallX = owner.x - owner.w / 2;
        const z = Math.min(a.z + a.d / 2, b.z + b.d / 2) - 1.5;                  // toward the front, clear of the desks
        owner.doors.left.push(z);
        inA = new THREE.Vector3(wallX + Math.sign(a.x - b.x) * 0.9, 0, z); inB = new THREE.Vector3(wallX - Math.sign(a.x - b.x) * 0.9, 0, z);
      } else {
        const owner = a.z > b.z ? a : b, wallZ = owner.z - owner.d / 2;
        const x = Math.max(Math.max(a.x - a.w / 2, b.x - b.w / 2) + 0.9, Math.min(a.x + a.w / 2, b.x + b.w / 2) - 1.2);   // toward the right, clear of the boards
        owner.doors.back.push(x);
        inA = new THREE.Vector3(x, 0, wallZ + Math.sign(a.z - b.z) * 0.9); inB = new THREE.Vector3(x, 0, wallZ - Math.sign(a.z - b.z) * 0.9);
      }
      room.doorIn = [inB, inA];
    }
    // routes from the entrance through the doors
    const routeOf = r => r.route || (r.route = [...routeOf(r.link), ...r.doorIn]);
    for (const room of rooms) routeOf(room);
    if (open) {
      this.openFloor([this.lobby, ...rooms]);
      this.glassRoom(0, 0, LW, LD);
    } else this.platform(0, 0, 0, LW, LD, "#f28c38", this.lobby.doors);
    // the CEO's status on a plaque on the lobby's back wall, right of the TV, where no doorway is
    const PW = 4.0, doorsBack = this.lobby.doors.back;
    let px = -LW / 2 + 3.4 + 1.2 + PW / 2, bestGap = -1;
    for (let x = -LW / 2 + 3.4 + 1.2 + PW / 2; x <= LW / 2 - PW / 2 - 0.3; x += 0.25) {
      const gap = Math.min(99, ...doorsBack.map(d => Math.abs(d - x) - PW / 2 - 0.7));
      if (gap > bestGap + 0.01 && (bestGap < 0 || gap >= 0)) { bestGap = gap; px = x; }
      if (gap >= 0) break;                                                       // the first free spot next to the TV
    }
    // the lobby's name on the floor, like every room: in the open space between the CEO's desk and the sofas
    // (in front of the reception desk it would be hidden behind it)
    const lobbySign = floorLabel(t("CEO"), new THREE.Color("#f28c38"), 2.4);
    lobbySign.position.set(0.55, 0.012, 0.5); this.world.add(lobbySign); this.signs.push(lobbySign); lobbySign.userData.room = this.lobby;
    this.ceoPlaque = wallPlaque(PW, 1.4);
    this.ceoPlaque.position.set(px, 0.92, -LD / 2 + 0.19);
    this.world.add(this.ceoPlaque);

    for (const room of rooms) {
      const dc = cssColor(`--d-${room.dept}`, "#4aa3ff");
      const th = room.theme;
      if (open) {   // a department area: a carpet in its colour on the open floor
        const carpet = new THREE.Mesh(new THREE.BoxGeometry(room.w - 0.5, 0.025, room.d - 0.5),
          new THREE.MeshStandardMaterial({ color: dc.clone().lerp(new THREE.Color("#ffffff"), 0.7), roughness: 0.95 }));
        carpet.position.set(room.x, 0.013, room.z); carpet.receiveShadow = true; this.world.add(carpet);
      } else this.platform(room.x, room.y, room.z, room.w, room.d, dc, room.doors);
      const g = new THREE.Group(); g.position.set(room.x, room.y, room.z); this.world.add(g);

      // the department's furniture: on the back wall (behind the desks) and in the space beside the desks
      const local = { anim: [] };
      const deskX = -room.w / 2 + 0.7 + room.deskW / 2;                             // centre of the desk area (left part)
      const back = th.back(local); back.position.set(deskX, 0, -room.d / 2 + 0.75); g.add(back); this.obstacles.push(back);
      // keep the doorways in the back wall clear: furniture in front of one moves to the side of it
      for (const dx of room.doors.back) {
        back.updateWorldMatrix(true, true);
        const bb = new THREE.Box3().setFromObject(back), gap = 0.65 + 0.6;
        if (bb.max.x < dx - gap || bb.min.x > dx + gap) continue;
        const right = dx + gap - bb.min.x, left = dx - gap - bb.max.x;            // shifts that clear the doorway
        const fitsRight = bb.max.x + right <= room.x + room.w / 2 - 0.3;
        back.position.x += fitsRight ? right : left;
      }
      if (th.aside) { const a = th.aside(local); a.position.set(room.w / 2 - 0.35 - th.side / 2, 0, 0.3); g.add(a); this.obstacles.push(a); }
      this.anim.push(...local.anim.map(fn => ({ fn, dept: room.dept })));
      // a plaque on the back wall for rooms with a counter (like the CEO's): above the counter, clear of doorways
      if (room.dept === "support") {
        const PW = 3.0, want = room.w / 2 - 0.35 - th.side / 2;                   // over the help desk
        let px = want;
        for (const dx of room.doors.back) if (Math.abs(room.x + px - dx) < PW / 2 + 0.8) px = dx - room.x - Math.sign(dx - room.x - px || 1) * (PW / 2 + 0.8);
        px = Math.max(-room.w / 2 + PW / 2 + 0.3, Math.min(room.w / 2 - PW / 2 - 0.3, px));
        const plaque = wallPlaque(PW, 1.0);
        plaque.userData.set([t("Help desk"), ""], "#2f9c95", false);
        plaque.position.set(px, 0.92, -room.d / 2 + 0.19); g.add(plaque);
        if (open) {   // no wall in the open office: the sign stands on two posts
          plaque.position.y = 1.5;
          for (const sx of [-PW / 2 + 0.15, PW / 2 - 0.15]) { const post = box(0.06, 1.0, 0.06, "#9aa3ad", px + sx, 0.5, -room.d / 2 + 0.16, false); g.add(post); }
        }
      }
      const pl = makePlant(0.9); pl.position.set(room.w / 2 - 0.5, 0, room.d / 2 - 0.5); g.add(pl); this.obstacles.push(pl);
      room.deskX = deskX;
      // The department's name painted on the floor. Front-row rooms: along the open front edge. Rooms with another
      // room in front: further in (that room's back wall hides the strip just behind it), in front of the desks and
      // clear of the furniture beside them.
      const front = room.front;
      const sign = floorLabel(nm(meta.departments[room.dept], "name") || room.dept, dc, front ? room.w - 1.6 : Math.max(room.deskW, room.w - 2.6));
      const sw = sign.geometry.parameters.width;                                   // back rooms: from the left, away from the furniture on the right
      sign.position.set(front ? 0 : -room.w / 2 + 1.0 + sw / 2, 0.012, room.d / 2 - (front ? 0.75 : 2.5)); g.add(sign); this.signs.push(sign); sign.userData.room = room;

      // desks and people: the desks of one role side by side
      const left0 = room.deskX - (room.cols - 1) * DESK_W / 2, top0 = -room.d / 2 + 2.1;
      room.list.forEach(([k, nd], i) => {
        const { c, r } = room.cells[i];
        const pos = new THREE.Vector3(room.x + left0 + c * DESK_W, room.y, room.z + top0 + r * DESK_D);
        this.people.set(k, this.makeWorkplace(k, nd, pos, room, firstBuild || before.has(k)));
      });
    }

    const xs = rooms.flatMap(r => [r.x - r.w / 2, r.x + r.w / 2]).concat([-LW / 2, LW / 2]);
    const zs = rooms.flatMap(r => [r.z - r.d / 2, r.z + r.d / 2]).concat([-LD / 2, LD / 2]);
    this.bounds = { minX: Math.min(...xs), maxX: Math.max(...xs), minZ: Math.min(...zs), maxZ: Math.max(...zs) };
    this.rects = [this.lobby, ...rooms].map(r => ({ x0: r.x - r.w / 2, x1: r.x + r.w / 2, z0: r.z - r.d / 2, z1: r.z + r.d / 2, y: r.y }));
    const span = Math.max(this.bounds.maxX - this.bounds.minX, this.bounds.maxZ - this.bounds.minZ) * (this.town ? 1.9 : 1);   // town: shadows on the street too
    Object.assign(this.sun.shadow.camera, { left: -span * 0.75, right: span * 0.75, top: span * 0.75, bottom: -span * 0.75, near: 1, far: span * 4 });
    this.sun.position.set(span * 0.45, span * 1.2, span * 0.3); this.sun.target.position.set(0, 0, 0);
    this.sun.shadow.camera.updateProjectionMatrix();
    if (this.town) this.buildTown();
    this.buildNav();
    this.placeFloorLabels();
    for (const p of this.people.values()) if (p.walkIn) {
      p.walkIn = false;
      const aisle = this.aisleOf(p);
      Object.assign(p, { path: [this.entrance.clone(), ...this.navPath(this.entrance, aisle), p.seat.clone()], seg: 0, segT: 0, dwell: null, handover: null, speed: 3 });
    }
    if (!this.framed) { this.frame(); this.framed = true; }
  }

  // Office 3: one open floor under everything, with the building's own walls at the back and on the left.
  openFloor(rects) {
    const x0 = Math.min(...rects.map(r => r.x - r.w / 2)), x1 = Math.max(...rects.map(r => r.x + r.w / 2));
    const z0 = Math.min(...rects.map(r => r.z - r.d / 2)), z1 = Math.max(...rects.map(r => r.z + r.d / 2));
    const w = x1 - x0, d = z1 - z0, x = (x0 + x1) / 2, z = (z0 + z1) / 2;
    this.world.add(box(w, RIM, d, "#d9d3ca", x, -RIM / 2 - 0.08, z));
    this.world.add(box(w, 0.06, d, "#e9ecef", x, -0.11, z, false));
    const floor = new THREE.Mesh(new THREE.BoxGeometry(w, 0.1, d), woodFloor(w, d));
    floor.position.set(x, -0.05, z); floor.receiveShadow = true; this.world.add(floor);
    const H = 1.7, T = 0.18, wall = "#f7f5f0";
    const back = box(w, H, T, wall, x, H / 2, z0 + T / 2), left = box(T, H, d, "#efece6", x0 + T / 2, H / 2, z);
    this.world.add(back, left); this.obstacles.push(back, left);
    for (let wx = x0 + 3; wx < x1 - 2; wx += 6)                                    // windows along the back wall
      this.world.add(box(2.4, 0.8, 0.04, "#dff1fb", wx, 0.95, z0 + T + 0.01, false));
  }

  // Office 3: the CEO's room, glass walls in slim aluminium frames on the two sides that face the floor, a doorway
  // in the left wall toward the front.
  glassRoom(x, z, w, d) {
    const H = 1.9, DOOR = 1.4, doorZ = z + d / 2 - 1.6;
    const glass = new THREE.MeshPhysicalMaterial({ color: "#d8eef8", transparent: true, opacity: 0.28, roughness: 0.05, metalness: 0, depthWrite: false });
    const frame = "#9aa3ad";
    const pane = (len, along, cx, cz) => {
      const m = new THREE.Mesh(along === "x" ? new THREE.BoxGeometry(len, H, 0.05) : new THREE.BoxGeometry(0.05, H, len), glass);
      m.position.set(cx, H / 2, cz); m.renderOrder = 2; this.world.add(m); this.obstacles.push(m);
      // frame: a rail on top and at the floor, posts every ~1.6 m
      this.world.add(along === "x" ? box(len, 0.05, 0.08, frame, cx, H, cz, false) : box(0.08, 0.05, len, frame, cx, H, cz, false));
      this.world.add(along === "x" ? box(len, 0.06, 0.08, frame, cx, 0.03, cz, false) : box(0.08, 0.06, len, frame, cx, 0.03, cz, false));
      const n = Math.max(1, Math.round(len / 1.6));
      for (let i = 0; i <= n; i++) {
        const t = -len / 2 + (len * i) / n;
        this.world.add(along === "x" ? box(0.05, H, 0.08, frame, cx + t, H / 2, cz, false) : box(0.08, H, 0.05, frame, cx, H / 2, cz + t, false));
      }
    };
    const bz = z - d / 2 + 0.1, lx = x - w / 2 + 0.1;
    pane(w - 0.1, "x", x + 0.05, bz);                                               // back
    const a = z - d / 2 + 0.1, b = doorZ - DOOR / 2, c = doorZ + DOOR / 2, e = z + d / 2;
    pane(b - a, "z", lx, (a + b) / 2);                                              // left, behind the doorway
    if (e - c > 0.2) pane(e - c, "z", lx, (c + e) / 2);                             // left, in front of it
    // a lighter floor inside the CEO's room
    const rug = new THREE.Mesh(new THREE.BoxGeometry(w - 0.6, 0.02, d - 0.6), new THREE.MeshStandardMaterial({ color: "#f3e7da", roughness: 0.95 }));
    rug.position.set(x + 0.15, 0.012, z + 0.15); rug.receiveShadow = true; this.world.add(rug);
  }

  // A clean room block: white floor on a coloured base slab, with two pastel walls (back and left) like a cut-away.
  // doors.back / doors.left: where the doorways are (world x along the back wall, world z along the left wall).
  platform(x, y, z, w, d, accent, doors = { back: [], left: [] }) {
    const base = new THREE.Color("#d9d3ca");                                                  // a light, warm base
    const wall = new THREE.Color(accent).lerp(new THREE.Color("#fbfaf7"), 0.86);               // warm white, a hint of the room colour
    const wallSide = wall.clone().offsetHSL(0, 0, -0.05);
    this.world.add(box(w, RIM, d, base, x, y - RIM / 2 - 0.08, z));
    this.world.add(box(w, 0.06, d, "#e9ecef", x, y - 0.11, z, false));                      // a thin light edge
    const floor = new THREE.Mesh(new THREE.BoxGeometry(w, 0.1, d), woodFloor(w, d));            // light wood floor
    floor.position.set(x, y - 0.05, z); floor.receiveShadow = true; this.world.add(floor);
    const H = 1.7, T = 0.18, DOOR = 1.3, DH = 1.45;            // low walls: the rooms behind stay visible
    // a wall along one axis, with an open doorway (no door) wherever a room leads to the next
    const wallAlong = (axis, from, to, fixed, gaps, color) => {
      const cuts = gaps.map(g => [g - DOOR / 2, g + DOOR / 2]).sort((a, b) => a[0] - b[0]);
      let at = from;
      const seg = (a, b, h = H, y0 = 0) => {
        if (b - a < 0.02) return;
        const len = b - a, mid = (a + b) / 2;
        const wallBox = axis === "x" ? box(len, h, T, color, mid, y + y0 + h / 2, fixed) : box(T, h, len, color, fixed, y + y0 + h / 2, mid);
        this.world.add(wallBox);
        if (y0 === 0) this.obstacles.push(wallBox);                                 // walls block; the doorways stay open
      };
      for (const [a, b] of cuts) {
        seg(at, a);
        seg(a, b, H - DH, DH);                                                     // above the doorway
        at = b;
      }
      seg(at, to);
    };
    wallAlong("x", x - w / 2, x + w / 2, z - d / 2 + T / 2, doors.back || [], wall);       // back wall
    wallAlong("z", z - d / 2, z + d / 2, x - w / 2 + T / 2, doors.left || [], wallSide);   // left wall
    // a window on the left wall, away from any door
    const winZ = z + d / 2 - 1.2;
    if (!(doors.left || []).some(g => Math.abs(g - winZ) < DOOR)) this.world.add(box(0.04, 0.8, 1.2, "#dff1fb", x - w / 2 + T + 0.01, y + 0.95, winZ, false));
  }

  makeWorkplace(key, n, pos, room, seated) {
    const color = roleColor(n.base);
    const desk = makeDesk(color, n.dept);
    desk.g.position.copy(pos); this.world.add(desk.g); this.obstacles.push(desk.g);
    if (this.layout === "cubicle") {
      const panel = "#c9ced6", trim = color.clone().lerp(new THREE.Color("#ffffff"), 0.15), H = 1.25;
      const cub = new THREE.Group();
      cub.add(box(2.36, H, 0.06, panel, 0, H / 2, -0.56), box(2.36, 0.05, 0.08, trim, 0, H + 0.02, -0.56));            // back
      for (const sx of [-1.18, 1.18])
        cub.add(box(0.06, H, 1.56, panel, sx, H / 2, 0.22), box(0.08, 0.05, 1.56, trim, sx, H + 0.02, 0.22));          // sides
      desk.g.add(cub);
    }
    const seed = hash(key);
    const person = makePerson(color, seed, OUTFITS[n.dept] || {});
    if (this.town) chibi(person, cssColor(`--d-${n.dept}`, "#4aa3ff"));
    const seat = pos.clone().add(new THREE.Vector3(0, 0, 0.85));
    this.world.add(person.g);
    const label = labelSprite([this.roleName(n)]);
    label.position.copy(seat).setY(seat.y + 2.3); this.world.add(label);
    const p = { key, base: n.base, node: n, person, desk, seat, label, color, room, phase: (seed % 100) / 16, glow: 0, nextWander: this.clock.elapsedTime + 15 + Math.random() * 45, wasWorking: n.g.classList.contains("working") };
    if (seated) { person.g.position.copy(seat); person.g.rotation.y = Math.PI; poseSit(person); }
    else {   // a new colleague: from the entrance, through the doors, to the free desk
      poseStand(person);
      p.walkIn = true;                                                            // planned in syncLayout, after buildNav()
      person.g.position.copy(this.entrance);
    }
    return p;
  }

  // Office 2: rooms packed in rows into one rectangle. Rows are filled with rooms of similar depth (deepest first),
  // each row is stretched to the full width so the outline is a clean rectangle, and the CEO's room closes the
  // front row in the right corner. The width is chosen for little empty floor and a wide, landscape shape.
  packRect(rooms, LW, LD) {
    const sorted = [...rooms].sort((a, b) => b.d - a.d || b.w - a.w);
    const lobby = { lobby: true, w: 11, d: LD };
    const rowsFor = W => {
      const rows = []; let row = [], used = 0;
      for (const r of sorted) {
        if (row.length && used + r.w > W) { rows.push(row); row = []; used = 0; }
        row.push(r); used += r.w;
      }
      if (row.length) rows.push(row);
      const last = rows[rows.length - 1];
      if (last && last.reduce((a, r) => a + r.w, 0) + lobby.w <= W) last.push(lobby); else rows.push([lobby]);
      return rows;
    };
    const minW = Math.max(lobby.w, ...rooms.map(r => r.w)), sumW = rooms.reduce((a, r) => a + r.w, 0) + lobby.w;
    let best = null;
    for (let W = minW; W <= sumW + 0.01; W += 0.5) {
      const rows = rowsFor(W), D = rows.reduce((a, row) => a + Math.max(...row.map(r => r.d)), 0);
      const need = rooms.reduce((a, r) => a + r.w * r.d, 0) + lobby.w * lobby.d;
      const score = (W * D) / need * (1 + 0.35 * Math.abs(Math.log((W / D) / 1.5)));
      if (!best || score < best.score) best = { W, rows, score };
    }
    const { W, rows } = best;
    let z = 0;
    for (const [ri, row] of rows.entries()) {
      const d = Math.max(...row.map(r => r.d)), natural = row.reduce((a, r) => a + r.w, 0);
      const grow = row.filter(r => !r.lobby), extra = W - natural;               // the rooms (not the CEO's) take up the slack
      const growW = grow.reduce((a, r) => a + r.w, 0) || 1;
      let x = 0;
      for (const r of row) {
        if (!r.lobby || !grow.length) r.w += grow.length ? extra * r.w / growW : extra;
        Object.assign(r, { x: x + r.w / 2, z: z + d / 2, d, y: 0, front: ri === rows.length - 1, band: null });
        x += r.w;
      }
      z += d;
    }
    // everything relative to the CEO's room, whose layout code expects it at the origin
    for (const r of rooms) { r.x -= lobby.x; r.z -= lobby.z; }
    return [lobby.w, lobby.d];
  }

  // Office 2: every room's door leads one step closer to the CEO's room, through a wall it shares with its neighbour.
  linkByWalls(rooms) {
    const all = [this.lobby, ...rooms];
    const touch = (a, b) => {
      const ox = Math.min(a.x + a.w / 2, b.x + b.w / 2) - Math.max(a.x - a.w / 2, b.x - b.w / 2);
      const oz = Math.min(a.z + a.d / 2, b.z + b.d / 2) - Math.max(a.z - a.d / 2, b.z - b.d / 2);
      const sideBySide = Math.abs(Math.abs(a.x - b.x) - (a.w + b.w) / 2) < 0.01 && oz >= 2.2;
      const behind = Math.abs(Math.abs(a.z - b.z) - (a.d + b.d) / 2) < 0.01 && ox >= 2.2;
      return sideBySide || behind;
    };
    const seen = new Set([this.lobby]), queue = [this.lobby];
    while (queue.length) {
      const cur = queue.shift();
      for (const r of all) if (!seen.has(r) && touch(cur, r)) { r.link = cur; seen.add(r); queue.push(r); }
    }
    for (const r of rooms) if (!r.link) r.link = this.lobby;                       // (cannot happen in a packed rectangle)
    // a room's link must come before it when routes are built: routeOf() follows the links recursively, so any order works
  }

  aisleOf(p) { return p.seat.clone().add(new THREE.Vector3(0, 0, 0.75)); }

  // A walk from the chair through the given stops (each a short pause) and back to the chair, around everything.
  planTrip(p, stops, { speed = 1.6, handoverAt = -1 } = {}) {
    const aisle = this.aisleOf(p), path = [p.seat.clone(), aisle], dwell = new Set();
    let at = aisle, handover = null;
    stops.forEach((st, i) => {
      path.push(...this.navPath(at, st)); at = path[path.length - 1];
      dwell.add(path.length - 1);
      if (i === handoverAt) handover = path.length - 1;
    });
    path.push(...this.navPath(at, aisle), p.seat.clone());
    Object.assign(p, { path, seg: 0, segT: 0, dwell, handover, speed, waitUntil: 0 });
    poseStand(p.person);
  }

  // A stroll for an idle person, inside their own room only (the CEO's lobby is for handing out work).
  startWander(p) {
    const r = p.room;
    const inRoom = () => new THREE.Vector3(r.x - r.w / 2 + 1 + Math.random() * (r.w - 2), 0, r.z + r.d / 2 - 0.9 - Math.random() * 1.2);
    p.chat = Math.random() < 0.5;
    this.planTrip(p, [inRoom(), inRoom()], { speed: 1.6 });
    p.wander = true;
  }

  // Given a task: walk through the doorways to the CEO's desk, take the paper the CEO hands over, back to work.
  fetchTask(p) {
    const desk = this.ceoPos, spot = new THREE.Vector3(desk.x + (Math.random() - 0.5) * 1.6, 0, desk.z - 2.1);
    p.chat = false;
    this.planTrip(p, [spot], { speed: 4.2, handoverAt: 0 });
    p.wander = false;
  }

  // ---------- walking around things: a grid of the floor, walls and furniture blocked, A* with smoothing ----------
  buildNav() {
    const C = 0.2, R = 0.24, b = this.bounds; if (!b) return;
    const x0 = b.minX, z0 = b.minZ, nx = Math.ceil((b.maxX - b.minX) / C) + 1, nz = Math.ceil((b.maxZ - b.minZ) / C) + 1;
    const grid = new Uint8Array(nx * nz).fill(1);
    const mark = (ax, bx, az, bz, v) => {
      const i0 = Math.max(0, Math.floor((ax - x0) / C)), i1 = Math.min(nx - 1, Math.ceil((bx - x0) / C));
      const j0 = Math.max(0, Math.floor((az - z0) / C)), j1 = Math.min(nz - 1, Math.ceil((bz - z0) / C));
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        const cx = x0 + i * C, cz = z0 + j * C;
        if (cx >= ax && cx <= bx && cz >= az && cz <= bz) grid[j * nx + i] = v;     // cells whose centre is inside
      }
    };
    for (const r of this.rects) mark(r.x0 - 0.01, r.x1 + 0.01, r.z0 - 0.01, r.z1 + 0.01, 0);   // the floors (rooms touch: no seam)
    this.world.updateMatrixWorld(true);
    const bb = new THREE.Box3();
    for (const o of this.obstacles) {
      bb.setFromObject(o); if (bb.isEmpty() || bb.max.y < 0.15) continue;
      mark(bb.min.x - R, bb.max.x + R, bb.min.z - R, bb.max.z + R, 1);
    }
    this.nav = { C, x0, z0, nx, nz, grid };
  }

  // The camera angle is fixed, so what hides a floor name is known: move each name to the spot nearest to where it
  // was put that lies on open floor (no furniture on it) and has nothing tall between it and the camera.
  placeFloorLabels() {
    const N = this.nav; if (!N) return;
    const toCam = new THREE.Vector3(60, 128, 132).normalize();                  // the view direction (see frame())
    this.world.updateMatrixWorld(true);
    const boxes = this.obstacles.map(o => new THREE.Box3().setFromObject(o)).filter(b => !b.isEmpty() && b.max.y > 0.15);
    const ray = new THREE.Ray();
    const hidden = (x, z) => { ray.origin.set(x, 0.02, z); ray.direction.copy(toCam); return boxes.some(b => ray.intersectsBox(b)); };
    const free = (x, z) => {
      const i = Math.round((x - N.x0) / N.C), j = Math.round((z - N.z0) / N.C);
      return i >= 0 && j >= 0 && i < N.nx && j < N.nz && !N.grid[j * N.nx + i];
    };
    const v = new THREE.Vector3();
    for (const s of this.signs) {
      const r = s.userData.room; if (!r) continue;
      const { width: w, height: h } = s.geometry.parameters;
      const pref = s.getWorldPosition(v.clone());
      const samples = (x, z) => [[0, 0], [-0.5, -0.5], [0.5, -0.5], [-0.5, 0.5], [0.5, 0.5], [-0.25, 0], [0.25, 0], [0, -0.5], [0, 0.5]]
        .map(([a, b]) => [x + a * w * 0.96, z + b * h * 0.9]);
      const search = strict => {
        let best = null;
        for (let z = r.z - r.d / 2 + h / 2 + 0.3; z <= r.z + r.d / 2 - h / 2 - 0.15; z += 0.25)
          for (let x = r.x - r.w / 2 + w / 2 + 0.3; x <= r.x + r.w / 2 - w / 2 - 0.2; x += 0.3) {
            const d = (x - pref.x) ** 2 + (z - pref.z) ** 2 * 1.5;                // stay near the front edge rather than sliding back
            if (best && d >= best.d) continue;
            const pts = samples(x, z);
            if (strict && !pts.every(([px, pz]) => free(px, pz))) continue;
            if (pts.some(([px, pz]) => hidden(px, pz))) continue;
            best = { x, z, d };
          }
        return best;
      };
      const best = search(true) || search(false);
      if (!best) continue;                                                       // nowhere better: keep it where it was
      const local = s.parent.worldToLocal(new THREE.Vector3(best.x, pref.y, best.z));
      s.position.set(local.x, s.position.y, local.z);
    }
  }

  navPath(from, to) {
    const N = this.nav; if (!N) return [to.clone()];
    const { C, x0, z0, nx, nz, grid } = N;
    const cell = v => [Math.min(nx - 1, Math.max(0, Math.round((v.x - x0) / C))), Math.min(nz - 1, Math.max(0, Math.round((v.z - z0) / C)))];
    const free = (i, j) => i >= 0 && j >= 0 && i < nx && j < nz && !grid[j * nx + i];
    const nearest = ([i, j]) => {
      if (free(i, j)) return [i, j];
      for (let r = 1; r < 25; r++) for (let dj = -r; dj <= r; dj++) for (let di = -r; di <= r; di++)
        if ((Math.abs(di) === r || Math.abs(dj) === r) && free(i + di, j + dj)) return [i + di, j + dj];
      return null;
    };
    const s = nearest(cell(from)), t = nearest(cell(to));
    if (!s || !t) { this.navFails = (this.navFails || 0) + 1; return [to.clone()]; }
    const S = s[1] * nx + s[0], T = t[1] * nx + t[0];
    const g = new Float32Array(nx * nz).fill(Infinity), came = new Int32Array(nx * nz).fill(-1), done = new Uint8Array(nx * nz);
    const heap = [];                                                               // [f, index]
    const push = (f, k) => { heap.push([f, k]); let c = heap.length - 1; while (c > 0) { const pa = (c - 1) >> 1; if (heap[pa][0] <= heap[c][0]) break; [heap[pa], heap[c]] = [heap[c], heap[pa]]; c = pa; } };
    const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let c = 0; for (;;) { const l = c * 2 + 1, r = l + 1; let m = c; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === c) break; [heap[m], heap[c]] = [heap[c], heap[m]]; c = m; } } return top; };
    const h = k => { const i = k % nx, j = (k / nx) | 0, dx = Math.abs(i - t[0]), dz = Math.abs(j - t[1]); return Math.max(dx, dz) + 0.414 * Math.min(dx, dz); };
    g[S] = 0; push(h(S), S);
    const DIRS = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, 1.414], [1, -1, 1.414], [-1, 1, 1.414], [-1, -1, 1.414]];
    let found = false;
    while (heap.length) {
      const [, k] = pop(); if (done[k]) continue; done[k] = 1;
      if (k === T) { found = true; break; }
      const i = k % nx, j = (k / nx) | 0;
      for (const [di, dj, w] of DIRS) {
        const a = i + di, c = j + dj; if (!free(a, c)) continue;
        if (di && dj && (!free(i + di, j) || !free(i, j + dj))) continue;         // no cutting corners
        const k2 = c * nx + a, ng = g[k] + w;
        if (ng < g[k2]) { g[k2] = ng; came[k2] = k; push(ng + h(k2), k2); }
      }
    }
    if (!found) { this.navFails = (this.navFails || 0) + 1; return [to.clone()]; }
    const cells = []; for (let k = T; k !== -1; k = came[k]) cells.push(k); cells.reverse();
    const pt = k => new THREE.Vector3(x0 + (k % nx) * C, 0, z0 + ((k / nx) | 0) * C);
    // smoothing: from each point, jump to the farthest point still in a clear straight line
    const clear = (a, b) => {
      const n = Math.ceil(a.distanceTo(b) / (C * 0.5));
      for (let q = 1; q < n; q++) { const v = a.clone().lerp(b, q / n), [i, j] = cell(v); if (!free(i, j)) return false; }
      return true;
    };
    const pts = cells.map(pt), out = [];
    let a = pts[0];
    for (let q = 1; q < pts.length;) {
      let far = q;
      for (let r = pts.length - 1; r > q; r--) if (clear(a, pts[r])) { far = r; break; }
      out.push(pts[far]); a = pts[far]; q = far + 1;
    }
    const end = to.clone(), [ei, ej] = cell(end);
    if (free(ei, ej) && clear(a, end)) out.push(end);
    return out.length ? out : [to.clone()];
  }

  roleName(n) { return nm(n.def, "role") + (n.inst > 1 || (this.viz.extra?.[n.base] || 1) > 1 ? ` #${n.inst}` : ""); }

  // ---------- Office 3: the game-style street ----------
  // Sky, crisper sunlight and a camera that rotates (left drag), pans (right drag) and zooms, but stays above ground.
  townLook() {
    const c = document.createElement("canvas"); c.width = 4; c.height = 256;
    const g = c.getContext("2d"), gr = g.createLinearGradient(0, 0, 0, 256);
    gr.addColorStop(0, "#9fd6ff"); gr.addColorStop(1, "#eaf7ff"); g.fillStyle = gr; g.fillRect(0, 0, 4, 256);
    const bg = new THREE.CanvasTexture(c); bg.colorSpace = THREE.SRGBColorSpace; this.scene.background = bg;
    this.scene.environmentIntensity = 0.35;
    this.scene.add(new THREE.HemisphereLight("#e3f4ff", "#9fd27f", 0.55));
    this.sun.intensity = 2.3; this.sun.color.set("#fff4e0");
    this.renderer.toneMappingExposure = 1.05;
    Object.assign(this.controls, { enableRotate: true, minPolarAngle: 0.35, maxPolarAngle: 1.22, minZoom: 0.45, maxZoom: 5, rotateSpeed: 0.7 });
    this.controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
    this.controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
    this.bubbles = [];
  }

  // The block around the office: grass, a sidewalk with tiles, a road with lane marks, neighbours with orange roofs,
  // low-poly trees, street lamps, motorbikes at the door, a glass front with a neon strip and a neon shop sign.
  buildTown() {
    const b = this.bounds, T = new THREE.Group(); this.world.add(T);
    this.townAnim = [];
    const X0 = b.minX - 20, X1 = b.maxX + 24, Z0 = b.minZ - 18, Z1 = b.maxZ + 18;
    const GW = X1 - X0, gcx = (X0 + X1) / 2;
    const flat = (w, h, d, color, x, y, z, cast = false) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), toon(color));
      m.position.set(x, y, z); m.receiveShadow = true; m.castShadow = cast; T.add(m); return m;
    };
    const glow = color => new THREE.MeshBasicMaterial({ color });
    const signTex = (text, bg, fg, { w = 512, h = 128, neon = null, font = 64 } = {}) => {
      const c = document.createElement("canvas"); c.width = w; c.height = h; const g = c.getContext("2d");
      g.fillStyle = bg; g.fillRect(0, 0, w, h);
      if (neon) { g.strokeStyle = neon; g.lineWidth = 10; g.shadowColor = neon; g.shadowBlur = 24; g.strokeRect(10, 10, w - 20, h - 20); }
      g.fillStyle = fg; g.font = `800 ${font}px "Bricolage Grotesque", "Segoe UI", sans-serif`; g.textAlign = "center"; g.textBaseline = "middle";
      if (neon) { g.shadowColor = neon; g.shadowBlur = 18; }
      let size = font; while (g.measureText(text).width > w - 50 && size > 16) { size -= 2; g.font = `800 ${size}px "Bricolage Grotesque", "Segoe UI", sans-serif`; }
      g.fillText(text, w / 2, h / 2 + 2);
      const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4; return tex;
    };
    const board = (text, bg, fg, w, h, opts) => new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: signTex(text, bg, fg, opts) }));

    // ground: grass, then from the building's front: sidewalk, curb, road, curb, far sidewalk
    flat(GW, 0.1, Z1 - Z0, "#9fd98a", gcx, -0.5, (Z0 + Z1) / 2);
    const sw0 = b.maxZ + 0.2, swD = 4.4;
    flat(GW, 0.16, swD, "#e8e2d6", gcx, -0.45, sw0 + swD / 2);
    for (let x = X0 + 1.6; x < X1; x += 1.6) flat(0.05, 0.02, swD, "#d2cabb", x, -0.36, sw0 + swD / 2);
    flat(GW, 0.26, 0.34, "#bdb5a7", gcx, -0.42, sw0 + swD + 0.17);
    const r0 = sw0 + swD + 0.34, rD = 7.6, rz = r0 + rD / 2;
    flat(GW, 0.08, rD, "#4a4f58", gcx, -0.52, rz);
    for (let x = X0 + 1; x < X1; x += 3.4) flat(1.8, 0.02, 0.2, "#f4f1e8", x, -0.47, rz);
    for (const e of [r0 + 0.4, r0 + rD - 0.4]) flat(GW, 0.02, 0.1, "#f4f1e8", gcx, -0.47, e);
    flat(GW, 0.26, 0.34, "#bdb5a7", gcx, -0.42, r0 + rD + 0.17);
    flat(GW, 0.16, 3.2, "#e8e2d6", gcx, -0.45, r0 + rD + 0.34 + 1.6);
    // a side path along the right of the office, to the shop next door
    flat(3.2, 0.16, b.maxZ - b.minZ + 0.4, "#e8e2d6", b.maxX + 2.0, -0.45, (b.minZ + b.maxZ) / 2);

    // neighbours: a row of houses behind, a shop with a blue roof on the right, a boarding house on the left
    const house = (x, z, w, d, h, wall, roof, sign, { flatRoof = false, face = 1 } = {}) => {
      const g = new THREE.Group(); g.position.set(x, -0.45, z); T.add(g);
      g.add(box(w, h, d, wall, 0, h / 2, 0));
      if (flatRoof) g.add(box(w + 0.7, 0.55, d + 0.7, roof, 0, h + 0.27, 0));
      else {
        const r = new THREE.Mesh(new THREE.ConeGeometry(1, 2.4, 4), new THREE.MeshStandardMaterial({ color: roof, roughness: 0.7, flatShading: true }));
        r.rotation.y = Math.PI / 4; r.scale.set((w + 0.9) / Math.SQRT2, 1, (d + 0.9) / Math.SQRT2); r.position.y = h + 1.2; r.castShadow = true; g.add(r);
      }
      const fz = face * (d / 2 + 0.04);
      for (let fl = 0; fl < Math.floor(h / 2.3); fl++) for (let cx = -w / 2 + 1.3; cx <= w / 2 - 1.2; cx += 1.7) {
        if (fl === 0 && Math.abs(cx) < 1.2) continue;                                           // the door's place
        const win = box(0.95, 0.95, 0.06, "#a9dcff", cx, 1.35 + fl * 2.3, fz, false); g.add(win);
        g.add(box(1.12, 0.12, 0.12, "#ffffff", cx, 0.82 + fl * 2.3, fz, false));               // sill
      }
      g.add(box(1.1, 2.0, 0.08, "#7a5233", 0, 1.0, fz, false));
      if (sign) { const s = board(sign, "#ffffff", "#2b2f3a", Math.min(w - 1.2, 5), 0.95); s.position.set(0, Math.min(h - 0.6, 3.0), fz + face * 0.02); if (face < 0) s.rotation.y = Math.PI; g.add(s); }
      return g;
    };
    const WALLS = ["#f2e3c9", "#e7eef5", "#f6d8c6", "#e3f0dc", "#efe6f6"];
    let i = 0;
    for (let x = b.minX + 4.5; x < b.maxX - 2; x += 11.5, i++)
      house(x, b.minZ - 7.5, 9, 7, i % 2 ? 7 : 5.2, WALLS[i % WALLS.length], i % 3 === 1 ? "#d9633a" : "#e2783f", i === 0 ? "KOS MELATI" : null);
    house(b.maxX + 9.5, b.maxZ - 4.5, 9, 8, 4.6, "#fdfcf8", "#3b6fd8", "WARUNG KOPI", { flatRoof: true });
    house(b.maxX + 9.5, b.maxZ - 15, 8, 7, 4.2, "#fff7e8", "#e0503a", "KONTER PULSA", { flatRoof: true });
    house(b.minX - 9.5, (b.minZ + b.maxZ) / 2, 9, 10, 7.2, "#f2e3c9", "#e2783f", "RUMAH MAKAN");
    // a striped awning over the coffee shop's front
    for (let k = 0; k < 6; k++) { const a = box(1.5, 0.08, 1.4, k % 2 ? "#ffffff" : "#e5484d", b.maxX + 9.5 - 3.75 + k * 1.5, 2.7, b.maxZ - 4.5 + 4.6, false); a.rotation.x = 0.35; T.add(a); }

    // low-poly trees
    const LEAF = ["#5cbf4a", "#4fae3f", "#74c95a", "#3f9e4a"];
    const tree = (x, z, s = 1) => {
      const g = new THREE.Group(); g.position.set(x, -0.45, z); T.add(g);
      g.add(box(0.34 * s, 1.4 * s, 0.34 * s, "#8a5a33", 0, 0.7 * s, 0));
      const m = new THREE.Mesh(new THREE.IcosahedronGeometry(1.25 * s, 0), new THREE.MeshStandardMaterial({ color: LEAF[Math.abs(Math.round(x * 7 + z * 3)) % LEAF.length], flatShading: true, roughness: 0.85 }));
      m.position.y = 2.3 * s; m.castShadow = true; m.rotation.y = x; g.add(m);
    };
    for (let x = X0 + 4; x < X1 - 2; x += 9) tree(x, r0 + rD + 2.2, 1 + ((x * 13) % 3) * 0.12);
    for (const [x, z, s] of [[b.minX - 3, b.minZ - 2, 1.1], [b.maxX + 3.2, b.minZ - 3, 1.2], [b.minX - 15, b.maxZ - 2, 1.3], [b.maxX + 17, b.minZ + 2, 1.2], [b.minX - 4, b.maxZ + 1.6, 0.8], [b.maxX + 15.5, b.maxZ + 1.6, 0.9], [b.minX + 18, b.minZ - 14, 1.2], [b.minX - 14, b.minZ - 10, 1.1]]) tree(x, z, s);

    // street lamps along the curb
    for (let x = X0 + 6; x < X1 - 3; x += 13) {
      const z = sw0 + swD - 0.4;
      T.add(box(0.13, 3.8, 0.13, "#3b4252", x, 1.45, z), box(0.08, 0.08, 0.9, "#3b4252", x, 3.3, z - 0.4));
      const head = new THREE.Mesh(new THREE.BoxGeometry(0.45, 0.16, 0.3), glow("#fff1b8")); head.position.set(x, 3.2, z - 0.8); T.add(head);
    }

    // motorbikes parked in front of the office, nose to the road
    const BIKES = ["#e74c3c", "#3b82f6", "#f5c518", "#14b8a6", "#a855f7"];
    const ex = this.entrance.x;
    BIKES.forEach((col, k) => {
      const g = new THREE.Group(); g.position.set(ex + 2.4 + k * 1.15, -0.37, sw0 + 2.7); g.rotation.y = (k % 2 ? 0.08 : -0.08); T.add(g);
      g.add(box(0.36, 0.34, 1.25, col, 0, 0.55, 0), box(0.3, 0.12, 0.55, "#22252b", 0, 0.78, -0.18, false));
      g.add(box(0.07, 0.6, 0.07, "#2b2f36", 0, 0.62, 0.58, false), box(0.62, 0.06, 0.06, "#22252b", 0, 0.94, 0.58, false));
      for (const wz of [-0.5, 0.5]) { const w = new THREE.Mesh(new THREE.TorusGeometry(0.27, 0.085, 8, 16), toon("#1b1d22")); w.rotation.y = Math.PI / 2; w.position.set(0, 0.3, wz); w.castShadow = true; g.add(w); }
    });

    // the office's street front: low glass walls with a neon strip on top, a gap at the door with a coloured frame
    const glassMat = new THREE.MeshStandardMaterial({ color: "#d3ecff", transparent: true, opacity: 0.3, roughness: 0.08, metalness: 0 });
    const neon = glow("#b56cff");
    const front = [[b.minX + 0.05, ex - 1.4], [ex + 1.4, b.maxX - 0.05]];
    for (const [a, c] of front) if (c - a > 0.3) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(c - a, 1.25, 0.08), glassMat); m.position.set((a + c) / 2, 0.62, b.maxZ - 0.05); T.add(m);
      const strip = new THREE.Mesh(new THREE.BoxGeometry(c - a, 0.09, 0.12), neon); strip.position.set((a + c) / 2, 1.28, b.maxZ - 0.05); T.add(strip);
    }
    {
      const m = new THREE.Mesh(new THREE.BoxGeometry(0.08, 1.25, b.maxZ - b.minZ), glassMat); m.position.set(b.maxX - 0.05, 0.62, (b.minZ + b.maxZ) / 2); T.add(m);
      const strip = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.09, b.maxZ - b.minZ), neon); strip.position.set(b.maxX - 0.05, 1.28, (b.minZ + b.maxZ) / 2); T.add(strip);
    }
    T.add(box(0.18, 2.6, 0.18, "#ff7a3d", ex - 1.4, 1.3, b.maxZ - 0.05), box(0.18, 2.6, 0.18, "#ff7a3d", ex + 1.4, 1.3, b.maxZ - 0.05), box(3.0, 0.2, 0.2, "#ff7a3d", ex, 2.6, b.maxZ - 0.05));
    const open = board("BUKA", "#2fbf5b", "#ffffff", 1.3, 0.5, { w: 256, h: 96, font: 60 }); open.position.set(ex + 2.1, 1.7, b.maxZ + 0.02); T.add(open);

    // the neon shop sign on two posts at the front corner of the sidewalk
    const sx = b.minX + 4.2, sz = sw0 + 1.2;
    T.add(box(0.16, 3.0, 0.16, "#2b2f36", sx - 2.4, 1.05, sz), box(0.16, 3.0, 0.16, "#2b2f36", sx + 2.4, 1.05, sz));
    const sign = board("NUSANTARA DIGITAL WORKS", "#2a0f45", "#ffffff", 5.4, 1.5, { w: 1024, h: 288, neon: "#d07bff", font: 96 });
    sign.position.set(sx, 2.75, sz + 0.1); T.add(sign);
    const back = sign.clone(); back.rotation.y = Math.PI; back.position.z = sz - 0.1; T.add(back);
    const lamp = new THREE.PointLight("#c47bff", 6, 9, 1.6); lamp.position.set(sx, 2.6, sz + 1.2); T.add(lamp);
    this.townAnim.push(time => { lamp.intensity = 5.5 + Math.sin(time * 3.1) * 0.6 + (Math.sin(time * 17) > 0.97 ? -3 : 0); });   // a little neon flicker

    // two cars driving along the road, one each way
    const car = (color, lane, dir, speed, offset) => {
      const g = new THREE.Group(); T.add(g);
      g.add(box(2.7, 0.65, 1.35, color, 0, 0.55, 0), box(1.55, 0.58, 1.25, "#dff3ff", -0.15, 1.15, 0));
      for (const [wx, wz] of [[-0.9, -0.62], [0.9, -0.62], [-0.9, 0.62], [0.9, 0.62]]) {
        const w = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.2, 12), toon("#1b1d22")); w.rotation.x = Math.PI / 2; w.position.set(wx, 0.3, wz); g.add(w);
      }
      g.rotation.y = dir > 0 ? 0 : Math.PI;
      this.townAnim.push(time => { const u = ((time * speed + offset) % GW + GW) % GW; g.position.set(dir > 0 ? X0 + u : X1 - u, -0.48, lane); });
    };
    car("#ff6b4a", rz + 1.8, 1, 4.2, 0);
    car("#3fa7ff", rz - 1.8, -1, 3.4, GW * 0.45);
  }

  // a green "+1" that rises over a person who just finished a task, then fades (screen-sized like the labels)
  bubble(p) {
    const c = document.createElement("canvas"); c.width = 220; c.height = 96; const g = c.getContext("2d");
    g.fillStyle = "#2fbf5b"; g.beginPath(); g.roundRect(6, 6, 208, 70, 35); g.fill();
    g.beginPath(); g.moveTo(98, 74); g.lineTo(110, 92); g.lineTo(122, 74); g.fill();
    g.fillStyle = "#ffffff"; g.font = "800 46px 'Bricolage Grotesque', 'Segoe UI', sans-serif"; g.textAlign = "center"; g.textBaseline = "middle";
    g.fillText("✓ +1", 110, 43);
    const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
    s.layers.set(1); s.renderOrder = 20; s.center.set(0.5, 0);
    s.position.copy(p.person.g.position).setY(p.seat.y + 3.0);
    s.userData = { px: [220 / 34, 96 / 34], mult: 1 };
    this.scene.add(s); LABELS.add(s);
    this.bubbles.push({ s, t0: this.clock.elapsedTime });
  }
  tickBubbles(time, dt) {
    this.bubbles = (this.bubbles || []).filter(bb => {
      const u = (time - bb.t0) / 1.9;
      if (u >= 1) { this.scene.remove(bb.s); LABELS.delete(bb.s); bb.s.material.map.dispose(); bb.s.material.dispose(); return false; }
      bb.s.position.y += dt * 1.1;
      bb.s.material.opacity = u < 0.65 ? 1 : 1 - (u - 0.65) / 0.35;
      return true;
    });
  }

  frame() {
    const b = this.bounds; if (!b) return;
    const cx = (b.minX + b.maxX) / 2, cz = (b.minZ + b.maxZ) / 2;
    this.controls.target.set(cx, 0, cz);
    this.camera.position.set(cx + 60, 128, cz + 132);       // a fixed three-quarter view from the front right
    this.camera.lookAt(this.controls.target); this.camera.updateMatrixWorld();
    // fit every corner of the building (floors down to the bases, walls up to their tops) into the view
    let mx = 0, my = 0; const v = new THREE.Vector3(), c = this.controls.target, inv = this.camera.matrixWorldInverse;
    const tc = c.clone().applyMatrix4(inv);
    for (const r of this.rects) for (const x of [r.x0, r.x1]) for (const z of [r.z0, r.z1]) for (const y of [r.y - RIM, r.y + 4]) {
      v.set(x, y, z).applyMatrix4(inv).sub(tc); mx = Math.max(mx, Math.abs(v.x)); my = Math.max(my, Math.abs(v.y));
    }
    const out = this.town ? 1.12 : 1;                         // town: a little of the street around; zoom out to see the block
    this.fit = { mx: mx * 1.03 * out, my: my * 1.2 * out };
    this.camera.zoom = 1;
    this.resize();
  }
  resetView() { this.frame(); }

  pick(e) {
    const r = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const meshes = [], owner = new Map();
    for (const p of this.people.values()) for (const g of [p.person.g, p.desk.g]) g.traverse(o => { if (o.isMesh) { meshes.push(o); owner.set(o, p); } });
    const hit = this.raycaster.intersectObjects(meshes, false)[0];
    return hit ? owner.get(hit.object) : null;
  }

  keyOf(n) { for (const [k, v] of Object.entries(this.viz.nodes || {})) if (v === n) return k; return null; }

  // a sheet of paper flying in an arc: a task from the CEO, or a hand-off between desks
  pulse(a, b, kind) {
    const at = x => x === "owner" ? this.ceoPos.clone() : this.people.get(this.keyOf(x))?.seat.clone().add(new THREE.Vector3(0, 1.4, 0));
    const from = at(a), to = at(b); if (!from || !to) return;
    const src = a === "owner" ? null : this.people.get(this.keyOf(a));
    const color = kind === "loop" ? "#ff6b6b" : kind === "feedback" ? "#3ccf7a" : src ? "#" + src.color.clone().offsetHSL(0, 0.2, 0.15).getHexString() : "#ffb35c";
    for (let i = 0; i < 4; i++) this.fly(from, to, color, i * 0.18);      // a little stream of papers, not just one
  }
  fly(from, to, color = "#ffffff", delay = 0) {
    const mid = from.clone().add(to).multiplyScalar(0.5); mid.y = Math.max(from.y, to.y) + 2.5 + from.distanceTo(to) * 0.12;
    const curve = new THREE.QuadraticBezierCurve3(from, mid, to);
    const paper = new THREE.Mesh(PAPER_GEO, new THREE.MeshBasicMaterial({ color }));
    paper.add(new THREE.LineSegments(PAPER_EDGE, PAPER_LINE));                 // a dark outline: visible on white floors
    paper.castShadow = true; paper.visible = false; this.scene.add(paper);
    const wob = (Math.random() - 0.5) * 0.8;                                   // each sheet takes a slightly different arc
    curve.v1.x += wob; curve.v1.z -= wob; curve.v1.y += Math.random() * 0.8;
    this.flights.push({ paper, curve, t0: this.clock.elapsedTime + delay, dur: 1.4 + Math.random() * 0.3 });
  }
  celebrate() { this.cheerAt = this.clock.elapsedTime; }

  // ---------- every frame ----------
  tick() {
    if (!this.running) return;
    requestAnimationFrame(this.tick);
    if (!this.container.offsetParent) return;
    const dt = Math.min(this.clock.getDelta(), 0.05), time = this.clock.elapsedTime;
    this.syncLayout();
    const cheering = time - (this.cheerAt ?? -99) < 3.5;
    const busyDepts = new Set();
    // idle agents' names only when the desks are far enough apart on screen for the labels not to overlap
    const roomy = DESK_W * Math.max(1, this.container.clientHeight) * this.camera.zoom / Math.max(1e-6, this.camera.top - this.camera.bottom) > 150;

    for (const p of this.people.values()) {
      const cls = p.node.g.classList, P = p.person;
      const working = cls.contains("working") && !cls.contains("paused"), off = cls.contains("off");   // paused: sits still
      const stalled = cls.contains("stalled") || cls.contains("retrying"), limited = cls.contains("limited");
      p.glow += ((working ? 1 : 0) - p.glow) * Math.min(1, dt * 4);
      P.g.visible = !off;

      const idle = !working && !stalled && !limited && !off;
      if (this.town && p.wasWorking && !working && cls.contains("done") && !reduced) this.bubble(p);   // a task done: a "+1" pops up
      if (working && !p.wasWorking && !p.path && !cheering && !reduced && p.room.route) this.fetchTask(p);
      p.wasWorking = working;
      // work came in while strolling: straight back to the desk, a little faster
      if (p.wander && !idle) {
        const here = P.g.position.clone().setY(0);
        Object.assign(p, { path: [here, ...this.navPath(here, this.aisleOf(p)), p.seat.clone()], seg: 0, segT: 0, wander: false, waitUntil: 0, dwell: null, handover: null, speed: 4.2 });
      }
      // idle people now and then get up for a stroll: around their room, or through the doors to the lobby
      if (idle && !p.path && !cheering && !reduced && time > p.nextWander) {
        const strolling = [...this.people.values()].filter(q => q.wander).length;
        if (strolling < Math.max(1, Math.round(this.people.size * 0.12))) this.startWander(p);
        p.nextWander = time + 40 + Math.random() * 60;
      }

      if (p.path && p.waitUntil > time) {   // stopping for a moment: stand, look around
        poseStand(P); P.body.position.y = 0;
        P.neck.rotation.set(0, Math.sin(time * 1.3 + p.phase) * 0.5, 0);
        if (p.chat) P.armR.rotation.set(-0.9 + Math.sin(time * 4) * 0.25, 0, -0.2);   // talking with the hands
      } else if (p.path) {   // walking
        const A0 = p.path[p.seg], B0 = p.path[p.seg + 1];
        p.segT += dt * (p.speed || 3.0) / Math.max(0.01, A0.distanceTo(B0));
        if (p.segT >= 1) {
          p.seg++; p.segT = 0;
          if (p.dwell?.has(p.seg)) {
            p.waitUntil = time + (p.handover === p.seg ? 1.4 : 1.5 + Math.random() * 3);
            if (p.handover === p.seg) { P.g.rotation.y = 0; this.fly(this.ceoPos.clone(), P.g.position.clone().add(new THREE.Vector3(0, 1.3, 0)), "#" + p.color.clone().offsetHSL(0, 0.2, 0.15).getHexString()); }
          }
        }
        if (p.seg >= p.path.length - 1) { p.path = null; p.wander = false; p.dwell = null; p.speed = 0; P.g.position.copy(p.seat); P.g.rotation.y = Math.PI; P.body.position.y = 0; poseSit(P); }
        else {
          const A = p.path[p.seg], B = p.path[p.seg + 1];
          P.g.position.lerpVectors(A, B, p.segT);
          P.g.rotation.y = Math.atan2(B.x - A.x, B.z - A.z);
          const s = Math.sin(time * 10) * 0.6;
          P.legL.rotation.x = s; P.legR.rotation.x = -s; P.armL.rotation.x = -s * 0.8; P.armR.rotation.x = s * 0.8;
          P.body.position.y = Math.abs(Math.sin(time * 10)) * 0.06;
        }
      } else if (cheering) {   // the project is live: stand up and cheer
        poseStand(P); P.g.rotation.y = Math.PI * 0.25;
        const j = Math.abs(Math.sin(time * 6 + p.phase));
        P.body.position.y = j * 0.35;
        P.armL.rotation.set(-Math.PI * 0.95, 0, 0.35 + j * 0.2); P.armR.rotation.set(-Math.PI * 0.95, 0, -0.35 - j * 0.2);
      } else {
        poseSit(P); P.body.position.y = 0; P.g.rotation.y = Math.PI;
        if (working && !reduced) {   // typing, eyes on the screen
          P.armL.rotation.x = -1.05 + Math.sin(time * 14 + p.phase) * 0.13;
          P.armR.rotation.x = -1.05 + Math.sin(time * 14 + p.phase + 1.7) * 0.13;
          P.neck.rotation.set(0.14 + Math.sin(time * 2 + p.phase) * 0.04, Math.sin(time * 0.9 + p.phase) * 0.1, 0);
        } else if (stalled || limited) {   // waiting: chin in hand
          P.armR.rotation.set(-2.3, 0, -0.5); P.neck.rotation.set(-0.1, 0, 0.15);
        } else {    // idle: breathe, now and then look around or stretch
          const look = !reduced && Math.sin(time * 0.35 + p.phase * 3) > 0.9;
          P.neck.rotation.set(look ? -0.1 : 0, look ? Math.sin(time * 1.5) * 0.6 : 0, 0);
          if (!reduced && Math.sin(time * 0.21 + p.phase * 5) > 0.95) { P.armL.rotation.set(-2.8, 0, 0.5); P.armR.rotation.set(-2.8, 0, -0.5); }
        }
        const br = reduced ? 1 : 1 + Math.sin(time * 1.8 + p.phase) * 0.02;
        P.torso.scale.set(br, 1, br);
      }

      // the screen: dark when idle, scrolling code in the role colour while working (amber stalled, red limited)
      const tint = limited ? new THREE.Color("#ff4d4d") : stalled ? new THREE.Color("#ffb020") : p.color.clone().offsetHSL(0, 0.3, 0.15);
      const lit = Math.max(p.glow, stalled || limited ? 0.8 : 0);
      const sc = new THREE.Color("#1b2233").lerp(tint.clone().multiplyScalar(0.3), lit);
      p.desk.screens.forEach(s => s.material.color.copy(sc));
      if (working) busyDepts.add(p.node.dept);
      p.desk.lines.children.forEach((l, i) => {
        l.material.opacity = p.glow * (0.6 + 0.4 * Math.sin(time * 5 + i));
        l.material.color.copy(tint);
        l.position.y = 0.17 - ((i * 0.085 + time * 0.12 * p.glow) % 0.425);
      });

      // label: the role, plus the live line while busy; outlined in the role colour and bobbing while working
      const busy = working || stalled || limited;
      const sub = busy ? (p.node.modelText?.textContent || "") : "";
      p.label.userData.set(sub ? [this.roleName(p.node), sub] : [this.roleName(p.node)], "#1f2a3a",
        busy ? "#" + tint.getHexString() : this.hover === p.key ? "#7b8aa0" : null);
      p.label.position.set(P.g.position.x, p.seat.y + 2.3 + (working && !reduced ? 0.15 + Math.sin(time * 2.4 + p.phase) * 0.08 : 0), P.g.position.z);
      p.label.material.opacity = busy || this.hover === p.key ? 1 : 0.85;
      p.label.userData.mult = busy || this.hover === p.key ? 1 : 0.8;
      p.label.visible = !off && (busy || this.hover === p.key || roomy);

      // while an agent works, the CEO keeps passing it papers
      if (working && !p.path && !reduced) {
        p.nextSheet ??= time + (p.phase % 1);
        if (time > p.nextSheet) {
          const toDesk = Math.random() < 0.7;                                  // mostly CEO -> desk, sometimes back
          const a = this.ceoPos.clone(), b = p.seat.clone().add(new THREE.Vector3(0, 1.4, 0));
          this.fly(toDesk ? a : b, toDesk ? b : a, toDesk ? "#" + p.color.clone().offsetHSL(0, 0.2, 0.15).getHexString() : "#ffe066");
          p.nextSheet = time + 0.55 + Math.random() * 0.45;
        }
      } else p.nextSheet = null;
    }

    // the CEO stands and raises a hand while a decision waits
    if (this.ceo) {
      const waiting = this.viz.owner?.classList.contains("waiting");
      if (waiting || cheering) {
        poseStand(this.ceo);
        this.ceo.armR.rotation.set(-Math.PI * 0.9 + Math.sin(time * 5) * 0.15, 0, -0.1);
        if (cheering) this.ceo.armL.rotation.set(-Math.PI * 0.9, 0, 0.3);
        this.ceo.body.position.y = cheering ? Math.abs(Math.sin(time * 6)) * 0.3 : 0;
      } else { poseSit(this.ceo); this.ceo.body.position.y = 0; this.ceo.neck.rotation.y = reduced ? 0 : Math.sin(time * 0.4) * 0.2; }
      this.ceoPlaque?.userData.set([t("CEO"), this.viz.ownerSub?.textContent || t("Approves the gates")], waiting ? "#f59e0b" : "#f28c38", waiting);
    }

    if (!reduced) for (const a of this.anim || []) a.fn(time, busyDepts.has(a.dept));

    this.flights = this.flights.filter(f => {
      const u = (time - f.t0) / f.dur;
      if (u < 0) return true;                                                  // not started yet
      f.paper.visible = true;
      if (u >= 1) { this.scene.remove(f.paper); f.paper.material.dispose(); return false; }
      f.paper.position.copy(f.curve.getPoint(u));
      f.paper.rotation.set(Math.sin(u * 9) * 0.4, u * 6, Math.cos(u * 7) * 0.3);
      return true;
    });

    if (this.town) {
      if (!reduced) for (const f of this.townAnim || []) f(time, dt);
      this.tickBubbles(time, dt);
    }
    this.controls.update();
    // labels keep the same size on screen at any zoom
    const wpp = (this.camera.top - this.camera.bottom) / this.camera.zoom / Math.max(1, this.container.clientHeight);
    for (const l of LABELS) { const [w, h] = l.userData.px || [1, 1], k = LABEL_PX * l.userData.mult * wpp; l.scale.set(w * k, h * k, 1); }
    this.declutter();
    if (this.quality === "high") {
      // the building through the effects (without labels), then the labels sharp on top in a plain pass
      this.camera.layers.set(0);
      this.aoCamera.copy(this.camera);
      this.composer.render();
      this.camera.layers.enable(1);
      this.aoCamera.copy(this.camera); this.aoCamera.layers.set(1);
      const bg = this.scene.background, auto = this.renderer.shadowMap.autoUpdate;
      this.scene.background = null; this.renderer.shadowMap.autoUpdate = false; this.renderer.autoClear = false;
      this.renderer.render(this.scene, this.aoCamera);
      this.scene.background = bg; this.renderer.shadowMap.autoUpdate = auto; this.renderer.autoClear = true;
    } else this.renderer.render(this.scene, this.camera);
  }

  // Place the labels so that none overlaps another on screen: the CEO first, then working agents, then department
  // names, then idle agents. A label that would overlap is lifted by a line or two; if it still overlaps, an idle
  // agent's name is hidden (it shows on hover or when zoomed in) and the others take their own place.
  declutter() {
    const W = this.container.clientWidth, H = this.container.clientHeight; if (!W || !H) return;
    const items = [];
    for (const p of this.people.values()) if (p.label.visible) {
      const main = p.label.userData.mult === 1;
      items.push({ s: p.label, prio: main ? 1 : 3, must: main });
    }
    items.sort((a, b) => a.prio - b.prio);
    const placed = [], floor = [], v = new THREE.Vector3();
    // the names on the floor: idle agents' names never cover them (the CEO and working agents keep their place by
    // their person and only avoid each other)
    for (const m of this.signs || []) {
      const { width: fw, height: fh } = m.geometry.parameters;
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (const [cx, cy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        v.set(cx * fw / 2, cy * fh / 2, 0).applyMatrix4(m.matrixWorld).project(this.camera);
        const sx = (v.x + 1) / 2 * W, sy = (1 - v.y) / 2 * H;
        x0 = Math.min(x0, sx); x1 = Math.max(x1, sx); y0 = Math.min(y0, sy); y1 = Math.max(y1, sy);
      }
      // the label is slanted on screen: keep only the middle band of its box, so it does not block too much
      const my = (y0 + y1) / 2, hh = (y1 - y0) * 0.38;
      floor.push({ x0, x1, y0: my - hh, y1: my + hh });
    }
    const over = (r, q) => r.x0 < q.x1 && r.x1 > q.x0 && r.y0 < q.y1 && r.y1 > q.y0;
    for (const it of items) {
      const s = it.s, [pw, ph] = s.userData.px || [1, 1], k = LABEL_PX * s.userData.mult;
      const w = pw * k, h = ph * k;
      s.getWorldPosition(v).project(this.camera);
      const x = (v.x + 1) / 2 * W, y = (1 - v.y) / 2 * H;       // bottom centre of the label on screen
      let best = null;
      for (let step = 0; step < 4 && !best; step++) {
        const r = { x0: x - w / 2 - 2, x1: x + w / 2 + 2, y0: y - step * (h + 3) - h - 1, y1: y - step * (h + 3) + 1, step };
        if (!placed.some(q => over(r, q)) && (it.must || !floor.some(q => over(r, q)))) best = r;
      }
      if (!best && !it.must) { s.visible = false; continue; }
      best ||= { x0: x - w / 2, x1: x + w / 2, y0: y - h, y1: y, step: 0 };
      s.center.y = -best.step * (h + 3) / h;
      placed.push(best);
    }
  }

  resize() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    if (!w || !h) return;
    const aspect = w / h, f = this.fit || { mx: 20, my: 20 };
    const hh = Math.max(f.my, f.mx / aspect), hw = hh * aspect;
    Object.assign(this.camera, { left: -hw, right: hw, top: hh, bottom: -hh });
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.composer.setSize(w, h);
  }

  // "high": ambient occlusion + SMAA + sharper shadows; "normal": plain rendering (lighter for slower computers)
  setQuality(q) {
    this.quality = q === "normal" ? "normal" : "high";
    const size = this.quality === "high" ? 4096 : 2048;
    if (this.sun.shadow.mapSize.x !== size) { this.sun.shadow.mapSize.set(size, size); this.sun.shadow.map?.dispose(); this.sun.shadow.map = null; }
  }

  dispose() {
    this.running = false; this.resizeObs.disconnect(); this.controls.dispose(); this.renderer.dispose(); this.renderer.domElement.remove();
  }
}

window.OfficeView = OfficeView;
window.dispatchEvent(new Event("office-ready"));
