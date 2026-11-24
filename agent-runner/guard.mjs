// Permission guard for tool-using agents. Everything must stay inside the project's app folder,
// and shell commands must come from a short allow-list.
import fs from "node:fs";
import path from "node:path";

const SAFE = new Set([
  "dotnet", "curl", "ls", "cat", "head", "tail", "grep", "find", "mkdir", "cp", "mv", "rm", "echo", "sleep", "kill",
  "pwd", "cd", "wc", "sort", "uniq", "test", "[", "timeout", "printf", "sed", "touch", "ps", "wait", "sqlite3",
  "true", "false", "jobs", "tee", "diff", "which", "basename", "dirname", "date", "seq", "tr", "cut", "xargs",
]);
const BLOCKED = /(^|[\s;&|(])(sudo|powershell|pwsh|cmd|cmd\.exe|reg|regedit|shutdown|format|del|rmdir|git|ssh|scp|npm|npx|pip|python3?|node|bash|sh|zsh|chmod|chown|dd|mkfs|netsh|setx|wget|nc|ncat|certutil|bitsadmin|schtasks|taskkill|start-process)(\s|$)/i;

function inside(root, p) {
  if (typeof p !== "string" || !p) return false;
  const full = path.resolve(root, p);
  const r = path.resolve(root);
  return full.toLowerCase() === r.toLowerCase() || full.toLowerCase().startsWith(r.toLowerCase() + path.sep);
}

export function checkBash(cmd, root) {
  if (typeof cmd !== "string" || !cmd.trim()) return "Empty command.";
  if (BLOCKED.test(cmd)) return "That program is not allowed here. Use dotnet, curl to localhost, and basic file commands inside the app folder.";
  if (/\.\.(\/|\\|$)/.test(cmd)) return "Paths with '..' are not allowed; stay inside the app folder.";
  if (/(^|[\s'"=])([A-Za-z]:[\\/]|~|\/(?!dev\/null)[A-Za-z])/.test(cmd)) return "Absolute paths are not allowed; use paths relative to the app folder.";
  for (const m of cmd.matchAll(/https?:\/\/([^\/\s:'"]+)/gi))
    if (!/^(localhost|127\.0\.0\.1)$/i.test(m[1])) return `Network calls are only allowed to localhost, not ${m[1]}.`;
  const segments = cmd.split(/\n|;|&&|\|\||\||&/).map(s => s.trim()).filter(Boolean);
  for (const seg of segments) {
    const words = seg.replace(/^\(+/, "").split(/\s+/).filter(w => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w));
    if (words.length === 0) continue;   // plain variable assignment
    const prog = words[0].replace(/^\$\(/, "");
    if (!SAFE.has(prog)) return `'${prog}' is not on the allowed command list.`;
    if (prog === "kill" && !words.slice(1).every(w => /^(-\d+|-[A-Z]+|\$\{?[A-Za-z_!][A-Za-z0-9_]*\}?|%\d+)$/.test(w)))
      return "kill may only target processes you started, by variable (kill $PID) or job (kill %1).";
    if (prog === "rm" && words.slice(1).some(w => w === "." || w === "*" || w === "./" || w === "./*"))
      return "rm of the whole folder is not allowed.";
  }
  return null;
}

/// Builds the SDK canUseTool callback for one run.
export function makeGuard(root, agentId, log) {
  const realRoot = fs.realpathSync(root);
  return async (toolName, input) => {
    const deny = message => { log(`${agentId} denied ${toolName}: ${message}`); return { behavior: "deny", message }; };
    switch (toolName) {
      case "Write": case "Edit": case "MultiEdit": case "Read":
        return inside(realRoot, input.file_path) ? { behavior: "allow", updatedInput: input } : deny("Only files inside the app folder may be used.");
      case "Glob": case "Grep":
        return !input.path || inside(realRoot, input.path) ? { behavior: "allow", updatedInput: input } : deny("Search only inside the app folder.");
      case "Bash": {
        const why = checkBash(input.command, realRoot);
        return why ? deny(why) : { behavior: "allow", updatedInput: input };
      }
      default:
        return deny(`${toolName} is not available to this agent.`);
    }
  };
}
