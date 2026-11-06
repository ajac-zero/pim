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
import { Switch } from "~/components/ui/switch";
import {
  type Agent,
  type BotSharing,
  pim,
  type ShareableTool,
} from "~/lib/pim-api";
import { modelQuery } from "~/lib/queries";
import { cn } from "~/lib/utils";

const DEFAULT_DAILY_MESSAGES = 50;
const DEFAULT_DAILY_TOOL_CALLS = 20;
/** The select's value for this Pim's default model: Radix needs a non-empty one. */
const DEFAULT_MODEL = "-";
const modelKey = (model: { provider: string; id: string }) =>
  `${model.provider}\n${model.id}`;

export const agentBotQuery = (id: string) =>
  queryOptions({
    queryKey: ["agent-bot", id],
    queryFn: () => pim.agentBot(id),
  });

const agentBotToolsQuery = (id: string) =>
  queryOptions({
    queryKey: ["agent-bot-tools", id],
    queryFn: () => pim.agentBotTools(id),
  });

/**
 * The admin shares an agent as a bot: a public link where anyone can make
 * a guest account and chat with a copy of it, up to the messages and tool
 * calls a day it allows each of them, with the agent's tools the admin
 * switches on, which run as the admin. Sharing again sends guests the agent
 * as it is now.
 */
export function BotShareButton({ agent }: { agent: Agent }) {
  const { t, formatNumber } = useI18n();
  const queryClient = useQueryClient();
  const inputId = useId();
  const { data: sharing } = useQuery(agentBotQuery(agent.id));
  const [daily, setDaily] = useState<string | null>(null);
  const [calls, setCalls] = useState<string | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const [tools, setTools] = useState<string[] | null>(null);
  const [ask, setAsk] = useState<string[] | null>(null);
  const { data: models } = useQuery(modelQuery());
  const { data: shareable } = useQuery(agentBotToolsQuery(agent.id));
  const sharedTools = tools ?? sharing?.tools ?? [];
  const askedTools = ask ?? sharing?.ask ?? [];
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
  // Shared before tool calls had a limit, it has the deployment's: shown as the default, saved on Update.
  const shownCalls =
    calls ?? String(sharing?.dailyToolCalls ?? DEFAULT_DAILY_TOOL_CALLS);
  const parsedCalls = Number(shownCalls);
  const valid =
    Number.isInteger(parsed) &&
    parsed >= 1 &&
    parsed <= 10_000 &&
    shownCalls.trim() !== "" &&
    Number.isInteger(parsedCalls) &&
    parsedCalls >= 0 &&
    parsedCalls <= 10_000;
  const settle = (next: BotSharing | null) => {
    queryClient.setQueryData(agentBotQuery(agent.id).queryKey, next);
    setDaily(null);
    setCalls(null);
    setModel(null);
    setTools(null);
    setAsk(null);
  };
  const share = useMutation({
    mutationFn: () => {
      const [provider, id] = chosen.split("\n");
      return pim.shareBot(agent.id, {
        dailyMessages: parsed,
        dailyToolCalls: parsedCalls,
        model:
          chosen === DEFAULT_MODEL || !provider || !id
            ? null
            : { provider, id },
        // A tool the agent no longer has, such as one of a connector since disconnected, stops being shared.
        tools: sharedTools.filter((name) =>
          shareable?.some((tool) => tool.name === name),
        ),
        ask: askedTools.filter(
          (name) =>
            sharedTools.includes(name) &&
            shareable?.some((tool) => tool.name === name),
        ),
      });
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
        className="max-h-(--radix-popover-content-available-height) w-96 space-y-4 overflow-y-auto p-4"
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
        <div className="grid grid-cols-2 gap-3">
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
              className="mt-1.5 h-9"
            />
          </div>
          <div>
            <label
              htmlFor={`${inputId}-calls`}
              className="block text-[13px] text-muted-foreground"
            >
              {t("botDailyToolCalls")}
            </label>
            <Input
              id={`${inputId}-calls`}
              type="number"
              inputMode="numeric"
              min={0}
              max={10_000}
              value={shownCalls}
              onChange={(event) => setCalls(event.target.value)}
              className="mt-1.5 h-9"
            />
          </div>
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
        <BotTools
          tools={shareable}
          chosen={sharedTools}
          asked={askedTools}
          onChange={(next, nextAsk) => {
            setTools(next);
            setAsk(nextAsk);
          }}
        />
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

type BotToolChoice = "off" | "ask" | "on";

/**
 * The agent's tools the bot shares, a connector at a time or one by one: off,
 * on, or on after the admin approves each call. Each runs in the admin's
 * space, as the admin.
 */
function BotTools({
  tools,
  chosen,
  asked,
  onChange,
}: {
  tools: ShareableTool[] | undefined;
  chosen: string[];
  asked: string[];
  onChange: (next: string[], ask: string[]) => void;
}) {
  const { t } = useI18n();
  const labels: Record<BotToolChoice, string> = {
    off: t("permissionOff"),
    ask: t("permissionAsk"),
    on: t("permissionOn"),
  };
  const choiceOf = (name: string): BotToolChoice =>
    !chosen.includes(name) ? "off" : asked.includes(name) ? "ask" : "on";
  const choose = (name: string, choice: BotToolChoice) =>
    onChange(
      choice === "off"
        ? chosen.filter((other) => other !== name)
        : [...new Set([...chosen, name])],
      choice === "ask"
        ? [...new Set([...asked, name])]
        : asked.filter((other) => other !== name),
    );
  const groups = new Map<string | null, ShareableTool[]>();
  for (const tool of tools ?? []) {
    groups.set(tool.appName, [...(groups.get(tool.appName) ?? []), tool]);
  }
  // Switching a connector on shares the tools that were off; those that ask still do.
  const set = (names: string[], on: boolean) =>
    on
      ? onChange([...new Set([...chosen, ...names])], asked)
      : onChange(
          chosen.filter((name) => !names.includes(name)),
          asked.filter((name) => !names.includes(name)),
        );
  return (
    <div>
      <span className="block text-[13px] text-muted-foreground">
        {t("botTools")}
      </span>
      <p className="mt-0.5 text-[13px] text-muted-foreground">
        {t("botToolsHint")}
      </p>
      {tools && tools.length === 0 && (
        <p className="mt-1.5 rounded-lg border px-3 py-2 text-[13px] text-muted-foreground">
          {t("botToolsNone")}
        </p>
      )}
      {tools && tools.length > 0 && (
        <div className="mt-1.5 max-h-56 overflow-y-auto rounded-lg border">
          {[...groups].map(([app, members]) => {
            const names = members.map((tool) => tool.name);
            const all = names.every((name) => chosen.includes(name));
            const label = app ?? t("botToolsPim");
            return (
              <section key={label} className="border-b last:border-b-0">
                <div className="flex items-center gap-2 bg-muted/40 px-3 py-1.5">
                  <span className="min-w-0 flex-1 truncate font-medium text-[13px]">
                    {label}
                  </span>
                  <Switch
                    size="sm"
                    checked={all}
                    onCheckedChange={(on) => set(names, on)}
                    aria-label={t("botToolsAll", { app: label })}
                  />
                </div>
                <ul>
                  {members.map((tool) => (
                    <li
                      key={tool.name}
                      className="flex items-center gap-2 px-3 py-1.5"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-mono text-[12px]">
                          {tool.name}
                          {tool.destructive && (
                            <span className="ml-1.5 font-sans text-destructive">
                              {t("botToolChanges")}
                            </span>
                          )}
                        </p>
                        <p className="truncate text-[12px] text-muted-foreground">
                          {tool.description.replace(/^\[[^\]]*\]\s*/, "")}
                        </p>
                      </div>
                      <span
                        role="group"
                        aria-label={t("permissionFor", { tool: tool.name })}
                        className="inline-flex shrink-0 rounded-full border bg-background p-0.5"
                      >
                        {(["off", "ask", "on"] as const).map((choice) => {
                          const selected = choiceOf(tool.name) === choice;
                          return (
                            <button
                              key={choice}
                              type="button"
                              aria-pressed={selected}
                              onClick={() => choose(tool.name, choice)}
                              className={cn(
                                "rounded-full px-2 py-0.5 text-[12px] transition-colors",
                                selected
                                  ? "bg-muted text-foreground"
                                  : "text-muted-foreground hover:bg-accent hover:text-foreground",
                              )}
                            >
                              {labels[choice]}
                            </button>
                          );
                        })}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}

const sameModel = (
  a: { provider: string; id: string },
  b: { provider: string; id: string },
) => a.provider === b.provider && a.id === b.id;
