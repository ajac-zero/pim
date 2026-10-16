import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { MessageCircle } from "lucide-react";
import { toast } from "sonner";
import { useI18n } from "~/components/i18n";
import { Page } from "~/components/page";
import { TemplateCard } from "~/components/template-card";
import { Button } from "~/components/ui/button";
import { pim } from "~/lib/pim-api";
import { personQuery, visitsQuery } from "~/lib/queries";

export const Route = createFileRoute("/people/$username")({
  component: PersonPage,
});

/** Someone on this Pim: who they say they are, and the agents they published. */
function PersonPage() {
  const { t } = useI18n();
  const { username } = Route.useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: person, error } = useQuery(personQuery(username));
  const { data: visits } = useQuery(visitsQuery());
  const visit = visits?.find(
    (candidate) => candidate.username === username && candidate.available,
  );
  const message = useMutation({
    mutationFn: async () =>
      visit?.session ?? (await pim.startVisit(username)).session,
    onSuccess: async (session) => {
      await queryClient.invalidateQueries({ queryKey: ["sessions"] });
      navigate({ to: "/chat/$sessionId", params: { sessionId: session } });
    },
    onError: (failure) => toast.error(failure.message),
  });

  if (error)
    return (
      <Page title={`@${username}`} description={error.message}>
        {null}
      </Page>
    );
  if (!person) return null;
  return (
    <Page
      title={person.displayName ?? `@${person.username}`}
      icon={
        <span
          className="flex size-12 shrink-0 items-center justify-center rounded-full bg-muted font-normal text-muted-foreground"
          aria-hidden="true"
        >
          {person.username.slice(0, 1).toUpperCase()}
        </span>
      }
      description={person.bio ?? ""}
    >
      <p className="-mt-6 mb-6 text-muted-foreground text-sm">
        @{person.username}
      </p>
      {visit && (
        <Button className="mb-8" onClick={() => message.mutate()}>
          <MessageCircle /> {t("messageTheirPim", { username })}
        </Button>
      )}
      <section className="space-y-3">
        <h2 className="font-medium text-muted-foreground text-sm">
          {t("publishedAgents")}
        </h2>
        {person.templates.length === 0 ? (
          <p className="px-1 text-muted-foreground text-sm">
            {t("nothingPublished")}
          </p>
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2">
            {person.templates.map((template) => (
              <li key={template.id}>
                <TemplateCard template={template} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </Page>
  );
}
