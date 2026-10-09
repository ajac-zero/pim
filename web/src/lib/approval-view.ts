import type { Approval } from "~/lib/pim-api";

/**
 * What an approval asks for, as the card shows it: a one-line title and the
 * arguments as readable fields instead of the JSON Pim stores. Pure, so it is
 * tested without a browser.
 */

export type CodeLanguage = "json" | "javascript" | "text";

export type ApprovalField =
  | { name: string; kind: "text"; text: string }
  | { name: string; kind: "code"; code: string; language: CodeLanguage };

export type ApprovalView = { title: string; fields: ApprovalField[] };

export type ResultView = {
  /** A status line before a JSON body, such as "HTTP 200 OK". */
  lead: string | null;
  code: string;
  language: CodeLanguage;
};

/** Strings this long, or with line breaks, read better as a block. */
const INLINE_MAX = 80;
const CODE_NAMES = /^(code|script|source|function)$/i;
const LOOKS_LIKE_JS = /=>|\bfunction\b|\bawait\b|\bconst\b|\blet\b|\breturn\b/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** An object or array encoded as a string, or undefined. */
function parseStructured(text: string): unknown {
  const trimmed = text.trim();
  if (!/^[[{]/.test(trimmed)) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

function fieldOf(name: string, value: unknown): ApprovalField {
  if (typeof value === "string") {
    const structured = parseStructured(value);
    if (structured !== undefined) {
      return {
        name,
        kind: "code",
        code: JSON.stringify(structured, null, 2),
        language: "json",
      };
    }
    if (CODE_NAMES.test(name) && LOOKS_LIKE_JS.test(value)) {
      return { name, kind: "code", code: value, language: "javascript" };
    }
    if (value.includes("\n") || value.length > INLINE_MAX) {
      return { name, kind: "code", code: value, language: "text" };
    }
    return { name, kind: "text", text: value };
  }
  if (typeof value === "object" && value !== null) {
    return {
      name,
      kind: "code",
      code: JSON.stringify(value, null, 2),
      language: "json",
    };
  }
  return { name, kind: "text", text: String(value) };
}

export function approvalView(
  approval: Pick<Approval, "action" | "args" | "summary">,
): ApprovalView {
  const { action, args, summary } = approval;
  // A connected app's tool: Pim's summary is "<App>: <tool> <JSON>".
  if (
    action === "mcp_call" &&
    isRecord(args) &&
    typeof args.tool === "string"
  ) {
    const marker = summary.indexOf(`: ${args.tool}`);
    const app =
      marker > 0 ? summary.slice(0, marker) : String(args.server ?? "");
    const fields = isRecord(args.arguments)
      ? Object.entries(args.arguments).map(([name, value]) =>
          fieldOf(name, value),
        )
      : [];
    return { title: app ? `${app} · ${args.tool}` : args.tool, fields };
  }
  // Pim's own actions summarize themselves; show what the summary leaves out.
  const fields = isRecord(args)
    ? Object.entries(args)
        .filter(
          ([, value]) =>
            value !== undefined &&
            !(typeof value === "string" && summary.includes(value)),
        )
        .map(([name, value]) => fieldOf(name, value))
    : [];
  return { title: summary, fields };
}

export function resultView(result: string): ResultView {
  const whole = parseStructured(result);
  if (whole !== undefined) {
    return {
      lead: null,
      code: JSON.stringify(whole, null, 2),
      language: "json",
    };
  }
  const newline = result.indexOf("\n");
  if (newline > 0) {
    const body = parseStructured(result.slice(newline + 1));
    if (body !== undefined) {
      return {
        lead: result.slice(0, newline).trim(),
        code: JSON.stringify(body, null, 2),
        language: "json",
      };
    }
  }
  return { lead: null, code: result, language: "text" };
}
