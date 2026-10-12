import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Composer } from "~/components/chat/composer";
import { useI18n } from "~/components/i18n";
import { personasQuery } from "~/lib/queries";
import { useStartChat } from "~/lib/start-chat";

/** An empty draft chat, with your default Pim or another of yours. No session exists until the first message is sent. */
export const Route = createFileRoute("/new")({
  validateSearch: (search: Record<string, unknown>): { pim?: string } =>
    typeof search.pim === "string" ? { pim: search.pim } : {},
  component: NewChatPage,
});

function NewChatPage() {
  const { t } = useI18n();
  const { pim: personaId } = Route.useSearch();
  const { data: personas } = useQuery(personasQuery());
  const persona = personas?.find((candidate) =>
    personaId === undefined ? candidate.default : candidate.id === personaId,
  );
  const { start, starting } = useStartChat(persona?.id);

  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col items-center justify-center px-4">
      <div className="w-full max-w-3xl">
        <p className="mb-4 text-center text-muted-foreground">
          {persona
            ? t("startChatWith", { name: persona.name })
            : t("startNewChat")}
        </p>
        <Composer
          onSend={start}
          busy={false}
          disabled={starting || (personaId !== undefined && !personas)}
          placeholder={
            persona ? t("messagePersona", { name: persona.name }) : undefined
          }
          autoFocus
        />
      </div>
    </main>
  );
}
