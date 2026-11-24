// Permission guard for tool-using agents. Everything must stay inside the project's app folder,
// shell commands must come from a short allow-list, and network calls may only go to localhost.
// Commands are read the way a shell reads them (quotes, redirections such as 2>&1, comments, loops),
// so ordinary shell syntax is not mistaken for a forbidden program.
import fs from "node:fs";
import path from "node:path";

const SAFE = new Set([
  "dotnet", "curl", "ls", "cat", "head", "tail", "grep", "find", "mkdir", "cp", "mv", "rm", "echo", "sleep", "kill",
  "pwd", "cd", "wc", "sort", "uniq", "test", "[", "[[", "timeout", "printf", "sed", "touch", "ps", "wait", "sqlite3",
  "true", "false", "jobs", "tee", "diff", "which", "basename", "dirname", "date", "seq", "tr", "cut", "xargs",
  "nl", "paste", "expr", "stat", "du", "cmp", "base64", "md5sum", "sha256sum", "read", "export", "local", "set",
  "break", "continue", "return", "exit", "shift", ":", "unzip", "tar", "file",
]);
// Shell keywords that start or continue a compound command; the program to check is the word after them.
const KEYWORDS = new Set(["for", "while", "until", "if", "then", "else", "elif", "fi", "do", "done", "case", "esac", "in", "!", "{", "}", "function", "select", "time"]);
// Commands whose arguments are file paths, so a bare /path there is a file system path.
const FILE_CMDS = new Set(["ls", "cat", "head", "tail", "grep", "find", "mkdir", "cp", "mv", "rm", "touch", "tee", "diff", "stat", "du",
  "cmp", "sqlite3", "dotnet", "cd", "unzip", "tar", "file", "nl", "wc", "sort", "uniq", "cut", "sed", "base64", "md5sum", "sha256sum", "test", "["]);
// Never allowed anywhere outside quotes (and inside double quotes that run a command substitution).
const BLOCKED = /(^|[\s;&|(`])(sudo|powershell|pwsh|cmd|cmd\.exe|reg|regedit|shutdown|format|del|rmdir|git|ssh|scp|npm|npx|pip|python3?|node|bash|sh|zsh|chmod|chown|dd|mkfs|netsh|setx|wget|nc|ncat|certutil|bitsadmin|schtasks|taskkill|start-process|eval|exec|source|awk|perl|ruby)(?=[\s;&|)`]|$)/i;

function inside(root, p) {
  if (typeof p !== "string" || !p) return false;
  const full = path.resolve(root, p);
  const r = path.resolve(root);
  return full.toLowerCase() === r.toLowerCase() || full.toLowerCase().startsWith(r.toLowerCase() + path.sep);
}

// Git Bash style /c/Users/... -> C:/Users/...
const toWin = p => /^\/[a-zA-Z]\//.test(p) ? `${p[1].toUpperCase()}:${p.slice(2)}` : p;

/// Splits a command line into simple commands at ; && || | & and newlines that are outside quotes.
/// Redirections that contain & (2>&1, >&2, &>file) are kept, and # comments are dropped.
export function splitCommands(cmd) {
  const segs = []; let cur = "", q = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i], n = cmd[i + 1], prev = cmd[i - 1];
    if (q) {
      cur += c;
      if (c === "\\" && q === '"' && n !== undefined) { cur += n; i++; }
      else if (c === q) q = null;
      continue;
    }
    if (c === "'" || c === '"') { q = c; cur += c; continue; }
    if (c === "\\" && n !== undefined) { cur += c + n; i++; continue; }
    if (c === "#" && (i === 0 || /[\s;&|(]/.test(prev))) { while (i < cmd.length && cmd[i] !== "\n") i++; segs.push(cur); cur = ""; continue; }
    if (c === "&" && (prev === ">" || prev === "<" || n === ">")) { cur += c; continue; }
    if (c === "\n" || c === ";" || c === "|" || c === "&") {
      if ((c === "|" || c === "&" || c === ";") && n === c) i++;
      segs.push(cur); cur = ""; continue;
    }
    cur += c;
  }
  segs.push(cur);
  return segs.map(s => s.trim()).filter(Boolean);
}

/// Words of one simple command, quotes removed (like the shell does before running it).
export function words(seg) {
  const out = []; let cur = "", q = null, has = false;
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i];
    // Inside double quotes a backslash only escapes $ ` " \ (so "C:\Windows" keeps its backslashes, as in bash).
    if (q) { if (c === q) q = null; else if (c === "\\" && q === '"' && /[$`"\\]/.test(seg[i + 1] ?? "")) cur += seg[++i]; else cur += c; continue; }
    if (c === "'" || c === '"') { q = c; has = true; continue; }
    if (c === "\\" && seg[i + 1] !== undefined) { cur += seg[++i]; has = true; continue; }
    if (/\s/.test(c)) { if (cur || has) out.push(cur); cur = ""; has = false; continue; }
    cur += c; has = true;
  }
  if (cur || has) out.push(cur);
  return out;
}

// Text a program name could hide in: everything except single-quoted strings and double-quoted strings
// that run no command substitution.
function unquoted(cmd) {
  return cmd.replace(/'[^']*'/g, "''").replace(/"((?:[^"\\]|\\.)*)"/g, (m, inner) => /\$\(|`/.test(inner) ? m : '""');
}

const isLocal = h => /^(localhost|127\.0\.0\.1)$/i.test(h);
const hostAllowed = (h, allowed) => isLocal(h) || allowed.some(a => { a = String(a).toLowerCase().trim(); h = h.toLowerCase(); return a && (h === a || h.endsWith("." + a)); });
// curl options that send data out; an external site may only be downloaded from.
const UPLOAD = /^(-d|--data.*|-F|--form.*|-T|--upload-file|--json|-X|--request|-u|--user|-e|--referer|-b|--cookie|-K|--config)$/;

export function checkBash(cmd, root, allowedHosts = []) {
  if (typeof cmd !== "string" || !cmd.trim()) return "Empty command.";
  if (BLOCKED.test(unquoted(cmd))) return "That program is not allowed here. Use dotnet, curl to localhost, and basic file commands inside the app folder.";
  for (const m of cmd.matchAll(/https?:\/\/([^\/\s:'"]+)/gi))
    if (!hostAllowed(m[1], allowedHosts))
      return `${m[1]} is not an approved site (approved: localhost${allowedHosts.length ? ", " + allowedHosts.join(", ") : ""}). ` +
             `Do not try another way to reach it. If you need it, add it to "access_requests" in your json data (host, why, license, alternatives) and the CEO will be asked.`;

  for (const seg of splitCommands(cmd)) {
    // Downloads from an allowed site: curl only, and nothing sent out (no data, forms, uploads, other methods).
    const external = [...seg.matchAll(/https?:\/\/([^\/\s:'"]+)/gi)].some(m => !isLocal(m[1]));
    if (external) {
      const ww = words(seg);
      const at = ww.findIndex(x => !KEYWORDS.has(x) && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(x));
      if (ww[at] !== "curl") return "Only curl may download from the allowed sites.";
      const bad = ww.slice(at + 1).find(x => UPLOAD.test(x) || /^-[A-Za-z]*[dFTXu]$/.test(x) && x.length > 2);
      if (bad) return `Downloads only: '${bad}' would send data to an outside site.`;
    }
    const w = words(seg.replace(/^\$\(|^\(+|^`/, "").replace(/[)`]+$/, ""));
    // X=$(cmd ...): the program is the one inside the substitution.
    if (w.length && /^[A-Za-z_][A-Za-z0-9_]*=(\$\(|`)/.test(w[0])) w[0] = w[0].replace(/^[A-Za-z_][A-Za-z0-9_]*=(\$\(|`)/, "");
    // Paths: absolute ones must point inside the app folder; '..' may not climb out of it.
    // Windows / Git Bash drive paths and ~ always count; a bare /path only for commands that work on files
    // (elsewhere it is usually a URL path such as /api/health).
    const fileCmd = FILE_CMDS.has(w.find(x => !KEYWORDS.has(x) && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(x)) ?? "");
    for (const raw of w) {
      const t = raw.replace(/^(\d?>>?|&>|<|--?[A-Za-z][\w-]*=)/, "");
      const redirect = t !== raw && /^(\d?>>?|&>|<)/.test(raw);
      if (!t || /^https?:/i.test(t)) continue;
      if (t === "/dev/null" || t === "/dev/stdout" || t === "/dev/stderr") continue;
      const drive = /^([A-Za-z]:[\\/]|\/[a-zA-Z]\/|~)/.test(t);
      const unixAbs = /^\/[A-Za-z_.]/.test(t) && !t.startsWith("/dev/");
      if (drive || (unixAbs && (fileCmd || redirect))) {
        if (t.startsWith("~") || !inside(root, toWin(t)))
          return "Absolute paths are only allowed inside the app folder; prefer paths relative to it.";
      }
      if (/(^|[\\/])\.\.([\\/]|$)/.test(t) && !inside(root, t)) return "Paths with '..' may not leave the app folder.";
    }
    // The program: skip shell keywords and VAR=value assignments in front of it.
    let k = 0;
    while (k < w.length && (KEYWORDS.has(w[k]) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[k]))) {
      if (w[k] === "for" || w[k] === "select" || w[k] === "case") { k = w.length; break; }   // "for x in a b c": only words follow
      k++;
    }
    if (k >= w.length) continue;
    const prog = w[k];
    if (/^[)}\]]+$/.test(prog) || /^\d*[<>]/.test(prog)) continue;   // closing bracket or a bare redirection
    if (!SAFE.has(prog)) return `'${prog}' is not on the allowed command list.`;
    const args = w.slice(k + 1);
    if (prog === "kill" && !args.every(a => /^(-\d+|-[A-Z]+|\$\{?[A-Za-z_!][A-Za-z0-9_]*\}?|%\d+)$/.test(a)))
      return "kill may only target processes you started, by variable (kill $PID) or job (kill %1).";
    if (prog === "rm" && args.some(a => a === "." || a === "*" || a === "./" || a === "./*" || a === "/"))
      return "rm of the whole folder is not allowed.";
    if (prog === "xargs") {
      let j = 0;
      while (j < args.length && args[j].startsWith("-")) j += /^-[IndPLsE]$/.test(args[j]) ? 2 : 1;   // options, some with a value
      if (j < args.length && !SAFE.has(args[j])) return "xargs may only run commands from the allowed list.";
      if (j < args.length && /^(rm|mv|cp|sed|tee|touch|kill)$/.test(args[j])) return "xargs may not change or delete files; name the files directly.";
    }
  }
  return null;
}

/// Builds the SDK canUseTool callback for one run.
export function makeGuard(root, agentId, log, allowedHosts = []) {
  const realRoot = fs.realpathSync(root);
  return async (toolName, input) => {
    const deny = message => { log(`${agentId} denied ${toolName}: ${message}`); return { behavior: "deny", message }; };
    switch (toolName) {
      case "Write": case "Edit": case "MultiEdit": case "Read":
        return inside(realRoot, toWin(input.file_path)) ? { behavior: "allow", updatedInput: input } : deny("Only files inside the app folder may be used.");
      case "Glob": case "Grep":
        return !input.path || inside(realRoot, toWin(input.path)) ? { behavior: "allow", updatedInput: input } : deny("Search only inside the app folder.");
      case "Bash": {
        const why = checkBash(input.command, realRoot, allowedHosts);
        return why ? deny(why) : { behavior: "allow", updatedInput: input };
      }
      default:
        return deny(`${toolName} is not available to this agent.`);
    }
  };
}
