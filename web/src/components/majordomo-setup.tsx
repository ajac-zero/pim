import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { ArrowLeft, Loader2, Pencil } from "lucide-react";
import { type ReactNode, useEffect, useId, useState } from "react";
import {
  AgentIcon,
  CompactLookPicker,
  type LookChoice,
} from "~/components/agent-icon";
import { PimMark } from "~/components/app-sidebar";
import { useI18n } from "~/components/i18n";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "~/components/ui/popover";
import { authSessionQuery } from "~/lib/auth";
import {
  type Agent,
  MAJORDOMO_HELP_WITH,
  MAJORDOMO_INVOLVEMENT,
  MAJORDOMO_TONES,
  MAX_PIM_NAME,
  type MajordomoSetup,
  pim,
} from "~/lib/pim-api";
import { pimClient } from "~/lib/pim-client";
import { showTab } from "~/lib/tabs";
import { cn } from "~/lib/utils";

type Tone = (typeof MAJORDOMO_TONES)[number];
type Involvement = (typeof MAJORDOMO_INVOLVEMENT)[number];
type HelpWith = (typeof MAJORDOMO_HELP_WITH)[number];

const toneKey = {
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

const helpWithKey = {
  work: "helpWork",
  home: "helpHome",
  health: "helpHealth",
  money: "helpMoney",
  learning: "helpLearning",
  travel: "helpTravel",
} as const;

/**
 * The first thing after joining. Unless an account they signed up with
 * already says it, they give their name; then they name their majordomo and
 * choose how it looks; then, if they like, how it should talk with them,
 * what they'd like a hand with, and how much it handles on its own, each
 * with a pencil for an answer of their own. Then it opens their first chat
 * by introducing itself, and they tell it the rest as they talk.
 */
export function MeetMajordomo({ majordomo }: { majordomo: Agent }) {
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const given = useQuery(authSessionQuery()).data?.name ?? null;
  const ids = { yourName: useId(), name: useId() };
  const [step, setStep] = useState<"you" | "majordomo" | "preferences">(
    given ? "majordomo" : "you",
  );
  const [yourName, setYourName] = useState(given ?? "");
  const [name, setName] = useState("");
  const [look, setLook] = useState<LookChoice>({
    symbol: "🎩",
    color: "violet",
    image: null,
  });
  const [tone, setTone] = useState<Tone | null>(null);
  // Null while the pencil's field is closed.
  const [customTone, setCustomTone] = useState<string | null>(null);
  const [helpWith, setHelpWith] = useState<HelpWith[]>([]);
  const [otherHelp, setOtherHelp] = useState<string | null>(null);
  const [involvement, setInvolvement] = useState<Involvement | null>(null);
  const [preview, setPreview] = useState<string>();
  useEffect(() => {
    if (!(look.image instanceof Blob)) return setPreview(undefined);
    const url = URL.createObjectURL(look.image);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [look.image]);

  const meet = useMutation({
    mutationFn: async (preferences: boolean) => {
      // The icon first: the introduction that starts with the setup shows it.
      if (look.image instanceof Blob)
        await pim.setAgentIcon(majordomo.id, look.image);
      const setup: MajordomoSetup = {
        name: name.trim(),
        symbol: look.symbol,
        color: look.color,
        yourName: yourName.trim() || null,
        locale,
        title: t("welcomeChat", { name: yourName.trim() }),
        ...(preferences
          ? {
              tone,
              customTone: customTone?.trim() || null,
              helpWith,
              otherHelp: otherHelp?.trim() || null,
              involvement,
            }
          : {}),
      };
      return pim.setUpMajordomo(setup);
    },
    onSuccess: async ({ session }) => {
      await queryClient.invalidateQueries({ queryKey: ["agents"] });
      await queryClient.invalidateQueries({ queryKey: ["sessions"] });
      showTab(session, true);
      pimClient.open(session);
      navigate({ to: "/chat/$sessionId", params: { sessionId: session } });
    },
  });
  const shown = name.trim() || t("majordomoNamePlaceholder");
  const icon = (
    <AgentIcon
      agent={{ ...majordomo, icon: null, ...look }}
      src={preview}
      tile
      className="size-10 rounded-xl"
    />
  );

  return (
    <main className="flex min-h-svh flex-col items-center justify-center px-6 py-12">
      <div className="w-full max-w-md">
        <PimMark className="mb-8 h-8 w-16" />
        {step === "you" && (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (yourName.trim() !== "") setStep("majordomo");
            }}
          >
            <h1 className="font-semibold text-2xl">{t("yourNameTitle")}</h1>
            <p className="mt-2 text-muted-foreground text-sm">
              {t("yourNameBody")}
            </p>
            <Input
              id={ids.yourName}
              value={yourName}
              onChange={(event) => setYourName(event.target.value)}
              placeholder={t("yourNamePlaceholder")}
              aria-label={t("yourNameLabel")}
              maxLength={80}
              autoComplete="given-name"
              className="mt-6"
              required
              autoFocus
            />
            <Button
              type="submit"
              size="lg"
              className="mt-8 w-full"
              disabled={yourName.trim() === ""}
            >
              {t("continue")}
            </Button>
          </form>
        )}
        {step === "majordomo" && (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (name.trim() !== "") setStep("preferences");
            }}
          >
            <h1 className="font-semibold text-2xl">
              {t("meetMajordomoTitle")}
            </h1>
            <p className="mt-2 text-muted-foreground text-sm">
              {t("meetMajordomoBody")}
            </p>
            <label
              htmlFor={ids.name}
              className="mt-6 block font-medium text-sm"
            >
              {t("majordomoNameLabel")}
            </label>
            <div className="mt-1.5 flex items-center gap-2">
              <Popover>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    aria-label={t("changeLook")}
                    title={t("changeLook")}
                    className="relative shrink-0 rounded-xl outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40"
                  >
                    {icon}
                    <span className="-right-1.5 -bottom-1.5 absolute flex size-4.5 items-center justify-center rounded-full bg-background shadow-sm ring-1 ring-border">
                      <Pencil className="size-2.5" />
                    </span>
                  </button>
                </PopoverTrigger>
                <PopoverContent align="start" className="w-auto p-3">
                  <CompactLookPicker value={look} onChange={setLook} />
                </PopoverContent>
              </Popover>
              <Input
                id={ids.name}
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder={t("majordomoNamePlaceholder")}
                maxLength={MAX_PIM_NAME}
                autoComplete="off"
                required
                autoFocus
              />
            </div>
            <div className="mt-8 flex items-center gap-2">
              {!given && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={t("back")}
                  onClick={() => setStep("you")}
                >
                  <ArrowLeft />
                </Button>
              )}
              <Button
                type="submit"
                size="lg"
                className="flex-1"
                disabled={name.trim() === ""}
              >
                {t("continue")}
              </Button>
            </div>
          </form>
        )}
        {step === "preferences" && (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              meet.mutate(true);
            }}
          >
            <div className="flex items-center gap-3">
              {icon}
              <h1 className="min-w-0 flex-1 truncate font-semibold text-2xl">
                {t("aboutYouTitle", { name: shown })}
              </h1>
            </div>
            <p className="mt-2 text-muted-foreground text-sm">
              {t("aboutYouBody", { name: shown })}
            </p>
            <Question label={t("toneLabel", { name: shown })}>
              {MAJORDOMO_TONES.map((choice) => (
                <Chip
                  key={choice}
                  selected={tone === choice}
                  onSelect={() => {
                    setTone(tone === choice ? null : choice);
                    setCustomTone(null);
                  }}
                >
                  {t(toneKey[choice])}
                </Chip>
              ))}
              <WriteYourOwn
                open={customTone !== null}
                onToggle={() => {
                  setCustomTone(customTone === null ? "" : null);
                  setTone(null);
                }}
              />
            </Question>
            {customTone !== null && (
              <Input
                value={customTone}
                onChange={(event) => setCustomTone(event.target.value)}
                placeholder={t("customTonePlaceholder")}
                aria-label={t("toneLabel", { name: shown })}
                maxLength={120}
                className="mt-2"
                autoFocus
              />
            )}
            <Question label={t("helpWithLabel")}>
              {MAJORDOMO_HELP_WITH.map((area) => (
                <Chip
                  key={area}
                  selected={helpWith.includes(area)}
                  onSelect={() =>
                    setHelpWith(
                      helpWith.includes(area)
                        ? helpWith.filter((other) => other !== area)
                        : [...helpWith, area],
                    )
                  }
                >
                  {t(helpWithKey[area])}
                </Chip>
              ))}
              <WriteYourOwn
                open={otherHelp !== null}
                onToggle={() => setOtherHelp(otherHelp === null ? "" : null)}
              />
            </Question>
            {otherHelp !== null && (
              <Input
                value={otherHelp}
                onChange={(event) => setOtherHelp(event.target.value)}
                placeholder={t("otherHelpPlaceholder")}
                aria-label={t("helpWithLabel")}
                maxLength={120}
                className="mt-2"
                autoFocus
              />
            )}
            <InvolvementBar
              label={t("involvementLabel", { name: shown })}
              value={involvement}
              onChange={setInvolvement}
            />
            <div className="mt-8 flex items-center gap-2">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={t("back")}
                onClick={() => setStep("majordomo")}
                disabled={meet.isPending}
              >
                <ArrowLeft />
              </Button>
              <Button
                type="button"
                variant="secondary"
                size="lg"
                className="ml-auto"
                onClick={() => meet.mutate(false)}
                disabled={meet.isPending}
              >
                {t("skip")}
              </Button>
              <Button type="submit" size="lg" disabled={meet.isPending}>
                {meet.isPending && <Loader2 className="animate-spin" />}
                {t("meetMajordomoStart", { name: shown })}
              </Button>
            </div>
            <p className="mt-3 text-right text-muted-foreground text-xs">
              {t("meetMajordomoFootnote", { name: shown })}
            </p>
            {meet.isError && (
              <p role="alert" className="mt-4 text-destructive text-sm">
                {meet.error.message}
              </p>
            )}
          </form>
        )}
      </div>
    </main>
  );
}

/** The last choice of a question: a pencil that opens a field for an answer in their own words. */
function WriteYourOwn({
  open,
  onToggle,
}: {
  open: boolean;
  onToggle: () => void;
}) {
  const { t } = useI18n();
  return (
    <Chip selected={open} onSelect={onToggle} label={t("writeYourOwn")}>
      <Pencil className="size-3.5" />
    </Chip>
  );
}

/** One multiple-choice question: a label over its choices. */
function Question({ label, children }: { label: string; children: ReactNode }) {
  return (
    <fieldset className="mt-6">
      <legend className="font-medium text-sm">{label}</legend>
      <div className="mt-2 flex flex-wrap gap-2">{children}</div>
    </fieldset>
  );
}

/** A choice that can be picked, or picked again to clear it. */
function Chip({
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
function InvolvementBar({
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
