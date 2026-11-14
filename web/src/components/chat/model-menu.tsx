import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { toast } from "sonner";
import { useI18n } from "~/components/i18n";
import { Check } from "~/components/icons";
import { ModelLogo } from "~/components/model-logo";
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "~/components/ui/dropdown-menu";
import { type ModelInfo, type ModelSettings, pim } from "~/lib/pim-api";
import { agentsQuery, modelQuery, sessionsQuery } from "~/lib/queries";
import { modelName } from "~/lib/utils";

/** A model's logo; a custom provider's models have one logo for all. */
export function ModelMark({
  settings,
  model,
  className,
}: {
  settings: ModelSettings;
  model: ModelInfo;
  className: string;
}) {
  return (
    <ModelLogo
      model={model}
      custom={settings.providers.some(
        (provider) => provider.provider === model.provider,
      )}
      className={className}
    />
  );
}

/**
 * The model an agent runs on and the means to change it: its own, if it has
 * one, else the default model. `settings` is undefined until they are known.
 */
export function useAgentModel(agentId: string | undefined) {
  const queryClient = useQueryClient();
  const { data: settings } = useQuery(modelQuery());
  const { data: agents } = useQuery(agentsQuery());
  const own = agents?.find((agent) => agent.id === agentId)?.model;
  const pinned = own
    ? settings?.choices.find(
        (choice) => choice.provider === own.provider && choice.id === own.id,
      )
    : undefined;
  const choose = useMutation({
    mutationFn: (model: Pick<ModelInfo, "provider" | "id"> | null) =>
      pim.chooseAgentModel(agentId ?? "", model),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["agents"] }),
    onError: (error) => toast.error(error.message),
  });
  return {
    settings,
    current: pinned ?? settings?.model,
    pinned: Boolean(pinned),
    choose,
  };
}

/**
 * The model one chat runs on and the means to change it for this chat alone:
 * its own choice if it has one, else its agent's, else the default model.
 * `fallback` is what "Default" in the menu goes back to: the agent's model.
 * With `member`, it is that agent's conversation in a group chat; the choice is
 * still the chat's, never the agent's own.
 */
export function useSessionModel(
  sessionId: string,
  agentId: string | undefined,
  member = false,
) {
  const queryClient = useQueryClient();
  const { data: settings } = useQuery(modelQuery());
  const { data: agents } = useQuery(agentsQuery());
  const { data: sessions } = useQuery(sessionsQuery());
  const session = sessions?.find((candidate) => candidate.id === sessionId);
  const shown = member
    ? session?.room?.members.find((seat) => seat.id === agentId)?.model
    : session?.model;
  const own = agents?.find((agent) => agent.id === agentId)?.model;
  const find = (
    model: Pick<ModelInfo, "provider" | "id"> | undefined | null,
  ) =>
    model
      ? settings?.choices.find(
          (choice) =>
            choice.provider === model.provider && choice.id === model.id,
        )
      : undefined;
  const choose = useMutation({
    mutationFn: (model: Pick<ModelInfo, "provider" | "id"> | null) =>
      member
        ? pim.chooseRoomMemberModel(sessionId, agentId ?? "", model)
        : pim.chooseSessionModel(sessionId, model),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["sessions"] }),
    onError: (error) => toast.error(error.message),
  });
  return {
    settings,
    current: find(shown?.model) ?? shown?.model ?? find(own) ?? settings?.model,
    pinned: shown?.override ?? false,
    fallback: find(own) ?? settings?.model,
    choose,
  };
}

/**
 * What to choose from for one agent: "Default", which follows Settings →
 * Model, then each model, and a link to Settings for more.
 */
export function ModelMenuItems({
  settings,
  current,
  pinned,
  choose,
  fallback = settings.model,
}: {
  settings: ModelSettings;
  current: ModelInfo;
  pinned: boolean;
  /** The model "Default" stands for; the default model unless a chat's agent has its own. */
  fallback?: ModelInfo;
  choose: (model: Pick<ModelInfo, "provider" | "id"> | null) => void;
}) {
  const { t } = useI18n();
  return (
    <>
      <DropdownMenuItem
        onSelect={() => {
          if (pinned) choose(null);
        }}
        className="min-h-11 gap-3"
      >
        <ModelMark
          settings={settings}
          model={fallback}
          className="size-5 text-foreground"
        />
        <span className="min-w-0 flex-1 truncate">
          {modelName(fallback.name)}
          <span className="ml-2 text-muted-foreground text-xs">
            {t("defaultModelTag")}
          </span>
        </span>
        {!pinned && <Check className="size-4 text-primary" />}
      </DropdownMenuItem>
      {settings.choices.map((choice) => {
        const selected =
          pinned &&
          choice.provider === current.provider &&
          choice.id === current.id;
        return (
          <DropdownMenuItem
            key={`${choice.provider}/${choice.id}`}
            onSelect={() => {
              if (!selected) choose(choice);
            }}
            className="min-h-11 gap-3"
          >
            <ModelMark
              settings={settings}
              model={choice}
              className="size-5 text-foreground"
            />
            <span className="min-w-0 flex-1 truncate">
              {modelName(choice.name)}
            </span>
            {selected && <Check className="size-4 text-primary" />}
          </DropdownMenuItem>
        );
      })}
      <DropdownMenuSeparator />
      <DropdownMenuItem asChild>
        <Link
          to="."
          search={(prev) => ({ ...prev, dialog: "settings", tab: "model" })}
        >
          {t("moreModels")}
        </Link>
      </DropdownMenuItem>
    </>
  );
}
