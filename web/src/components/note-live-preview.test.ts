import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorSelection, EditorState } from "@codemirror/state";
import type { DecorationSet } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import {
  blockDecorations,
  liveDecorations,
  noteLivePreview,
  setNoteFocus,
  taskToggle,
} from "./note-live-preview";

const NOTE = [
  "# Plan",
  "",
  "Some **bold** and `code` with [a link](https://example.com).",
  "",
  "- first",
  "- [ ] todo",
  "- [x] done",
  "",
  "```ts",
  "const a = 1;",
  "```",
  "",
  "![chart](/api/images/abc)",
  "",
  "```mermaid",
  "graph TD; A-->B",
  "```",
].join("\n");

/** A focused editor state with the cursor at the start of `line` (1-based) of the note. */
function stateAt(line: number | null, doc = NOTE) {
  let state = EditorState.create({
    doc,
    extensions: [
      markdown({ base: markdownLanguage }),
      noteLivePreview({ mount() {}, unmount() {} }),
    ],
  });
  if (line !== null) {
    state = state.update({
      selection: EditorSelection.cursor(state.doc.line(line).from),
      effects: setNoteFocus.of(true),
    }).state;
  }
  return state;
}

/** The text each replace decoration hides or draws over, in order. */
function replaced(state: EditorState, set?: DecorationSet): string[] {
  const out: string[] = [];
  (set ?? liveDecorations(state, [{ from: 0, to: state.doc.length }])).between(
    0,
    state.doc.length,
    (from, to, value) => {
      if (value.spec.widget || to > from) {
        if (!value.spec.class && !value.spec.attributes)
          out.push(state.sliceDoc(from, to));
      }
    },
  );
  return out;
}

describe("note live preview", () => {
  it("hides the marks of every line but the one the cursor is on", () => {
    const away = replaced(stateAt(5));
    expect(away).toContain("# ");
    expect(away).toContain("**");
    expect(away).toContain("`");
    expect(away).toContain("[");
    expect(away).toContain("](https://example.com)");
    // Checkboxes are drawn in place of `[ ]` and `[x]`, except on the cursor's own line.
    expect(away).toEqual(expect.arrayContaining(["[ ]", "[x]"]));
    const onTask = replaced(stateAt(6));
    expect(onTask).not.toContain("[ ]");
    expect(onTask).toContain("[x]");
    // A plain bullet is drawn in place of `-`, and kept raw on the cursor's line.
    const bullets = (line: number | null) =>
      replaced(stateAt(line, "- one\n- two")).filter((text) => text === "-");
    expect(bullets(1)).toHaveLength(1);
    expect(bullets(null)).toHaveLength(2);
  });

  it("shows the heading line as written while the cursor is on it", () => {
    expect(replaced(stateAt(1))).not.toContain("# ");
    expect(replaced(stateAt(3))).not.toContain("**");
    expect(replaced(stateAt(3))).toContain("# ");
  });

  it("draws everything while the editor is not focused", () => {
    const state = stateAt(null);
    expect(replaced(state)).toContain("# ");
    expect(replaced(state)).toContain("[x]");
  });

  it("reveals a code block's fences while the cursor is anywhere in it", () => {
    expect(replaced(stateAt(10))).not.toContain("```");
    expect(replaced(stateAt(3))).toContain("```");
  });

  it("draws a lone image and a diagram as blocks, raw only under the cursor", () => {
    const blocks = (line: number | null) => {
      const state = stateAt(line);
      const found: string[] = [];
      blockDecorations(state).between(0, state.doc.length, (from, to) => {
        found.push(state.sliceDoc(from, to));
      });
      return found;
    };
    expect(blocks(1)).toEqual([
      "![chart](/api/images/abc)",
      "```mermaid\ngraph TD; A-->B\n```",
    ]);
    expect(blocks(13)).toEqual(["```mermaid\ngraph TD; A-->B\n```"]);
    expect(blocks(16)).toEqual(["![chart](/api/images/abc)"]);
  });

  it("toggles a task through an ordinary change to the text", () => {
    let state = stateAt(1);
    const at = state.doc.line(6).from + 2;
    const check = taskToggle(state, at);
    expect(check).not.toBeNull();
    state = state.update({ changes: check ?? [] }).state;
    expect(state.doc.line(6).text).toBe("- [x] todo");
    state = state.update({ changes: taskToggle(state, at) ?? [] }).state;
    expect(state.doc.line(6).text).toBe("- [ ] todo");
    expect(taskToggle(state, 0)).toBeNull();
  });
});
