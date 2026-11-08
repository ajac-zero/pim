import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useI18n } from "~/components/i18n";
import { TriggerEditor } from "~/components/trigger-editor";
import { BackLink, Unavailable } from "~/components/triggers";
import { triggersAvailableQuery } from "~/lib/queries";

export const Route = createFileRoute("/triggers/new")({
  component: NewTriggerPage,
});

/** A new trigger, saved as a draft after the person reviews it. */
function NewTriggerPage() {
  const { t } = useI18n();
  const available = useQuery(triggersAvailableQuery());
  if (available.data === false) return <Unavailable />;
  return (
    <main className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
      <div className="mx-auto w-full max-w-[768px] px-4 py-8 sm:px-6 md:py-12">
        <BackLink />
        {available.data ? (
          <TriggerEditor />
        ) : (
          <p role="status" className="mt-6 text-muted-foreground text-sm">
            {available.error ? available.error.message : t("triggersLoading")}
          </p>
        )}
      </div>
    </main>
  );
}
