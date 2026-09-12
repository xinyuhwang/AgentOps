import { AgentOpsError } from "../errors";

export type ToolHandler = (
  args: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

export type BuiltinTool = {
  key: string;
  version: number;
  displayName: string;
  description: string;
  jsonSchema: Record<string, unknown>;
  /** Drives the approval gate (§3.2) and the replay guard (§7.3). */
  sideEffecting: boolean;
  /** A *reference* to a secret, never the secret (§7.7). */
  credentialRef: string | null;
  handler: ToolHandler;
};

function str(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.length === 0) {
    // Not retryable: calling it again with the same bad arguments fails again.
    throw new AgentOpsError(
      "tool_error",
      `Missing or invalid argument "${key}"`,
      false,
    );
  }
  return value;
}

/**
 * Tool definitions are code-defined and seeded into `tool_definitions` rows, so
 * a Run can pin an exact (key, version) even though there is no registry UI.
 * Changing a tool's behaviour means bumping `version`, never editing a row.
 */
export const BUILTIN_TOOLS: BuiltinTool[] = [
  {
    key: "calculator",
    version: 1,
    displayName: "Calculator",
    description: "Evaluate an arithmetic expression.",
    jsonSchema: {
      type: "object",
      properties: {
        expression: { type: "string", description: "e.g. (3 + 4) * 2" },
      },
      required: ["expression"],
      additionalProperties: false,
    },
    sideEffecting: false,
    credentialRef: null,
    async handler(args) {
      const expression = str(args, "expression");
      // Arithmetic only — no identifiers, no calls, so there is nothing to
      // evaluate but numbers and operators.
      if (!/^[\d\s+\-*/().%]+$/.test(expression)) {
        throw new AgentOpsError(
          "tool_error",
          "Expression may only contain numbers and + - * / ( ) %",
          false,
        );
      }
      const value = Function(`"use strict"; return (${expression});`)() as unknown;
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new AgentOpsError("tool_error", "Expression did not evaluate to a finite number", false);
      }
      return { expression, value };
    },
  },
  {
    key: "web_search",
    version: 1,
    displayName: "Web search",
    description: "Search the web and return result snippets.",
    jsonSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 10 },
      },
      required: ["query"],
      additionalProperties: false,
    },
    sideEffecting: false,
    credentialRef: "SEARCH_API_KEY",
    async handler(args) {
      const query = str(args, "query");
      const limit = Math.min(Number(args.limit ?? 3) || 3, 10);
      // Stubbed: Phase 1 is about the execution core, not about shipping a
      // search integration. The dispatcher path is identical either way.
      return {
        query,
        results: Array.from({ length: limit }, (_, i) => ({
          title: `Result ${i + 1} for "${query}"`,
          url: `https://example.com/${encodeURIComponent(query)}/${i + 1}`,
          snippet: `Representative snippet ${i + 1}.`,
        })),
      };
    },
  },
  {
    key: "database_query",
    version: 1,
    displayName: "Database query",
    description: "Run a read-only SQL query against the analytics warehouse.",
    jsonSchema: {
      type: "object",
      properties: { sql: { type: "string" } },
      required: ["sql"],
      additionalProperties: false,
    },
    sideEffecting: false,
    credentialRef: "WAREHOUSE_URL",
    async handler(args) {
      const sql = str(args, "sql");
      if (!/^\s*select\b/i.test(sql)) {
        throw new AgentOpsError(
          "tool_error",
          "Only SELECT statements are permitted",
          false,
        );
      }
      return { sql, rows: [{ count: 42 }], rowCount: 1 };
    },
  },
  {
    key: "send_email",
    version: 1,
    displayName: "Send email",
    description: "Send an email to a recipient.",
    jsonSchema: {
      type: "object",
      properties: {
        to: { type: "string" },
        subject: { type: "string" },
        body: { type: "string" },
      },
      required: ["to", "subject", "body"],
      additionalProperties: false,
    },
    /**
     * The one side-effecting built-in. This flag is what makes the approval
     * gate and the replay guard mean something concrete rather than depending
     * on an undefined notion of "external action".
     */
    sideEffecting: true,
    credentialRef: "SMTP_URL",
    async handler(args) {
      const to = str(args, "to");
      const subject = str(args, "subject");
      const body = str(args, "body");
      return { to, subject, bodyLength: body.length, delivered: true };
    },
  },
];

export const BUILTIN_BY_KEY = new Map(BUILTIN_TOOLS.map((t) => [t.key, t]));
