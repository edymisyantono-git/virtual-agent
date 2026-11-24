// Records a finished project into wwwroot/demo-data.js so demo.html can replay it without a server.
// Usage: node tools/export-demo.js [projectId]   (default: the newest completed project)
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const projectsDir = path.join(root, "data", "projects");
const base = process.env.VC_URL || "http://localhost:5080";

(async () => {
  const ids = fs.readdirSync(projectsDir).filter(d => fs.existsSync(path.join(projectsDir, d, "project.json")));
  const projects = ids.map(id => JSON.parse(fs.readFileSync(path.join(projectsDir, id, "project.json"), "utf8")));
  const pick = process.argv[2]
    ? projects.find(p => p.id === process.argv[2])
    : projects.filter(p => p.status === "Completed").sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  if (!pick) throw new Error("No completed project found. Run one first.");

  const meta = await (await fetch(base + "/api/meta")).json();
  meta.live = false;
  const artifacts = {};
  for (const a of pick.artifacts) artifacts[a.name] = fs.readFileSync(path.join(projectsDir, pick.id, "artifacts", a.name), "utf8");

  const js = "window.VC_DEMO = true;\n" +
    `window.VC_DEMO_PROJECT = ${JSON.stringify({ id: pick.id, title: pick.title })};\n` +
    `window.VC_DEMO_META = ${JSON.stringify(meta)};\n` +
    `window.VC_DEMO_EVENTS = ${JSON.stringify(pick.events)};\n` +
    `window.VC_DEMO_ARTIFACTS = ${JSON.stringify(artifacts)};\n`;
  fs.writeFileSync(path.join(root, "wwwroot", "demo-data.js"), js);
  console.log(`Exported ${pick.id}: ${pick.events.length} events, ${pick.artifacts.length} documents, ${(js.length / 1024).toFixed(0)} KB`);
})().catch(e => { console.error(e.message); process.exit(1); });
