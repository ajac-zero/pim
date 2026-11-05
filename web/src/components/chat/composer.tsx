import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Dialog } from "radix-ui";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { toast } from "sonner";
import { AgentIcon } from "~/components/agent-icon";
import { Suggestion, Suggestions } from "~/components/ai-elements/suggestion";
import { AppIcon } from "~/components/app-icon";
import { ArtifactIcon } from "~/components/artifact-icon";
import {
  ModelMark,
  ModelMenuItems,
  useAgentModel,
} from "~/components/chat/model-menu";
import { useI18n } from "~/components/i18n";
import {
  ArrowUp,
  Camera,
  Loader2,
  Mic,
  Paperclip,
  Plus,
  Sparkles,
  Square,
  X,
} from "~/components/icons";
import { Button } from "~/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import {
  PromptInput,
  type PromptInputMessage,
  PromptInputProvider,
  PromptInputSubmit,
  PromptInputTextarea,
  usePromptInputAttachments,
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
  type DirectoryApp,
  type ModelInfo,
  type ModelSettings,
  pim,
  type UserContent,
} from "~/lib/pim-api";
import {
  agentsQuery,
  appDirectoryQuery,
  appsQuery,
  artifactQuery,
  extensionsQuery,
} from "~/lib/queries";
import { cn } from "~/lib/utils";

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
  /** Beside the attach buttons, such as whom a new chat is with. */
  controls?: ReactNode;
  /**
   * The agent the chat is with, whose model the picker chooses and whose apps
   * an @ offers; none shows no picker, as in a group chat, which has it in
   * the header.
   */
  agent?: Pick<Agent, "id" | "name">;
  /** The agents in the chat, which an @ offers to mention. */
  mentions?: readonly Agent[];
}

/** The mention being typed just before the caret: an @ at the start of a word, and what follows it. */
const MENTION = /(?:^|\s)@([^\s@]{0,40})$/;

/** What an @ offers: an agent in the chat, or an app, with whether the chat's agent works with it already. */
type MentionChoice =
  | { kind: "agent"; agent: Agent }
  | { kind: "app"; app: DirectoryApp; listed: boolean };

/** An app picked from an @, and the text its mention replaces. */
type AppMention = { app: DirectoryApp; start: number; end: number };

/** How many choices an @ shows at once. */
const MAX_MENTION_CHOICES = 6;

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

/** The part of the browser's speech recognizer that dictation uses. */
interface Recognizer {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult:
    | ((event: {
        results: ArrayLike<ArrayLike<{ transcript: string }>>;
      }) => void)
    | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

/** The browser's speech recognizer, where it has one (Chrome, Edge, Safari). */
function speechRecognizer(): (new () => Recognizer) | undefined {
  const w = window as unknown as {
    SpeechRecognition?: new () => Recognizer;
    webkitSpeechRecognition?: new () => Recognizer;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition;
}

/**
 * Dictation into the draft: while listening, what is heard is appended to the
 * text the draft held when listening began.
 */
function useVoiceInput(text: string, setText: (text: string) => void) {
  const { locale, t } = useI18n();
  const [listening, setListening] = useState(false);
  const recognition = useRef<Recognizer | null>(null);
  useEffect(() => () => recognition.current?.abort(), []);
  const toggle = () => {
    const Recognition = speechRecognizer();
    if (!Recognition) return;
    if (recognition.current) {
      recognition.current.stop();
      return;
    }
    const next = new Recognition();
    const before = text.trim() ? `${text.trimEnd()} ` : "";
    next.lang = locale;
    next.continuous = true;
    next.interimResults = true;
    next.onresult = (event) => {
      let heard = "";
      for (const result of Array.from(event.results))
        heard += result[0]?.transcript ?? "";
      setText(before + heard.trimStart());
    };
    next.onerror = (event) => {
      if (event.error !== "no-speech" && event.error !== "aborted")
        toast.error(t("voiceInputFailed"));
    };
    next.onend = () => {
      recognition.current = null;
      setListening(false);
    };
    recognition.current = next;
    setListening(true);
    next.start();
  };
  return { supported: Boolean(speechRecognizer()), listening, toggle };
}

/**
 * Takes a photo with the device's camera and attaches it. On a phone the
 * input opens the camera app; a computer opens its file picker instead. It
 * sits inside `PromptInput` so the photo goes through the same limits as a
 * picked file.
 */
function CameraButton({
  disabled,
  seesImages,
  onBlocked,
}: {
  disabled?: boolean;
  seesImages: boolean;
  onBlocked: () => void;
}) {
  const { t } = useI18n();
  const attachments = usePromptInputAttachments();
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        tabIndex={-1}
        aria-hidden
        onChange={(event) => {
          if (event.currentTarget.files)
            attachments.add(event.currentTarget.files);
          event.currentTarget.value = "";
        }}
      />
      <Button
        type="button"
        size="icon"
        variant="ghost"
        aria-label={t("takePhoto")}
        title={t("takePhoto")}
        disabled={disabled}
        onClick={() => (seesImages ? inputRef.current?.click() : onBlocked())}
        className="size-9 shrink-0 rounded-full bg-muted text-muted-foreground"
      >
        <Camera className="size-4.5" />
      </Button>
    </>
  );
}

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
  agent,
  controls,
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
  const { settings, current, pinned, choose } = useAgentModel(agent?.id);
  const model = current;
  const seesImages = model?.images ?? false;
  const inputId = useId();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const touchInput = window.matchMedia("(pointer: coarse)").matches;
  useEffect(() => {
    if (!autoFocus || touchInput) return;
    const input = textareaRef.current;
    if (input) input.setSelectionRange(input.value.length, input.value.length);
  }, [autoFocus, touchInput]);
  // Typing @ offers the agents to mention, by the start of their name, and
  // apps, by the start of a word of theirs: the ones the chat's agent works
  // with first, then those you connected, then the rest of the directory.
  const [caret, setCaret] = useState(0);
  const [highlighted, setHighlighted] = useState(0);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const typed = inputText.slice(0, caret);
  const mention = MENTION.exec(typed);
  const query = mention?.[1]?.toLowerCase();
  const { data: agents } = useQuery({
    ...agentsQuery(),
    enabled: Boolean(agent),
  });
  const self = agents?.find((candidate) => candidate.id === agent?.id);
  const { data: extensions } = useQuery({
    ...extensionsQuery(),
    enabled: Boolean(self),
  });
  const { data: directory = [] } = useQuery({
    ...appDirectoryQuery(),
    enabled: Boolean(self),
  });
  const { data: connected = [] } = useQuery({
    ...appsQuery(),
    enabled: Boolean(self),
  });
  const listed = new Set([
    ...(extensions?.extensions
      .flatMap((extension) => extension.blueprints)
      .find((candidate) => candidate.ref === self?.blueprint)?.apps ?? []),
    ...(self?.apps ?? []),
  ]);
  const rank = (app: DirectoryApp) =>
    listed.has(app.ref)
      ? 0
      : connected.some((server) => server.app === app.ref)
        ? 1
        : 2;
  const choices: MentionChoice[] =
    query === undefined || dismissed === typed
      ? []
      : [
          ...(mentions ?? [])
            .filter((agent) => agent.name.toLowerCase().startsWith(query))
            .map((agent) => ({ kind: "agent" as const, agent })),
          ...(self ? directory : [])
            .filter((app) =>
              app.name
                .toLowerCase()
                .split(/\s+/)
                .some((word) => word.startsWith(query)),
            )
            .sort((a, b) => rank(a) - rank(b))
            .map((app) => ({
              kind: "app" as const,
              app,
              listed: listed.has(app.ref),
            })),
        ].slice(0, MAX_MENTION_CHOICES);
  const mentionId = useId();
  /** Puts `@name` in place of the text between `start` and `end`. */
  const insertMention = (name: string, start: number, end: number) => {
    const next = `${inputText.slice(0, start)}@${name} ${inputText.slice(end)}`;
    controller.textInput.setInput(
      (prefix ? `${prefix.trimEnd()}\n\n` : "") + next,
    );
    const position = start + name.length + 2;
    setCaret(position);
    setHighlighted(0);
    queueMicrotask(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(position, position);
    });
  };
  // An app the agent doesn't work with yet is added to it, and connected,
  // once you say so; then it's mentioned.
  const [adding, setAdding] = useState<AppMention | null>(null);
  const addButtonRef = useRef<HTMLButtonElement>(null);
  const queryClient = useQueryClient();
  const addApp = useMutation({
    mutationFn: async ({ app }: AppMention) => {
      if (!self) return null;
      await pim.updateAgent(self.id, { apps: [...self.apps, app.ref] });
      const server = connected.find((candidate) => candidate.app === app.ref);
      if (server?.state === "ready") return null;
      return (await pim.connectApp(app.ref)).authUrl ?? null;
    },
    onSuccess: (authUrl, { app, start, end }) => {
      queryClient.invalidateQueries({ queryKey: ["agents"] });
      queryClient.invalidateQueries({ queryKey: ["apps"] });
      queryClient.invalidateQueries({ queryKey: ["permissions"] });
      if (authUrl) window.open(authUrl, "_blank", "noopener");
      setAdding(null);
      insertMention(app.name, start, end);
    },
    onError: (error) => toast.error(error.message),
  });
  const pickMention = (choice: MentionChoice) => {
    if (query === undefined) return;
    const start = caret - query.length - 1;
    if (choice.kind === "app" && !choice.listed) {
      setAdding({ app: choice.app, start, end: caret });
      return;
    }
    insertMention(
      choice.kind === "agent" ? choice.agent.name : choice.app.name,
      start,
      caret,
    );
  };
  const [preparing, setPreparing] = useState(false);
  const voice = useVoiceInput(text, controller.textInput.setInput);
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
    toast.info(t("modelCantSeeImages", { model: model?.name ?? "" }));

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
      {choices.length > 0 && (
        <div
          id={mentionId}
          role="listbox"
          aria-label={t(self ? "mentionAgentOrApp" : "mentionAgent")}
          className="absolute bottom-full left-0 z-20 mb-2 w-64 animate-in rounded-xl border bg-popover p-1 text-popover-foreground shadow-[0_8px_30px_-6px_rgb(0_0_0/0.18)] duration-150 fade-in"
        >
          {choices.map((choice, index) => (
            <button
              key={choice.kind === "agent" ? choice.agent.id : choice.app.ref}
              type="button"
              role="option"
              aria-selected={index === highlighted % choices.length}
              // Keeps the caret in the text, where the name goes.
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => setHighlighted(index)}
              onClick={() => pickMention(choice)}
              className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm aria-selected:bg-muted"
            >
              {choice.kind === "agent" ? (
                <AgentIcon
                  agent={choice.agent}
                  tile
                  className="size-5 shrink-0 rounded-md"
                />
              ) : (
                <AppIcon
                  name={choice.app.name}
                  icon={choice.app.icon}
                  className="size-5 text-[11px]"
                />
              )}
              <span className="min-w-0 flex-1 truncate">
                {choice.kind === "agent" ? choice.agent.name : choice.app.name}
              </span>
              {choice.kind === "app" && !choice.listed && (
                <span className="flex shrink-0 items-center gap-0.5 text-muted-foreground text-xs">
                  <Plus className="size-3" />
                  {t("mentionAdd")}
                </span>
              )}
            </button>
          ))}
        </div>
      )}

      {self && (
        <Dialog.Root
          open={adding !== null}
          onOpenChange={(open) => {
            if (!open && !addApp.isPending) setAdding(null);
          }}
        >
          <Dialog.Portal>
            <Dialog.Overlay className="fixed inset-0 z-50 bg-black/30 data-[state=open]:animate-in data-[state=open]:fade-in-0" />
            <Dialog.Content
              // You picked the app to add it, so Enter adds it.
              onOpenAutoFocus={(event) => {
                event.preventDefault();
                addButtonRef.current?.focus();
              }}
              // Back to the text, where the mention was being typed.
              onCloseAutoFocus={(event) => {
                event.preventDefault();
                textareaRef.current?.focus();
              }}
              className="fixed top-1/2 left-1/2 z-50 w-[calc(100%-2rem)] max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-[18px] border bg-background p-6 shadow-xl data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95"
            >
              {adding && (
                <>
                  <AppIcon
                    name={adding.app.name}
                    icon={adding.app.icon}
                    className="size-10 text-base"
                  />
                  <Dialog.Title className="mt-4 font-semibold text-xl">
                    {t("letAgentUseApp", {
                      agent: self.name,
                      app: adding.app.name,
                    })}
                  </Dialog.Title>
                  <Dialog.Description className="mt-2 text-muted-foreground text-sm">
                    {t(
                      connected.some(
                        (server) =>
                          server.app === adding.app.ref &&
                          server.state === "ready",
                      )
                        ? "letAgentUseAppHint"
                        : "letAgentUseAppSignIn",
                      { agent: self.name, app: adding.app.name },
                    )}
                  </Dialog.Description>
                  <div className="mt-6 flex justify-end gap-2">
                    <Dialog.Close asChild>
                      <Button variant="secondary" disabled={addApp.isPending}>
                        {t("cancel")}
                      </Button>
                    </Dialog.Close>
                    <Button
                      ref={addButtonRef}
                      onClick={() => addApp.mutate(adding)}
                      disabled={addApp.isPending}
                    >
                      {addApp.isPending && (
                        <Loader2 className="size-4 animate-spin" />
                      )}
                      {t("addAppTo", { agent: self.name })}
                    </Button>
                  </div>
                </>
              )}
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>
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
                  pickMention(
                    choices[highlighted % choices.length] as MentionChoice,
                  );
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
            <Paperclip className="size-4.5" />
          </Button>
          <CameraButton
            disabled={disabled}
            onBlocked={cantSeeImages}
            seesImages={seesImages}
          />
          {controls}
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
            {settings && current && agent && (
              <ModelPicker
                settings={settings}
                current={current}
                pinned={pinned}
                choose={choose}
                agent={agent}
              />
            )}
            {voice.supported && !hasContent && !showStop && !preparing ? (
              <Button
                type="button"
                size="icon"
                aria-label={t(
                  voice.listening ? "stopVoiceInput" : "voiceInput",
                )}
                title={t(voice.listening ? "stopVoiceInput" : "voiceInput")}
                disabled={disabled}
                onClick={voice.toggle}
                className={cn(
                  "size-9 shrink-0 rounded-full",
                  voice.listening && "animate-pulse",
                )}
              >
                {voice.listening ? (
                  <Square className="size-4 fill-current" />
                ) : (
                  <Mic className="size-4.5" />
                )}
              </Button>
            ) : (
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
            )}
          </div>
        </div>
      </PromptInput>

      {showSuggestions && (
        // Radix positions the scroll area itself, so a wrapper fades it in.
        <div className="animate-in fade-in duration-700">
          <Suggestions>
            {promptSuggestions.map((suggestion) => (
              <Suggestion
                key={suggestion}
                suggestion={suggestion}
                disabled={disabled}
                onClick={send}
                variant="outline"
              />
            ))}
          </Suggestions>
        </div>
      )}

      {disclaimer != null && (
        <p className="flex items-center justify-center gap-1.5 px-2 pt-2 pb-1 text-center text-muted-foreground text-xs">
          {disclaimer}
        </p>
      )}
    </div>
  );
}

/**
 * The agent's model, as its logo beside Send, with its name on hover. Choosing
 * here sets the model of this agent alone; "Default" has it follow Settings →
 * Model again, which the menu links to for more models.
 */
function ModelPicker({
  settings,
  current,
  pinned,
  choose,
  agent,
}: {
  settings: ModelSettings;
  /** The model the agent runs on now. */
  current: ModelInfo;
  /** Whether it was chosen for this agent, rather than followed from the default. */
  pinned: boolean;
  choose: ReturnType<typeof useAgentModel>["choose"];
  agent: Pick<Agent, "id" | "name">;
}) {
  const { t } = useI18n();
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
                  <ModelMark
                    settings={settings}
                    model={current}
                    className="size-4.5"
                  />
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
          {t("modelForAgent", { name: agent.name })}
        </DropdownMenuLabel>
        <ModelMenuItems
          settings={settings}
          current={current}
          pinned={pinned}
          choose={choose.mutate}
        />
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
