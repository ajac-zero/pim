import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import {
  type ChangeSpec,
  type EditorState,
  Facet,
  type Range,
  StateEffect,
  StateField,
} from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";

/*
 * A note's live preview: the Markdown reads as it will be read, except where
 * the cursor is. The line (or the block, for code) holding the cursor or the
 * selection shows its raw Markdown; everywhere else the marks are hidden and
 * bullets, checkboxes, rules, quotes, code, images and drawings are drawn.
 * The text stays pure Markdown: only what is drawn changes, as decorations of
 * the syntax tree, so collaboration, undo and cursors work as they did.
 *
 * Only the local selection reveals raw Markdown. A collaborator's cursor is
 * drawn by y-codemirror from awareness and is not in the editor's selection.
 */

type SyntaxNode = ReturnType<typeof syntaxTree>["topNode"];
type Span = { from: number; to: number };

/** Whether the editor has focus: an editor the person isn't in draws everything. */
export const setNoteFocus = StateEffect.define<boolean>();
const focused = StateField.define<boolean>({
  create: () => false,
  update(value, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(setNoteFocus)) return effect.value;
    }
    return value;
  },
});

/** Where blocks drawn by the app, such as diagrams and images, are mounted. */
export interface BlockHost {
  mount(element: HTMLElement, source: string): void;
  unmount(element: HTMLElement): void;
}
const blockHost = Facet.define<BlockHost, BlockHost | null>({
  combine: (hosts) => hosts[0] ?? null,
});

/** The lines the selection is on: what shows raw. Empty while the editor isn't focused. */
function rawSpans(state: EditorState): Span[] {
  if (!state.field(focused, false)) return [];
  return state.selection.ranges.map((range) => ({
    from: state.doc.lineAt(range.from).from,
    to: state.doc.lineAt(range.to).to,
  }));
}

const touches = (spans: readonly Span[], from: number, to: number) =>
  spans.some((span) => span.from <= to && span.to >= from);

function tree(state: EditorState) {
  return ensureSyntaxTree(state, state.doc.length, 100) ?? syntaxTree(state);
}

class Bullet extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    const element = document.createElement("span");
    element.className = "cm-bullet";
    element.textContent = "•";
    return element;
  }
}

class Checkbox extends WidgetType {
  constructor(readonly checked: boolean) {
    super();
  }
  eq(other: Checkbox) {
    return other.checked === this.checked;
  }
  toDOM() {
    const box = document.createElement("input");
    box.type = "checkbox";
    box.className = "cm-task-box";
    box.checked = this.checked;
    return box;
  }
  ignoreEvent() {
    return false;
  }
}

class Rule extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    const element = document.createElement("span");
    element.className = "cm-rule";
    return element;
  }
}

/** A table, image or drawing, drawn by the app in place of its Markdown. */
class DrawnBlock extends WidgetType {
  constructor(
    readonly source: string,
    readonly host: BlockHost | null,
  ) {
    super();
  }
  eq(other: DrawnBlock) {
    return other.source === this.source && other.host === this.host;
  }
  toDOM() {
    const element = document.createElement("div");
    element.className = "cm-drawn-block";
    if (this.host) this.host.mount(element, this.source);
    else element.textContent = this.source;
    return element;
  }
  destroy(element: HTMLElement) {
    this.host?.unmount(element);
  }
  ignoreEvent() {
    return false;
  }
}

const HIDE = Decoration.replace({});
const lineClass = (name: string) => Decoration.line({ class: name });
const markClass = (name: string) => Decoration.mark({ class: name });

/** A fenced block's language: the first word after its opening fence. */
function fenceLanguage(state: EditorState, node: SyntaxNode): string {
  const info = node.getChild("CodeInfo");
  return info
    ? (state.sliceDoc(info.from, info.to).trim().split(/\s/)[0] ?? "")
    : "";
}

/** Whether a top-level block is one the app draws in place of its Markdown: a table, a lone image or a diagram. */
function isDrawn(state: EditorState, node: SyntaxNode): boolean {
  if (node.parent?.name !== "Document") return false;
  switch (node.name) {
    case "Table":
      return true;
    case "FencedCode": {
      const language = fenceLanguage(state, node);
      return language === "mermaid" || language === "svg";
    }
    case "Paragraph": {
      let rest = "";
      let at = node.from;
      let images = 0;
      for (let child = node.firstChild; child; child = child.nextSibling) {
        if (child.name !== "Image") return false;
        rest += state.sliceDoc(at, child.from);
        at = child.to;
        images++;
      }
      return images > 0 && (rest + state.sliceDoc(at, node.to)).trim() === "";
    }
    default:
      return false;
  }
}

/** The blocks drawn in place of their Markdown: those the cursor is not in. */
export function blockDecorations(state: EditorState): DecorationSet {
  const raw = rawSpans(state);
  const host = state.facet(blockHost);
  const out: Range<Decoration>[] = [];
  for (
    let node: SyntaxNode | null = tree(state).topNode.firstChild;
    node;
    node = node.nextSibling
  ) {
    if (!isDrawn(state, node) || touches(raw, node.from, node.to)) continue;
    out.push(
      Decoration.replace({
        widget: new DrawnBlock(state.sliceDoc(node.from, node.to), host),
        block: true,
      }).range(node.from, node.to),
    );
  }
  return Decoration.set(out);
}

const drawnBlocks = StateField.define<DecorationSet>({
  create: blockDecorations,
  update(value, transaction) {
    if (
      transaction.docChanged ||
      transaction.selection ||
      transaction.effects.some((effect) => effect.is(setNoteFocus)) ||
      syntaxTree(transaction.startState) !== syntaxTree(transaction.state)
    ) {
      return blockDecorations(transaction.state);
    }
    return value;
  },
  provide: (field) => EditorView.decorations.from(field),
});

/**
 * The marks hidden and the lines and words styled in the given ranges: the
 * visible part of the note. A line the selection is on is left as written.
 */
export function liveDecorations(
  state: EditorState,
  ranges: readonly Span[],
): DecorationSet {
  const raw = rawSpans(state);
  const out: Range<Decoration>[] = [];
  const doc = state.doc;
  const rawAt = (pos: number) => touches(raw, pos, pos);
  const hide = (from: number, to: number) => {
    if (to > from) out.push(HIDE.range(from, to));
  };
  /** A mark and the space after it. */
  const hideWithSpace = (mark: Span) =>
    hide(
      mark.from,
      mark.to + (doc.sliceString(mark.to, mark.to + 1) === " " ? 1 : 0),
    );
  /** The lines of a node within a visible range. */
  const eachLine = (
    node: Span,
    from: number,
    to: number,
    each: (line: Span) => void,
  ) => {
    for (let pos = Math.max(node.from, from); pos <= Math.min(node.to, to); ) {
      const line = doc.lineAt(pos);
      each(line);
      pos = line.to + 1;
    }
  };
  const syntax = tree(state);

  for (const { from, to } of ranges) {
    syntax.iterate({
      from,
      to,
      enter(ref) {
        const node = ref.node;
        switch (ref.name) {
          case "HeaderMark":
            if (node.parent?.name.startsWith("ATX") && !rawAt(ref.from)) {
              hideWithSpace(ref);
            }
            break;
          case "EmphasisMark":
          case "StrikethroughMark":
            if (!rawAt(ref.from)) hide(ref.from, ref.to);
            break;
          case "InlineCode":
            out.push(markClass("cm-inline-code").range(ref.from, ref.to));
            break;
          case "CodeMark":
            if (node.parent?.name === "InlineCode" && !rawAt(ref.from)) {
              hide(ref.from, ref.to);
            }
            break;
          case "Link": {
            const marks = node.getChildren("LinkMark");
            const [first, second] = marks;
            if (!first || !second || !node.getChild("URL")) break;
            out.push(markClass("cm-link").range(ref.from, second.to));
            if (!touches(raw, ref.from, ref.to)) {
              hide(ref.from, first.to);
              hide(second.from, ref.to);
            }
            return false;
          }
          case "ListMark":
            if (node.parent?.parent?.name === "OrderedList") {
              out.push(markClass("cm-list-number").range(ref.from, ref.to));
            } else if (!rawAt(ref.from)) {
              if (node.parent?.getChild("Task")) hideWithSpace(ref);
              else
                out.push(
                  Decoration.replace({ widget: new Bullet() }).range(
                    ref.from,
                    ref.to,
                  ),
                );
            }
            break;
          case "TaskMarker": {
            const checked = doc.sliceString(ref.from + 1, ref.from + 2) !== " ";
            if (checked && node.parent) {
              out.push(
                markClass("cm-task-done").range(
                  Math.min(ref.to + 1, node.parent.to),
                  node.parent.to,
                ),
              );
            }
            if (!rawAt(ref.from)) {
              out.push(
                Decoration.replace({ widget: new Checkbox(checked) }).range(
                  ref.from,
                  ref.to,
                ),
              );
            }
            break;
          }
          case "HorizontalRule":
            if (!rawAt(ref.from)) {
              out.push(
                Decoration.replace({ widget: new Rule() }).range(
                  ref.from,
                  ref.to,
                ),
              );
            }
            break;
          case "QuoteMark":
            if (!rawAt(ref.from)) hideWithSpace(ref);
            break;
          case "Blockquote":
            eachLine(ref, from, to, (line) =>
              out.push(lineClass("cm-quote").range(line.from)),
            );
            break;
          case "FencedCode": {
            if (isDrawn(state, node)) return false;
            const revealed = touches(raw, ref.from, ref.to);
            const marks = node.getChildren("CodeMark");
            const closing = marks.length > 1 ? marks[marks.length - 1] : null;
            const firstLine = doc.lineAt(ref.from).from;
            const lastLine = closing ? doc.lineAt(closing.from).from : -1;
            eachLine(ref, from, to, (line) => {
              let classes = "cm-codeblock";
              if (!revealed && line.from === firstLine)
                classes += " cm-code-open";
              if (!revealed && line.from === lastLine)
                classes += " cm-code-close";
              out.push(lineClass(classes).range(line.from));
            });
            if (!revealed) {
              if (marks[0]) hide(marks[0].from, marks[0].to);
              if (closing) hide(closing.from, closing.to);
              const info = node.getChild("CodeInfo");
              if (info)
                out.push(markClass("cm-code-lang").range(info.from, info.to));
            }
            return false;
          }
        }
      },
    });
  }
  return Decoration.set(out, true);
}

/** The preview of the visible part of the note, kept up to date as it is edited and the cursor moves. */
const livePlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = liveDecorations(view.state, view.visibleRanges);
    }
    update(update: ViewUpdate) {
      if (
        update.docChanged ||
        update.selectionSet ||
        update.viewportChanged ||
        update.startState.field(focused) !== update.state.field(focused) ||
        syntaxTree(update.startState) !== syntaxTree(update.state)
      ) {
        this.decorations = liveDecorations(
          update.state,
          update.view.visibleRanges,
        );
      }
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

/** The change that checks or unchecks the task whose `[ ]` or `[x]` starts at `pos`, if one does. */
export function taskToggle(state: EditorState, pos: number): ChangeSpec | null {
  const mark = state.sliceDoc(pos, pos + 3);
  if (!/^\[[ xX]\]$/.test(mark)) return null;
  return { from: pos + 1, to: pos + 2, insert: mark[1] === " " ? "x" : " " };
}

/** The address of the web or mail link under a click, if there is one. */
function linkAt(view: EditorView, event: MouseEvent): string | null {
  const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
  if (pos === null) return null;
  for (
    let node: SyntaxNode | null = syntaxTree(view.state).resolveInner(pos, 1);
    node;
    node = node.parent
  ) {
    if (node.name !== "Link") continue;
    const url = node.getChild("URL");
    const address = url ? view.state.sliceDoc(url.from, url.to) : "";
    return /^(https?:|mailto:)/i.test(address) ? address : null;
  }
  return null;
}

/** A click on a checkbox toggles its task; Ctrl or Cmd with a click opens a link, and a plain click puts the cursor in it to edit. */
const events = EditorView.domEventHandlers({
  mousedown(event, view) {
    const target = event.target;
    if (
      target instanceof HTMLInputElement &&
      target.classList.contains("cm-task-box")
    ) {
      const change = taskToggle(view.state, view.posAtDOM(target));
      if (change) view.dispatch({ changes: change, userEvent: "input.toggle" });
      event.preventDefault();
      return true;
    }
    if (event.metaKey || event.ctrlKey) {
      const address = linkAt(view, event);
      if (address) {
        window.open(address, "_blank", "noopener,noreferrer");
        event.preventDefault();
        return true;
      }
    }
    return false;
  },
});

const MUTED = "var(--muted-foreground)";
const theme = EditorView.theme({
  ".cm-inline-code": {
    backgroundColor: "color-mix(in oklab, var(--foreground) 6%, transparent)",
    borderRadius: "4px",
    padding: "0.1em 0.3em",
  },
  ".cm-link": {
    color: "var(--link)",
    textDecoration: "underline",
    textUnderlineOffset: "2px",
  },
  ".cm-list-number": { color: MUTED },
  ".cm-bullet": { color: MUTED, display: "inline-block", width: "1ch" },
  ".cm-task-box": {
    margin: "0 0.5ch 0 0",
    verticalAlign: "-0.1em",
    accentColor: "var(--primary)",
    cursor: "pointer",
  },
  ".cm-task-done": { color: MUTED, textDecoration: "line-through" },
  ".cm-rule": {
    display: "inline-block",
    width: "100%",
    borderTop: "1px solid var(--border)",
    verticalAlign: "middle",
  },
  ".cm-quote": {
    borderLeft: "2px solid var(--border)",
    paddingLeft: "0.9em !important",
    color: MUTED,
  },
  ".cm-codeblock": {
    fontFamily: "var(--theme-font-code)",
    fontSize: "0.9em",
    backgroundColor: "color-mix(in oklab, var(--foreground) 6%, transparent)",
    padding: "0 0.9em !important",
  },
  ".cm-codeblock span": { color: "var(--foreground) !important" },
  ".cm-codeblock .cm-code-lang": { color: `${MUTED} !important` },
  ".cm-code-open": {
    borderRadius: "12px 12px 0 0",
    paddingTop: "0.4em !important",
    fontSize: "0.8em",
  },
  ".cm-code-close": {
    borderRadius: "0 0 12px 12px",
    height: "0.6em",
    overflow: "hidden",
  },
  ".cm-drawn-block": { margin: "0.5rem 0", cursor: "text" },
});

/** The live preview, to add to a note's editor beside the Markdown language. */
export function noteLivePreview(host: BlockHost) {
  return [
    focused,
    EditorView.focusChangeEffect.of((_state, isFocused) =>
      setNoteFocus.of(isFocused),
    ),
    blockHost.of(host),
    drawnBlocks,
    livePlugin,
    events,
    theme,
  ];
}
