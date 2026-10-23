import type { Approval } from "~/lib/pim-api";

/**
 * What an approval asks for, as the card shows it: a one-line title and the
 * arguments as readable fields instead of the JSON Pim stores. Pure, so it is
 * tested without a browser.
 */

export type CodeLanguage = "json" | "javascript" | "text";

export type ApprovalField =
  | { name: string; kind: "text"; text: string }
  | { name: string; kind: "code"; code: string; language: CodeLanguage }
  | { name: string; kind: "image"; src: string };

export type ApprovalView = { title: string; fields: ApprovalField[] };

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

/** Files a request would save, such as a skill's supporting files: text, or copies of the person's files or of files on the web. */
function isFileList(
  value: unknown,
): value is ({ path: string } & (
  | { content: string }
  | { from_file: string }
  | { from_url: string }
))[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (item) =>
        isRecord(item) &&
        typeof item.path === "string" &&
        (typeof item.content === "string" ||
          typeof item.from_file === "string" ||
          typeof item.from_url === "string"),
    )
  );
}

/** Where a copy comes from, and the size and hash Pim checks it against when it is approved. */
function copyText(file: Record<string, unknown>): string {
  const from = String(file.from_file ?? file.from_url);
  if (typeof file.sha256 !== "string") return from;
  const size = typeof file.size === "number" ? `${file.size} bytes, ` : "";
  return `${from} (${size}SHA-256 ${file.sha256.slice(0, 12)}…)`;
}

function languageOf(path: string): CodeLanguage {
  if (/\.(m?js|ts)$/i.test(path)) return "javascript";
  if (/\.json$/i.test(path)) return "json";
  return "text";
}

export function approvalView(
  approval: Pick<Approval, "id" | "action" | "args" | "summary">,
): ApprovalView {
  const { id, action, args, summary } = approval;
  // An agent's new icon shows as the picture, as Pim reads it to set it; its hash is for Pim.
  if (
    action === "update_agent" &&
    isRecord(args) &&
    typeof args.icon === "string"
  ) {
    const { icon: _, icon_sha256: __, ...rest } = args;
    return {
      title: summary,
      fields: [
        { name: "icon", kind: "image", src: `/api/approvals/${id}/icon` },
        ...approvalView({ id, action, args: rest, summary }).fields,
      ],
    };
  }
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
  // Pim's own actions summarize themselves; show what the summary leaves out,
  // and each file they would save as a field of its own, named by its path.
  // A skill's summary names the agent asking and the agent it is for, whose ids are Pim's.
  const named = action === "write_skill" ? ["by", "agent"] : [];
  const fields = isRecord(args)
    ? Object.entries(args)
        .filter(
          ([name, value]) =>
            value !== undefined &&
            !named.includes(name) &&
            !(typeof value === "string" && summary.includes(value)),
        )
        .flatMap(([name, value]): ApprovalField[] =>
          isFileList(value)
            ? value.map(
                (file): ApprovalField =>
                  "content" in file
                    ? {
                        name: file.path,
                        kind: "code",
                        code: file.content,
                        language: languageOf(file.path),
                      }
                    : // A copy shows where it comes from, and the hash it must still have.
                      { name: file.path, kind: "text", text: copyText(file) },
              )
            : [fieldOf(name, value)],
        )
    : [];
  return { title: summary, fields };
}
