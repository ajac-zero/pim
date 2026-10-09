import { type ErrorComponentProps, useRouter } from "@tanstack/react-router";
import { AlertCircle } from "lucide-react";
import { useI18n } from "~/components/i18n";
import { Button } from "~/components/ui/button";
import { SignInRequired } from "~/lib/pim-api";

/** A page that failed to load: usually Pim unreachable or sign-in lapsed. */
export function RouteError({ error, reset }: ErrorComponentProps) {
  const { t } = useI18n();
  const router = useRouter();
  const signIn = error instanceof SignInRequired;
  return (
    <main className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
      <AlertCircle className="size-6 text-muted-foreground" />
      <p className="font-medium">
        {signIn ? t("signInExpired") : t("couldNotReachPim")}
      </p>
      <p className="max-w-md text-muted-foreground text-sm">
        {error instanceof Error ? error.message : String(error)}
      </p>
      <Button
        variant="outline"
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
