import { useMutation } from "@tanstack/react-query";
import { Check, Copy, Loader2, Smartphone } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { renderSVG } from "uqr";
import { useI18n } from "~/components/i18n";
import { Button } from "~/components/ui/button";
import { auth } from "~/lib/auth";

/**
 * Adds another device (a phone, another computer) to this Pim: a one-use
 * link, good for ten minutes, that the other device opens to make its own
 * passkey. Shown as a QR code to scan, and as a link to copy. Only a browser
 * signed in with a passkey can make one.
 */
export function AddDevice() {
  const { t, formatDate } = useI18n();
  const [link, setLink] = useState<{ url: string; expiresAt: string } | null>(
    null,
  );
  const [copied, setCopied] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const make = useMutation({
    mutationFn: auth.deviceLink,
    onSuccess: (made) => {
      setLink(made);
      setCopied(false);
    },
    onError: (error) => toast.error(error.message),
  });
  const expired = link !== null && Date.parse(link.expiresAt) <= now;
  // Ticks while a link is shown, so it says when it's no longer good.
  useEffect(() => {
    if (!link) return;
    const timer = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(timer);
  }, [link]);
  // The QR code is drawn here, from the link: nothing leaves the browser to make it.
  const qr = useMemo(
    () =>
      link && !expired
        ? renderSVG(link.url, { ecc: "M", border: 2, pixelSize: 6 })
        : null,
    [link, expired],
  );

  return (
    <div className="space-y-3 rounded-xl border px-4 py-3">
      <div className="flex items-start gap-3">
        <Smartphone className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <p className="font-medium text-sm">{t("addDeviceTitle")}</p>
          <p className="mt-0.5 text-muted-foreground text-xs">
            {t("addDeviceBody")}
          </p>
        </div>
      </div>
      {link && !expired && qr ? (
        <div className="flex flex-col items-start gap-3 sm:flex-row">
          <div
            role="img"
            aria-label={t("addDeviceQr")}
            className="size-44 shrink-0 rounded-lg bg-white p-1 [&>svg]:size-full"
            // uqr returns a self-contained SVG of rectangles drawn from the link.
            // biome-ignore lint/security/noDangerouslySetInnerHtml: generated locally from our own URL
            dangerouslySetInnerHTML={{ __html: qr }}
          />
          <div className="min-w-0 flex-1 space-y-2 text-sm">
            <ol className="list-decimal space-y-1 pl-5">
              <li>{t("addDeviceStepScan")}</li>
              <li>{t("addDeviceStepPasskey")}</li>
            </ol>
            <p className="text-muted-foreground text-xs">
              {t("addDeviceExpires", {
                time: formatDate(new Date(link.expiresAt), {
                  timeStyle: "short",
                }),
              })}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={async () => {
                  await navigator.clipboard.writeText(link.url);
                  setCopied(true);
                }}
              >
                {copied ? <Check /> : <Copy />}
                {copied ? t("copied") : t("copyLink")}
              </Button>
              {/* Ending it here stops the link working at once, not in ten minutes. */}
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setLink(null);
                  void auth.cancelDeviceLink().catch(() => undefined);
                }}
              >
                {t("done")}
              </Button>
            </div>
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          {expired && (
            <p className="text-muted-foreground text-xs">
              {t("addDeviceExpired")}
            </p>
          )}
          <Button
            variant="outline"
            onClick={() => make.mutate()}
            disabled={make.isPending}
          >
            {make.isPending ? (
              <Loader2 className="animate-spin" />
            ) : (
              <Smartphone />
            )}
            {t("addDeviceButton")}
          </Button>
        </div>
      )}
    </div>
  );
}
