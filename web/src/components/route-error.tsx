import { type ErrorComponentProps, useRouter } from "@tanstack/react-router";
import { PimMark } from "~/components/app-sidebar";
import { useI18n } from "~/components/i18n";
import { Button } from "~/components/ui/button";
import { NoAddress, SignInRequired } from "~/lib/pim-api";

/** A page that failed to load: usually Pim unreachable or sign-in lapsed. */
export function RouteError({ error, reset }: ErrorComponentProps) {
  const { t } = useI18n();
  const router = useRouter();
  const signIn = error instanceof SignInRequired;
  if (error instanceof NoAddress) return <SetAddress />;
  return (
    <main className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
      <p className="font-medium text-[15px]">
        {signIn ? t("signInExpired") : t("couldNotReachPim")}
      </p>
      <p className="max-w-md text-[13px] text-muted-foreground">
        {error instanceof Error ? error.message : String(error)}
      </p>
      <Button
        variant="secondary"
        // Invalidating reruns the failed loader, not just the boundary;
        // reset retries whatever else failed (the sign-in check).
        onClick={() => {
          if (signIn) return location.reload();
          reset();
          router.invalidate();
        }}
      >
        {signIn ? t("reload") : t("tryAgain")}
      </Button>
    </main>
  );
}

/** What a new deployment shows until it has `PIM_PUBLIC_URL`: how to set it. */
function SetAddress() {
  const { t } = useI18n();
  const code = "rounded bg-muted px-1 py-0.5 font-mono text-[13px]";
  return (
    <main className="flex min-h-0 flex-1 flex-col items-center justify-center overflow-y-auto px-6 py-12">
      <div className="w-full max-w-sm">
        <PimMark className="mb-8 h-8 w-16" />
        <h1 className="font-semibold text-2xl">{t("noAddressTitle")}</h1>
        <ol className="mt-6 list-decimal space-y-3 pl-5 text-sm marker:text-muted-foreground">
          <li>{t("noAddressOpen")}</li>
          <li>
            {t("noAddressAdd")} <code className={code}>PIM_PUBLIC_URL</code>{" "}
            {t("noAddressAddValue")}{" "}
            <code className={code}>https://pim.example.com</code>
          </li>
          <li>{t("noAddressReload")}</li>
        </ol>
        <p className="mt-6 text-muted-foreground text-sm">
          {t("noAddressNote")}
        </p>
        <Button className="mt-6 w-full" onClick={() => location.reload()}>
          {t("reload")}
        </Button>
      </div>
    </main>
  );
}
