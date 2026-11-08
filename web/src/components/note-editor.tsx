import { defaultKeymap } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import {
  drawSelection,
  EditorView,
  keymap,
  placeholder,
} from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { yCollab, yUndoManagerKeymap } from "y-codemirror.next";
import * as Y from "yjs";
import { Markdown } from "~/components/chat/markdown";
import { useI18n } from "~/components/i18n";
import { NoteLive, type NoteStatus } from "~/lib/note-live";
import { cn } from "~/lib/utils";

/*
 * A note's editor: its Markdown, written by the person and their agents
 * together, live. The text stays Markdown, as the agent reads and edits it,
 * styled as it's written: headings larger, emphasis and links as they'll
 * read, and the marks that make them quiet.
 */

/** How Markdown looks as it's written, in the theme's own colors. */
const markdownStyle = HighlightStyle.define([
  {
    tag: tags.heading1,
    fontSize: "1.6em",
    fontWeight: "600",
    lineHeight: "1.3",
  },
  {
    tag: tags.heading2,
    fontSize: "1.3em",
    fontWeight: "600",
    lineHeight: "1.35",
  },
  { tag: tags.heading3, fontSize: "1.1em", fontWeight: "600" },
  { tag: [tags.heading4, tags.heading5, tags.heading6], fontWeight: "600" },
  { tag: tags.strong, fontWeight: "600" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.strikethrough, textDecoration: "line-through" },
  { tag: [tags.link, tags.url], color: "var(--link)" },
  {
    tag: tags.monospace,
    fontFamily: "var(--theme-font-code)",
    fontSize: "0.9em",
    color: "var(--destructive)",
  },
  { tag: tags.quote, color: "var(--muted-foreground)" },
  {
    tag: [tags.processingInstruction, tags.contentSeparator, tags.meta],
    color: "var(--muted-foreground)",
  },
]);

const editorTheme = EditorView.theme({
  "&": {
    height: "100%",
    fontSize: "15px",
    color: "var(--foreground)",
    backgroundColor: "transparent",
  },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": {
    fontFamily: "var(--theme-font-ui)",
    lineHeight: "1.65",
    overflow: "auto",
  },
  ".cm-content": {
    maxWidth: "46rem",
    margin: "0 auto",
    padding: "1.5rem 1.25rem 40vh",
    caretColor: "var(--foreground)",
  },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--foreground)" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, ::selection":
    {
      backgroundColor:
        "color-mix(in oklab, var(--ring) 25%, transparent) !important",
    },
  ".cm-placeholder": { color: "var(--muted-foreground)" },
  // Others' cursors and selections, with their names on hover.
  ".cm-ySelectionInfo": {
    fontFamily: "var(--theme-font-ui)",
    fontSize: "11px",
    padding: "1px 4px",
    borderRadius: "4px",
    top: "-1.4em",
  },
});

/** The colors cursors take, one per person or agent at the note. */
const CURSOR_COLORS = [
  "#2563eb",
  "#16a34a",
  "#db2777",
  "#ea580c",
  "#7c3aed",
  "#0d9488",
];

export function NoteEditor({
  noteId,
  name,
  preview = false,
  onVersion,
  className,
}: {
  noteId: string;
  /** Shows the note as it reads, with its diagrams and drawings drawn, in place of its Markdown; it follows every change. */
  preview?: boolean;
  /** Who's typing, as others at the note see it beside the cursor. */
  name: string;
  /** A new version was made: the person paused, or the agent changed the note. */
  onVersion: (version: number) => void;
  className?: string;
}) {
  const { t } = useI18n();
  const host = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<NoteStatus>("connecting");
  const onVersionRef = useRef(onVersion);
  onVersionRef.current = onVersion;
  const liveRef = useRef<NoteLive | null>(null);
  // The text the preview shows, kept up to date only while it shows.
  const [shown, setShown] = useState("");
  const previewRef = useRef(preview);
  previewRef.current = preview;
  useEffect(() => {
    if (preview) setShown(liveRef.current?.text.toString() ?? "");
  }, [preview]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: the editor lives as long as the note; the name and texts are read once
  useEffect(() => {
    const parent = host.current;
    if (!parent) return;
    const live = new NoteLive(noteId, {
      status: setStatus,
      version: (version) => onVersionRef.current(version),
      error: (message) => toast.error(message, { id: `note-${noteId}` }),
    });
    const color =
      CURSOR_COLORS[live.doc.clientID % CURSOR_COLORS.length] ?? "#2563eb";
    live.awareness.setLocalStateField("user", {
      name,
      color,
      colorLight: `${color}33`,
    });
    liveRef.current = live;
    live.text.observe(() => {
      if (previewRef.current) setShown(live.text.toString());
    });
    const undoManager = new Y.UndoManager(live.text);
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: live.text.toString(),
        extensions: [
          drawSelection(),
          // Undo takes back the person's own changes only, never the agent's or another editor's.
          keymap.of([...yUndoManagerKeymap, ...defaultKeymap]),
          markdown({ base: markdownLanguage }),
          syntaxHighlighting(markdownStyle),
          EditorView.lineWrapping,
          EditorView.contentAttributes.of({
            "aria-label": t("noteText"),
            spellcheck: "true",
          }),
          placeholder(t("notePlaceholder")),
          editorTheme,
          yCollab(live.text, live.awareness, { undoManager }),
        ],
      }),
    });
    return () => {
      view.destroy();
      undoManager.destroy();
      live.close();
      liveRef.current = null;
    };
  }, [noteId]);

  return (
    <div className={cn("relative min-h-0 flex-1", className)}>
      <div ref={host} className={cn("absolute inset-0", preview && "hidden")} />
      {preview && (
        <div className="absolute inset-0 overflow-y-auto scrollbar-thin">
          <div className="mx-auto max-w-[46rem] px-5 pt-6 pb-24">
            {shown.trim() === "" ? (
              <p className="text-muted-foreground">{t("notePlaceholder")}</p>
            ) : (
              <Markdown text={shown} untrusted drawings />
            )}
          </div>
        </div>
      )}
      {status !== "synced" && (
        <p
          role="status"
          className="pointer-events-none absolute top-2 right-3 rounded-full bg-muted px-2.5 py-0.5 text-muted-foreground text-xs"
        >
          {t(status === "gone" ? "noteGone" : "noteConnecting")}
        </p>
      )}
    </div>
  );
}
