import { useQuery } from "@tanstack/react-query";
import { Dialog } from "radix-ui";
import { useEffect, useState } from "react";
import { useI18n } from "~/components/i18n";
import { Bot, Search, X } from "~/components/icons";
import { EmptyState } from "~/components/page";
import { TemplateCard } from "~/components/template-card";
import { Input } from "~/components/ui/input";
import { accountQuery, templatesQuery } from "~/lib/queries";

/** Agents people published for anyone to make their own, as a dialog over whatever is open. */
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
        <Dialog.Content className="fixed top-1/2 left-1/2 z-50 max-h-[min(720px,calc(100dvh-2rem))] w-[calc(100%-2rem)] max-w-3xl -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-2xl border bg-background p-6 shadow-xl scrollbar-thin data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 sm:p-8">
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
      {templates?.length === 0 ? (
        <EmptyState
          icon={<Bot className="size-5" />}
          text={query ? t("noAgentsMatch") : t("noAgentsPublished")}
        />
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2" aria-label={t("discover")}>
          {templates?.map((template) => (
            <li key={template.id}>
              <TemplateCard template={template} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
