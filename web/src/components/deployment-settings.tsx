import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { type TranslationKey, useI18n } from "~/components/i18n";
import { AlertCircle } from "~/components/icons";
import type {
  DeploymentSettings,
  DeploymentVariable,
  Limits,
} from "~/lib/pim-api";
import { deploymentQuery } from "~/lib/queries";

const LIMITS: [keyof Limits, TranslationKey][] = [
  ["dailyTokens", "limitDailyTokens"],
  ["dailyModelRequests", "limitDailyModelRequests"],
  ["dailyRuns", "limitDailyRuns"],
  ["sessions", "limitSessions"],
  ["schedules", "limitSchedules"],
  ["storageBytes", "limitStorageBytes"],
  ["artifacts", "limitArtifacts"],
  ["artifactVersions", "limitArtifactVersions"],
  ["artifactBytes", "limitArtifactBytes"],
  ["artifactStorageBytes", "limitArtifactStorageBytes"],
];

/** The variable that sets a limit, as the server names it: `dailyTokens` is `PIM_LIMIT_DAILY_TOKENS`. */
const limitVariable = (name: keyof Limits) =>
  `PIM_LIMIT_${name.replace(/[A-Z]/g, (letter) => `_${letter}`).toUpperCase()}`;

/**
 * How this deployment runs for everyone, as its variables in the Cloudflare
 * dashboard say: each setting, the variable that sets it, whether it's the
 * default, and what's wrong with any Pim can't read. Read-only: they change
 * in the dashboard. The admin's alone.
 */
export function DeploymentSection() {
  const { t, formatNumber } = useI18n();
  const { data } = useQuery(deploymentQuery());
  if (!data) return null;
  const { settings, variables } = data;
  const byName = new Map(
    variables.map((variable) => [variable.name, variable]),
  );
  const problems = variables.filter((variable) => variable.problem);
  const row = (
    name: string,
    label: TranslationKey,
    value: string,
    hint?: TranslationKey,
  ) => (
    <Row
      key={name}
      label={t(label)}
      hint={hint && t(hint)}
      value={value}
      variable={byName.get(name) ?? { name, value: null, problem: null }}
    />
  );
  const count = (value: number | null, none: TranslationKey) =>
    value === null ? t(none) : formatNumber(value);
  const off = (value: string | null, none: TranslationKey = "deploymentOff") =>
    value ?? t(none);
  const registration: Record<DeploymentSettings["registration"], string> = {
    invite: t("deploymentRegistrationInvite"),
    open: t("deploymentRegistrationOpen"),
    closed: t("deploymentRegistrationClosed"),
  };
  const approvals: Record<DeploymentSettings["approvalPolicy"], string> = {
    majordomo: t("deploymentApprovalMajordomo"),
    explicit: t("deploymentApprovalExplicit"),
    auto: t("deploymentApprovalAuto"),
  };

  return (
    <div className="space-y-10">
      <p className="text-[13px] text-muted-foreground">
        {t("deploymentDescription")}
      </p>
      {problems.length > 0 && (
        <div
          role="alert"
          className="flex gap-3 rounded-2xl border border-destructive/40 px-4 py-3 text-sm"
        >
          <AlertCircle className="mt-0.5 size-4 shrink-0 text-destructive" />
          <span>
            {t("deploymentProblems", { count: String(problems.length) })}
          </span>
        </div>
      )}
      <Group title={t("deploymentJoining")}>
        {row(
          "PIM_REGISTRATION",
          "deploymentRegistration",
          registration[settings.registration],
        )}
        {row(
          "PIM_MAX_ACCOUNTS",
          "deploymentMaxAccounts",
          count(settings.maxAccounts, "deploymentNoCap"),
          "deploymentMaxAccountsHint",
        )}
        {row(
          "PIM_REGISTRATIONS_PER_ADDRESS",
          "deploymentPerAddress",
          formatNumber(settings.registrationsPerAddress),
        )}
      </Group>
      <Group title={t("deploymentModels")}>
        {row("PIM_MODEL", "deploymentModel", settings.model)}
        {row(
          "PIM_MODELS",
          "deploymentOtherModels",
          settings.models.length === 0
            ? t("deploymentAnyModel")
            : settings.models.join(", "),
        )}
        {row(
          "PIM_UTILITY_MODEL",
          "deploymentUtilityModel",
          off(settings.utilityModel),
          "deploymentUtilityModelHint",
        )}
        {row(
          "PIM_MEMORY_MODEL",
          "deploymentMemoryModel",
          off(settings.memoryModel, "deploymentSameAsDefault"),
        )}
        {row(
          "PIM_WEB_SEARCH",
          "deploymentWebSearch",
          off(settings.webSearch),
          "deploymentWebSearchHint",
        )}
      </Group>
      <Group
        title={t("deploymentEveryone")}
        description={t("deploymentEveryoneHint")}
      >
        {row(
          "PIM_APPROVAL_POLICY",
          "deploymentApprovals",
          approvals[settings.approvalPolicy],
        )}
        {row("PIM_TIME_ZONE", "deploymentTimeZone", settings.timeZone)}
        {row(
          "PIM_MEMORY_LINES",
          "deploymentMemoryLines",
          formatNumber(settings.memoryLines),
        )}
      </Group>
      <Group
        title={t("deploymentLimits")}
        description={t("deploymentLimitsHint")}
      >
        {LIMITS.map(([name, label]) =>
          row(
            limitVariable(name),
            label,
            count(settings.limits[name], "deploymentNoLimit"),
          ),
        )}
      </Group>
      <Group title={t("deploymentAddress")}>
        {row(
          "PIM_PUBLIC_URL",
          "deploymentPublicUrl",
          settings.publicUrl ?? "",
          "deploymentPublicUrlHint",
        )}
        {row(
          "PIM_CONTENT_ORIGIN",
          "deploymentContentOrigin",
          off(settings.contentOrigin),
          "deploymentContentOriginHint",
        )}
        {row("PIM_EMAIL_FROM", "deploymentEmailFrom", off(settings.emailFrom))}
      </Group>
    </div>
  );
}

function Group({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section className="space-y-3">
      <h2 className="font-medium text-muted-foreground text-sm">{title}</h2>
      {description && (
        <p className="text-[13px] text-muted-foreground">{description}</p>
      )}
      <dl className="divide-y rounded-2xl border bg-muted/20">{children}</dl>
    </section>
  );
}

/** One setting: what it is and the variable that sets it, then what it is now. */
function Row({
  label,
  hint,
  value,
  variable,
}: {
  label: string;
  hint?: string;
  value: string;
  variable: DeploymentVariable;
}) {
  const { t } = useI18n();
  return (
    <div className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
      <dt className="min-w-0">
        <span className="block text-sm">{label}</span>
        {hint && (
          <span className="block text-muted-foreground text-xs">{hint}</span>
        )}
        <span className="mt-0.5 block text-muted-foreground text-xs">
          <code className="font-mono">{variable.name}</code>
          {variable.value === null && ` · ${t("deploymentDefault")}`}
        </span>
      </dt>
      <dd className="min-w-0 break-words text-sm sm:max-w-[50%] sm:shrink-0 sm:text-right">
        {value}
        {variable.problem && (
          <span className="block text-destructive text-xs">
            {t("deploymentProblem", {
              problem: variable.problem,
              value: variable.value ?? "",
            })}
          </span>
        )}
      </dd>
    </div>
  );
}
