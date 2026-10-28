// Takes secrets out of text before it leaves the app (exports now; tool results and logs later).
// This is a safety net for well-known formats, not a guarantee: a secret in an unusual format gets through.

const RULES: { name: string; pattern: RegExp; replace?: (...m: string[]) => string }[] = [
  { name: "private-key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { name: "api-key", pattern: /\bsk-[A-Za-z0-9_-]{20,}/g }, // OpenAI, OpenRouter (sk-or-v1-…), Anthropic (sk-ant-…)
  { name: "aws-key", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { name: "github-token", pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,})/g },
  { name: "slack-token", pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  { name: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  {
    // NAME=value lines (.env files, exported variables) where the name says it is a secret.
    name: "env-secret",
    pattern: /^([ \t]*(?:export[ \t]+)?[A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|PRIVATE_?KEY|CREDENTIALS?)[A-Za-z0-9_]*[ \t]*=[ \t]*)(?!\[REDACTED)(\S.*)$/gim,
    replace: (_all, name) => `${name}[REDACTED:env-secret]`,
  },
];

export function redactText(text: string): string {
  let out = text;
  for (const rule of RULES) {
    out = out.replace(rule.pattern, rule.replace ?? (() => `[REDACTED:${rule.name}]`));
  }
  return out;
}

/** Redacts every string inside a value made of objects, arrays and strings. */
export function redactDeep<T>(value: T): T {
  if (typeof value === "string") return redactText(value) as T;
  if (Array.isArray(value)) return value.map(redactDeep) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactDeep(v)])) as T;
  }
  return value;
}
