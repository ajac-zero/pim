import {
  createContext,
  lazy,
  memo,
  type ReactNode,
  Suspense,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { Markdown } from "~/components/chat/markdown";
import { Reply } from "~/components/chat/reply-blocks";
import type { ChartPoint } from "~/components/chat/ui-chart";
import { useI18n } from "~/components/i18n";
import { Button } from "~/components/ui/button";
import { pim, type StoredUiState } from "~/lib/pim-api";
import { loadUiStates, UiStateWriter } from "~/lib/ui-state";
import { cn } from "~/lib/utils";
import {
  type Action,
  compile,
  type Evaluation,
  evaluate,
  extraState,
  httpUrlOf,
  initialState,
  type RenderNode,
  stateSummary,
  storableState,
  stringOf,
  turnFits,
  type UiEvent,
  type UiProgram,
  type UiResponse,
  type UiState,
  uiBlockId,
  uiTurn,
  type Value,
} from "../../../../src/ui-lang";

/**
 * A ```ui block of an agent's message, drawn with the app's own components.
 * The web compiles the source with the same module the Worker checked it
 * with, then walks it with the interpreter on every keystroke and click — no
 * code of the model's runs, only its expressions. What its handler asked for
 * comes back as actions, which the app runs: a form's turn goes through the
 * composer's own send path, once, with the form locked until it is placed.
 * What a block holds is kept by Pim as it changes (see lib/ui-state.ts), so a
 * reload draws it as it was; the answers a chat's later turns carry still lock
 * a form where a save was lost.
 */

/** The drawn part of a chart is recharts, which only a page with a chart needs. */
const UiChartView = lazy(() => import("~/components/chat/ui-chart"));

/** A ```ui fence, as the model wrote it. */
export function isUiBlock(language: string): boolean {
  return language === "ui";
}

/** What the tree is drawn with: the events its components raise. */
type UiEvents = {
  change: (key: string, value: string | number | boolean) => void;
  submit: (form: string) => void;
  click: (key: string) => void;
};

/** Whether the block is complete. Until it is, its fields can be typed into, but nothing is sent or run. */
const Settled = createContext(true);

const Events = createContext<UiEvents>({
  change: () => {},
  submit: () => {},
  click: () => {},
});

/** How often a block still being written is compiled again, at most. */
export const COMPILE_EVERY_MS = 250;

/**
 * What the person typed into a block while it streamed, by message and place,
 * for the block drawn anew when the stream ends and the message is drawn
 * another way. An entry whose block goes while the stream is still going waits
 * `CARRY_FOR_MS` for the block that replaces it, then is dropped, so nothing
 * typed into a block that never comes back is kept for good.
 */
const carried = new Map<
  string,
  { values: UiState["values"]; expires: ReturnType<typeof setTimeout> | null }
>();

/** How long what was typed waits for the block that replaces its own: the new one draws within a compile or two. */
export const CARRY_FOR_MS = 5000;

/** What was typed in the block at `key`, made if there is none yet and kept for as long as a block holds it. */
function claimCarried(
  key: string,
  values: UiState["values"] = {},
): UiState["values"] {
  let entry = carried.get(key);
  if (entry === undefined) {
    entry = { values, expires: null };
    carried.set(key, entry);
  }
  if (entry.expires !== null) clearTimeout(entry.expires);
  entry.expires = null;
  return entry.values;
}

/** The block that held what was typed at `key` is gone before its stream finished: it is dropped unless a block claims it in time. */
function releaseCarried(key: string, values: UiState["values"]): void {
  const entry = carried.get(key);
  if (entry === undefined || entry.values !== values) return;
  if (entry.expires !== null) clearTimeout(entry.expires);
  entry.expires = setTimeout(() => {
    if (carried.get(key) === entry) carried.delete(key);
  }, CARRY_FOR_MS);
}

/** What was typed at `key` is no longer wanted. */
function dropCarried(key: string): void {
  const entry = carried.get(key);
  if (entry?.expires != null) clearTimeout(entry.expires);
  carried.delete(key);
}

/**
 * The program of a block as it is written. Once it is complete it is compiled
 * as it stands. While it is still open it is compiled at most every
 * `COMPILE_EVERY_MS` and once more at the end, and only a compile that can be
 * drawn replaces the last: what has been drawn stays when a newer cut of the
 * source doesn't compile. Null until something can be drawn.
 */
function useStreamedProgram(
  source: string,
  open: boolean,
): { program: UiProgram | null; complete: boolean } {
  /** The last compile, so the same source is never compiled twice. */
  const compiled = useRef<{ source: string; program: UiProgram } | null>(null);
  const [partial, setPartial] = useState<UiProgram | null>(null);
  const latest = useRef(source);
  latest.current = source;
  const lastAt = useRef(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `source` is what it waits on; the latest of it is read from the ref when it runs.
  useEffect(() => {
    if (!open) return;
    const compileNow = () => {
      lastAt.current = Date.now();
      // A closing fence cut off mid-write reads as text of the source.
      const written = latest.current.replace(/\n`{1,2}$/, "");
      if (compiled.current?.source === written) return;
      const program = compile(written, { partial: true });
      compiled.current = { source: written, program };
      if (import.meta.env.DEV) {
        // For whoever is debugging: what the repair cut, never shown to the person.
        const cuts = program.diagnostics.filter((diagnostic) =>
          diagnostic.code.startsWith("unterminated_"),
        );
        if (cuts.length > 0)
          console.debug("[ui] repaired a streaming block", cuts);
      }
      if (program.valid && program.nodes.length > 0) setPartial(program);
    };
    const wait = lastAt.current + COMPILE_EVERY_MS - Date.now();
    if (wait <= 0) {
      compileNow();
      return;
    }
    const timer = setTimeout(compileNow, wait);
    return () => clearTimeout(timer);
  }, [source, open]);

  if (open) return { program: partial, complete: false };
  if (compiled.current?.source !== source) {
    compiled.current = { source, program: compile(source) };
  }
  return { program: compiled.current.program, complete: true };
}

/** Draws one block of ui source; its fallback, when it can't be drawn. */
export const UiBlock = memo(function UiBlock({
  source,
  fallback,
  open: openInText = false,
  slot,
  block,
}: {
  source: string;
  /** Its source as a code block, kept for where nothing else can be shown. */
  fallback: ReactNode;
  /** Whether it is the fence its message has open at its end. */
  open?: boolean;
  /** Which of its message's ui blocks it is, by order. */
  slot?: number;
  /** Its id within its message (see `uiBlockIds`), which Pim keeps its state under. */
  block?: string;
}) {
  const { streaming, messageId } = useContext(Reply);
  const { t } = useI18n();
  const open = streaming && openInText;
  const { program, complete } = useStreamedProgram(source, open);
  if (program === null)
    return <div className="my-4 h-24 animate-pulse rounded-2xl bg-muted" />;
  if (!program.valid || program.nodes.length === 0) {
    const error = program.diagnostics.find(
      (diagnostic) => diagnostic.severity === "error",
    );
    return (
      <div className="my-4 min-w-0">
        {program.fallbackMarkdown.trim() !== "" && (
          <Markdown text={program.fallbackMarkdown} untrusted />
        )}
        <p className="mt-1 text-[13px] text-muted-foreground">
          {t("uiFallbackNote")}
          {error && <span className="text-destructive"> {error.message}</span>}
        </p>
        {program.fallbackMarkdown.trim() === "" && fallback}
      </div>
    );
  }
  return (
    <UiProgramView
      program={program}
      block={block ?? uiBlockId(source)}
      complete={complete}
      carryKey={
        messageId !== undefined && slot !== undefined
          ? `${messageId}#${slot}`
          : undefined
      }
    />
  );
});

/** The state a block starts with: what Pim kept of it, relocked for any form its chat already answered. */
function seededState(
  program: UiProgram,
  submitted: ReadonlyMap<string, UiResponse> | undefined,
  stored?: StoredUiState["state"],
): UiState {
  const state = initialState(program);
  Object.assign(state.values, stored?.values);
  Object.assign(state.revealed, stored?.revealed);
  Object.assign(state.submitted, stored?.submitted);
  for (const [block, response] of submitted ?? []) {
    const spec = program.forms[block];
    if (spec === undefined) continue;
    state.submitted[block] = {
      values: response.values,
      graded: Object.fromEntries(
        spec.fields
          .filter((field) => field.graded)
          .map((field) => [field.key, response.graded[field.key] === true]),
      ),
    };
    state.revealed[block] = true;
    // Only the form's own fields: a trailer is text of a turn, and may name anything.
    const keys = new Set(spec.fields.map((field) => field.key));
    for (const [key, value] of Object.entries(response.values)) {
      if (keys.has(key)) state.values[key] = value;
    }
  }
  return state;
}

/** A state with what the person typed over it, for the keys the program has. */
function withTyped(
  state: UiState,
  program: UiProgram,
  typed: UiState["values"],
): UiState {
  for (const [key, value] of Object.entries(typed)) {
    if (program.stateKeys.includes(key)) state.values[key] = value;
  }
  return state;
}

/** One whole block, holding its state between the events that change it. */
function UiProgramView({
  program,
  block,
  complete,
  carryKey,
}: {
  program: UiProgram;
  /** Its id within its message (see `uiBlockId`), which Pim keeps its state under. */
  block: string;
  /**
   * False while the block streams in: its program is replaced as more of it
   * arrives, and so is its id, so nothing is kept or sent until it is whole.
   */
  complete: boolean;
  /** Where what the person typed while it streamed is carried to the block that replaces this one when the message is drawn anew. */
  carryKey: string | undefined;
}) {
  const reply = useContext(Reply);
  const { t } = useI18n();
  /** What the person has set, by state key. A program that replaces this one starts from its own initial state and takes these over it. */
  const [typed] = useState(() => {
    if (!carryKey) return {};
    return complete
      ? (carried.get(carryKey)?.values ?? {})
      : claimCarried(carryKey);
  });
  const [seed] = useState(() =>
    withTyped(seededState(program, reply.submitted), program, typed),
  );
  const [view, setView] = useState<Evaluation>(() =>
    evaluate(program, seed, null),
  );
  const viewRef = useRef(view);
  const blockRef = useRef(block);
  blockRef.current = block;
  const [problem, setProblem] = useState<string | null>(null);
  const sending = useRef(false);
  const [busy, setBusy] = useState(false);
  /** Whether the person has changed anything since the block was drawn: what Pim kept then doesn't replace it. */
  const touched = useRef(Object.keys(typed).length > 0);
  /** How many handlers' actions are being run, one inside another. */
  const acting = useRef(0);

  // Only a message the person can talk in is theirs to keep state for: a public copy has no Pim to ask.
  const message =
    reply.send !== undefined ? reply.messageId?.split(":")[0] : undefined;
  const messageRef = useRef(message);
  messageRef.current = message;
  const writer = useRef<UiStateWriter | null>(null);
  if (writer.current === null) {
    writer.current = new UiStateWriter(
      (version, state, submitted) =>
        pim.saveUiState(messageRef.current as string, blockRef.current, {
          version,
          state,
          submitted,
        }),
      // Submitted from elsewhere: it is as it was submitted here too.
      (stored) => draw(seededState(program, reply.submitted, stored.state)),
    );
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: read once, when the block is drawn; `draw` and `reply` only reach the state it is drawn from.
  useEffect(() => {
    const saving = writer.current;
    if (message === undefined) return;
    let current = true;
    loadUiStates(message)
      .then((blocks) => {
        const stored = blocks[block];
        if (!current || stored === undefined) return;
        saving?.adopt(stored.version);
        if (!touched.current)
          draw(seededState(program, reply.submitted, stored.state));
      })
      // Not there to read: the block is as the message drew it, and what is typed is still saved.
      .catch(() => {});
    return () => {
      current = false;
      // Leaving the page or the chat doesn't lose the last change.
      saving?.flush();
    };
  }, [message, block, program]);

  const show = (next: Evaluation) => {
    viewRef.current = next;
    setView(next);
  };

  /** Draws the block again from a state of the web's own making, such as unlocked after a failed send. */
  const draw = (state: UiState) => {
    show(evaluate(program, state, null));
  };

  /** Has Pim keep the state: for good once every form is answered and nothing is left to send. */
  const keep = (state: UiState) => {
    // Not while a handler's actions are being run: whether a turn is left to send isn't known until they have been.
    if (message === undefined || acting.current > 0 || !complete) return;
    const forms = Object.keys(program.forms);
    const done =
      forms.length > 0 &&
      forms.every((form) => state.submitted[form] !== undefined) &&
      !sending.current;
    writer.current?.write(storableState(state), {
      submitted: done,
      now: done,
    });
  };

  const run = (event: UiEvent) => {
    // Typing is for any time; what sends or runs waits for the block to be whole.
    if (!complete && event.type !== "change") return;
    const next = evaluate(program, viewRef.current.state, event);
    if (next.error !== null) {
      setProblem(next.error);
      return;
    }
    setProblem(null);
    touched.current = true;
    if (event.type === "change") typed[event.key] = event.value;
    show(next);
    acting.current += 1;
    try {
      runActions(next.actions, event);
    } finally {
      acting.current -= 1;
    }
    keep(viewRef.current.state);
  };

  // A program that replaces this one, as a block streaming in grows: it keeps what the person typed, by key.
  const [drawnProgram, setDrawnProgram] = useState(program);
  if (drawnProgram !== program) {
    setDrawnProgram(program);
    const state = withTyped(
      seededState(program, reply.submitted),
      program,
      typed,
    );
    const next = evaluate(program, state, null);
    // One that doesn't work out leaves the last that did.
    if (next.error === null) show(next);
  }

  // A block that goes while its message is still arriving doesn't keep what was typed in it for good (see `carried`).
  // biome-ignore lint/correctness/useExhaustiveDependencies: `typed` is the same object for as long as the block lives
  useEffect(() => {
    if (!carryKey || complete) return;
    claimCarried(carryKey, typed);
    return () => releaseCarried(carryKey, typed);
  }, [carryKey, complete]);

  // The block is whole: what the person typed while it streamed is kept, under its final id.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only when it becomes complete
  useEffect(() => {
    if (!complete) return;
    if (touched.current) keep(viewRef.current.state);
    if (carryKey) dropCarried(carryKey);
  }, [complete]);

  const events: UiEvents = {
    change: (key, value) => run({ type: "change", key, value }),
    submit: (form) => run({ type: "submit", form }),
    click: (key) => run({ type: "click", key }),
  };

  /** Lets a submitted form be answered again, after a send that didn't go. */
  const unlock = (form: string) => {
    const state = viewRef.current.state;
    const freed: UiState = {
      values: { ...state.values },
      revealed: { ...state.revealed },
      submitted: { ...state.submitted },
    };
    delete freed.submitted[form];
    delete freed.revealed[form];
    draw(freed);
    keep(freed);
  };

  /** Runs what a handler asked for, as data; one turn sends once. */
  const runActions = (actions: readonly Action[], event: UiEvent) => {
    for (const action of actions) {
      if (action.name === "reveal") {
        // A reveal shows the answers of the form it belongs to, in place.
        const form =
          action.form ?? (event.type === "submit" ? event.form : null);
        if (form !== null) run({ type: "reveal", form });
        continue;
      }
      if (action.name === "copy") {
        void navigator.clipboard
          ?.writeText(stringOf(action.args[0] ?? ""))
          .catch(() => {});
        continue;
      }
      if (action.name === "openUrl") {
        // Checked again here, whatever the interpreter let through: only an http or https address is ever opened, and only if the person says so after seeing all of it.
        const url = httpUrlOf(stringOf(action.args[0] ?? ""));
        if (url !== null && window.confirm(t("uiOpenUrlConfirm", { url }))) {
          window.open(url, "_blank", "noopener,noreferrer");
        }
        continue;
      }
      if (action.name !== "issueNewTurn" || reply.send === undefined) continue;
      const form = action.form ?? (event.type === "submit" ? event.form : null);
      if (form === null || sending.current) continue;
      const submitted = viewRef.current.state.submitted[form];
      if (submitted === undefined) continue;
      const spec = program.forms[form];
      const values = Object.fromEntries(
        (spec?.fields ?? []).map((field) => [
          field.key,
          stringOf(submitted.values[field.key] ?? ""),
        ]),
      );
      const response: UiResponse = {
        block: form,
        ...(reply.messageId !== undefined
          ? { messageId: reply.messageId }
          : {}),
        values,
        graded: submitted.graded,
      };
      // The rest of the block's state goes along, so the agent hears the sliders and checkboxes as they stood.
      const extra = extraState(program, viewRef.current.state);
      if (Object.keys(extra).length > 0) response.state = extra;
      const readable = [stringOf(action.args[0] ?? ""), stateSummary(extra)]
        .filter((part) => part !== "")
        .join("\n\n");
      const turn = uiTurn(readable, response);
      if (!turnFits(turn)) {
        unlock(form);
        setProblem(t("uiTurnTooLong"));
        continue;
      }
      sending.current = true;
      setBusy(true);
      void reply
        .send(turn)
        .then(() => {
          setProblem(null);
          // Placed: the form is answered for good.
          sending.current = false;
          keep(viewRef.current.state);
        })
        .catch(() => {
          unlock(form);
          setProblem(t("uiSendFailed"));
        })
        .finally(() => {
          sending.current = false;
          setBusy(false);
        });
    }
  };

  return (
    <div className="my-4 min-w-0 rounded-2xl border bg-background p-4">
      <Settled.Provider value={complete}>
        <Events.Provider value={events}>
          <Tree nodes={view.tree} locked={busy} />
        </Events.Provider>
      </Settled.Provider>
      {problem !== null && (
        <p className="mt-3 text-[13px] text-destructive" role="alert">
          {problem}
        </p>
      )}
    </div>
  );
}

/** Draws the tree the interpreter gave. */
function Tree({
  nodes,
  locked,
  inline = false,
}: {
  nodes: readonly RenderNode[];
  locked: boolean;
  /** Text within a line, rather than a paragraph of its own. */
  inline?: boolean;
}) {
  return (
    <>
      {nodes.map((node, index) => (
        // The tree's shape changes only as its state does, never its order.
        // biome-ignore lint/suspicious/noArrayIndexKey: see above
        <Node key={index} node={node} locked={locked} inline={inline} />
      ))}
    </>
  );
}

function Node({
  node,
  locked,
  inline = false,
}: {
  node: RenderNode;
  locked: boolean;
  inline?: boolean;
}) {
  const { t } = useI18n();
  const events = useContext(Events);
  const settled = useContext(Settled);
  if (node.t === "md")
    return inline ? node.text : <Markdown text={node.text} untrusted />;
  if (node.t === "text")
    return inline ? (
      node.text
    ) : (
      <p className="text-[15px] leading-6">{node.text}</p>
    );
  const props = node.props;
  // Text that makes up a line of its own is read as text; text inside a
  // component joins the line it belongs to.
  const own = ["text", "title", "cell", "button", "badge"].includes(node.tag);
  const children = <Tree nodes={node.children} locked={locked} inline={own} />;
  switch (node.tag) {
    case "box": {
      const gap = [
        "gap-0",
        "gap-1",
        "gap-2",
        "gap-3",
        "gap-4",
        "gap-6",
        "gap-8",
      ][Math.max(0, Math.min(Number(props.gap ?? 2), 6))];
      const padding = ["p-0", "p-2", "p-3", "p-4", "p-6", "p-8"][
        Math.max(0, Math.min(Number(props.padding ?? 0), 5))
      ];
      return (
        <div
          className={cn(
            "flex min-w-0 flex-col",
            props.row === true && "flex-row flex-wrap items-start",
            gap,
            padding,
            props.border === true && "rounded-2xl border",
            props.tone === "muted" && "rounded-2xl bg-muted/50",
          )}
        >
          {children}
        </div>
      );
    }
    case "text":
      return (
        <p
          className={cn(
            "text-[15px] leading-6",
            props.tone === "muted" && "text-muted-foreground",
          )}
        >
          {children}
        </p>
      );
    case "title":
      return <p className="font-semibold">{children}</p>;
    case "table": {
      const head = Array.isArray(props.head) ? props.head.map(String) : [];
      return (
        <div className="my-2 max-w-full overflow-x-auto rounded-xl border border-border scrollbar-thin">
          <table className="w-full border-collapse text-sm">
            {head.length > 0 && (
              <thead className="bg-muted/50 text-left">
                <tr>
                  {head.map((title, index) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: a table's columns are its order
                    <th key={index} className="px-3 py-2 font-semibold">
                      {title}
                    </th>
                  ))}
                </tr>
              </thead>
            )}
            <tbody>{children}</tbody>
          </table>
        </div>
      );
    }
    case "row":
      return <tr>{children}</tr>;
    case "cell":
      return (
        <td className="border-t border-border px-3 py-2 align-middle">
          {children}
        </td>
      );
    case "form": {
      const id = String(props.id ?? "");
      const isLocked = props.locked === true;
      const ready = props.ready !== false;
      const hintId = `${id}-ready-hint`;
      return (
        <form
          data-form={id}
          onSubmit={(event) => {
            event.preventDefault();
            if (!isLocked && ready && settled) events.submit(id);
          }}
          className="min-w-0"
        >
          {children}
          <div className="mt-3 flex items-center gap-2">
            <Button
              type="submit"
              size="sm"
              disabled={isLocked || locked || !ready || !settled}
              aria-describedby={!isLocked && !ready ? hintId : undefined}
              data-part="submit"
            >
              {String(props.submitLabel ?? t("uiSubmit"))}
            </Button>
            {!isLocked && !ready && (
              <span id={hintId} className="text-[13px] text-muted-foreground">
                {t("uiFillIn")}
              </span>
            )}
            {locked && (
              <span className="text-[13px] text-muted-foreground">
                {t("uiSending")}
              </span>
            )}
          </div>
        </form>
      );
    }
    case "badge":
      return (
        <span
          data-tone={String(props.tone ?? "default")}
          className={cn(
            "inline-flex w-fit items-center rounded-full px-2 py-0.5 text-xs font-medium",
            props.tone === "muted"
              ? "bg-muted text-muted-foreground"
              : props.tone === "good"
                ? "bg-success/12 text-success"
                : props.tone === "bad"
                  ? "bg-destructive/12 text-destructive"
                  : props.tone === "warn"
                    ? "bg-agent-amber/15 text-agent-amber"
                    : "bg-secondary text-foreground",
          )}
        >
          {children}
        </span>
      );
    case "chart":
      return <Chart props={props} />;
    case "number":
    case "input":
    case "select":
    case "checkbox":
    case "slider":
      return <Field node={node} locked={locked} />;
    case "button":
      return (
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={locked || !settled}
          onClick={() => events.click(String(props.key ?? ""))}
        >
          {children}
        </Button>
      );
    default:
      return null;
  }
}

/** One field of a form, with its mark when it has been graded. */
function Field({
  node,
  locked,
}: {
  node: Extract<RenderNode, { t: "el" }>;
  locked: boolean;
}) {
  const { t } = useI18n();
  const events = useContext(Events);
  const props = node.props;
  const key = String(props.key ?? "");
  const label = props.label === undefined ? undefined : String(props.label);
  const value = props.value === undefined ? "" : String(props.value);
  const isLocked = props.locked === true;
  const graded = props.graded === true;
  const required = props.required !== false;
  const revealed = props.answer !== undefined;
  const change = (next: string | number | boolean) => events.change(key, next);
  if (node.tag === "checkbox") {
    return (
      <div className="min-w-0" data-field={key}>
        <label className="flex items-center gap-2 text-[15px]">
          <input
            type="checkbox"
            checked={props.value === true}
            disabled={isLocked || locked}
            aria-required={props.required === true}
            onChange={(event) => change(event.currentTarget.checked)}
            className="size-4 shrink-0 accent-primary"
          />
          {label ?? String(props.name ?? "")}
          {revealed && <Mark graded={graded} />}
        </label>
        {revealed && !graded && props.answer !== undefined && (
          <p className="mt-1 text-[13px] text-muted-foreground">
            {t("uiExpected", { answer: props.answer === true ? "✓" : "—" })}
            {props.explain !== undefined && (
              <span> · {String(props.explain)}</span>
            )}
          </p>
        )}
      </div>
    );
  }
  if (node.tag === "slider") {
    const shown = `${String(props.value)}${props.unit === undefined ? "" : ` ${String(props.unit)}`}`;
    return (
      <div className="min-w-0" data-field={key}>
        <div className="mb-1 flex items-baseline justify-between gap-2 text-[13px] text-muted-foreground">
          <label htmlFor={`slider-${key}`}>{label}</label>
          <output
            htmlFor={`slider-${key}`}
            className="tabular-nums text-foreground"
          >
            {shown}
          </output>
        </div>
        <div className="flex items-center gap-2">
          <input
            id={`slider-${key}`}
            type="range"
            min={Number(props.min)}
            max={Number(props.max)}
            step={Number(props.step ?? 1)}
            value={Number(props.value)}
            disabled={isLocked || locked}
            aria-label={label ?? String(props.name ?? "")}
            aria-valuetext={shown}
            onChange={(event) => change(event.currentTarget.valueAsNumber)}
            className="h-6 w-full min-w-0 accent-primary disabled:cursor-not-allowed disabled:opacity-50"
          />
          {revealed && <Mark graded={graded} />}
        </div>
        {revealed && !graded && props.answer !== undefined && (
          <p className="mt-1 text-[13px] text-muted-foreground">
            {t("uiExpected", { answer: String(props.answer) })}
            {props.explain !== undefined && (
              <span> · {String(props.explain)}</span>
            )}
          </p>
        )}
      </div>
    );
  }
  const field =
    node.tag === "select" ? (
      <select
        value={value}
        disabled={isLocked}
        aria-label={label}
        aria-required={required}
        onChange={(event) => change(event.currentTarget.value)}
        className="h-10 w-full min-w-0 rounded-xl border border-input bg-background px-3 text-[15px] outline-none transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/20 disabled:cursor-not-allowed disabled:opacity-50"
      >
        <option value="" hidden />
        {(Array.isArray(props.options) ? props.options : []).map((option) => (
          <option key={String(option)} value={String(option)}>
            {String(option)}
          </option>
        ))}
      </select>
    ) : (
      <input
        type={node.tag === "number" ? "number" : "text"}
        value={value}
        disabled={isLocked}
        readOnly={locked}
        aria-label={label}
        aria-required={required}
        placeholder={
          props.placeholder === undefined ? "" : String(props.placeholder)
        }
        onChange={(event) => change(event.currentTarget.value)}
        className="h-10 w-full min-w-0 rounded-xl border border-input bg-background px-3 text-[15px] outline-none transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/20 disabled:cursor-not-allowed disabled:opacity-50"
      />
    );
  return (
    <div className="min-w-0" data-field={key}>
      {label !== undefined && (
        <label className="mb-1 block text-[13px] text-muted-foreground">
          {label}
        </label>
      )}
      <div className="flex items-center gap-2">
        {field}
        {revealed && <Mark graded={graded} />}
      </div>
      {revealed && !graded && props.answer !== undefined && (
        <p className="mt-1 text-[13px] text-muted-foreground">
          {t("uiExpected", { answer: String(props.answer) })}
          {props.explain !== undefined && (
            <span> · {String(props.explain)}</span>
          )}
        </p>
      )}
    </div>
  );
}

/** The mark a graded field shows once its form is revealed. */
function Mark({ graded }: { graded: boolean }) {
  const { t } = useI18n();
  return (
    <span
      role="img"
      aria-label={t(graded ? "uiCorrect" : "uiWrong")}
      className={cn(
        "shrink-0 font-medium",
        graded ? "text-success" : "text-destructive",
      )}
    >
      {graded ? "✓" : "✗"}
    </span>
  );
}

/** A chart: drawn for those who see, with its data as a table for those who don't. */
function Chart({ props }: { props: Record<string, Value> }) {
  const { t } = useI18n();
  const kind = props.kind as "bar" | "line" | "pie";
  const points = (Array.isArray(props.data) ? props.data : []) as ChartPoint[];
  const title = props.title === undefined ? undefined : String(props.title);
  const label = title ?? t("uiChart", { kind });
  return (
    <figure className="my-2 min-w-0" data-chart={kind}>
      {title !== undefined && (
        <figcaption className="mb-1 font-semibold">{title}</figcaption>
      )}
      <div role="img" aria-label={label}>
        <Suspense fallback={<div className="h-[220px] rounded-xl bg-muted" />}>
          <UiChartView kind={kind} points={points} />
        </Suspense>
      </div>
      <table className="sr-only">
        <caption>{label}</caption>
        <thead>
          <tr>
            <th scope="col">{String(props.x)}</th>
            <th scope="col">{String(props.y)}</th>
          </tr>
        </thead>
        <tbody>
          {points.map((point, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: a chart's points are its order
            <tr key={index}>
              <td>{point.x}</td>
              <td>{point.y}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}
