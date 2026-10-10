import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Bell,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  Copy,
  RotateCcw,
  ShieldCheck,
  X,
  Zap,
} from "lucide-react";
import { memo, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Markdown } from "~/components/chat/markdown";
import { useI18n } from "~/components/i18n";
import { useShowReasoning } from "~/components/reasoning-preference";
import { Action, Actions } from "~/components/ui/actions";
import { Button } from "~/components/ui/button";
import { CodeBlock } from "~/components/ui/code-block";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "~/components/ui/collapsible";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import {
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
} from "~/components/ui/reasoning";
import {
  Tool,
  ToolContent,
  ToolHeader,
  ToolInput,
  ToolOutput,
  type ToolState,
} from "~/components/ui/tool";
import {
  type ApprovalField,
  approvalView,
  type CodeLanguage,
  resultView,
} from "~/lib/approval-view";
import {
  type FunctionCallItem,
  type FunctionCallOutputItem,
  type MessageItem,
  messageText,
  type ORItem,
  type ReasoningItem,
  reasoningSummaryText,
} from "~/lib/openresponses";
import { type Approval, pim } from "~/lib/pim-api";
import type { PimNotice } from "~/lib/pim-view";
import { cn } from "~/lib/utils";

function useCopy(text: string) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  return { copied, copy };
}

/* ------------------------------ user message ----------------------------- */

export const UserMessage = memo(function UserMessage({
  item,
}: {
  item: MessageItem;
}) {
  const { t } = useI18n();
  const text = messageText(item);
  const { copied, copy } = useCopy(text);

  return (
    <div className="group/user flex w-full flex-col items-end gap-1.5">
      {text.length > 0 && (
        <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-3xl bg-secondary px-4 py-2.5 text-[15px] text-secondary-foreground leading-6">
          {text}
        </div>
      )}
      <Actions className="gap-0.5 opacity-0 transition-opacity group-hover/user:opacity-100">
        <Action
          size="icon"
          className="size-7 text-muted-foreground"
          onClick={copy}
          aria-label={t("copyMessage")}
        >
          {copied ? (
            <Check className="size-3.5" />
          ) : (
            <Copy className="size-3.5" />
          )}
        </Action>
      </Actions>
    </div>
  );
});

/* --------------------------- assistant message --------------------------- */

export const AssistantMessage = memo(function AssistantMessage({
  item,
  streaming,
}: {
  item: MessageItem;
  streaming?: boolean;
}) {
  const { t } = useI18n();
  const text = messageText(item);
  const { copied, copy } = useCopy(text);

  return (
    <div className="group/assistant w-full">
      <Markdown text={text} streaming={streaming} />
      {streaming && (
        <span className="ml-0.5 inline-block h-4 w-2 animate-pulse rounded-sm bg-foreground/70 align-text-bottom" />
      )}
      {!streaming && (
        <Actions className="mt-1.5 gap-0.5 opacity-0 transition-opacity group-hover/assistant:opacity-100">
          <Action
            size="icon"
            className="size-7 text-muted-foreground"
            onClick={copy}
            aria-label={t("copyResponse")}
          >
            {copied ? (
              <Check className="size-3.5" />
            ) : (
              <Copy className="size-3.5" />
            )}
          </Action>
        </Actions>
      )}
    </div>
  );
});

/* ---------------------------- Pim's own inputs --------------------------- */

const NOTICE_ICONS = {
  approval: ShieldCheck,
  schedule: Bell,
  event: Zap,
  reset: RotateCcw,
} as const;

/**
 * Something Pim fed itself rather than something the user said: an approval
 * decision, a scheduled task firing, an app event. Shown as a compact,
 * expandable line so the conversation reads as the user experienced it.
 */
export const EventNotice = memo(function EventNotice({
  notice,
}: {
  notice: PimNotice;
}) {
  const [open, setOpen] = useState(false);
  const Icon = NOTICE_ICONS[notice.kind];
  return (
    <div className="flex w-full flex-col items-center">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="inline-flex max-w-full items-center gap-1.5 rounded-full border bg-card px-3 py-1 text-muted-foreground text-xs transition-colors hover:bg-accent/50"
      >
        <Icon className="size-3.5 shrink-0" />
        <span className="truncate">{notice.title}</span>
        <ChevronRight
          className={cn(
            "size-3 shrink-0 transition-transform",
            open && "rotate-90",
          )}
        />
      </button>
      {open && (
        <pre className="mt-2 max-h-64 w-full overflow-y-auto whitespace-pre-wrap rounded-xl border bg-muted/50 p-3 font-mono text-xs leading-relaxed [overflow-wrap:anywhere]">
          {notice.text}
        </pre>
      )}
    </div>
  );
});

/* -------------------------------- reasoning ------------------------------ */

export const ReasoningBlock = memo(function ReasoningBlock({
  item,
  streaming,
}: {
  item: ReasoningItem;
  streaming?: boolean;
}) {
  const { t } = useI18n();
  const summary = reasoningSummaryText(item);
  const { showReasoning } = useShowReasoning();

  if (summary.trim().length === 0) {
    return (
      <div className="flex items-center gap-1.5 text-muted-foreground text-sm">
        {streaming ? (
          <span className="animate-pulse">{t("thinking")}</span>
        ) : (
          t("thoughtProcess")
        )}
      </div>
    );
  }

  return (
    <Reasoning
      className="w-full"
      isStreaming={streaming}
      defaultOpen={showReasoning}
    >
      <ReasoningTrigger />
      <ReasoningContent>{summary}</ReasoningContent>
    </Reasoning>
  );
});

/* ------------------------------- tool calls ------------------------------ */

function tryPrettyJson(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

export const ToolCallBlock = memo(function ToolCallBlock({
  call,
  output,
  running,
  liveOutput,
}: {
  call: FunctionCallItem;
  output?: FunctionCallOutputItem | null;
  /** The call is executing now. */
  running?: boolean;
  /** Output streamed so far, while running. */
  liveOutput?: string;
}) {
  const outputText = useMemo(() => {
    if (!output) return liveOutput || null;
    if (typeof output.output === "string") return tryPrettyJson(output.output);
    return JSON.stringify(output.output, null, 2);
  }, [output, liveOutput]);

  const state: ToolState = output
    ? output.status === "incomplete"
      ? "error"
      : "completed"
    : running
      ? "running"
      : "pending";

  return (
    <Tool>
      <ToolHeader title={call.name} state={state} />
      <ToolContent>
        <ToolInput input={tryPrettyJson(call.arguments || "{}")} />
        <ToolOutput output={outputText} />
      </ToolContent>
    </Tool>
  );
});

/* -------------------------------- approvals ------------------------------ */

/**
 * A gated tool call, shown as the approval it filed: what Pim wants to do,
 * and Approve/Deny while it waits. Once decided, the outcome and its result.
 */
export const ApprovalBlock = memo(function ApprovalBlock({
  approval,
}: {
  approval: Approval;
}) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const decide = useMutation({
    mutationFn: (decision: "approve" | "deny" | "always") =>
      decision === "always"
        ? pim.decide(approval.id, "approve", true)
        : pim.decide(approval.id, decision),
    onSuccess: (decided, decision) => {
      queryClient.setQueryData<Approval[]>(["approvals"], (approvals) =>
        approvals?.map((candidate) =>
          candidate.id === decided.id ? decided : candidate,
        ),
      );
      if (decision === "always") {
        queryClient.invalidateQueries({ queryKey: ["always-approved"] });
      }
    },
    onError: (error) => toast.error(error.message),
  });
  const pending = approval.status === "pending";
  const approved = approval.status === "approved";
  const StatusIcon = pending ? ShieldCheck : approved ? Check : X;
  const view = useMemo(() => approvalView(approval), [approval]);
  const hasDetails = view.fields.length > 0 || approval.result !== null;

  return (
    <article
      className={cn(
        "w-full min-w-0 rounded-xl border bg-card px-4 py-3",
        pending && "border-primary/40 shadow-xs",
      )}
    >
      <div
        className={cn(
          "flex items-center gap-2 font-medium text-xs",
          pending && "text-muted-foreground",
          approved && "text-green-600 dark:text-green-500",
          approval.status === "denied" && "text-destructive",
        )}
      >
        <StatusIcon className="size-3.5 shrink-0" />
        {pending
          ? t("approvalRequested")
          : approved
            ? t(
                approval.decidedBy === "timeout"
                  ? "approvedNoAnswer"
                  : "approved",
              )
            : t(approval.decidedBy === "timeout" ? "deniedNoAnswer" : "denied")}
      </div>
      <p
        className="mt-1.5 line-clamp-3 font-medium text-sm [overflow-wrap:anywhere]"
        title={view.title}
      >
        {view.title}
      </p>
      {approval.note && (
        <p className="mt-1 text-muted-foreground text-sm [overflow-wrap:anywhere]">
          “{approval.note}”
        </p>
      )}
      {/* What is being approved stays in view; once decided, it folds away. */}
      {pending
        ? view.fields.length > 0 && <ApprovalFields fields={view.fields} />
        : hasDetails && (
            <Collapsible className="mt-2">
              <CollapsibleTrigger className="group flex items-center gap-1 text-muted-foreground text-xs hover:text-foreground">
                <ChevronRight className="size-3.5 shrink-0 transition-transform group-data-[state=open]:rotate-90" />
                {t("details")}
              </CollapsibleTrigger>
              <CollapsibleContent>
                <ApprovalFields fields={view.fields} />
                {approval.result !== null && (
                  <ApprovalResult result={approval.result} />
                )}
              </CollapsibleContent>
            </Collapsible>
          )}
      {pending && (
        <div className="mt-3 flex gap-2">
          {/* The countdown sits on the button the timeout will press. */}
          <Button
            variant="outline"
            onClick={() => decide.mutate("deny")}
            disabled={decide.isPending}
            className="flex-1"
          >
            {approval.expiresAt !== null && approval.onTimeout === "deny" ? (
              <CountdownRing
                from={approval.createdAt}
                until={approval.expiresAt}
              />
            ) : (
              <X className="size-4" />
            )}{" "}
            {t("deny")}
          </Button>
          {/* Approve, with "always" one step away in its menu rather than a button of its own. */}
          <div className="flex flex-1">
            <Button
              onClick={() => decide.mutate("approve")}
              disabled={decide.isPending}
              className={cn(
                "flex-1",
                approval.tool !== null && "rounded-r-none",
              )}
            >
              {approval.expiresAt !== null && approval.onTimeout !== "deny" ? (
                <CountdownRing
                  from={approval.createdAt}
                  until={approval.expiresAt}
                />
              ) : (
                <Check className="size-4" />
              )}{" "}
              {t("approve")}
            </Button>
            {approval.tool !== null && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    size="icon"
                    disabled={decide.isPending}
                    aria-label={t("moreApprovalOptions")}
                    className="rounded-l-none border-primary-foreground/20 border-l"
                  >
                    <ChevronDown className="size-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem
                    className="cursor-pointer"
                    onSelect={() => decide.mutate("always")}
                  >
                    <CheckCheck /> {t("alwaysApprove")}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        </div>
      )}
    </article>
  );
});

/** A ring that empties as `until` nears, with the seconds left inside (minutes, above 99 seconds). */
function CountdownRing({ from, until }: { from: number; until: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 200);
    return () => clearInterval(timer);
  }, []);
  const left = Math.max(0, until - now);
  const shown =
    left > 99_000
      ? `${Math.ceil(left / 60_000)}m`
      : `${Math.ceil(left / 1000)}`;
  const radius = 12;
  const circumference = 2 * Math.PI * radius;
  return (
    <svg
      viewBox="0 0 32 32"
      className="size-8 shrink-0 -rotate-90"
      role="img"
      aria-label={shown}
    >
      <circle
        cx="16"
        cy="16"
        r={radius}
        fill="none"
        stroke="currentColor"
        strokeOpacity={0.25}
        strokeWidth={2.5}
      />
      <circle
        cx="16"
        cy="16"
        r={radius}
        fill="none"
        stroke="currentColor"
        strokeWidth={2.5}
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={circumference * (1 - left / (until - from))}
      />
      {/* Turned back upright. Digits are about 0.72em tall, so a baseline 0.36em below the middle centres their ink, whatever the font. */}
      <text
        x="16"
        y="16"
        dy="0.36em"
        transform="rotate(90 16 16)"
        textAnchor="middle"
        fill="currentColor"
        fontSize="10"
        fontWeight="500"
        style={{ fontVariantNumeric: "tabular-nums" }}
      >
        {shown}
      </text>
    </svg>
  );
}

const FIELD_LABEL_CLASS =
  "font-mono text-muted-foreground text-xs [overflow-wrap:anywhere]";

/** A value too long for a line: highlighted, wrapped, and capped in height. */
function ApprovalCode({
  code,
  language,
}: {
  code: string;
  language: CodeLanguage;
}) {
  return (
    <div className="max-h-64 overflow-y-auto rounded-lg border bg-muted/40 scrollbar-thin">
      {language === "text" ? (
        <pre className="whitespace-pre-wrap px-3 py-2.5 font-mono text-xs leading-relaxed [overflow-wrap:anywhere]">
          {code}
        </pre>
      ) : (
        <CodeBlock
          code={code}
          language={language}
          className="my-0 rounded-none border-0 bg-transparent [&_pre]:!bg-transparent [&_pre]:px-3 [&_pre]:py-2.5 [&_pre]:text-xs [&_pre]:whitespace-pre-wrap [&_pre]:[overflow-wrap:anywhere] [&_code]:text-xs"
        />
      )}
    </div>
  );
}

function ApprovalFields({ fields }: { fields: readonly ApprovalField[] }) {
  if (fields.length === 0) return null;
  return (
    <dl className="mt-2.5 space-y-2.5">
      {fields.map((field) =>
        field.kind === "text" ? (
          <div key={field.name} className="flex min-w-0 items-baseline gap-2">
            <dt className={cn(FIELD_LABEL_CLASS, "shrink-0")}>{field.name}</dt>
            <dd className="min-w-0 font-mono text-xs [overflow-wrap:anywhere]">
              {field.text}
            </dd>
          </div>
        ) : (
          <div key={field.name} className="min-w-0 space-y-1">
            <dt className={FIELD_LABEL_CLASS}>{field.name}</dt>
            <dd>
              <ApprovalCode code={field.code} language={field.language} />
            </dd>
          </div>
        ),
      )}
    </dl>
  );
}

function ApprovalResult({ result }: { result: string }) {
  const { t } = useI18n();
  const view = useMemo(() => resultView(result), [result]);
  return (
    <div className="mt-2.5 min-w-0 space-y-1">
      <div className={FIELD_LABEL_CLASS}>
        {t("result")}
        {view.lead && <span className="ml-2 text-foreground">{view.lead}</span>}
      </div>
      <ApprovalCode code={view.code} language={view.language} />
    </div>
  );
}

/* ------------------------------ unknown items ---------------------------- */

export const UnknownItemBlock = memo(function UnknownItemBlock({
  item,
}: {
  item: ORItem;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="w-full overflow-hidden rounded-xl border border-dashed bg-card/50">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3.5 py-2 text-left text-muted-foreground text-sm hover:bg-accent/50"
      >
        <span className="font-mono text-xs">{item.type}</span>
        <ChevronRight
          className={cn(
            "ml-auto size-4 transition-transform",
            open && "rotate-90",
          )}
        />
      </button>
      {open && (
        <pre className="max-h-64 overflow-auto border-t bg-muted/50 p-3 font-mono text-xs leading-relaxed scrollbar-thin">
          {JSON.stringify(item, null, 2)}
        </pre>
      )}
    </div>
  );
});

/* ------------------------------- indicators ------------------------------ */

export function ThinkingDot() {
  return (
    <div className="flex h-7 items-center">
      <span className="size-3 animate-pulse rounded-full bg-foreground/80" />
    </div>
  );
}
