import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from "@codemirror/commands";
import {
  bracketMatching,
  HighlightStyle,
  indentOnInput,
  syntaxHighlighting,
} from "@codemirror/language";
import { search, searchKeymap } from "@codemirror/search";
import { Annotation, Compartment, EditorState } from "@codemirror/state";
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { useEffect, useRef } from "react";
import { takeReveal } from "~/lib/canvas-live";
import { loadLanguage } from "~/lib/editor-language";
import type { EditorHandle, FileSession } from "~/lib/file-session";

/*
 * The CodeMirror view of a file's session. It is its own chunk, loaded when a
 * file opens, so the main bundle stays small. Colors come from the app's CSS
 * variables, so the editor follows its light and dark themes.
 */

const highlight = HighlightStyle.define([
  {
    tag: [tags.keyword, tags.operatorKeyword, tags.modifier],
    color: "var(--color-agent-violet)",
  },
  {
    tag: [tags.string, tags.regexp, tags.special(tags.string)],
    color: "var(--color-success)",
  },
  {
    tag: [tags.number, tags.bool, tags.null, tags.atom],
    color: "var(--color-agent-orange)",
  },
  {
    tag: [tags.comment, tags.meta],
    color: "var(--muted-foreground)",
    fontStyle: "italic",
  },
  {
    tag: [
      tags.function(tags.variableName),
      tags.propertyName,
      tags.attributeName,
    ],
    color: "var(--link)",
  },
  {
    tag: [tags.typeName, tags.className, tags.tagName],
    color: "var(--color-agent-teal)",
  },
  { tag: [tags.heading], fontWeight: "600", color: "var(--link)" },
  { tag: tags.strong, fontWeight: "600" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: [tags.link, tags.url], color: "var(--link)" },
]);

const theme = EditorView.theme({
  "&": {
    height: "100%",
    minWidth: "0",
    // 16px keeps iOS from zooming the page when the editor is focused.
    fontSize: "16px",
    color: "var(--foreground)",
    backgroundColor: "transparent",
  },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": {
    fontFamily: "var(--font-mono)",
    lineHeight: "1.55",
    overflow: "auto",
  },
  ".cm-content": { caretColor: "var(--foreground)" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--foreground)" },
  ".cm-gutters": {
    backgroundColor: "transparent",
    color: "var(--muted-foreground)",
    border: "none",
  },
  ".cm-activeLine, .cm-activeLineGutter": {
    backgroundColor: "color-mix(in oklab, var(--foreground) 5%, transparent)",
  },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection":
    {
      backgroundColor: "color-mix(in oklab, var(--link) 25%, transparent)",
    },
  ".cm-panels": {
    backgroundColor: "var(--muted)",
    color: "var(--foreground)",
    borderColor: "var(--border)",
  },
  ".cm-textfield, .cm-button": {
    color: "var(--foreground)",
    backgroundColor: "var(--background)",
    backgroundImage: "none",
    border: "1px solid var(--border)",
  },
});

/** Replaces the document with `next`, changing only the span that differs so the selection and scroll stay put. */
function replaceDocument(view: EditorView, next: string) {
  const current = view.state.doc.toString();
  if (current === next) return;
  let start = 0;
  const max = Math.min(current.length, next.length);
  while (start < max && current[start] === next[start]) start++;
  let end = 0;
  while (
    end < max - start &&
    current[current.length - 1 - end] === next[next.length - 1 - end]
  ) {
    end++;
  }
  view.dispatch({
    changes: {
      from: start,
      to: current.length - end,
      insert: next.slice(start, next.length - end),
    },
    annotations: remote.of(true),
  });
}

const remote = Annotation.define<boolean>();

/** The most of a selection an agent is told. */
const MAX_SELECTION = 8000;

const readOnlyExtensions = (readOnly: boolean) => [
  EditorState.readOnly.of(readOnly),
  EditorView.editable.of(!readOnly),
];

export default function FileEditor({
  session,
  name,
  readOnly,
}: {
  session: FileSession;
  name: string;
  readOnly: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const language = useRef(new Compartment());
  const editable = useRef(new Compartment());
  const readOnlyAtOpen = useRef(readOnly);

  useEffect(() => {
    if (!host.current) return;
    const created = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: session.text,
        extensions: [
          lineNumbers(),
          history(),
          drawSelection(),
          highlightActiveLine(),
          indentOnInput(),
          bracketMatching(),
          search({ top: true }),
          syntaxHighlighting(highlight),
          EditorView.lineWrapping,
          theme,
          keymap.of([
            ...searchKeymap,
            ...historyKeymap,
            indentWithTab,
            ...defaultKeymap,
          ]),
          language.current.of([]),
          editable.current.of(readOnlyExtensions(readOnlyAtOpen.current)),
          EditorView.updateListener.of((update) => {
            if (
              update.docChanged &&
              !update.transactions.some((tr) => tr.annotation(remote))
            ) {
              session.edit(update.state.doc.toString());
            }
          }),
          EditorView.domEventHandlers({ blur: () => void session.flush() }),
        ],
      }),
    });
    view.current = created;
    const handle: EditorHandle = {
      getText: () => created.state.doc.toString(),
      setText: (text) => replaceDocument(created, text),
      getSelection: () => {
        const { doc, selection } = created.state;
        const place = (at: number) => {
          const line = doc.lineAt(at);
          return { line: line.number, column: at - line.from + 1 };
        };
        const { from, to } = selection.main;
        return {
          from: place(from),
          to: place(to),
          text: doc.sliceString(from, Math.min(to, from + MAX_SELECTION)),
        };
      },
      reveal: (line) => {
        const { doc } = created.state;
        const at = doc.line(Math.min(Math.max(1, line), doc.lines)).from;
        created.dispatch({
          selection: { anchor: at },
          effects: EditorView.scrollIntoView(at, { y: "center" }),
        });
      },
    };
    session.attach(handle);
    const asked = takeReveal(session.path);
    if (asked) handle.reveal(asked);
    let cancelled = false;
    void loadLanguage(name).then((extension) => {
      if (!cancelled && extension) {
        created.dispatch({ effects: language.current.reconfigure(extension) });
      }
    });
    return () => {
      cancelled = true;
      session.attach(null);
      created.destroy();
      view.current = null;
    };
  }, [session, name]);

  useEffect(() => {
    view.current?.dispatch({
      effects: editable.current.reconfigure(readOnlyExtensions(readOnly)),
    });
  }, [readOnly]);

  return <div ref={host} className="min-h-0 min-w-0 flex-1 overflow-hidden" />;
}
