import {
  createContext,
  memo,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Markdown } from "~/components/chat/markdown";
import { Reply } from "~/components/chat/reply-blocks";
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
  initialState,
  MAX_TURN_BYTES,
  type RenderNode,
  storableState,
  stringOf,
  type UiEvent,
  type UiProgram,
  type UiResponse,
  type UiState,
  uiBlockId,
  uiTurn,
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

/** A ```ui fence, as the model wrote it. */
export function isUiBlock(language: string): boolean {
  return language === "ui";
}

/** What the tree is drawn with: the events its components raise. */
type UiEvents = {
  change: (key: string, value: string) => void;
  submit: (form: string) => void;
  click: (key: string) => void;
};

const Events = createContext<UiEvents>({
  change: () => {},
  submit: () => {},
  click: () => {},
});

/** Draws one block of ui source; its fallback, when it can't be drawn. */
export const UiBlock = memo(function UiBlock({
  source,
  fallback,
}: {
  source: string;
  /** Its source as a code block, kept for where nothing else can be shown. */
  fallback: ReactNode;
}) {
  const { streaming } = useContext(Reply);
  const { t } = useI18n();
  const program = useMemo(() => compile(source), [source]);
  if (streaming)
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
  return <UiProgramView program={program} block={uiBlockId(source)} />;
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
    for (const [key, value] of Object.entries(response.values)) {
      state.values[key] = value;
    }
  }
  return state;
}

/** One whole block, holding its state between the events that change it. */
function UiProgramView({
  program,
  block,
}: {
  program: UiProgram;
  /** Its id within its message (see `uiBlockId`), which Pim keeps its state under. */
  block: string;
}) {
  const reply = useContext(Reply);
  const { t } = useI18n();
  const [seed] = useState(() => seededState(program, reply.submitted));
  const [view, setView] = useState<Evaluation>(() =>
    evaluate(program, seed, null),
  );
  const viewRef = useRef(view);
  const [problem, setProblem] = useState<string | null>(null);
  const sending = useRef(false);
  const [busy, setBusy] = useState(false);
  /** Whether the person has changed anything since the block was drawn: what Pim kept then doesn't replace it. */
  const touched = useRef(false);
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
        pim.saveUiState(messageRef.current as string, block, {
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
    if (message === undefined || acting.current > 0) return;
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
    const next = evaluate(program, viewRef.current.state, event);
    if (next.error !== null) {
      setProblem(next.error);
      return;
    }
    setProblem(null);
    touched.current = true;
    show(next);
    acting.current += 1;
    try {
      runActions(next.actions, event);
    } finally {
      acting.current -= 1;
    }
    keep(viewRef.current.state);
  };

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
      const turn = uiTurn(stringOf(action.args[0] ?? ""), response);
      if (turn.length > MAX_TURN_BYTES) {
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
      <Events.Provider value={events}>
        <Tree nodes={view.tree} locked={busy} />
      </Events.Provider>
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
  const own = ["text", "title", "cell", "button"].includes(node.tag);
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
            if (!isLocked && ready) events.submit(id);
          }}
          className="min-w-0"
        >
          {children}
          <div className="mt-3 flex items-center gap-2">
            <Button
              type="submit"
              size="sm"
              disabled={isLocked || locked || !ready}
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
    case "number":
    case "input":
    case "select":
      return <Field node={node} locked={locked} />;
    case "button":
      return (
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={locked}
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
  const change = (next: string) => events.change(key, next);
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
        {revealed && (
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
        )}
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
