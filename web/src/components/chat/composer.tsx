import { ArrowUp, Square } from "lucide-react";
import { type ReactNode, useId, useRef } from "react";
import { Suggestion, Suggestions } from "~/components/ai-elements/suggestion";
import { useI18n } from "~/components/i18n";
import {
  PromptInput,
  type PromptInputMessage,
  PromptInputProvider,
  PromptInputSubmit,
  PromptInputTextarea,
  usePromptInputController,
} from "~/components/ui/prompt-input";
import { cn } from "~/lib/utils";

export interface ComposerProps {
  onSend: (text: string) => void;
  onStop?: () => void;
  /** Pim is working on this session. Sending still works: Pim queues it. */
  busy: boolean;
  disabled?: boolean;
  placeholder?: string;
  /** Below the input; null hides it. */
  disclaimer?: ReactNode;
  autoFocus?: boolean;
  promptSuggestions?: string[];
}

/**
 * Text-only composer. `~/components/ui/prompt-input` handles IME-safe
 * Enter-to-send and auto-resize. While Pim is busy, the button is Stop when
 * the box is empty and Send (a queued follow-up) when there is text.
 */
export function Composer(props: ComposerProps) {
  return (
    <PromptInputProvider>
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
}: ComposerProps) {
  const { t } = useI18n();
  const controller = usePromptInputController();
  const inputId = useId();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const text = controller.textInput.value;
  const hasText = text.trim().length > 0;
  const canSend = !disabled && hasText;
  const showStop = busy && !hasText && Boolean(onStop);

  const handleSubmit = (message: PromptInputMessage) => {
    // Throwing tells PromptInput not to clear the text, so Enter on a
    // disabled composer doesn't wipe what the user typed.
    if (!canSend) throw new Error("Composer is not ready to send.");
    onSend(message.text.trim());
    queueMicrotask(() => textareaRef.current?.focus());
  };

  const showSuggestions = promptSuggestions.length > 0 && !text && !busy;

  return (
    <div className="w-full">
      {showSuggestions && (
        <Suggestions className="mb-3 px-1">
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
      <PromptInput
        onSubmit={handleSubmit}
        className={cn(
          "relative rounded-[26px] border bg-card shadow-xs transition-shadow",
          "focus-within:border-ring/60 focus-within:shadow-sm",
        )}
      >
        <div className="flex items-end gap-1.5 p-2.5 pl-4">
          <PromptInputTextarea
            ref={textareaRef}
            id={inputId}
            placeholder={placeholder ?? t("messagePim")}
            disabled={disabled}
            autoFocus={autoFocus}
            className="self-center"
          />

          <PromptInputSubmit
            status={showStop ? "streaming" : "ready"}
            onStop={onStop}
            disabled={!showStop && !canSend}
          >
            {showStop ? (
              <Square className="size-4 fill-current" />
            ) : (
              <ArrowUp className="size-5" />
            )}
          </PromptInputSubmit>
        </div>
      </PromptInput>

      {disclaimer !== null && (
        <p className="flex items-center justify-center gap-1.5 px-2 pt-2 pb-1 text-center text-muted-foreground text-xs">
          {disclaimer ?? t("pimCanMakeMistakes")}
        </p>
      )}
    </div>
  );
}
