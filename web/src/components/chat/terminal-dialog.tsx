import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Dialog } from "radix-ui";
import { useEffect, useRef } from "react";
import { useI18n } from "~/components/i18n";
import { Terminal, X } from "~/components/icons";
import { pim, type TerminalCommand, type TerminalStatus } from "~/lib/pim-api";

/** How often the chat looks for new output while a command runs, and for a new command while the chat works. */
const RUNNING_REFRESH_MS = 1_000;
const WORKING_REFRESH_MS = 3_000;

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
/** Escape sequences a terminal acts on that this view leaves out: every one but the colors (SGR, `ESC[…m`). */
const OTHER_ESCAPES = new RegExp(
  `${ESC}(\\[[0-?]*[ -/]*[@-ln-~]|\\][^${BEL}]*(${BEL}|${ESC}\\\\)|[@-Z\\\\-_])`,
  "g",
);
const COLORS = new RegExp(`${ESC}\\[([0-9;]*)m`);

/** The terminal's own palette, the same in light and dark mode: ANSI's eight colors and their bright forms. */
const PALETTE = [
  "#3b4252",
  "#f07178",
  "#a6da95",
  "#f5c76e",
  "#82aaff",
  "#c792ea",
  "#7fdbca",
  "#d6deeb",
];
const BRIGHT = [
  "#697098",
  "#ff8b92",
  "#c3e88d",
  "#ffd580",
  "#9cc4ff",
  "#e0b0ff",
  "#a2f0e2",
  "#ffffff",
];

type Style = { color?: string; bold?: boolean; dim?: boolean };
export type Run = { text: string } & Style;

/**
 * Output as a terminal leaves it, in runs of one color: each line as its last carriage return left it
 * (a progress bar shows its last state), with the colors its SGR sequences set and no other escape.
 */
export function terminalRuns(output: string): Run[] {
  const text = output
    .replace(OTHER_ESCAPES, "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.slice(line.lastIndexOf("\r") + 1))
    .join("\n");
  const runs: Run[] = [];
  let style: Style = {};
  const parts = text.split(COLORS);
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i] ?? "";
    if (i % 2 === 0) {
      if (part) runs.push({ text: part, ...style });
      continue;
    }
    const codes = (part || "0").split(";").map(Number);
    for (let c = 0; c < codes.length; c++) {
      const code = codes[c] ?? 0;
      if (code === 0) style = {};
      else if (code === 1) style = { ...style, bold: true };
      else if (code === 2) style = { ...style, dim: true };
      else if (code === 22) style = { ...style, bold: false, dim: false };
      else if (code >= 30 && code <= 37)
        style = { ...style, color: PALETTE[code - 30] };
      else if (code >= 90 && code <= 97)
        style = { ...style, color: BRIGHT[code - 90] };
      else if (code === 39) style = { ...style, color: undefined };
      // 256 colors and RGB name a color this palette has no slot for: their numbers are skipped.
      else if (code === 38) c += codes[c + 1] === 5 ? 2 : 4;
    }
  }
  return runs;
}

/**
 * The chat's terminal: the commands its agents ran in the shell on the
 * person's computer, oldest first, and whether one runs now. It asks again
 * every second while a command runs, every few while the chat works (when
 * the next may start), and otherwise only when the chat's activity says
 * something changed; only what changed comes back.
 */
export function useTerminal(sessionId: string, working: boolean) {
  const queryClient = useQueryClient();
  const queryKey = ["terminal", sessionId];
  const terminal = useQuery({
    queryKey,
    queryFn: async (): Promise<TerminalStatus> => {
      const known = queryClient.getQueryData<TerminalStatus>(queryKey);
      const read = await pim.terminal(sessionId, known?.version);
      return read.commands ? read : { ...read, commands: known?.commands };
    },
    refetchInterval: (query) =>
      query.state.data?.commands?.some((command) => command.endedAt === null)
        ? RUNNING_REFRESH_MS
        : working
          ? WORKING_REFRESH_MS
          : false,
  });
  const commands = terminal.data?.commands ?? [];
  return {
    commands,
    running: commands.some((command) => command.endedAt === null),
  };
}

/**
 * The chat's terminal, over the page as the Computer dialog is: each command
 * as a prompt line, what it printed, as it prints it, and how it ended.
 * Read-only: the person watches, and the agents' commands run as they would
 * without it. New output scrolls into view unless the person scrolled up.
 */
export function TerminalDialog({
  commands,
  open,
  onOpenChange,
}: {
  commands: TerminalCommand[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useI18n();
  const scroller = useRef<HTMLDivElement | null>(null);
  const following = useRef(true);
  const last = commands.at(-1);
  // biome-ignore lint/correctness/useExhaustiveDependencies: it scrolls when the output changes.
  useEffect(() => {
    const view = scroller.current;
    if (view && following.current) view.scrollTop = view.scrollHeight;
  }, [open, last?.id, last?.output, last?.endedAt]);
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        following.current = true;
        onOpenChange(next);
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/30 data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        {/* A terminal window, dark in light and dark mode alike, as terminals are. */}
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed inset-0 z-50 flex flex-col overflow-hidden bg-[#0b0e14] text-[#d6deeb] outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 sm:inset-auto sm:top-1/2 sm:left-1/2 sm:h-[min(calc(100dvh-4rem),48rem)] sm:w-[min(calc(100vw-4rem),64rem)] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-2xl sm:border sm:border-white/10 sm:shadow-xl"
        >
          {/* The browser dialog's title bar, in the terminal's colors: what it is where the browser has its buttons, and the close button where it has its own. */}
          <header className="flex h-11 shrink-0 items-center gap-1.5 border-white/10 border-b bg-[#161b22] pr-1.5 pl-3">
            <span className="flex size-8 shrink-0 items-center justify-center text-[#8b949e]">
              <Terminal className="size-4" />
            </span>
            <Dialog.Title className="min-w-0 flex-1 truncate font-medium text-[15px] text-white">
              {t("terminal")}
            </Dialog.Title>
            <Dialog.Close className="rounded-full p-2 text-[#8b949e] hover:bg-white/10 hover:text-white">
              <X className="size-4" />
              <span className="sr-only">{t("close")}</span>
            </Dialog.Close>
          </header>
          <div
            ref={scroller}
            onScroll={(event) => {
              const view = event.currentTarget;
              following.current =
                view.scrollHeight - view.scrollTop - view.clientHeight < 24;
            }}
            className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3 font-mono text-[13px] leading-relaxed selection:bg-[#264f78]"
          >
            {commands.map((command) => (
              <CommandBlock key={command.id} command={command} />
            ))}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function CommandBlock({ command }: { command: TerminalCommand }) {
  const { t } = useI18n();
  const runs = terminalRuns(command.output.replace(/\n$/, ""));
  const failed =
    command.timedOut ||
    command.signal !== null ||
    (command.exitCode !== null && command.exitCode !== 0);
  const ended = command.timedOut
    ? t("terminalTimedOut")
    : command.signal
      ? t("terminalSignal", { signal: command.signal })
      : t("terminalExit", { code: String(command.exitCode ?? "?") });
  return (
    <div>
      <p className="whitespace-pre-wrap break-words">
        <span className="select-none text-[#82aaff]">{command.cwd}</span>
        <span className="select-none text-[#a6da95]"> $ </span>
        <span className="text-white">{command.command}</span>
      </p>
      {(runs.length > 0 || command.endedAt === null) && (
        <pre className="whitespace-pre-wrap break-words font-mono text-[#c8d0e0]">
          {runs.map((run, index) => (
            <span
              // biome-ignore lint/suspicious/noArrayIndexKey: runs are only ever replaced whole.
              key={index}
              style={run.color ? { color: run.color } : undefined}
              className={
                run.bold ? "font-bold" : run.dim ? "opacity-60" : undefined
              }
            >
              {run.text}
            </span>
          ))}
          {command.endedAt === null && (
            <span
              role="img"
              aria-label={t("terminalRunning")}
              className="ml-px inline-block h-[1.1em] w-[0.6em] translate-y-[0.2em] animate-pulse bg-[#d6deeb]"
            />
          )}
        </pre>
      )}
      {command.endedAt !== null && (
        <p className={failed ? "text-[#f07178]" : "text-[#697098]"}>{ended}</p>
      )}
    </div>
  );
}
