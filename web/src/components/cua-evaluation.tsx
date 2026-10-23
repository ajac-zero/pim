import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Section } from "~/components/account-settings";
import { useI18n } from "~/components/i18n";
import {
  ExternalLink,
  Loader2,
  Monitor,
  Pause,
  Play,
} from "~/components/icons";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { type CuaStatus, pim } from "~/lib/pim-api";
import { cuaQuery } from "~/lib/queries";

type Offered = Extract<CuaStatus, { offered: true }>;

/** The evaluation's status, kept up while a pause waits for the agents' work to finish. */
function useCua() {
  return useQuery({
    ...cuaQuery(),
    refetchInterval: (query) => {
      const data = query.state.data;
      return data?.offered && data.enabled && data.mode === "pausing"
        ? 2_000
        : false;
    },
  });
}

/**
 * Opens Cua's viewer in a tab of its own, never in a frame: the tab opens
 * at once, while the click still counts, and goes to the viewer once Pim
 * has a link for it. The link carries a short-lived ticket in its fragment,
 * so it isn't kept here, in the app's cache or in its address.
 */
export async function openViewer(): Promise<void> {
  const tab = window.open("", "_blank");
  if (tab) tab.opener = null;
  try {
    const { url } = await pim.cuaViewer();
    if (!tab) throw new Error("Allow pop-ups for Pim to open the viewer.");
    tab.location.replace(url);
  } catch (error) {
    tab?.close();
    throw error;
  }
}

/**
 * Pausing your agents, opening the viewer and resuming them: what the
 * evaluation's settings show, and the browser box beside a chat in place
 * of taking over.
 */
export function CuaControls({ status }: { status: Offered }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const settle = (next: CuaStatus) => queryClient.setQueryData(["cua"], next);
  const onError = (error: Error) => {
    toast.error(error.message);
    void queryClient.invalidateQueries({ queryKey: ["cua"] });
  };
  const pause = useMutation({
    mutationFn: pim.pauseCua,
    onSuccess: settle,
    onError,
  });
  const resume = useMutation({
    mutationFn: () => pim.resumeCua(status.generation),
    onSuccess: settle,
    onError,
  });
  const viewer = useMutation({ mutationFn: openViewer, onError });

  return (
    <div className="space-y-3" data-cua-mode={status.mode}>
      <p className="flex items-center gap-2 text-[13px] text-muted-foreground">
        {status.mode === "pausing" && (
          <Loader2 className="size-3.5 shrink-0 animate-spin" />
        )}
        {status.mode === "agents"
          ? t("cuaAgentsInControl")
          : status.mode === "pausing"
            ? t("cuaPausing", { count: status.pending })
            : t("cuaPaused")}
      </p>
      {status.problem && (
        <p className="text-[13px] text-destructive">{status.problem}</p>
      )}
      <div className="flex flex-wrap gap-2">
        {status.mode === "agents" ? (
          <Button onClick={() => pause.mutate()} disabled={pause.isPending}>
            {pause.isPending ? <Loader2 className="animate-spin" /> : <Pause />}
            {t("cuaPause")}
          </Button>
        ) : (
          <>
            <Button
              onClick={() => viewer.mutate()}
              disabled={status.mode !== "paused" || viewer.isPending}
            >
              {viewer.isPending ? (
                <Loader2 className="animate-spin" />
              ) : (
                <ExternalLink />
              )}
              {t("cuaOpenViewer")}
            </Button>
            <Button
              variant="secondary"
              onClick={() => resume.mutate()}
              disabled={resume.isPending}
            >
              {resume.isPending ? (
                <Loader2 className="animate-spin" />
              ) : (
                <Play />
              )}
              {t("cuaResume")}
            </Button>
          </>
        )}
      </div>
      {status.mode !== "agents" && (
        <p className="text-muted-foreground text-xs">{t("cuaViewerHint")}</p>
      )}
    </div>
  );
}

/** The evaluation's controls for the browser box, while it stands in for your browser. */
export function CuaBrowserControls() {
  const { data } = useCua();
  if (!data?.offered || !data.enabled) return null;
  return <CuaControls status={data} />;
}

/**
 * Settings → Computer, where this Pim offers you the Cua evaluation: turn
 * it on for your agents, in place of your computer, which stays as it is
 * and comes back when you turn it off.
 */
export function CuaEvaluationSection() {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const { data } = useCua();
  const settle = (next: CuaStatus) => {
    queryClient.setQueryData(["cua"], next);
    void queryClient.invalidateQueries({ queryKey: ["computer"] });
    void queryClient.invalidateQueries({ queryKey: ["files"] });
  };
  const enable = useMutation({
    mutationFn: pim.enableCua,
    onSuccess: settle,
    onError: (error) => toast.error(error.message),
  });
  const disable = useMutation({
    mutationFn: pim.disableCua,
    onSuccess: settle,
    onError: (error) => toast.error(error.message),
  });
  if (!data?.offered) return null;

  return (
    <Section title={t("cuaEvaluation")} description={t("cuaDescription")}>
      <div className="flex items-center gap-3 rounded-2xl border bg-muted/20 px-4 py-3">
        <Monitor className="size-11 shrink-0 rounded-xl bg-muted p-3 text-muted-foreground" />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="truncate font-medium text-sm">{data.host}</span>
            <Badge
              variant={data.enabled ? "success" : "secondary"}
              className="text-[11px]"
            >
              {t(data.enabled ? "cuaOn" : "cuaOff")}
            </Badge>
          </span>
          <span className="block truncate text-muted-foreground text-xs">
            {t("cuaFeatures")}
          </span>
        </span>
      </div>
      {data.enabled && <CuaControls status={data} />}
      {data.enabled ? (
        <Button
          variant="ghost"
          className="text-muted-foreground"
          onClick={() => disable.mutate()}
          disabled={disable.isPending}
        >
          {disable.isPending && <Loader2 className="animate-spin" />}
          {t("cuaTurnOff")}
        </Button>
      ) : (
        <Button
          variant="secondary"
          onClick={() => enable.mutate()}
          disabled={enable.isPending}
        >
          {enable.isPending && <Loader2 className="animate-spin" />}
          {t("cuaTurnOn")}
        </Button>
      )}
    </Section>
  );
}
