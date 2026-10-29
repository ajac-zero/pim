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
import { agentsQuery, modelQuery } from "~/lib/queries";
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
 * What to choose from for one agent: "Default", which follows Settings →
 * Model, then each model, and a link to Settings for more.
 */
export function ModelMenuItems({
  settings,
  current,
  pinned,
  choose,
}: {
  settings: ModelSettings;
  current: ModelInfo;
  pinned: boolean;
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
          model={settings.model}
          className="size-5 text-foreground"
        />
        <span className="min-w-0 flex-1 truncate">
          {modelName(settings.model.name)}
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
