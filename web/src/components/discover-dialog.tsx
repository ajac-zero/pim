import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Dialog } from "radix-ui";
import { useEffect, useState } from "react";
import { ARTIFACT_KIND_NAMES, ArtifactIcon } from "~/components/artifact";
import { useI18n } from "~/components/i18n";
import { Bot, Search, X } from "~/components/icons";
import { EmptyState } from "~/components/page";
import { TemplateCard } from "~/components/template-card";
import { Input } from "~/components/ui/input";
import type { PublishedArtifact } from "~/lib/pim-api";
import {
  accountQuery,
  publishedArtifactsQuery,
  templatesQuery,
} from "~/lib/queries";

/** Agents and artifacts people published for anyone to use or make their own, as a dialog over whatever is open. */
export function DiscoverDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useI18n();
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/30 data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <Dialog.Content className="fixed inset-0 z-50 overflow-y-auto bg-background p-6 scrollbar-thin data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 sm:inset-auto sm:top-1/2 sm:left-1/2 sm:max-h-[min(720px,calc(100dvh-2rem))] sm:w-[calc(100%-2rem)] sm:max-w-3xl sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-2xl sm:border sm:p-8 sm:shadow-xl">
          <Dialog.Title className="pr-8 font-semibold text-xl">
            {t("discover")}
          </Dialog.Title>
          <Dialog.Description className="mt-1 mb-8 text-muted-foreground text-sm">
            {t("discoverDescription")}
          </Dialog.Description>
          <Templates />
          <Dialog.Close className="absolute top-4 right-4 rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground">
            <X className="size-4" />
            <span className="sr-only">{t("close")}</span>
          </Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function Templates() {
  const { t } = useI18n();
  const { data: account } = useQuery(accountQuery());
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
  const { data: artifacts } = useQuery({
    ...publishedArtifactsQuery(query),
    enabled: !!account,
  });

  if (!account) return null;
  return (
    <div className="space-y-4">
      <div className="relative">
        <Search className="-translate-y-1/2 absolute top-1/2 left-3 size-4 text-muted-foreground" />
        <Input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder={t("searchAgents")}
          aria-label={t("searchAgents")}
          className="border-transparent bg-muted pl-9 shadow-none"
        />
      </div>
      {templates?.length === 0 && artifacts?.length === 0 ? (
        <EmptyState
          icon={<Bot className="size-5" />}
          text={query ? t("noAgentsMatch") : t("noAgentsPublished")}
        />
      ) : (
        <>
          {!!templates?.length && (
            <section className="space-y-3">
              {!!artifacts?.length && (
                <h3 className="font-medium text-muted-foreground text-sm">
                  {t("discoverAgents")}
                </h3>
              )}
              <ul
                className="grid gap-3 sm:grid-cols-2"
                aria-label={t("discoverAgents")}
              >
                {templates.map((template) => (
                  <li key={template.id}>
                    <TemplateCard template={template} />
                  </li>
                ))}
              </ul>
            </section>
          )}
          {!!artifacts?.length && (
            <section className="space-y-3 pt-2">
              <h3 className="font-medium text-muted-foreground text-sm">
                {t("artifacts")}
              </h3>
              <ul
                className="grid gap-3 sm:grid-cols-2"
                aria-label={t("artifacts")}
              >
                {artifacts.map((artifact) => (
                  <li key={artifact.id}>
                    <PublishedArtifactCard artifact={artifact} />
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </div>
  );
}

/** A published artifact in a list: its title, what kind it is, who made it. */
function PublishedArtifactCard({ artifact }: { artifact: PublishedArtifact }) {
  const { t } = useI18n();
  return (
    <Link
      to="/artifacts/published/$publishedId"
      params={{ publishedId: artifact.id }}
      className="flex h-full flex-col rounded-xl border px-4 py-3 transition-colors hover:bg-accent/50"
    >
      <span className="flex items-center gap-2">
        <ArtifactIcon
          kind={artifact.kind}
          className="size-4 shrink-0 text-primary"
        />
        <span className="truncate font-medium">{artifact.title}</span>
      </span>
      <span className="mt-1 text-muted-foreground text-sm">
        {ARTIFACT_KIND_NAMES[artifact.kind]}
      </span>
      <span className="mt-auto pt-2 text-muted-foreground text-xs">
        {artifact.authorName
          ? `${artifact.authorName} · @${artifact.author}`
          : `@${artifact.author}`}
        {artifact.uses > 0 &&
          ` · ${t("templateUses", { count: artifact.uses })}`}
      </span>
    </Link>
  );
}
