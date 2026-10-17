import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Loader2 } from "lucide-react";
import { useId, useState } from "react";
import { AgentLookPicker, type LookChoice } from "~/components/agent-icon";
import { PimMark } from "~/components/app-sidebar";
import { useI18n } from "~/components/i18n";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { type Agent, MAX_PIM_NAME, pim } from "~/lib/pim-api";
import { pimClient } from "~/lib/pim-client";
import { showTab } from "~/lib/tabs";

/**
 * The first thing after joining: say your name, name your majordomo and
 * choose how it looks. Then it opens your first chat by introducing itself,
 * and you tell it the rest as you talk.
 */
export function MeetMajordomo({ majordomo }: { majordomo: Agent }) {
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const ids = { yourName: useId(), name: useId() };
  const [yourName, setYourName] = useState("");
  const [name, setName] = useState("");
  const [look, setLook] = useState<LookChoice>({
    symbol: "🎩",
    color: "violet",
    image: null,
  });
  const meet = useMutation({
    mutationFn: async () => {
      // The icon first: the introduction that starts with the setup shows it.
      if (look.image instanceof Blob)
        await pim.setAgentIcon(majordomo.id, look.image);
      return pim.setUpMajordomo({
        name: name.trim(),
        symbol: look.symbol,
        color: look.color,
        yourName: yourName.trim() || null,
        locale,
      });
    },
    onSuccess: async ({ session }) => {
      await queryClient.invalidateQueries({ queryKey: ["agents"] });
      await queryClient.invalidateQueries({ queryKey: ["sessions"] });
      showTab(session, true);
      pimClient.open(session);
      navigate({ to: "/chat/$sessionId", params: { sessionId: session } });
    },
  });
  const ready = yourName.trim() !== "" && name.trim() !== "";

  return (
    <main className="flex min-h-svh flex-col items-center justify-center px-6 py-12">
      <form
        className="w-full max-w-md"
        onSubmit={(event) => {
          event.preventDefault();
          if (ready) meet.mutate();
        }}
      >
        <PimMark className="mb-8 h-8 w-16" />
        <h1 className="font-semibold text-2xl">{t("meetMajordomoTitle")}</h1>
        <p className="mt-2 text-muted-foreground text-sm">
          {t("meetMajordomoBody")}
        </p>
        <label
          htmlFor={ids.yourName}
          className="mt-6 block font-medium text-sm"
        >
          {t("yourNameLabel")}
        </label>
        <Input
          id={ids.yourName}
          value={yourName}
          onChange={(event) => setYourName(event.target.value)}
          placeholder={t("yourNamePlaceholder")}
          maxLength={80}
          autoComplete="given-name"
          className="mt-1.5"
          required
          autoFocus
        />
        <label htmlFor={ids.name} className="mt-5 block font-medium text-sm">
          {t("majordomoNameLabel")}
        </label>
        <Input
          id={ids.name}
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder={t("majordomoNamePlaceholder")}
          maxLength={MAX_PIM_NAME}
          autoComplete="off"
          className="mt-1.5"
          required
        />
        <div className="mt-6">
          <AgentLookPicker value={look} onChange={setLook} />
        </div>
        <Button
          type="submit"
          size="lg"
          className="mt-8 w-full"
          disabled={!ready || meet.isPending}
        >
          {meet.isPending && <Loader2 className="animate-spin" />}
          {t("meetMajordomoStart", {
            name: name.trim() || t("majordomoNamePlaceholder"),
          })}
        </Button>
        <p className="mt-3 text-center text-muted-foreground text-xs">
          {t("meetMajordomoFootnote", {
            name: name.trim() || t("majordomoNamePlaceholder"),
          })}
        </p>
        {meet.isError && (
          <p role="alert" className="mt-4 text-destructive text-sm">
            {meet.error.message}
          </p>
        )}
      </form>
    </main>
  );
}
