import { describe, expect, test } from "bun:test";
import { redact } from "../src/redact.ts";

/** Builds a fake secret from parts so secret scanners don't flag test fixtures. None of these are real. */
const fake = (...parts: string[]) => parts.join("");

const GITHUB_TOKEN = fake("ghp", "_abcdefghijklmnopqrstuvwxyz0123456789");

describe("redact", () => {
  test.each([
    [`AWS key ${fake("AKIA", "IOSFODNN7EXAMPLE")} here`, "aws-access-key"],
    [`token ${GITHUB_TOKEN}`, "github-token"],
    [`key ${fake("sk-", "ant-api03-abcdefghijklmnopqrstuvwxyz")}`, "anthropic-key"],
    [`key ${fake("sk-", "proj-abcdefghijklmnopqrstuvwxyz")}`, "openai-key"],
    [fake("xoxb", "-123456789012-abcdefghij"), "slack-token"],
    [fake("eyJ", "hbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"), "jwt"],
    [`key ${fake("sk_", "live", "_51HxAbCdEfGhIjKlMnOpQrStUv")}`, "stripe-key"],
    [`key ${fake("AIza", "SyD-AbCdEfGhIjKlMnOpQrStUvWxYz01234")}`, "google-api-key"],
    [`token ${fake("npm", "_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789")}`, "npm-token"],
    [fake("DB_PASSWORD=", "correcthorsebatterystaple"), "env-secret"],
    [fake("password: ", "hunter2"), "secret-assignment"],
  ])("redacts %s", (input, rule) => {
    const result = redact(input);
    expect(result.text).toContain(`[REDACTED:${rule}]`);
    expect(result.count).toBe(1);
  });

  test("redacts private key blocks", () => {
    const key = fake("-----BEGIN RSA ", "PRIVATE KEY-----\nMIIEow\nabc\n-----END RSA ", "PRIVATE KEY-----");
    expect(redact(`before\n${key}\nafter`).text).toBe("before\n[REDACTED:private-key]\nafter");
  });

  test("keeps the label of assignments, headers, and URLs", () => {
    expect(redact(fake("DB_PASSWORD=", "hunter2hunter2x9")).text).toBe("DB_PASSWORD=[REDACTED:env-secret]");
    expect(redact(fake('apiKey: "', 'a1b2c3d4e5f6"')).text).toBe('apiKey: "[REDACTED:secret-assignment]"');
    expect(redact(fake("Authorization: Bearer ", "abcdef0123456789abcdef")).text).toBe(
      "Authorization: Bearer [REDACTED:bearer]",
    );
    expect(redact(fake("postgres://admin:", "s3cretpass", "@db.internal:5432/app")).text).toBe(
      "postgres://admin:[REDACTED:url-credentials]@db.internal:5432/app",
    );
  });

  test("leaves ordinary code alone", () => {
    const code = "const tokenCount = countTokens(input); const secretSauce = true; password: string; MAX_TOKENS=4096; const TOKEN_TYPE = getType()";
    expect(redact(code)).toEqual({ text: code, count: 0 });
  });

  test("does not double-redact", () => {
    const result = redact(`GITHUB_TOKEN=${GITHUB_TOKEN}`);
    expect(result.text).toBe("GITHUB_TOKEN=[REDACTED:github-token]");
    expect(result.count).toBe(1);
  });

  test("applies custom patterns", () => {
    expect(redact("customer acme-corp-7781 called", ["acme-corp-\\d+"]).text).toBe("customer [REDACTED:custom-1] called");
  });
});
