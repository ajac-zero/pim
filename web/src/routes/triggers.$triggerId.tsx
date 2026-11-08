import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useI18n } from "~/components/i18n";
import { TriggerEditor } from "~/components/trigger-editor";
import {
  BackLink,
  ProblemNotice,
  RunHistory,
  TriggerActions,
  TriggerDetail,
  Unavailable,
} from "~/components/triggers";
import { triggerQuery } from "~/lib/queries";
import { triggerProblem } from "~/lib/triggers";

export const Route = createFileRoute("/triggers/$triggerId")({
  component: TriggerRoute,
});

function TriggerRoute() {
  const { triggerId } = Route.useParams();
  return <TriggerPage key={triggerId} id={triggerId} />;
}

/** A trigger's page: what it is, what it does, and what came of it. */
function TriggerPage({ id }: { id: string }) {
  const { t } = useI18n();
  const { data: trigger, error, refetch } = useQuery(triggerQuery(id));
  const [editing, setEditing] = useState(false);
  if (error) {
    const problem = triggerProblem(error);
    if (problem.code === "unavailable") return <Unavailable />;
    return (
      <main className="mx-auto w-full max-w-[768px] px-6 py-8">
        <BackLink />
        <div className="mt-6">
          <ProblemNotice problem={problem} />
        </div>
      </main>
    );
  }
  if (!trigger) {
    return (
      <main className="mx-auto w-full max-w-[768px] px-6 py-8">
        <p role="status" className="text-muted-foreground text-sm">
          {t("triggersLoading")}
        </p>
      </main>
    );
  }
  return (
    <main className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
      <div className="mx-auto w-full max-w-[768px] px-4 py-8 sm:px-6 md:py-12">
        <BackLink />
        {editing ? (
          <TriggerEditor
            trigger={trigger}
            onDone={() => setEditing(false)}
            onReload={async () => (await refetch()).data ?? trigger}
          />
        ) : (
          <>
            <TriggerDetail trigger={trigger} />
            <TriggerActions
              trigger={trigger}
              onEdit={() => setEditing(true)}
              onReload={() => void refetch()}
            />
            <RunHistory trigger={trigger} />
          </>
        )}
      </div>
    </main>
  );
}
