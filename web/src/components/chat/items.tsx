import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { memo, type ReactNode, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Markdown } from "~/components/chat/markdown";
import { useI18n } from "~/components/i18n";
import {
  Bell,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  Copy,
  Loader2,
  Mail,
  RotateCcw,
  ShieldCheck,
  Workflow,
  X,
  Zap,
} from "~/components/icons";
import { Action, Actions } from "~/components/ui/actions";
import { Badge } from "~/components/ui/badge";
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
  type ApprovalField,
  approvalView,
  type CodeLanguage,
  resultView,
} from "~/lib/approval-view";
import {
  type InputImagePart,
  type MessageItem,
  messageText,
} from "~/lib/openresponses";
import { type Approval, pim } from "~/lib/pim-api";
import type { PimNotice } from "~/lib/pim-view";
import { agentsQuery } from "~/lib/queries";
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

/** When a message was said: the time, with the date when it wasn't today. */
function MessageTime({ at }: { at: number }) {
  const { formatDate } = useI18n();
  const date = new Date(at);
  const now = new Date();
  const options: Intl.DateTimeFormatOptions =
    date.toDateString() === now.toDateString()
      ? { timeStyle: "short" }
      : date.getFullYear() === now.getFullYear()
        ? { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }
        : { dateStyle: "medium", timeStyle: "short" };
  return (
    <time
      dateTime={date.toISOString()}
      title={formatDate(date, { dateStyle: "full", timeStyle: "short" })}
      className="shrink-0 tabular-nums"
    >
      {formatDate(date, options)}
    </time>
  );
}

/** A message's copy button, shown while the message is hovered or focused. */
function CopyAction({
  text,
  label,
  className,
}: {
  text: string;
  label: string;
  className: string;
}) {
  const { copied, copy } = useCopy(text);
  return (
    <Actions className={cn("opacity-0 transition-opacity", className)}>
      <Action
        size="icon"
        className="size-7 text-muted-foreground"
        onClick={copy}
        aria-label={label}
      >
        {copied ? (
          <Check className="size-3.5" />
        ) : (
          <Copy className="size-3.5" />
        )}
      </Action>
    </Actions>
  );
}

/* ------------------------------ user message ----------------------------- */

export const UserMessage = memo(function UserMessage({
  item,
  at,
}: {
  item: MessageItem;
  /** When it was sent, in ms. */
  at: number;
}) {
  const { t } = useI18n();
  const text = messageText(item);
  const images =
    typeof item.content === "string"
      ? []
      : item.content.flatMap((part) => {
          const url =
            part.type === "input_image"
              ? (part as InputImagePart).image_url
              : undefined;
          return url ? [url] : [];
        });

  return (
    <div
      data-speaker="user"
      className="group/user flex w-full flex-col items-end gap-1.5"
    >
      {images.length > 0 && (
        <div className="flex max-w-[85%] flex-wrap justify-end gap-1.5">
          {images.map((src, index) => (
            <img
              // biome-ignore lint/suspicious/noArrayIndexKey: a message's images never reorder.
              key={index}
              src={src}
              alt={t("attachedImage")}
              className="max-h-60 max-w-full rounded-2xl border object-contain"
            />
          ))}
        </div>
      )}
      {text.length > 0 && (
        // Its time and copy button sit beside the bubble, in the space its alignment leaves.
        <div className="flex w-full items-end justify-end gap-2">
          <div className="flex shrink-0 items-center gap-1 pb-1.5 text-muted-foreground text-xs">
            <CopyAction
              text={text}
              label={t("copyMessage")}
              className="group-has-focus-visible/user:opacity-100 group-hover/user:opacity-100"
            />
            <MessageTime at={at} />
          </div>
          <div className="min-w-0 max-w-[88%] md:max-w-[80%] whitespace-pre-wrap break-words rounded-2xl bg-bubble px-4 py-3 text-[15px] text-bubble-foreground leading-6">
            {text}
          </div>
        </div>
      )}
    </div>
  );
});

/* --------------------------- assistant message --------------------------- */

export const AssistantMessage = memo(function AssistantMessage({
  item,
  at,
  streaming,
  notified,
  attachments,
}: {
  item: MessageItem;
  /** When it was sent, in ms. */
  at: number;
  streaming?: boolean;
  /** Pim also alerted the person's devices with it. */
  notified?: boolean;
  /** What goes with the message, under its text: its widgets. */
  attachments?: ReactNode;
}) {
  const { t } = useI18n();
  const text = messageText(item);

  // No bubble: an agent's message has the transcript's whole width for its
  // text, tables and code. Its footer keeps its height while it streams, so
  // the time and actions don't push the thread when it finishes.
  return (
    <div data-speaker="assistant" className="group/assistant w-full min-w-0">
      <Markdown text={text} streaming={streaming} />
      {attachments}
      <div className="mt-1 flex h-7 items-center gap-1.5 text-muted-foreground text-xs">
        {!streaming && (
          <>
            <MessageTime at={at} />
            {notified && (
              <span className="flex min-w-0 items-center gap-1.5">
                <span aria-hidden>·</span>
                <Bell className="size-3.5 shrink-0" />
                <span className="truncate">{t("alsoNotified")}</span>
              </span>
            )}
            <CopyAction
              text={text}
              label={t("copyResponse")}
              className="group-has-focus-visible/assistant:opacity-100 group-hover/assistant:opacity-100"
            />
          </>
        )}
      </div>
    </div>
  );
});

/* ------------------------------ sent by email ----------------------------- */

/** A message Pim sent to the person's inbox: its subject, and the message on demand. */
export const EmailedMessage = memo(function EmailedMessage({
  subject,
  text,
}: {
  subject: string;
  text: string;
}) {
  const { t } = useI18n();
  return (
    <Collapsible className="w-full rounded-2xl bg-muted px-4 py-3">
      <CollapsibleTrigger className="group flex w-full min-w-0 items-center gap-2 text-left text-sm">
        <Mail className="size-4 shrink-0 text-muted-foreground" />
        <span className="shrink-0 text-muted-foreground">
          {t("emailedYou")}
        </span>
        <span className="min-w-0 flex-1 truncate font-medium">{subject}</span>
        <ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-90" />
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-2 border-t pt-2">
        <Markdown text={text} />
      </CollapsibleContent>
    </Collapsible>
  );
});

/* ---------------------------- Pim's own inputs --------------------------- */

const NOTICE_ICONS = {
  approval: ShieldCheck,
  schedule: Bell,
  event: Zap,
  task: Workflow,
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
        className="inline-flex max-w-full items-center gap-1.5 px-3 py-1 text-muted-foreground text-[13px] transition-colors hover:text-foreground"
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
        queryClient.invalidateQueries({ queryKey: ["permissions"] });
      }
    },
    onError: (error) => toast.error(error.message),
  });
  // The majordomo decides other agents' requests first, and may ask you with a word of its own.
  const { data: agents } = useQuery(agentsQuery());
  const majordomo = agents?.find((agent) => agent.majordomo)?.name ?? "";
  const pending = approval.status === "pending";
  const approved = approval.status === "approved";
  const reviewing = pending && approval.review?.status === "reviewing";
  const escalated = pending && approval.review?.status === "escalated";
  const StatusIcon = reviewing
    ? Loader2
    : pending
      ? ShieldCheck
      : approved
        ? Check
        : X;
  const status = reviewing
    ? t("majordomoReviewing", { name: majordomo })
    : escalated
      ? t("majordomoAsks", { name: majordomo })
      : pending
        ? t("approvalRequested")
        : approval.decidedBy === "majordomo"
          ? t(approved ? "approvedByMajordomo" : "deniedByMajordomo", {
              name: majordomo,
            })
          : approved
            ? t(
                approval.decidedBy === "timeout"
                  ? "approvedNoAnswer"
                  : "approved",
              )
            : t(approval.decidedBy === "timeout" ? "deniedNoAnswer" : "denied");
  const escalation = escalated && approval.review?.note;
  // Someone in a circle asked: who, and through which circle. Or a member of this Pim's team.
  const asker = approval.requestedBy
    ? t("guestAsked", {
        username: approval.requestedBy.username,
        circle: approval.requestedBy.circleName,
      })
    : approval.member
      ? t("memberAsked", { member: approval.member.name })
      : null;
  const view = useMemo(() => approvalView(approval), [approval]);
  const hasDetails = view.fields.length > 0 || approval.result !== null;

  return (
    <article className="w-full min-w-0 rounded-2xl bg-muted px-4 py-4">
      <div className="flex flex-col-reverse items-start gap-2 sm:flex-row sm:justify-between">
        <p
          className="min-w-0 flex-1 font-medium text-[15px] [overflow-wrap:anywhere]"
          title={view.title}
        >
          {view.title}
        </p>
        <Badge
          variant={approved ? "success" : "secondary"}
          className={cn(
            "gap-1.5",
            !approved && "bg-background",
            approval.status === "denied" && "text-destructive",
          )}
        >
          {approved ? (
            <span className="size-1.5 rounded-full bg-current" />
          ) : (
            <StatusIcon
              className={cn("size-3.5 shrink-0", reviewing && "animate-spin")}
            />
          )}
          {status}
        </Badge>
      </div>
      {asker && (
        <p className="mt-1 text-muted-foreground text-[13px]">{asker}</p>
      )}
      {escalation && (
        <p className="mt-1 text-sm [overflow-wrap:anywhere]">
          {majordomo}: “{escalation}”
        </p>
      )}
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
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          {/* The countdown sits on the button the timeout will press. */}
          <Button
            variant="outline"
            onClick={() => decide.mutate("deny")}
            disabled={decide.isPending}
          >
            {/* A guest's request waits a day: no countdown for that. */}
            {approval.expiresAt !== null &&
            approval.onTimeout === "deny" &&
            !approval.requestedBy ? (
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
          <div className="flex">
            <Button
              onClick={() => decide.mutate("approve")}
              disabled={decide.isPending}
              className={cn(approval.tool !== null && "rounded-r-none pr-3")}
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
                    <CheckCheck />{" "}
                    {approval.requestedBy
                      ? t("alwaysApproveForCircle", {
                          circle: approval.requestedBy.circleName,
                        })
                      : t("alwaysApprove")}
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

/* ------------------------------- indicators ------------------------------ */

export function ThinkingDot() {
  return (
    <div className="flex h-6 w-fit items-center gap-1 text-muted-foreground">
      <span className="size-1.5 animate-pulse rounded-full bg-current motion-reduce:animate-none" />
      <span className="size-1.5 animate-pulse rounded-full bg-current [animation-delay:150ms] motion-reduce:animate-none" />
      <span className="size-1.5 animate-pulse rounded-full bg-current [animation-delay:300ms] motion-reduce:animate-none" />
    </div>
  );
}
