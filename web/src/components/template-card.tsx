import { Link } from "@tanstack/react-router";
import { AgentIcon, templateIconSrc } from "~/components/agent-icon";
import { useI18n } from "~/components/i18n";
import type { TemplateSummary } from "~/lib/pim-api";

/** A published agent in a list: its name, what it's for, who made it. */
export function TemplateCard({ template }: { template: TemplateSummary }) {
  const { t } = useI18n();
  return (
    <Link
      to="/templates/$templateId"
      params={{ templateId: template.id }}
      className="flex h-full flex-col rounded-2xl border bg-muted/30 p-5 transition-colors hover:bg-muted/70"
    >
      <span className="flex items-center gap-3">
        <span className="text-primary">
          <AgentIcon
            agent={template}
            src={templateIconSrc(template)}
            className="size-12 shrink-0"
          />
        </span>
        <span className="truncate font-medium">{template.name}</span>
      </span>
      {template.description && (
        <span className="mt-1 line-clamp-2 text-muted-foreground text-sm">
          {template.description}
        </span>
      )}
      <span className="mt-auto pt-2 text-muted-foreground text-xs">
        {template.authorName
          ? `${template.authorName} · @${template.author}`
          : `@${template.author}`}
        {template.uses > 0 &&
          ` · ${t("templateUses", { count: template.uses })}`}
      </span>
    </Link>
  );
}
