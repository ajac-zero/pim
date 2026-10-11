import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Bot, Globe, Search } from "lucide-react";
import { useEffect, useState } from "react";
import { useI18n } from "~/components/i18n";
import { EmptyState, Page } from "~/components/page";
import { TemplateCard } from "~/components/template-card";
import { Input } from "~/components/ui/input";
import { accountQuery, templatesQuery } from "~/lib/queries";

export const Route = createFileRoute("/discover")({
  component: DiscoverPage,
});

/** Pims people published for anyone to make their own. */
function DiscoverPage() {
  const { t } = useI18n();
  const { data: account, isPending } = useQuery(accountQuery());
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  // Asks once typing pauses, not at every key.
  useEffect(() => {
    const timer = setTimeout(() => setQuery(search.trim()), 250);
    return () => clearTimeout(timer);
  }, [search]);
  const { data: templates } = useQuery({
    ...templatesQuery(query),
    enabled: !!account,
  });

  return (
    <Page title={t("discover")} description={t("discoverDescription")}>
      {isPending ? null : !account ? (
        <EmptyState
          icon={<Globe className="size-5" />}
          text={t("discoverNeedsPimling")}
        />
      ) : (
        <div className="space-y-4">
          <div className="relative">
            <Search className="-translate-y-1/2 absolute top-1/2 left-3 size-4 text-muted-foreground" />
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={t("searchPims")}
              aria-label={t("searchPims")}
              className="pl-9"
            />
          </div>
          {templates?.length === 0 ? (
            <EmptyState
              icon={<Bot className="size-5" />}
              text={query ? t("noPimsMatch") : t("noPimsPublished")}
            />
          ) : (
            <ul
              className="grid gap-3 sm:grid-cols-2"
              aria-label={t("discover")}
            >
              {templates?.map((template) => (
                <li key={template.id}>
                  <TemplateCard template={template} />
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Page>
  );
}
