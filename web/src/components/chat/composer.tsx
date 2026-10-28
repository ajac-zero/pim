import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { toast } from "sonner";
import { AgentIcon } from "~/components/agent-icon";
import { Suggestion, Suggestions } from "~/components/ai-elements/suggestion";
import { ArtifactIcon } from "~/components/artifact";
import { useI18n } from "~/components/i18n";
import {
  ArrowUp,
  Check,
  Loader2,
  Plus,
  Sparkles,
  Square,
  X,
} from "~/components/icons";
import { ModelLogo } from "~/components/model-logo";
import { Button } from "~/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import {
  PromptInput,
  type PromptInputMessage,
  PromptInputProvider,
  PromptInputSubmit,
  PromptInputTextarea,
  usePromptInputController,
} from "~/components/ui/prompt-input";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "~/components/ui/tooltip";
import {
  type Agent,
  type ModelInfo,
  type ModelSettings,
  pim,
  type UserContent,
} from "~/lib/pim-api";
import { artifactQuery, modelQuery } from "~/lib/queries";
import { cn, modelName } from "~/lib/utils";

export interface ComposerProps {
  onSend: (content: UserContent) => void;
  onStop?: () => void;
  /** Pim is working on this session. Sending still works: Pim queues it. */
  busy: boolean;
  disabled?: boolean;
  placeholder?: string;
  /** Optional context below the input, such as whose agent this chat visits. */
  disclaimer?: ReactNode;
  autoFocus?: boolean;
  promptSuggestions?: string[];
  /** Editable text to start a new message with; nothing is sent automatically. */
  initialInput?: string;
  /** Keeps unsent text under this key, such as the chat's id, while other chats are open. */
  draftKey?: string;
  /** The agents in the chat, which an @ offers to mention. */
  mentions?: readonly Agent[];
}

/** The mention being typed just before the caret: an @ at the start of a word, and what follows it. */
const MENTION = /(?:^|\s)@([^\s@]{0,40})$/;

/** Unsent text by draft key, for this page's lifetime. */
const drafts = new Map<string, string>();

/** Image types Pim takes, as the server checks them. */
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
const MAX_IMAGES = 4;
/** What a picked file may be before it's shrunk. */
const MAX_PICKED_BYTES = 20_000_000;
/**
 * Longest side, and size, an image is sent at. Models see no more detail in
 * a larger one, and every model request in the chat carries it again.
 */
const MAX_EDGE = 1568;
const MAX_SENT_BYTES = 1_000_000;

/**
 * Composer for text and images. `~/components/ui/prompt-input` handles
 * IME-safe Enter-to-send, auto-resize, paste and drop. Images go only to a
 * model that can see them. While Pim is busy, the button is Stop when the box
 * is empty and Send (a queued follow-up) when there is something to send.
 */
export function Composer(props: ComposerProps) {
  return (
    <PromptInputProvider
      initialInput={
        (props.draftKey ? drafts.get(props.draftKey) : undefined) ??
        props.initialInput
      }
    >
      <ComposerInner {...props} />
    </PromptInputProvider>
  );
}

function ComposerInner({
  onSend,
  onStop,
  busy,
  disabled,
  placeholder,
  disclaimer,
  autoFocus,
  promptSuggestions = [],
  draftKey,
  mentions,
}: ComposerProps) {
  const { t } = useI18n();
  const controller = usePromptInputController();
  const text = controller.textInput.value;
  // The reference stays in the message sent to Pim, but reads as a titled chip.
  const reference =
    /^\/artifacts\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\?v=\d+)?(?:\n\n|$)/i.exec(
      text,
    );
  const { data: artifact } = useQuery({
    ...artifactQuery(reference?.[1]?.toLowerCase() ?? ""),
    enabled: Boolean(reference),
  });
  // Missing or unknown references stay editable as text.
  const prefix = artifact && reference ? reference[0] : "";
  const inputText = text.slice(prefix.length);
  useEffect(() => {
    if (!draftKey) return;
    if (text) drafts.set(draftKey, text);
    else drafts.delete(draftKey);
  }, [draftKey, text]);
  const { data: model } = useQuery(modelQuery());
  const seesImages = model?.model.images ?? false;
  const inputId = useId();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const touchInput = window.matchMedia("(pointer: coarse)").matches;
  useEffect(() => {
    if (!autoFocus || touchInput) return;
    const input = textareaRef.current;
    if (input) input.setSelectionRange(input.value.length, input.value.length);
  }, [autoFocus, touchInput]);
  // Typing @ offers the agents to mention, by the start of their name.
  const [caret, setCaret] = useState(0);
  const [highlighted, setHighlighted] = useState(0);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const typed = inputText.slice(0, caret);
  const mention = MENTION.exec(typed);
  const query = mention?.[1]?.toLowerCase();
  const choices =
    query === undefined || !mentions || dismissed === typed
      ? []
      : mentions
          .filter((agent) => agent.name.toLowerCase().startsWith(query))
          .slice(0, 6);
  const mentionId = useId();
  const pickMention = (agent: Agent) => {
    if (query === undefined) return;
    const start = caret - query.length - 1;
    const next = `${inputText.slice(0, start)}@${agent.name} ${inputText.slice(caret)}`;
    controller.textInput.setInput(
      (prefix ? `${prefix.trimEnd()}\n\n` : "") + next,
    );
    const position = start + agent.name.length + 2;
    setCaret(position);
    setHighlighted(0);
    queueMicrotask(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(position, position);
    });
  };
  const [preparing, setPreparing] = useState(false);
  const files = controller.attachments.files;
  const hasText = text.trim().length > 0;
  const hasContent = hasText || files.length > 0;
  // The utility model rewrites the draft in place.
  const improve = useMutation({
    mutationFn: (draft: string) => pim.improvePrompt(draft),
    onSuccess: (improved) => {
      controller.textInput.setInput(improved);
      queueMicrotask(() => textareaRef.current?.focus());
    },
    onError: (error) => toast.error(error.message),
  });
  const canImprove = !disabled && hasText && !improve.isPending;
  const canSend = !disabled && !preparing && !improve.isPending && hasContent;
  const showStop = busy && !hasContent && Boolean(onStop);

  const cantSeeImages = () =>
    toast.info(t("modelCantSeeImages", { model: model?.model.name ?? "" }));

  const send = (content: UserContent) => {
    // Dismiss the phone's keyboard, including when sending opens a new chat.
    if (touchInput) textareaRef.current?.blur();
    onSend(content);
    if (!touchInput) queueMicrotask(() => textareaRef.current?.focus());
  };

  const handleSubmit = async (message: PromptInputMessage) => {
    // Throwing tells PromptInput not to clear the text, so Enter on a
    // disabled composer doesn't wipe what the user typed.
    if (!canSend) throw new Error("Composer is not ready to send.");
    const typed = message.text.trim();
    let content: UserContent = typed;
    if (message.files.length > 0) {
      setPreparing(true);
      try {
        const images = await Promise.all(
          message.files.map((file) => imageContent(file.url)),
        );
        content = [
          ...(typed ? [{ type: "text" as const, text: typed }] : []),
          ...images,
        ];
      } catch (error) {
        toast.error(t("couldNotReadImage"));
        throw error;
      } finally {
        setPreparing(false);
      }
    }
    send(content);
  };

  const showSuggestions = promptSuggestions.length > 0 && !hasContent && !busy;

  return (
    <div className="relative w-full">
      {showSuggestions && (
        // They float over what's above the composer, which scrolls on beneath them, so they take none of its room.
        // Radix positions the scroll area itself, so a wrapper places it.
        <div className="pointer-events-none absolute inset-x-0 bottom-full z-10 animate-in fade-in duration-700">
          <Suggestions>
            {promptSuggestions.map((suggestion) => (
              <Suggestion
                key={suggestion}
                suggestion={suggestion}
                disabled={disabled}
                onClick={send}
                variant="outline"
                className="pointer-events-auto shadow-[0_4px_14px_-4px_rgb(0_0_0/0.2)]"
              />
            ))}
          </Suggestions>
        </div>
      )}

      {choices.length > 0 && (
        <div
          id={mentionId}
          role="listbox"
          aria-label={t("mentionAgent")}
          className="absolute bottom-full left-0 z-20 mb-2 w-64 animate-in rounded-xl border bg-popover p-1 text-popover-foreground shadow-[0_8px_30px_-6px_rgb(0_0_0/0.18)] duration-150 fade-in"
        >
          {choices.map((agent, index) => (
            <button
              key={agent.id}
              type="button"
              role="option"
              aria-selected={index === highlighted % choices.length}
              // Keeps the caret in the text, where the name goes.
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => setHighlighted(index)}
              onClick={() => pickMention(agent)}
              className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm aria-selected:bg-muted"
            >
              <AgentIcon
                agent={agent}
                tile
                className="size-5 shrink-0 rounded-md"
              />
              <span className="truncate">{agent.name}</span>
            </button>
          ))}
        </div>
      )}

      <PromptInput
        onSubmit={handleSubmit}
        // The whole field is the input: a click on its empty space, such as
        // the controls row, focuses the text.
        onClick={(event) => {
          if (!(event.target as Element).closest("button, a, textarea"))
            textareaRef.current?.focus();
        }}
        accept={IMAGE_TYPES.join(",")}
        multiple
        maxFiles={seesImages ? MAX_IMAGES : 0}
        maxFileSize={MAX_PICKED_BYTES}
        onError={({ code }) => {
          if (code === "accept") toast.error(t("imagesOnly"));
          else if (code === "max_file_size") toast.error(t("imageTooLarge"));
          else if (seesImages)
            toast.error(t("tooManyImages", { count: MAX_IMAGES }));
          else cantSeeImages();
        }}
        className={cn(
          "relative rounded-2xl border bg-background transition-colors",
          "focus-within:border-ring/60",
        )}
      >
        {prefix && artifact && (
          <div className="px-4 pt-3">
            <span className="inline-flex max-w-full items-center gap-2 rounded-full bg-muted py-1 pr-1 pl-3 text-sm">
              <ArtifactIcon
                kind={artifact.kind}
                className="size-4 shrink-0 text-muted-foreground"
              />
              <span className="truncate">{artifact.title}</span>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="size-6 shrink-0 rounded-full text-muted-foreground"
                aria-label={t("removeArtifact", { name: artifact.title })}
                disabled={disabled || improve.isPending}
                onClick={() => {
                  controller.textInput.setInput(inputText);
                  textareaRef.current?.focus();
                }}
              >
                <X className="size-3" />
              </Button>
            </span>
          </div>
        )}
        {files.length > 0 && (
          <ul className="flex flex-wrap gap-2 px-4 pt-3">
            {files.map((file) => (
              <li key={file.id} className="group/image relative">
                <img
                  src={file.url}
                  alt={file.filename}
                  className="size-16 rounded-xl border object-cover"
                />
                <Button
                  type="button"
                  size="icon"
                  variant="secondary"
                  aria-label={t("removeImage", { name: file.filename })}
                  onClick={() => controller.attachments.remove(file.id)}
                  className="-top-1.5 -right-1.5 absolute size-5 rounded-full border shadow-sm"
                >
                  <X className="size-3" />
                </Button>
              </li>
            ))}
          </ul>
        )}
        {/* The text takes the full width, with its padding outside the scrolling
            box so scrolled lines stop short of the border; the controls sit in a
            row below it, which has room for more of them. */}
        <div className="px-4 pt-3.5 pb-1">
          <PromptInputTextarea
            ref={textareaRef}
            id={inputId}
            value={inputText}
            onChange={(event) => {
              setCaret(event.currentTarget.selectionStart);
              setHighlighted(0);
              controller.textInput.setInput(
                (prefix ? `${prefix.trimEnd()}\n\n` : "") +
                  event.currentTarget.value,
              );
            }}
            onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
            aria-controls={choices.length > 0 ? mentionId : undefined}
            onKeyDown={(event) => {
              if (choices.length > 0) {
                const step =
                  event.key === "ArrowDown"
                    ? 1
                    : event.key === "ArrowUp"
                      ? -1
                      : 0;
                if (step !== 0) {
                  event.preventDefault();
                  setHighlighted(
                    (highlighted + step + choices.length) % choices.length,
                  );
                  return;
                }
                if (event.key === "Enter" || event.key === "Tab") {
                  event.preventDefault();
                  pickMention(choices[highlighted % choices.length] as Agent);
                  return;
                }
                if (event.key === "Escape") {
                  event.preventDefault();
                  setDismissed(typed);
                  return;
                }
              }
              if (prefix && !inputText && event.key === "Backspace") {
                event.preventDefault();
                controller.textInput.setInput("");
              }
            }}
            placeholder={placeholder ?? t("messagePim")}
            disabled={disabled || improve.isPending}
            autoFocus={autoFocus && !touchInput}
          />
        </div>
        <div className="flex items-center gap-1.5 p-2.5 pt-1">
          <Button
            type="button"
            size="icon"
            variant="ghost"
            aria-label={t("attachImages")}
            title={t("attachImages")}
            disabled={disabled}
            onClick={() =>
              seesImages
                ? controller.attachments.openFileDialog()
                : cantSeeImages()
            }
            className="size-9 shrink-0 rounded-full bg-muted text-muted-foreground"
          >
            <Plus className="size-4.5" />
          </Button>
          <div className="ml-auto flex items-center gap-1.5">
            {(hasText || improve.isPending) && (
              <Button
                type="button"
                size="icon"
                variant="ghost"
                aria-label={t("improvePrompt")}
                title={t("improvePrompt")}
                disabled={!canImprove}
                onClick={() => improve.mutate(text.trim())}
                className="size-9 shrink-0 rounded-full text-muted-foreground"
              >
                {improve.isPending ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Sparkles className="size-4" />
                )}
              </Button>
            )}
            {model && <ModelPicker settings={model} />}

            <PromptInputSubmit
              status={
                showStop ? "streaming" : preparing ? "submitted" : "ready"
              }
              onStop={onStop}
              disabled={!showStop && !canSend}
            >
              {showStop ? (
                <Square className="size-4 fill-current" />
              ) : preparing ? undefined : (
                <ArrowUp className="size-5" />
              )}
            </PromptInputSubmit>
          </div>
        </div>
      </PromptInput>

      {disclaimer != null && (
        <p className="flex items-center justify-center gap-1.5 px-2 pt-2 pb-1 text-center text-muted-foreground text-xs">
          {disclaimer}
        </p>
      )}
    </div>
  );
}

/**
 * The model, as its logo beside Send, with its name on hover. Pim has one
 * model for every chat, so choosing here does what Settings → Model does; the
 * menu says so, and links there for more models.
 */
function ModelPicker({ settings }: { settings: ModelSettings }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const choose = useMutation({
    mutationFn: pim.chooseModel,
    onSuccess: ({ model }) => {
      queryClient.setQueryData<ModelSettings>(["model"], (old) =>
        old ? { ...old, model } : old,
      );
      queryClient.invalidateQueries({ queryKey: ["model"] });
    },
    onError: (error) => toast.error(error.message),
  });
  const current = settings.model;
  // A provider someone added, if the model runs on one.
  const providerOf = (choice: ModelInfo) =>
    settings.providers.find(
      (provider) => provider.provider === choice.provider,
    );
  const logo = (choice: ModelInfo, className: string) => (
    <ModelLogo
      model={choice}
      custom={Boolean(providerOf(choice))}
      className={className}
    />
  );
  return (
    <DropdownMenu>
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                aria-label={t("chooseModel", { model: current.name })}
                disabled={choose.isPending}
                className="size-9 shrink-0 rounded-full text-muted-foreground"
              >
                {choose.isPending ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  logo(current, "size-4.5")
                )}
              </Button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={6} showArrow={false}>
            {current.name}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <DropdownMenuContent
        align="end"
        side="top"
        className="w-72 max-w-[calc(100vw-2rem)]"
      >
        <DropdownMenuLabel className="font-normal text-muted-foreground text-xs">
          {t("modelForEveryChat")}
        </DropdownMenuLabel>
        {settings.choices.map((choice) => {
          const selected =
            choice.provider === current.provider && choice.id === current.id;
          return (
            <DropdownMenuItem
              key={`${choice.provider}/${choice.id}`}
              onSelect={() => {
                if (!selected) choose.mutate(choice);
              }}
              className="min-h-11 gap-3"
            >
              {logo(choice, "size-5 text-foreground")}
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
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * A picked image as Pim takes it: as it is when it's small enough, else
 * shrunk to fit and sent as a JPEG.
 */
async function imageContent(
  url: string,
): Promise<{ type: "image"; data: string; mimeType: string }> {
  const blob = await (await fetch(url)).blob();
  const bitmap = await createImageBitmap(blob);
  try {
    let scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    let sent = blob;
    if (
      scale < 1 ||
      blob.size > MAX_SENT_BYTES ||
      !IMAGE_TYPES.includes(blob.type)
    ) {
      do {
        sent = await jpeg(bitmap, scale);
        scale *= 0.75;
      } while (sent.size > MAX_SENT_BYTES && scale > 0.05);
    }
    return { type: "image", data: await base64(sent), mimeType: sent.type };
  } finally {
    bitmap.close();
  }
}

function jpeg(bitmap: ImageBitmap, scale: number): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const context = canvas.getContext("2d");
  if (!context) return Promise.reject(new Error("No canvas"));
  // JPEG has no transparency: what was clear becomes white, not black.
  context.fillStyle = "#fff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (out) => (out ? resolve(out) : reject(new Error("Could not encode"))),
      "image/jpeg",
      0.85,
    ),
  );
}

function base64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}
