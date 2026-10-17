import { useMutation } from "@tanstack/react-query";
import { useI18n } from "~/components/i18n";
import { Loader2, LogIn } from "~/components/icons";
import { Button } from "~/components/ui/button";
import { auth, type ProviderId, type SignInProvider } from "~/lib/auth";

/** A provider's mark: Google's and GitHub's from Simple Icons (CC0), a generic one for single sign-on. */
export function ProviderLogo({
  provider,
  className,
}: {
  provider: ProviderId;
  className?: string;
}) {
  if (provider === "oidc") return <LogIn className={className} />;
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      className={className}
      aria-hidden="true"
    >
      <path
        d={
          provider === "google"
            ? "M12.48 10.92v3.28h7.84c-.24 1.84-.853 3.187-1.787 4.133-1.147 1.147-2.933 2.4-6.053 2.4-4.827 0-8.6-3.893-8.6-8.72s3.773-8.72 8.6-8.72c2.6 0 4.507 1.027 5.907 2.347l2.307-2.307C18.747 1.44 16.133 0 12.48 0 5.867 0 .307 5.387.307 12s5.56 12 12.173 12c3.573 0 6.267-1.173 8.373-3.36 2.16-2.16 2.84-5.213 2.84-7.667 0-.76-.053-1.467-.173-2.053H12.48z"
            : "M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"
        }
      />
    </svg>
  );
}

/**
 * "Continue with Google", and the other providers the admin set up. Each
 * leaves for the provider's sign-in page; `setup` makes it the account's
 * first way in, instead of a sign-in.
 */
export function ProviderButtons({
  providers,
  setup,
  disabled,
  onError,
}: {
  providers: SignInProvider[] | undefined;
  setup?: string | null;
  disabled?: boolean;
  onError: (error: Error) => void;
}) {
  const { t } = useI18n();
  const go = useMutation({
    mutationFn: (provider: ProviderId) =>
      auth.withProvider(provider, setup ?? undefined),
    onError,
  });
  if (!providers?.length) return null;
  return (
    <div className="mt-3 space-y-2">
      {providers.map((provider) => (
        <Button
          key={provider.id}
          variant="outline"
          size="lg"
          className="w-full"
          disabled={disabled || go.isPending}
          onClick={() => go.mutate(provider.id)}
        >
          {go.isPending && go.variables === provider.id ? (
            <Loader2 className="animate-spin" />
          ) : (
            <ProviderLogo provider={provider.id} />
          )}
          {t("continueWith", { provider: provider.name })}
        </Button>
      ))}
    </div>
  );
}
