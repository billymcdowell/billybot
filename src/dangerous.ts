// A guardrail for shell commands: spots a few well-known ways to do serious damage, so the
// command asks for approval even in Bypass mode and the approval card says why.
//
// It is NOT a security boundary. A shell command can be written a thousand ways (variables,
// encoding, a script that does it for you) and none of that is caught. It exists to make the
// obvious mistakes loud. The real protection is the approval prompt, and the sandbox when on.

/** Splits a command into segments (at ; && || | & and newlines, outside quotes), each a list of words. */
export function parseCommand(command: string): string[][] {
  const segments: string[][] = [];
  let words: string[] = [];
  let word = "";
  let started = false; // a quoted empty string is still a word
  let quote: "'" | '"' | null = null;

  const endWord = () => {
    if (started) words.push(word);
    word = "";
    started = false;
  };
  const endSegment = () => {
    endWord();
    if (words.length) segments.push(words);
    words = [];
  };

  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === "\\" && quote === '"' && i + 1 < command.length) word += command[++i];
      else word += c;
    } else if (c === "'" || c === '"') {
      quote = c;
      started = true;
    } else if (c === "\\" && i + 1 < command.length && /[ \t'"\\;|&$<>()#~*?-]/.test(command[i + 1])) {
      // A backslash escapes only the characters a shell gives meaning to; before anything else
      // (as in C:\Users) it is just part of a Windows path.
      word += command[++i];
      started = true;
    } else if (c === "\n" || c === ";" || c === "|" || c === "&") {
      endSegment();
    } else if (c === " " || c === "\t" || c === "\r") {
      endWord();
    } else {
      word += c;
      started = true;
    }
  }
  endSegment();
  return segments;
}

const WRAPPERS = new Set(["env", "nohup", "time", "nice", "command", "exec", "builtin", "stdbuf", "caffeinate"]);
const ELEVATORS = new Set(["sudo", "doas", "su", "pkexec", "runas"]);
const SAFE_TEMP = ["/tmp/", "/private/tmp/", "/var/tmp/", "/var/folders/", "$TMPDIR/", "${TMPDIR}/"];

const base = (w: string) => w.replace(/^.*[\\/]/, "").toLowerCase().replace(/\.exe$/, "");

/** The command a segment runs, with leading VAR=value assignments and wrappers like `env` skipped. */
function commandOf(words: string[]): { name: string; args: string[] } | null {
  let i = 0;
  while (i < words.length) {
    const w = words[i];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w) || WRAPPERS.has(base(w))) {
      i++;
      continue;
    }
    // `env -i FOO=1 cmd` and `nice -n 5 cmd`: skip the wrapper's own options
    if (i > 0 && WRAPPERS.has(base(words[i - 1])) && w.startsWith("-")) {
      i++;
      continue;
    }
    return { name: base(w), args: words.slice(i + 1) };
  }
  return null;
}

/**
 * A target that reaches well beyond a project: the root, your home folder, a top-level system
 * folder, "everything here", or anything that climbs out with "..".
 */
export function isBroadTarget(target: string, opts: { allowDot?: boolean } = {}): boolean {
  const t = target.trim();
  if (t === "") return false;
  if (t === "." || t === "./") return !opts.allowDot;
  if (t === ".." || t === "*" || t === ".*" || t === "./*" || t === "./.*") return true;
  const parts = t.split(/[\\/]+/).filter(Boolean);
  if (parts.includes("..")) return true;
  // home folder: ~, $HOME, %USERPROFILE%, $env:USERPROFILE — the folder itself or one thing directly inside it
  const home = /^(?:~[A-Za-z0-9_-]*|\$\{?HOME\}?|%USERPROFILE%|\$env:USERPROFILE|\$HOME)$/i;
  if (parts.length > 0 && home.test(parts[0])) return parts.length <= 2;
  // Windows drive roots and top-level folders: C:\, C:\Users, C:\Windows
  if (/^[A-Za-z]:$/.test(parts[0] ?? "")) return parts.length <= 2;
  if (/^[\\/]+$/.test(t)) return true;
  if (t.startsWith("/")) {
    if (SAFE_TEMP.some((p) => t.startsWith(p) || t === p.slice(0, -1))) return false;
    return parts.length <= 2; // /, /usr, /usr/local, /Users/me
  }
  return false;
}

type Flags = { recursive: boolean; force: boolean; noPreserveRoot: boolean; targets: string[] };

/** Reads rm/Remove-Item/del style arguments. */
function removalArgs(args: string[]): Flags {
  const out: Flags = { recursive: false, force: false, noPreserveRoot: false, targets: [] };
  for (const a of args) {
    if (a === "--no-preserve-root") out.noPreserveRoot = true;
    else if (a === "--recursive" || /^-recurse$/i.test(a) || /^\/s$/i.test(a)) out.recursive = true;
    else if (a === "--force" || /^-force$/i.test(a) || /^\/q$/i.test(a)) out.force = true;
    else if (/^-[A-Za-z]{1,4}$/.test(a)) {
      // a cluster of one-letter flags such as -rf, -fr, -Rfv
      if (/[rR]/.test(a)) out.recursive = true;
      if (/f/.test(a)) out.force = true;
    } else if (a.startsWith("-") || /^\/[a-z]$/i.test(a)) {
      // some other option
    } else out.targets.push(a);
  }
  return out;
}

const REMOVERS = new Set(["rm", "rmdir", "remove-item", "ri", "del", "erase", "rd"]);

function gitSubcommand(args: string[]): { sub: string; rest: string[] } {
  let i = 0;
  while (i < args.length && args[i].startsWith("-")) {
    i += args[i] === "-C" || args[i] === "-c" || args[i] === "--git-dir" || args[i] === "--work-tree" ? 2 : 1;
  }
  return { sub: (args[i] ?? "").toLowerCase(), rest: args.slice(i + 1) };
}

function checkGit(args: string[]): string | null {
  const { sub, rest } = gitSubcommand(args);
  const flag = (re: RegExp) => rest.some((a) => re.test(a));
  switch (sub) {
    case "push":
      if (flag(/^(-f|--force|--force-with-lease(=.*)?|--mirror|--delete|-d)$/) || rest.some((a) => /^\+[^+]|^:[^:]/.test(a))) {
        return "force-pushes or deletes on the remote, which can overwrite other people's work";
      }
      return null;
    case "reset":
      return flag(/^--hard$/) ? "throws away uncommitted changes (git reset --hard)" : null;
    case "clean":
      return flag(/^(-[a-z]*f[a-z]*|--force)$/) ? "deletes untracked files that git cannot bring back (git clean)" : null;
    case "checkout":
      return rest.includes(".") || rest.some((a) => a === "--" && rest[rest.indexOf(a) + 1] === ".")
        ? "throws away uncommitted changes (git checkout .)"
        : null;
    case "restore":
      return rest.includes(".") && !flag(/^--staged$/) ? "throws away uncommitted changes (git restore .)" : null;
    case "filter-branch":
    case "filter-repo":
      return "rewrites the repository's history";
    case "reflog":
      return flag(/^(expire|delete)$/) ? "deletes the reflog, the way back from mistakes" : null;
    case "update-ref":
      return flag(/^-d$/) ? "deletes a git ref" : null;
    default:
      return null;
  }
}

function checkSegment(words: string[]): string | null {
  const cmd = commandOf(words);
  if (!cmd) return null;
  const { name, args } = cmd;

  if (ELEVATORS.has(name)) return "runs with administrator rights";

  if (REMOVERS.has(name)) {
    const f = removalArgs(args);
    if (f.noPreserveRoot) return "removes files with --no-preserve-root";
    if (f.recursive && f.targets.some((t) => isBroadTarget(t))) {
      return "recursively deletes a folder far larger than a project (the root, your home folder, a system folder, or everything around you)";
    }
    return null;
  }

  switch (name) {
    case "find": {
      const start = args.find((a) => !a.startsWith("-"));
      const deletes = args.includes("-delete") || (args.includes("-exec") && args.some((a) => REMOVERS.has(base(a))));
      return deletes && start && isBroadTarget(start, { allowDot: true }) ? "deletes files across a very large area" : null;
    }
    case "chmod":
    case "chown":
    case "chgrp": {
      const recursive = args.some((a) => a === "--recursive" || /^-[A-Za-z]*R[A-Za-z]*$/.test(a));
      if (!recursive) return null;
      if (args.includes("777") || args.includes("a+rwx")) return "makes files writable by everyone";
      const targets = args.filter((a) => !a.startsWith("-"));
      return targets.slice(1).some((t) => isBroadTarget(t, { allowDot: true })) ? `changes ${name} recursively across a very large area` : null;
    }
    case "dd":
      return args.some((a) => /^of=\/dev\//.test(a)) ? "writes straight to a disk device" : null;
    case "mkfs":
    case "mke2fs":
    case "fdisk":
    case "sfdisk":
    case "parted":
    case "wipefs":
    case "shred":
    case "format-volume":
    case "clear-disk":
    case "remove-partition":
    case "initialize-disk":
      return "can destroy a disk or the data on it";
    case "diskutil":
      return args.some((a) => /^(erase|partition|reformat|zero|secure)/i.test(a)) ? "can erase a disk" : null;
    case "shutdown":
    case "reboot":
    case "halt":
    case "poweroff":
    case "stop-computer":
    case "restart-computer":
      return "shuts down or restarts the computer";
    case "kill":
      return args.includes("-1") ? "signals every process you own (kill -1)" : null;
    case "crontab":
      return args.includes("-r") ? "deletes all your scheduled jobs (crontab -r)" : null;
    case "git":
      return checkGit(args);
    default:
      if (name.startsWith("mkfs.")) return "can destroy a disk or the data on it";
      if (name === "format" && args.some((a) => /^[A-Za-z]:$/.test(a))) return "formats a drive";
      return null;
  }
}

/** Patterns that look at the command as a whole, since they span several segments. */
const WHOLE: { pattern: RegExp; reason: string }[] = [
  { pattern: /\|\s*(?:sudo\s+)?(?:env\s+\S+=\S+\s+)*(?:\S*\/)?(?:sh|bash|zsh|dash|ksh|csh|tcsh|fish)\b/i, reason: "pipes text into a shell to run it" },
  { pattern: /(?:\b(?:sh|bash|zsh|dash|source)\b|\s\.)\s+(?:-c\s+)?["']?(?:<|\$)\(\s*(?:curl|wget)\b/i, reason: "runs a script straight from the internet" },
  { pattern: /\b(?:iwr|irm|invoke-webrequest|invoke-restmethod|curl|wget)\b[^|;]*\|\s*(?:iex|invoke-expression)\b/i, reason: "runs a script straight from the internet" },
  { pattern: /\b(?:iex|invoke-expression)\b\s*\(+\s*(?:iwr|irm|invoke-webrequest|invoke-restmethod|new-object\s+net\.webclient)/i, reason: "runs a script straight from the internet" },
  { pattern: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, reason: "is a fork bomb" },
  { pattern: />>?\s*["']?(?:~|\$HOME|\$\{HOME\}|\/Users\/[^/\s]+|\/home\/[^/\s]+)?\/?\.(?:ssh|aws|gnupg)(?:\/|\b)/, reason: "writes into your credentials folders" },
  { pattern: />>?\s*["']?(?:~|\$HOME|\/Users\/[^/\s]+|\/home\/[^/\s]+)\/\.(?:zshrc|zprofile|zshenv|bashrc|bash_profile|profile)\b/, reason: "changes your shell startup files" },
  { pattern: /(?:>>?\s*|\btee\s+(?:-a\s+)?)["']?\/etc\//, reason: "writes to system configuration in /etc" },
];

/** Why a command is risky enough to need approval even in Bypass mode, or null. */
export function dangerousReason(command: string): string | null {
  for (const { pattern, reason } of WHOLE) {
    if (pattern.test(command)) return `This command ${reason}.`;
  }
  for (const words of parseCommand(command)) {
    const reason = checkSegment(words);
    if (reason) return `This command ${reason}.`;
  }
  return null;
}
