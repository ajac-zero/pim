import {
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useId, useState } from "react";
import { toast } from "sonner";
import { useI18n } from "~/components/i18n";
import { Check, Copy, Link2, Loader2 } from "~/components/icons";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "~/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { type Agent, type BotSharing, pim } from "~/lib/pim-api";
import { modelQuery } from "~/lib/queries";

const DEFAULT_DAILY_MESSAGES = 50;
/** The select's value for this Pim's default model: Radix needs a non-empty one. */
const DEFAULT_MODEL = "-";
const modelKey = (model: { provider: string; id: string }) =>
  `${model.provider}\n${model.id}`;

export const agentBotQuery = (id: string) =>
  queryOptions({
    queryKey: ["agent-bot", id],
    queryFn: () => pim.agentBot(id),
  });

/**
 * The admin shares an agent as a bot: a public link where anyone can make
 * a guest account and chat with a copy of it, up to the messages a day it
 * allows each of them. Sharing again sends guests the agent as it is now.
 */
export function BotShareButton({ agent }: { agent: Agent }) {
  const { t, formatNumber } = useI18n();
  const queryClient = useQueryClient();
  const inputId = useId();
  const { data: sharing } = useQuery(agentBotQuery(agent.id));
  const [daily, setDaily] = useState<string | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const { data: models } = useQuery(modelQuery());
  // Guests can't use the admin's ChatGPT plan or own providers: only what this Pim offers everyone.
  const choices =
    models?.choices.filter(
      (choice) =>
        !sameModel(choice, models.default) &&
        choice.provider !== "openai" &&
        !choice.provider.startsWith("own:"),
    ) ?? [];
  const kept = sharing?.model ?? null;
  const stale =
    kept &&
    !choices.some((choice) => sameModel(choice, kept)) &&
    !(models && sameModel(models.default, kept))
      ? kept
      : null;
  const chosen =
    model ?? (sharing?.model ? modelKey(sharing.model) : DEFAULT_MODEL);
  const [copied, setCopied] = useState(false);
  const shown =
    daily ?? String(sharing?.dailyMessages ?? DEFAULT_DAILY_MESSAGES);
  const parsed = Number(shown);
  const valid = Number.isInteger(parsed) && parsed >= 1 && parsed <= 10_000;
  const settle = (next: BotSharing | null) => {
    queryClient.setQueryData(agentBotQuery(agent.id).queryKey, next);
    setDaily(null);
    setModel(null);
  };
  const share = useMutation({
    mutationFn: () => {
      const [provider, id] = chosen.split("\n");
      return pim.shareBot(
        agent.id,
        parsed,
        chosen === DEFAULT_MODEL || !provider || !id ? null : { provider, id },
      );
    },
    onSuccess: (next) => {
      settle(next);
      toast.success(t(sharing ? "botUpdated" : "botShared"));
    },
    onError: (error) => toast.error(error.message),
  });
  const unshare = useMutation({
    mutationFn: () => pim.unshareBot(agent.id),
    onSuccess: () => {
      settle(null);
      toast.success(t("botUnshared"));
    },
    onError: (error) => toast.error(error.message),
  });
  if (sharing === undefined) return null;
  const busy = share.isPending || unshare.isPending;
  return (
    <Popover onOpenChange={() => setCopied(false)}>
      <PopoverTrigger asChild>
        <Button size="sm" variant="outline">
          <Link2 /> {t(sharing ? "botLinkOn" : "shareAsBot")}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-96 space-y-4 p-4"
        // The link is there to copy, not to type in: nothing is focused at first.
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <div>
          <p className="text-[15px]">{t("shareAsBot")}</p>
          <p className="mt-1 text-[13px] text-muted-foreground">
            {t("shareAsBotBody", { name: agent.name })}
          </p>
        </div>
        {sharing && (
          <div className="space-y-2">
            <div className="flex gap-2">
              <Input
                readOnly
                value={sharing.url}
                aria-label={t("botLink")}
                className="h-9 font-mono text-[13px]"
                onFocus={(event) => event.currentTarget.select()}
              />
              <Button
                size="sm"
                variant="secondary"
                className="h-9 shrink-0"
                onClick={async () => {
                  await navigator.clipboard.writeText(sharing.url);
                  setCopied(true);
                }}
              >
                {copied ? <Check /> : <Copy />}
                {t(copied ? "copied" : "copy")}
              </Button>
            </div>
            <p className="text-[13px] text-muted-foreground">
              {t("botGuests", {
                count: sharing.guests,
                people: formatNumber(sharing.guests),
              })}
            </p>
          </div>
        )}
        <div>
          <label
            htmlFor={inputId}
            className="block text-[13px] text-muted-foreground"
          >
            {t("botDailyMessages")}
          </label>
          <Input
            id={inputId}
            type="number"
            inputMode="numeric"
            min={1}
            max={10_000}
            value={shown}
            onChange={(event) => setDaily(event.target.value)}
            className="mt-1.5 h-9 w-32"
          />
        </div>
        <div>
          <span className="block text-[13px] text-muted-foreground">
            {t("botModel")}
          </span>
          <Select value={chosen} onValueChange={setModel}>
            <SelectTrigger className="mt-1.5 w-full" aria-label={t("botModel")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={DEFAULT_MODEL}>
                {t("botModelDefault", { name: models?.default.name ?? "" })}
              </SelectItem>
              {choices.map((choice) => (
                <SelectItem key={modelKey(choice)} value={modelKey(choice)}>
                  {choice.name}
                </SelectItem>
              ))}
              {/* Shared on a model this Pim no longer offers: shown, so it can be changed. */}
              {stale && (
                <SelectItem value={modelKey(stale)}>{stale.id}</SelectItem>
              )}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            onClick={() => share.mutate()}
            disabled={!valid || busy}
          >
            {share.isPending && <Loader2 className="animate-spin" />}
            {t(sharing ? "botUpdate" : "botCreateLink")}
          </Button>
          {sharing && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => unshare.mutate()}
              disabled={busy}
            >
              {t("botTurnOff")}
            </Button>
          )}
        </div>
        {sharing && (
          <p className="text-[13px] text-muted-foreground">
            {t("botUpdateHint")}
          </p>
        )}
      </PopoverContent>
    </Popover>
  );
}

const sameModel = (
  a: { provider: string; id: string },
  b: { provider: string; id: string },
) => a.provider === b.provider && a.id === b.id;
