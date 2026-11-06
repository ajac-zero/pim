import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useI18n } from "~/components/i18n";
import { Loader2, Pencil } from "~/components/icons";
import { RouteError } from "~/components/route-error";
import { authSessionQuery } from "~/lib/auth";
import { MAJORDOMO_INVOLVEMENT, pim } from "~/lib/pim-api";
import { pimClient } from "~/lib/pim-client";
import { cn } from "~/lib/utils";

type Involvement = (typeof MAJORDOMO_INVOLVEMENT)[number];

export const toneKey = {
  warm: "toneWarm",
  formal: "toneFormal",
  playful: "tonePlayful",
  brief: "toneBrief",
} as const;

const involvementKey = {
  close: "involvementClose",
  balanced: "involvementBalanced",
  hands_off: "involvementHandsOff",
} as const;

/**
 * The first time the person opens Pim: their majordomo opens the main chat
 * by introducing itself, and the chat opens, where they set it up by talking
 * with it. Nothing to fill in first. `given` is the name they gave when they
 * joined, if they gave one.
 */
export function MeetMajordomo({ given }: { given: string | null }) {
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  // The name they gave when they joined, or the one the account they joined with says: it greets them by it.
  const linked = useQuery(authSessionQuery()).data?.name ?? null;
  const yourName = given ?? linked;
  const meet = useMutation({
    mutationFn: () =>
      pim.setUpMajordomo({
        yourName,
        locale,
        title: yourName
          ? t("welcomeChat", { name: yourName })
          : t("welcomeChatUnnamed"),
      }),
    onSuccess: async ({ session }) => {
      await queryClient.invalidateQueries({ queryKey: ["agents"] });
      await queryClient.invalidateQueries({ queryKey: ["sessions"] });
      pimClient.open(session);
      navigate({ to: "/chat/$sessionId", params: { sessionId: session } });
    },
  });
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    meet.mutate();
  }, [meet]);
  if (meet.isError) {
    return (
      <div className="flex h-svh">
        <RouteError error={meet.error} reset={() => meet.mutate()} />
      </div>
    );
  }
  return (
    <main className="flex h-svh items-center justify-center">
      <Loader2 className="size-5 animate-spin text-muted-foreground" />
    </main>
  );
}

/**
 * A pencil that turns, in place, into a field the size of a choice for an
 * answer in their own words. Enter or leaving it keeps the answer, shown as
 * a chosen choice that opens again to edit; Escape, or emptying it, takes it
 * back.
 */
export function WriteYourOwn({
  value,
  onChange,
}: {
  value: string | null;
  onChange: (value: string | null) => void;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState<string | null>(null);
  const editing = draft !== null;
  const field = useRef<HTMLInputElement>(null);
  // It opens because they asked to type: the field takes the keyboard.
  useEffect(() => {
    if (editing) field.current?.focus();
  }, [editing]);
  const keep = () => {
    if (draft === null) return;
    onChange(draft.trim() || null);
    setDraft(null);
  };
  if (draft !== null) {
    return (
      <span
        className={cn(
          "flex items-center gap-2 rounded-full bg-background px-3.5 py-1.5 ring-2 ring-ring",
        )}
      >
        <Pencil className="size-3.5 shrink-0 text-muted-foreground" />
        <input
          ref={field}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={keep}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              keep();
            } else if (event.key === "Escape") {
              event.preventDefault();
              setDraft(null);
            }
          }}
          placeholder={t("writeYourOwnPlaceholder")}
          aria-label={t("writeYourOwn")}
          maxLength={120}
          // Opens small, where the pencil was, and grows with what they type.
          style={{
            width: `${Math.max(t("writeYourOwnPlaceholder").length, draft.length) + 1}ch`,
          }}
          className="max-w-60 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
        />
      </span>
    );
  }
  return (
    <button
      type="button"
      aria-pressed={value !== null}
      aria-label={value ?? t("writeYourOwn")}
      title={t("writeYourOwn")}
      onClick={() => setDraft(value ?? "")}
      className={cn(
        "flex items-center gap-2 rounded-full px-3.5 py-1.5 text-sm transition-colors",
        value !== null
          ? "bg-background ring-2 ring-ring"
          : "bg-secondary hover:bg-accent",
      )}
    >
      {value !== null && <span className="max-w-52 truncate">{value}</span>}
      <Pencil className="size-3.5 text-muted-foreground" />
    </button>
  );
}

/** One multiple-choice question: a label over its choices. */
export function Question({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <fieldset className="mt-6">
      <legend className="font-medium text-sm">{label}</legend>
      <div className="mt-2 flex flex-wrap gap-2">{children}</div>
    </fieldset>
  );
}

/** A choice that can be picked, or picked again to clear it. */
export function Chip({
  selected,
  onSelect,
  label,
  children,
}: {
  selected: boolean;
  onSelect: () => void;
  /** Its name, when its content is only an icon. */
  label?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      aria-label={label}
      title={label}
      onClick={onSelect}
      className={cn(
        "rounded-full px-3.5 py-1.5 text-sm transition-colors",
        selected
          ? "bg-background ring-2 ring-ring"
          : "bg-secondary hover:bg-accent",
      )}
    >
      {children}
    </button>
  );
}

/**
 * How much the majordomo handles on its own, as a bar of three steps: each
 * step fills the bar up to it. Choosing the chosen one again clears it.
 */
export function InvolvementBar({
  label,
  value,
  onChange,
}: {
  label: string;
  value: Involvement | null;
  onChange: (value: Involvement | null) => void;
}) {
  const { t } = useI18n();
  const level = value === null ? -1 : MAJORDOMO_INVOLVEMENT.indexOf(value);
  return (
    <fieldset className="mt-6">
      <legend className="font-medium text-sm">{label}</legend>
      <div
        role="radiogroup"
        aria-label={label}
        className="mt-3 grid grid-cols-3 gap-1.5"
      >
        {MAJORDOMO_INVOLVEMENT.map((choice, index) => (
          <button
            key={choice}
            type="button"
            role="radio"
            aria-checked={value === choice}
            onClick={() => onChange(value === choice ? null : choice)}
            className="group flex flex-col gap-2 rounded-md outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40"
          >
            <span
              className={cn(
                "h-2 w-full rounded-full transition-colors",
                index <= level
                  ? "bg-ring"
                  : "bg-secondary group-hover:bg-accent",
              )}
            />
            <span
              className={cn(
                "w-full text-[13px]",
                ["text-left", "text-center", "text-right"][index],
                value === choice
                  ? "text-foreground"
                  : "text-muted-foreground group-hover:text-foreground",
              )}
            >
              {t(involvementKey[choice])}
            </span>
          </button>
        ))}
      </div>
    </fieldset>
  );
}
