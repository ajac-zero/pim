import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { Composer } from "~/components/chat/composer";
import { useI18n } from "~/components/i18n";
import { pim } from "~/lib/pim-api";
import { pimClient } from "~/lib/pim-client";
import { personasQuery } from "~/lib/queries";

/** An empty draft chat, with your default Pim or another of yours. No session exists until the first message is sent. */
export const Route = createFileRoute("/new")({
  validateSearch: (search: Record<string, unknown>): { pim?: string } =>
    typeof search.pim === "string" ? { pim: search.pim } : {},
  component: NewChatPage,
});

function NewChatPage() {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { pim: personaId } = Route.useSearch();
  const { data: personas } = useQuery(personasQuery());
  const persona = personas?.find((candidate) =>
    personaId === undefined ? candidate.default : candidate.id === personaId,
  );
  const [creating, setCreating] = useState(false);

  const send = async (text: string) => {
    setCreating(true);
    try {
      const session = await pim.createSession(
        persona ? { persona: persona.id } : {},
      );
      await queryClient.invalidateQueries({ queryKey: ["sessions"] });
      pimClient.open(session.id);
      await navigate({
        to: "/chat/$sessionId",
        params: { sessionId: session.id },
      });
      await pimClient.send(text);
    } catch (error) {
      toast.error((error as Error).message);
      setCreating(false);
    }
  };

  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col items-center justify-center px-4">
      <div className="w-full max-w-3xl">
        <p className="mb-4 text-center text-muted-foreground">
          {persona
            ? t("startChatWith", { name: persona.name })
            : t("startNewChat")}
        </p>
        <Composer
          onSend={send}
          busy={false}
          disabled={creating || (personaId !== undefined && !personas)}
          placeholder={
            persona ? t("messagePersona", { name: persona.name }) : undefined
          }
          autoFocus
        />
      </div>
    </main>
  );
}
