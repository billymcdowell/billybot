import { describe, expect, it } from "vitest";
import { redactDeep, redactText } from "./redact";

describe("redactText", () => {
  it.each([
    ["an OpenRouter key", "key sk-or-v1-0123456789abcdef0123456789abcdef", "api-key"],
    ["an Anthropic key", "sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ", "api-key"],
    ["an AWS key", "id AKIAIOSFODNN7EXAMPLE here", "aws-key"],
    ["a GitHub token", "ghp_abcdefghijklmnopqrstuvwxyz0123456789", "github-token"],
    ["a Slack token", "xoxb-1234567890-abcdefghij", "slack-token"],
    ["a JWT", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpM", "jwt"],
  ])("removes %s", (_name, text, kind) => {
    const out = redactText(text);
    expect(out).toContain(`[REDACTED:${kind}]`);
    expect(out).not.toMatch(/AKIAIOSFODNN7|0123456789abcdef|ABCDEFGHIJKLMNOP|SflKxwRJ|xoxb-1234/);
  });

  it("removes a whole private key block", () => {
    const key = "-----BEGIN RSA PRIVATE KEY-----\nMIIEow\nabc\n-----END RSA PRIVATE KEY-----";
    expect(redactText(`before\n${key}\nafter`)).toBe("before\n[REDACTED:private-key]\nafter");
  });

  it("hides the value of secret-looking variables but keeps the name", () => {
    const env = "PORT=3000\nDATABASE_PASSWORD=hunter2\nexport API_KEY = abc123\nSTRIPE_SECRET_KEY=whsec\nNAME=bob";
    expect(redactText(env)).toBe(
      "PORT=3000\nDATABASE_PASSWORD=[REDACTED:env-secret]\nexport API_KEY = [REDACTED:env-secret]\nSTRIPE_SECRET_KEY=[REDACTED:env-secret]\nNAME=bob",
    );
  });

  it("leaves ordinary text, short sk- words and code alone", () => {
    const text = "const task-sk = 1; sk-short; the password field; token_count = 4";
    expect(redactText(text)).toBe(text);
  });

  it("does not redact twice", () => {
    const once = redactText("TOKEN=abc");
    expect(redactText(once)).toBe(once);
  });
});

describe("redactDeep", () => {
  it("cleans strings inside objects and arrays and leaves other values alone", () => {
    const out = redactDeep({ a: ["sk-or-v1-0123456789abcdef0123456789abcdef", 5, null, true], b: { c: "fine" } });
    expect(out).toEqual({ a: ["[REDACTED:api-key]", 5, null, true], b: { c: "fine" } });
  });
});
