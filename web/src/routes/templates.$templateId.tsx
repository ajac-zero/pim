import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import { AgentIcon, templateIconSrc } from "~/components/agent-icon";
import { AppIcon } from "~/components/app-icon";
import { useI18n } from "~/components/i18n";
import { Bot, Copy, ShieldAlert } from "~/components/icons";
import { Page } from "~/components/page";
import { Button } from "~/components/ui/button";
import { pim } from "~/lib/pim-api";
import { agentsQuery, appDirectoryQuery, templateQuery } from "~/lib/queries";

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
  const { data: directory } = useQuery(appDirectoryQuery());
  const copy = agents?.find((agent) => agent.source?.template === templateId);
  const use = useMutation({
    mutationFn: () => pim.adoptTemplate(templateId),
    onSuccess: (agent) => {
      queryClient.invalidateQueries({ queryKey: ["agents"] });
      queryClient.invalidateQueries({ queryKey: ["templates"] });
      toast.success(t("madeYourOwn", { name: agent.name }));
      navigate({ to: "/agents/$agentId", params: { agentId: agent.id } });
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
      icon={
        <AgentIcon
          agent={template}
          src={templateIconSrc(template)}
          tile
          className="size-9 rounded-lg"
        />
      }
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
            {template.apps.map((ref) => {
              const app = directory?.find((candidate) => candidate.ref === ref);
              return (
                <li
                  key={ref}
                  className="flex items-center gap-3 px-4 py-2.5 text-sm"
                >
                  <AppIcon
                    name={app?.name ?? ref}
                    icon={app?.icon}
                    className="size-8 text-sm"
                  />
                  <span className="min-w-0">
                    <span className="font-medium">{app?.name ?? ref}</span>
                    {app?.description && (
                      <span className="block truncate text-muted-foreground text-xs">
                        {app.description}
                      </span>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      )}
      {template.bundle.length > 0 && (
        <section className="mt-6 space-y-2">
          <h2 className="font-medium text-muted-foreground text-sm">
            {t("comesWith")}
          </h2>
          <p className="text-muted-foreground text-xs">{t("comesWithHint")}</p>
          <ul className="divide-y rounded-xl border">
            {template.bundle.map((agent, position) => (
              <li key={agent.name} className="px-4 py-3 text-sm">
                <div className="flex items-center gap-3">
                  <AgentIcon
                    agent={{ id: agent.name, ...agent }}
                    src={
                      agent.icon === null
                        ? undefined
                        : `/api/templates/${template.id}/agents/${position}/icon?v=${agent.icon}`
                    }
                    tile
                    className="size-8 rounded-lg"
                  />
                  <span className="min-w-0">
                    <span className="block font-medium">{agent.name}</span>
                    {agent.description && (
                      <span className="block truncate text-muted-foreground text-xs">
                        {agent.description}
                      </span>
                    )}
                  </span>
                </div>
                <p className="mt-2 whitespace-pre-wrap text-muted-foreground">
                  {agent.instructions}
                </p>
                {agent.contacts.length > 0 && (
                  <p className="mt-1 text-muted-foreground text-xs">
                    {t("contactsList", { names: agent.contacts.join(", ") })}
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
          <Link
            to="/agents/$agentId"
            params={{ agentId: copy.id }}
            className="underline underline-offset-2"
          >
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
