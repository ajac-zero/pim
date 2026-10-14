import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Bot, Copy, ShieldAlert } from "lucide-react";
import { toast } from "sonner";
import { useI18n } from "~/components/i18n";
import { Page } from "~/components/page";
import { Button } from "~/components/ui/button";
import { pim } from "~/lib/pim-api";
import { agentsQuery, templateQuery } from "~/lib/queries";

export const Route = createFileRoute("/templates/$templateId")({
  component: TemplatePage,
});

/** A published agent in full, to read before making it your own. */
function TemplatePage() {
  const { t, formatDate } = useI18n();
  const { templateId } = Route.useParams();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { data: template, error } = useQuery(templateQuery(templateId));
  const { data: agents } = useQuery(agentsQuery());
  const copy = agents?.find((agent) => agent.source?.template === templateId);
  const use = useMutation({
    mutationFn: () => pim.adoptTemplate(templateId),
    onSuccess: (agent) => {
      queryClient.invalidateQueries({ queryKey: ["agents"] });
      queryClient.invalidateQueries({ queryKey: ["templates"] });
      toast.success(t("madeYourOwn", { name: agent.name }));
      navigate({ to: "/agents" });
    },
    onError: (failure) => toast.error(failure.message),
  });

  if (error) {
    return (
      <Page title={t("discover")} description={error.message}>
        <Link to="/discover" className="text-sm underline underline-offset-2">
          {t("backToDiscover")}
        </Link>
      </Page>
    );
  }
  if (!template) return null;
  return (
    <Page
      title={template.name}
      description={template.description || t("noDescription")}
    >
      <p className="-mt-6 mb-6 text-muted-foreground text-sm">
        {t("publishedBy")}{" "}
        <Link
          to="/people/$username"
          params={{ username: template.author }}
          className="text-foreground underline underline-offset-2"
        >
          {template.authorName ?? `@${template.author}`}
        </Link>
        {" · "}
        {formatDate(new Date(template.publishedAt), { dateStyle: "medium" })}
        {template.uses > 0 &&
          ` · ${t("templateUses", { count: template.uses })}`}
      </p>
      <section className="space-y-2">
        <h2 className="font-medium text-muted-foreground text-sm">
          {t("agentInstructions")}
        </h2>
        <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded-xl border bg-muted/40 px-4 py-3 font-sans text-sm">
          {template.instructions}
        </pre>
      </section>
      {template.apps.length > 0 && (
        <section className="mt-6 space-y-2">
          <h2 className="font-medium text-muted-foreground text-sm">
            {t("suggestedApps")}
          </h2>
          <ul className="divide-y rounded-xl border">
            {template.apps.map((app) => (
              <li key={app.url} className="px-4 py-2.5 text-sm">
                <span className="font-medium">{app.name}</span>
                <span className="block truncate font-mono text-muted-foreground text-xs">
                  {app.url}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {template.team.length > 0 && (
        <section className="mt-6 space-y-2">
          <h2 className="font-medium text-muted-foreground text-sm">
            {t("team")}
          </h2>
          <ul className="divide-y rounded-xl border">
            {template.team.map((member) => (
              <li key={member.name} className="px-4 py-2.5 text-sm">
                <span className="font-medium">{member.name}</span>
                <p className="mt-0.5 whitespace-pre-wrap text-muted-foreground">
                  {member.instructions}
                </p>
                {member.tools && (
                  <p className="mt-1 font-mono text-muted-foreground text-xs">
                    {member.tools.join(", ")}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
      <p className="mt-6 flex items-start gap-2 text-muted-foreground text-xs">
        <ShieldAlert className="mt-px size-3.5 shrink-0" />
        {t("templateWarning")}
      </p>
      {copy && (
        <p className="mt-4 text-sm">
          {t("youHaveACopy")}{" "}
          <Link to="/agents" className="underline underline-offset-2">
            {copy.name}
          </Link>
        </p>
      )}
      <div className="mt-4 flex gap-2">
        <Button onClick={() => use.mutate()} disabled={use.isPending}>
          <Copy /> {t("makeItYourOwn")}
        </Button>
        <Button variant="outline" asChild>
          <Link to="/discover">
            <Bot /> {t("backToDiscover")}
          </Link>
        </Button>
      </div>
    </Page>
  );
}
