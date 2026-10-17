import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { ArrowLeft, Loader2 } from "lucide-react";
import { type ReactNode, useEffect, useId, useState } from "react";
import {
  AgentIcon,
  AgentLookPicker,
  type LookChoice,
} from "~/components/agent-icon";
import { PimMark } from "~/components/app-sidebar";
import { useI18n } from "~/components/i18n";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import {
  type Agent,
  MAJORDOMO_TONES,
  MAX_ABOUT,
  MAX_PIM_NAME,
  type MajordomoSetup,
  pim,
} from "~/lib/pim-api";
import { cn } from "~/lib/utils";

type Tone = MajordomoSetup["tone"];

const toneKey = {
  warm: "toneWarm",
  formal: "toneFormal",
  playful: "tonePlayful",
  brief: "toneBrief",
} as const;

/**
 * The first thing after joining: name your majordomo and choose how it
 * looks, then, if you like, tell it a few things about yourself and how it
 * should talk. Only the name is needed; the second step can be skipped.
 */
export function MeetMajordomo({ majordomo }: { majordomo: Agent }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const ids = {
    name: useId(),
    theirName: useId(),
    callMe: useId(),
    age: useId(),
    notes: useId(),
  };
  const [step, setStep] = useState<"name" | "about">("name");
  const [name, setName] = useState("");
  const [look, setLook] = useState<LookChoice>({
    symbol: "🎩",
    color: "violet",
    image: null,
  });
  const [tone, setTone] = useState<Tone>(null);
  const [about, setAbout] = useState({
    name: "",
    callMe: "",
    age: "",
    notes: "",
  });
  const finish = useMutation({
    mutationFn: async (withAbout: boolean) => {
      const age = Number.parseInt(about.age, 10);
      const { agent } = await pim.setUpMajordomo({
        name: name.trim(),
        symbol: look.symbol,
        color: look.color,
        tone: withAbout ? tone : null,
        about: withAbout
          ? {
              ...(about.name.trim() ? { name: about.name.trim() } : {}),
              ...(about.callMe.trim() ? { callMe: about.callMe.trim() } : {}),
              ...(Number.isInteger(age) ? { age } : {}),
              ...(about.notes.trim() ? { notes: about.notes.trim() } : {}),
            }
          : {},
      });
      if (look.image instanceof Blob)
        await pim.setAgentIcon(agent.id, look.image);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["agents"] });
      navigate({ to: "/" });
    },
  });
  const shown = name.trim() || t("majordomoNamePlaceholder");
  const [preview, setPreview] = useState<string>();
  useEffect(() => {
    if (!(look.image instanceof Blob)) return setPreview(undefined);
    const url = URL.createObjectURL(look.image);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [look.image]);

  return (
    <main className="flex min-h-svh flex-col items-center justify-center px-6 py-12">
      <div className="w-full max-w-md">
        <PimMark className="mb-8 h-8 w-16" />
        {step === "name" ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (name.trim() !== "") setStep("about");
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
            <Input
              id={ids.name}
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={t("majordomoNamePlaceholder")}
              maxLength={MAX_PIM_NAME}
              className="mt-1.5"
              required
              autoFocus
            />
            <div className="mt-6">
              <AgentLookPicker value={look} onChange={setLook} />
            </div>
            <Button
              type="submit"
              size="lg"
              className="mt-8 w-full"
              disabled={name.trim() === ""}
            >
              {t("continue")}
            </Button>
          </form>
        ) : (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              finish.mutate(true);
            }}
          >
            <div className="flex items-center gap-3">
              <AgentIcon
                agent={{ ...majordomo, icon: null, ...look }}
                src={preview}
                tile
                className="size-10 rounded-xl"
              />
              <h1 className="min-w-0 flex-1 truncate font-semibold text-2xl">
                {t("aboutYouTitle", { name: shown })}
              </h1>
            </div>
            <p className="mt-2 text-muted-foreground text-sm">
              {t("aboutYouBody", { name: shown })}
            </p>
            <div className="mt-6 grid grid-cols-[1fr_1fr_5rem] gap-3">
              <Field id={ids.theirName} label={t("aboutYourName")}>
                <Input
                  id={ids.theirName}
                  value={about.name}
                  onChange={(event) =>
                    setAbout({ ...about, name: event.target.value })
                  }
                  maxLength={80}
                  autoComplete="name"
                  autoFocus
                />
              </Field>
              <Field id={ids.callMe} label={t("aboutCallMe")}>
                <Input
                  id={ids.callMe}
                  value={about.callMe}
                  onChange={(event) =>
                    setAbout({ ...about, callMe: event.target.value })
                  }
                  maxLength={80}
                  autoComplete="nickname"
                />
              </Field>
              <Field id={ids.age} label={t("aboutAge")}>
                <Input
                  id={ids.age}
                  value={about.age}
                  onChange={(event) =>
                    setAbout({
                      ...about,
                      age: event.target.value.replace(/\D/g, "").slice(0, 3),
                    })
                  }
                  inputMode="numeric"
                />
              </Field>
            </div>
            <fieldset className="mt-5">
              <legend className="font-medium text-sm">
                {t("toneLabel", { name: shown })}
              </legend>
              <div className="mt-1.5 flex flex-wrap gap-2">
                {MAJORDOMO_TONES.map((choice) => (
                  <button
                    key={choice}
                    type="button"
                    aria-pressed={tone === choice}
                    onClick={() => setTone(tone === choice ? null : choice)}
                    className={cn(
                      "rounded-full px-3.5 py-1.5 text-sm transition-colors",
                      tone === choice
                        ? "bg-background ring-2 ring-ring"
                        : "bg-secondary hover:bg-accent",
                    )}
                  >
                    {t(toneKey[choice])}
                  </button>
                ))}
              </div>
            </fieldset>
            <Field id={ids.notes} label={t("aboutNotes")} className="mt-5">
              <textarea
                id={ids.notes}
                value={about.notes}
                onChange={(event) =>
                  setAbout({
                    ...about,
                    notes: event.target.value.replace(/[\r\n]+/g, " "),
                  })
                }
                placeholder={t("aboutNotesPlaceholder")}
                maxLength={MAX_ABOUT}
                rows={3}
                className="w-full resize-none rounded-xl border border-input bg-background px-3.5 py-2 text-base outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/20 md:text-[15px] dark:bg-input/30"
              />
            </Field>
            <p className="mt-2 text-muted-foreground text-xs">
              {t("aboutYouFootnote")}
            </p>
            <div className="mt-8 flex items-center gap-2">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={t("back")}
                onClick={() => setStep("name")}
                disabled={finish.isPending}
              >
                <ArrowLeft />
              </Button>
              <Button
                type="button"
                variant="secondary"
                size="lg"
                className="ml-auto"
                onClick={() => finish.mutate(false)}
                disabled={finish.isPending}
              >
                {t("skip")}
              </Button>
              <Button type="submit" size="lg" disabled={finish.isPending}>
                {finish.isPending && <Loader2 className="animate-spin" />}
                {t("meetMajordomoStart", { name: shown })}
              </Button>
            </div>
            {finish.isError && (
              <p role="alert" className="mt-4 text-destructive text-sm">
                {finish.error.message}
              </p>
            )}
          </form>
        )}
      </div>
    </main>
  );
}

function Field({
  id,
  label,
  className,
  children,
}: {
  id: string;
  label: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn("min-w-0", className)}>
      <label htmlFor={id} className="block text-muted-foreground text-[13px]">
        {label}
      </label>
      <div className="mt-1.5">{children}</div>
    </div>
  );
}
