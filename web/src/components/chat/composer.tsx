import { useMutation, useQuery } from "@tanstack/react-query";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { toast } from "sonner";
import { Suggestion, Suggestions } from "~/components/ai-elements/suggestion";
import { useI18n } from "~/components/i18n";
import {
  ArrowUp,
  Loader2,
  Plus,
  Sparkles,
  Square,
  X,
} from "~/components/icons";
import { Button } from "~/components/ui/button";
import {
  PromptInput,
  type PromptInputMessage,
  PromptInputProvider,
  PromptInputSubmit,
  PromptInputTextarea,
  usePromptInputController,
} from "~/components/ui/prompt-input";
import { pim, type UserContent } from "~/lib/pim-api";
import { modelQuery } from "~/lib/queries";
import { cn } from "~/lib/utils";

export interface ComposerProps {
  onSend: (content: UserContent) => void;
  onStop?: () => void;
  /** Pim is working on this session. Sending still works: Pim queues it. */
  busy: boolean;
  disabled?: boolean;
  placeholder?: string;
  /** Below the input; null hides it. */
  disclaimer?: ReactNode;
  autoFocus?: boolean;
  promptSuggestions?: string[];
  /** Keeps unsent text under this key, such as the chat's id, while other chats are open. */
  draftKey?: string;
}

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
      initialInput={props.draftKey ? drafts.get(props.draftKey) : undefined}
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
}: ComposerProps) {
  const { t } = useI18n();
  const controller = usePromptInputController();
  const text = controller.textInput.value;
  useEffect(() => {
    if (!draftKey) return;
    if (text) drafts.set(draftKey, text);
    else drafts.delete(draftKey);
  }, [draftKey, text]);
  const { data: model } = useQuery(modelQuery());
  const seesImages = model?.model.images ?? false;
  const inputId = useId();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
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
    onSend(content);
    queueMicrotask(() => textareaRef.current?.focus());
  };

  const showSuggestions = promptSuggestions.length > 0 && !hasContent && !busy;

  return (
    <div className="w-full">
      <PromptInput
        onSubmit={handleSubmit}
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
        {files.length > 0 && (
          <ul className="flex flex-wrap gap-2 px-3 pt-3">
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
        <div className="flex items-end gap-1.5 p-2.5 pl-2.5">
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
          <PromptInputTextarea
            ref={textareaRef}
            id={inputId}
            placeholder={placeholder ?? t("messagePim")}
            disabled={disabled || improve.isPending}
            autoFocus={autoFocus}
            className="self-center"
          />

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

          <PromptInputSubmit
            status={showStop ? "streaming" : preparing ? "submitted" : "ready"}
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
      </PromptInput>

      {showSuggestions && (
        <Suggestions className="mt-3 px-1">
          {promptSuggestions.map((suggestion) => (
            <Suggestion
              key={suggestion}
              suggestion={suggestion}
              disabled={disabled}
              onClick={(value) => onSend(value)}
            />
          ))}
        </Suggestions>
      )}

      {disclaimer !== null && (
        <p className="flex items-center justify-center gap-1.5 px-2 pt-2 pb-1 text-center text-muted-foreground text-xs">
          {disclaimer ?? t("pimCanMakeMistakes")}
        </p>
      )}
    </div>
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
