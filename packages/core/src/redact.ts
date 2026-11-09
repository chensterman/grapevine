interface RedactionRule {
  name: string;
  pattern: RegExp;
  /** When set, capture group 1 is kept and only the remainder is replaced. */
  keepPrefix?: boolean;
}

const NOT_REDACTED = "(?!\\[REDACTED)";

const BUILTIN_RULES: RedactionRule[] = [
  {
    name: "private-key",
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  },
  { name: "aws-access-key", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { name: "github-token", pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})/g },
  { name: "anthropic-key", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { name: "openai-key", pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g },
  { name: "slack-token", pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g },
  { name: "stripe-key", pattern: /\b[rsp]k_(?:live|test)_[A-Za-z0-9]{16,}/g },
  { name: "google-api-key", pattern: /\bAIza[0-9A-Za-z_-]{35}/g },
  { name: "npm-token", pattern: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { name: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  { name: "bearer", pattern: new RegExp(`(\\bBearer\\s+)${NOT_REDACTED}[A-Za-z0-9._~+/-]{16,}=*`, "gi"), keepPrefix: true },
  {
    name: "url-credentials",
    pattern: /(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+(?=@)/gi,
    keepPrefix: true,
  },
  {
    // Dotenv-style `NAME=value` (no spaces) is explicit enough to redact values without digits, like passphrases.
    name: "env-secret",
    pattern: new RegExp(
      `((?:^|(?<=\\s))[A-Z0-9_]*(?:PASSWORD|PASSWD|SECRET|TOKEN|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY)[A-Z0-9_]*=["']?)${NOT_REDACTED}[^\\s"'\`]{8,}`,
      "gm",
    ),
    keepPrefix: true,
  },
  {
    name: "secret-assignment",
    pattern: new RegExp(
      `(\\b[A-Za-z0-9_.-]*(?:password|passwd|secret|token|api[_-]?key|access[_-]?key)[A-Za-z0-9_.-]*["']?\\s*[:=]\\s*["']?)${NOT_REDACTED}(?=[^\\s"',;]*\\d)[A-Za-z0-9_\\-+/=.]{6,}`,
      "gi",
    ),
    keepPrefix: true,
  },
];

export interface RedactionResult {
  text: string;
  count: number;
}

/** Replaces likely secrets with `[REDACTED:<rule>]`. Extra patterns are regex sources applied globally. */
export function redact(text: string, extraPatterns: string[] = []): RedactionResult {
  const rules: RedactionRule[] = [
    ...BUILTIN_RULES,
    ...extraPatterns.map((source, i) => ({ name: `custom-${i + 1}`, pattern: new RegExp(source, "g") })),
  ];
  let count = 0;
  let out = text;
  for (const rule of rules) {
    out = out.replace(rule.pattern, (_match, ...groups: unknown[]) => {
      count += 1;
      const prefix = rule.keepPrefix && typeof groups[0] === "string" ? groups[0] : "";
      return `${prefix}[REDACTED:${rule.name}]`;
    });
  }
  return { text: out, count };
}
