import { skipToken, useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useI18n } from "~/components/i18n";
import {
  BackLink,
  GrantReview,
  ProblemNotice,
  Unavailable,
} from "~/components/triggers";
import { approvalsQuery, triggerQuery } from "~/lib/queries";
import {
  grantStanding,
  sourceConfigHash,
  triggerProblem,
} from "~/lib/triggers";

export const Route = createFileRoute("/triggers/$triggerId_/grant")({
  component: GrantRoute,
});

function GrantRoute() {
  const { triggerId } = Route.useParams();
  return <GrantPage key={triggerId} id={triggerId} />;
}

/** Where a trigger's grant request stands, and the person's decision on it. */
function GrantPage({ id }: { id: string }) {
  const { t } = useI18n();
  const trigger = useQuery(triggerQuery(id));
  const approvals = useQuery(approvalsQuery());
  const source = trigger.data?.source;
  // Whether a request is for the source the trigger has now: the digest Pim put in its scope.
  const hash = useQuery({
    queryKey: ["triggers", "source-hash", source],
    queryFn:
      source && trigger.data?.grant.required
        ? () => sourceConfigHash(source)
        : skipToken,
    staleTime: Number.POSITIVE_INFINITY,
  });
  const error = trigger.error ?? approvals.error ?? hash.error;
  if (error) {
    const problem = triggerProblem(error);
    if (trigger.error && problem.code === "unavailable") return <Unavailable />;
    return (
      <main className="mx-auto w-full max-w-[768px] px-6 py-8">
        <BackLink />
        <div className="mt-6">
          <ProblemNotice problem={problem} />
        </div>
      </main>
    );
  }
  const required = trigger.data?.grant.required;
  if (!trigger.data || !approvals.data || (required && !hash.data)) {
    return (
      <main className="mx-auto w-full max-w-[768px] px-6 py-8">
        <p role="status" className="text-muted-foreground text-sm">
          {t("triggerGrantLoading")}
        </p>
      </main>
    );
  }
  const currentHash = hash.data ?? "";
  return (
    <main className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
      <div className="mx-auto w-full max-w-[768px] px-4 py-8 sm:px-6 md:py-12">
        <GrantReview
          trigger={trigger.data}
          standing={grantStanding(
            trigger.data,
            approvals.data,
            currentHash,
            Date.now(),
          )}
          currentHash={currentHash}
        />
      </div>
    </main>
  );
}
