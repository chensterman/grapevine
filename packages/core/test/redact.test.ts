import { describe, expect, test } from "bun:test";
import { redact } from "../src/redact.ts";

describe("redact", () => {
  test.each([
    ["AWS key AKIAIOSFODNN7EXAMPLE here", "aws-access-key"],
    ["token ghp_abcdefghijklmnopqrstuvwxyz0123456789", "github-token"],
    ["key sk-ant-api03-abcdefghijklmnopqrstuvwxyz", "anthropic-key"],
    ["key sk-proj-abcdefghijklmnopqrstuvwxyz", "openai-key"],
    ["xoxb-123456789012-abcdefghij", "slack-token"],
    ["eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U", "jwt"],
  ])("redacts %s", (input, rule) => {
    const result = redact(input);
    expect(result.text).toContain(`[REDACTED:${rule}]`);
    expect(result.count).toBe(1);
  });

  test("redacts private key blocks", () => {
    const key = "-----BEGIN RSA PRIVATE KEY-----\nMIIEow\nabc\n-----END RSA PRIVATE KEY-----";
    expect(redact(`before\n${key}\nafter`).text).toBe("before\n[REDACTED:private-key]\nafter");
  });

  test("keeps the label of assignments, headers, and URLs", () => {
    expect(redact("DB_PASSWORD=hunter2hunter2x9").text).toBe("DB_PASSWORD=[REDACTED:secret-assignment]");
    expect(redact("Authorization: Bearer abcdef0123456789abcdef").text).toBe(
      "Authorization: Bearer [REDACTED:bearer]",
    );
    expect(redact("postgres://admin:s3cretpass@db.internal:5432/app").text).toBe(
      "postgres://admin:[REDACTED:url-credentials]@db.internal:5432/app",
    );
  });

  test("leaves ordinary code alone", () => {
    const code = "const tokenCount = countTokens(input); const secretSauce = true; password: string";
    expect(redact(code)).toEqual({ text: code, count: 0 });
  });

  test("does not double-redact", () => {
    const result = redact("GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789");
    expect(result.text).toBe("GITHUB_TOKEN=[REDACTED:github-token]");
    expect(result.count).toBe(1);
  });

  test("applies custom patterns", () => {
    expect(redact("customer acme-corp-7781 called", ["acme-corp-\\d+"]).text).toBe("customer [REDACTED:custom-1] called");
  });
});
