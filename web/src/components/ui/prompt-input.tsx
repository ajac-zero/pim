"use client";

import type {
  ChangeEvent,
  ClipboardEvent,
  ComponentProps,
  FormEvent,
  KeyboardEvent,
  MouseEvent,
  ReactNode,
  RefObject,
} from "react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { CornerDownLeft, ImagePlus, Loader2, Plus, Square, X } from "lucide-react";
import { Button } from "~/components/ui/button";
import { useI18n } from "~/components/i18n";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { cn } from "~/lib/utils";

/**
 * Adapted from Vercel's AI Elements `PromptInput`
 * (https://ai-sdk.dev/elements/components/prompt-input), trimmed to what
 * this app actually needs: no model/tool selector, action-menu dropdown,
 * screenshot capture, or referenced-sources tracking (all unused here).
 *
 * What's kept is the genuinely fiddly logic: drag-and-drop, paste-to-attach,
 * IME-composition-safe Enter-to-send, auto-resizing textarea, and file
 * validation (accept/maxFiles/maxFileSize) — plus the optional
 * `PromptInputProvider` "lifted state" pattern, which lets a parent
 * component (e.g. our own submit handler that also needs to kick off
 * uploads) read/mutate attachments without prop-drilling.
 *
 * Uses `crypto.randomUUID()` instead of the `nanoid` dependency the
 * upstream version uses, to avoid adding another package for id generation.
 */

export interface PromptInputAttachment {
  id: string;
  filename: string;
  mediaType: string;
  /** Object URL (blob:) while the file lives only in the browser. */
  url: string;
}

export interface AttachmentsContext {
  files: PromptInputAttachment[];
  add: (files: File[] | FileList) => void;
  remove: (id: string) => void;
  clear: () => void;
  openFileDialog: () => void;
  fileInputRef: RefObject<HTMLInputElement | null>;
}

export interface TextInputContext {
  value: string;
  setInput: (v: string) => void;
  clear: () => void;
}

interface PromptInputControllerProps {
  textInput: TextInputContext;
  attachments: AttachmentsContext;
  /** Lets `<PromptInput>` (which owns the real file input) tell the
   * provider how to trigger it, since the provider itself renders no DOM. */
  __registerFileInput: (
    ref: RefObject<HTMLInputElement | null>,
    open: () => void,
  ) => void;
}

const PromptInputController =
  createContext<PromptInputControllerProps | null>(null);
const ProviderAttachmentsContext =
  createContext<AttachmentsContext | null>(null);

const useOptionalPromptInputController = () =>
  useContext(PromptInputController);

/** Only usable within a `<PromptInputProvider>`. */
export const usePromptInputController = () => {
  const ctx = useContext(PromptInputController);
  if (!ctx) {
    throw new Error(
      "usePromptInputController must be used within a PromptInputProvider.",
    );
  }
  return ctx;
};

/** Only usable within a `<PromptInputProvider>`. */
export const useProviderAttachments = () => {
  const ctx = useContext(ProviderAttachmentsContext);
  if (!ctx) {
    throw new Error(
      "useProviderAttachments must be used within a PromptInputProvider.",
    );
  }
  return ctx;
};

const useOptionalProviderAttachments = () =>
  useContext(ProviderAttachmentsContext);

export type PromptInputProviderProps = {
  initialInput?: string;
  children: ReactNode;
};

/**
 * Optional provider that lifts PromptInput's text/attachment state outside
 * of the `<PromptInput>` tree, so a parent component (e.g. one that also
 * needs to run uploads as attachments are added) can read/mutate it. If you
 * don't need that, skip this — `<PromptInput>` stays fully self-managed.
 */
export const PromptInputProvider = ({
  initialInput = "",
  children,
}: PromptInputProviderProps) => {
  const [textInput, setTextInput] = useState(initialInput);
  const clearInput = useCallback(() => setTextInput(""), []);

  const [attachmentFiles, setAttachmentFiles] = useState<
    PromptInputAttachment[]
  >([]);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const openRef = useRef<() => void>(() => {});

  const add = useCallback((files: File[] | FileList) => {
    const incoming = [...files];
    if (incoming.length === 0) return;
    setAttachmentFiles((prev) => [
      ...prev,
      ...incoming.map((file) => ({
        filename: file.name,
        id: crypto.randomUUID(),
        mediaType: file.type,
        url: URL.createObjectURL(file),
      })),
    ]);
  }, []);

  const remove = useCallback((id: string) => {
    setAttachmentFiles((prev) => {
      const found = prev.find((f) => f.id === id);
      if (found?.url) URL.revokeObjectURL(found.url);
      return prev.filter((f) => f.id !== id);
    });
  }, []);

  const clear = useCallback(() => {
    setAttachmentFiles((prev) => {
      for (const f of prev) if (f.url) URL.revokeObjectURL(f.url);
      return [];
    });
  }, []);

  const attachmentsRef = useRef(attachmentFiles);
  useEffect(() => {
    attachmentsRef.current = attachmentFiles;
  }, [attachmentFiles]);
  useEffect(
    () => () => {
      for (const f of attachmentsRef.current) {
        if (f.url) URL.revokeObjectURL(f.url);
      }
    },
    [],
  );

  const openFileDialog = useCallback(() => openRef.current?.(), []);

  const attachments = useMemo<AttachmentsContext>(
    () => ({ add, clear, fileInputRef, files: attachmentFiles, openFileDialog, remove }),
    [attachmentFiles, add, remove, clear, openFileDialog],
  );

  const registerFileInput = useCallback(
    (ref: RefObject<HTMLInputElement | null>, open: () => void) => {
      fileInputRef.current = ref.current;
      openRef.current = open;
    },
    [],
  );

  const controller = useMemo<PromptInputControllerProps>(
    () => ({
      __registerFileInput: registerFileInput,
      attachments,
      textInput: { clear: clearInput, setInput: setTextInput, value: textInput },
    }),
    [textInput, clearInput, attachments, registerFileInput],
  );

  return (
    <PromptInputController.Provider value={controller}>
      <ProviderAttachmentsContext.Provider value={attachments}>
        {children}
      </ProviderAttachmentsContext.Provider>
    </PromptInputController.Provider>
  );
};

const LocalAttachmentsContext = createContext<AttachmentsContext | null>(null);

/** Access attachments from anywhere inside `<PromptInput>` (or a `<PromptInputProvider>`). */
export const usePromptInputAttachments = () => {
  const provider = useOptionalProviderAttachments();
  const local = useContext(LocalAttachmentsContext);
  const context = local ?? provider;
  if (!context) {
    throw new Error(
      "usePromptInputAttachments must be used within a PromptInput or PromptInputProvider",
    );
  }
  return context;
};

export interface PromptInputMessage {
  text: string;
  files: PromptInputAttachment[];
}

export type PromptInputProps = Omit<
  ComponentProps<"form">,
  "onSubmit" | "onError"
> & {
  accept?: string;
  multiple?: boolean;
  /** Accept file drops anywhere on the document, not just the form. */
  globalDrop?: boolean;
  maxFiles?: number;
  /** Max size per file, in bytes. */
  maxFileSize?: number;
  onError?: (err: {
    code: "max_files" | "max_file_size" | "accept";
    message: string;
  }) => void;
  onSubmit: (
    message: PromptInputMessage,
    event: FormEvent<HTMLFormElement>,
  ) => void | Promise<void>;
};

export const PromptInput = ({
  className,
  accept,
  multiple,
  globalDrop,
  maxFiles,
  maxFileSize,
  onError,
  onSubmit,
  children,
  ...props
}: PromptInputProps) => {
  const { t } = useI18n();
  const controller = useOptionalPromptInputController();
  const usingProvider = !!controller;

  const inputRef = useRef<HTMLInputElement | null>(null);
  const formRef = useRef<HTMLFormElement | null>(null);

  const [items, setItems] = useState<PromptInputAttachment[]>([]);
  const files = usingProvider ? controller.attachments.files : items;
  const filesRef = useRef(files);
  useEffect(() => {
    filesRef.current = files;
  }, [files]);

  const matchesAccept = useCallback(
    (f: File) => {
      if (!accept || accept.trim() === "") return true;
      const patterns = accept.split(",").map((s) => s.trim()).filter(Boolean);
      return patterns.some((pattern) =>
        pattern.endsWith("/*")
          ? f.type.startsWith(pattern.slice(0, -1))
          : f.type === pattern,
      );
    },
    [accept],
  );

  const validate = useCallback(
    (incoming: File[], currentCount: number) => {
      const accepted = incoming.filter(matchesAccept);
      if (incoming.length && accepted.length === 0) {
        onError?.({ code: "accept", message: "No files match the accepted types." });
        return [];
      }
      const withinSize = (f: File) => (maxFileSize ? f.size <= maxFileSize : true);
      const sized = accepted.filter(withinSize);
      if (accepted.length > 0 && sized.length === 0) {
        onError?.({ code: "max_file_size", message: "All files exceed the maximum size." });
        return [];
      }
      const capacity =
        typeof maxFiles === "number" ? Math.max(0, maxFiles - currentCount) : undefined;
      const capped = typeof capacity === "number" ? sized.slice(0, capacity) : sized;
      if (typeof capacity === "number" && sized.length > capacity) {
        onError?.({ code: "max_files", message: "Too many files. Some were not added." });
      }
      return capped;
    },
    [matchesAccept, maxFiles, maxFileSize, onError],
  );

  const addLocal = useCallback(
    (fileList: File[] | FileList) => {
      const capped = validate([...fileList], items.length);
      if (capped.length === 0) return;
      setItems((prev) => [
        ...prev,
        ...capped.map((file) => ({
          filename: file.name,
          id: crypto.randomUUID(),
          mediaType: file.type,
          url: URL.createObjectURL(file),
        })),
      ]);
    },
    [validate, items.length],
  );

  const addWithProviderValidation = useCallback(
    (fileList: File[] | FileList) => {
      const capped = validate([...fileList], files.length);
      if (capped.length > 0) controller?.attachments.add(capped);
    },
    [validate, files.length, controller],
  );

  const removeLocal = useCallback(
    (id: string) =>
      setItems((prev) => {
        const found = prev.find((f) => f.id === id);
        if (found?.url) URL.revokeObjectURL(found.url);
        return prev.filter((f) => f.id !== id);
      }),
    [],
  );

  const openFileDialogLocal = useCallback(() => inputRef.current?.click(), []);

  const add = usingProvider ? addWithProviderValidation : addLocal;
  const remove = usingProvider ? controller.attachments.remove : removeLocal;
  const openFileDialog = usingProvider
    ? controller.attachments.openFileDialog
    : openFileDialogLocal;

  // Tell the provider how to open *this* form's real file input — the
  // provider itself renders no DOM, so its own openFileDialog is a no-op
  // until a `<PromptInput>` registers one.
  useEffect(() => {
    if (usingProvider) controller.__registerFileInput(inputRef, openFileDialogLocal);
  }, [usingProvider, controller, openFileDialogLocal]);

  const clear = useCallback(() => {
    if (usingProvider) {
      controller?.attachments.clear();
    } else {
      setItems((prev) => {
        for (const f of prev) if (f.url) URL.revokeObjectURL(f.url);
        return [];
      });
    }
  }, [usingProvider, controller]);

  // Drag-and-drop, scoped to the form unless `globalDrop` is set.
  useEffect(() => {
    const target: Document | HTMLFormElement | null = globalDrop
      ? document
      : formRef.current;
    if (!target) return;
    const onDragOver = (e: DragEvent) => {
      if (e.dataTransfer?.types?.includes("Files")) e.preventDefault();
    };
    const onDrop = (e: DragEvent) => {
      if (e.dataTransfer?.types?.includes("Files")) e.preventDefault();
      if (e.dataTransfer?.files?.length) add(e.dataTransfer.files);
    };
    target.addEventListener("dragover", onDragOver as EventListener);
    target.addEventListener("drop", onDrop as EventListener);
    return () => {
      target.removeEventListener("dragover", onDragOver as EventListener);
      target.removeEventListener("drop", onDrop as EventListener);
    };
  }, [add, globalDrop]);

  useEffect(
    () => () => {
      if (!usingProvider) {
        for (const f of filesRef.current) if (f.url) URL.revokeObjectURL(f.url);
      }
    },
    [usingProvider],
  );

  const handleChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      if (event.currentTarget.files) add(event.currentTarget.files);
      event.currentTarget.value = "";
    },
    [add],
  );

  const attachmentsCtx = useMemo<AttachmentsContext>(
    () => ({ add, clear, fileInputRef: inputRef, files, openFileDialog, remove }),
    [files, add, remove, clear, openFileDialog],
  );

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const form = event.currentTarget;
      const text = usingProvider
        ? controller.textInput.value
        : (new FormData(form).get("message") as string) || "";

      if (!usingProvider) form.reset();

      try {
        const result = onSubmit({ files, text }, event);
        if (result instanceof Promise) {
          await result;
        }
        clear();
        if (usingProvider) controller.textInput.clear();
      } catch {
        // Don't clear on error - the user may want to retry.
      }
    },
    [usingProvider, controller, files, onSubmit, clear],
  );

  return (
    <LocalAttachmentsContext.Provider value={attachmentsCtx}>
      <input
        accept={accept}
        aria-label={t("uploadFiles")}
        className="hidden"
        multiple={multiple}
        onChange={handleChange}
        ref={inputRef}
        title={t("uploadFiles")}
        type="file"
      />
      <form
        className={cn("w-full", className)}
        onSubmit={handleSubmit}
        ref={formRef}
        {...props}
      >
        {children}
      </form>
    </LocalAttachmentsContext.Provider>
  );
};

export type PromptInputTextareaProps = ComponentProps<"textarea">;

export const PromptInputTextarea = ({
  onChange,
  onKeyDown,
  className,
  placeholder = "What would you like to know?",
  ...props
}: PromptInputTextareaProps) => {
  const controller = useOptionalPromptInputController();
  const attachments = usePromptInputAttachments();
  const [isComposing, setIsComposing] = useState(false);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      onKeyDown?.(e);
      if (e.defaultPrevented) return;

      if (e.key === "Enter") {
        if (isComposing || e.nativeEvent.isComposing || e.shiftKey) return;
        e.preventDefault();
        const { form } = e.currentTarget;
        const submitButton = form?.querySelector(
          'button[type="submit"]',
        ) as HTMLButtonElement | null;
        if (submitButton?.disabled) return;
        form?.requestSubmit();
      }

      if (
        e.key === "Backspace" &&
        e.currentTarget.value === "" &&
        attachments.files.length > 0
      ) {
        e.preventDefault();
        const last = attachments.files.at(-1);
        if (last) attachments.remove(last.id);
      }
    },
    [onKeyDown, isComposing, attachments],
  );

  const handlePaste = useCallback(
    (event: ClipboardEvent<HTMLTextAreaElement>) => {
      const items = event.clipboardData?.items;
      if (!items) return;
      const files: File[] = [];
      for (const item of items) {
        if (item.kind === "file") {
          const file = item.getAsFile();
          if (file) files.push(file);
        }
      }
      if (files.length > 0) {
        event.preventDefault();
        attachments.add(files);
      }
    },
    [attachments],
  );

  const controlledProps = controller
    ? {
        onChange: (e: ChangeEvent<HTMLTextAreaElement>) => {
          controller.textInput.setInput(e.currentTarget.value);
          onChange?.(e);
        },
        value: controller.textInput.value,
      }
    : { onChange };

  return (
    <textarea
      className={cn(
        "field-sizing-content max-h-[220px] min-h-9 w-full resize-none bg-transparent px-1.5 py-1.5",
        "text-[15px] leading-6 outline-none placeholder:text-muted-foreground",
        "disabled:opacity-50 scrollbar-thin",
        className,
      )}
      name="message"
      onCompositionEnd={() => setIsComposing(false)}
      onCompositionStart={() => setIsComposing(true)}
      onKeyDown={handleKeyDown}
      onPaste={handlePaste}
      placeholder={placeholder}
      rows={1}
      {...props}
      {...controlledProps}
    />
  );
};

export type PromptInputSubmitStatus = "ready" | "submitted" | "streaming" | "error";

export type PromptInputSubmitProps = ComponentProps<typeof Button> & {
  status?: PromptInputSubmitStatus;
  onStop?: () => void;
};

export const PromptInputSubmit = ({
  className,
  status,
  onStop,
  onClick,
  children,
  ...props
}: PromptInputSubmitProps) => {
  const { t } = useI18n();
  const isGenerating = status === "submitted" || status === "streaming";

  let icon = <CornerDownLeft className="size-4" />;
  if (status === "submitted") icon = <Loader2 className="size-4 animate-spin" />;
  else if (status === "streaming") icon = <Square className="size-4 fill-current" />;
  else if (status === "error") icon = <X className="size-4" />;

  const handleClick = useCallback(
    (e: MouseEvent<HTMLButtonElement>) => {
      if (isGenerating && onStop) {
        e.preventDefault();
        onStop();
        return;
      }
      onClick?.(e);
    },
    [isGenerating, onStop, onClick],
  );

  return (
    <Button
      aria-label={isGenerating ? t("stopGenerating") : t("sendMessage")}
      className={cn("size-9 shrink-0 rounded-full", className)}
      onClick={handleClick}
      size="icon"
      type={isGenerating && onStop ? "button" : "submit"}
      {...props}
    >
      {children ?? icon}
    </Button>
  );
};

/**
 * A "+" trigger that expands into a dropdown of composer actions (e.g. add
 * attachments). Mirrors AI Elements' `PromptInputActionMenu` family, built
 * on this app's existing `~/components/ui/dropdown-menu` primitives.
 */
export type PromptInputActionMenuProps = ComponentProps<typeof DropdownMenu>;

export const PromptInputActionMenu = (props: PromptInputActionMenuProps) => (
  <DropdownMenu {...props} />
);

export type PromptInputActionMenuTriggerProps = ComponentProps<typeof Button>;

export const PromptInputActionMenuTrigger = ({
  className,
  children,
  ...props
}: PromptInputActionMenuTriggerProps) => (
  <PromptInputActionMenuTriggerInner className={className} {...props}>
    {children}
  </PromptInputActionMenuTriggerInner>
);

function PromptInputActionMenuTriggerInner({
  className,
  children,
  ...props
}: PromptInputActionMenuTriggerProps) {
  const { t } = useI18n();
  return (
    <DropdownMenuTrigger asChild>
      <Button
        aria-label={t("moreActions")}
      className={cn(
        "size-9 shrink-0 rounded-full text-muted-foreground",
        className,
      )}
      size="icon"
      type="button"
      variant="ghost"
      {...props}
      >
        {children ?? <Plus className="size-4.5" />}
      </Button>
    </DropdownMenuTrigger>
  );
}

export type PromptInputActionMenuContentProps = ComponentProps<
  typeof DropdownMenuContent
>;

export const PromptInputActionMenuContent = ({
  align = "start",
  side = "top",
  className,
  ...props
}: PromptInputActionMenuContentProps) => (
  <DropdownMenuContent
    align={align}
    side={side}
    className={cn("w-56", className)}
    {...props}
  />
);

export type PromptInputActionMenuItemProps = ComponentProps<
  typeof DropdownMenuItem
>;

export const PromptInputActionMenuItem = (
  props: PromptInputActionMenuItemProps,
) => <DropdownMenuItem {...props} />;

export type PromptInputActionAddAttachmentsProps = ComponentProps<
  typeof DropdownMenuItem
> & {
  label?: string;
};

/** Menu item that opens the composer's file dialog when clicked. */
export const PromptInputActionAddAttachments = ({
  label = "Add photos or files",
  onClick,
  children,
  ...props
}: PromptInputActionAddAttachmentsProps) => {
  const attachments = usePromptInputAttachments();

  return (
    <DropdownMenuItem
      onClick={(e) => {
        attachments.openFileDialog();
        onClick?.(e);
      }}
      {...props}
    >
      {children ?? (
        <>
          <ImagePlus className="size-4" />
          {label}
        </>
      )}
    </DropdownMenuItem>
  );
};
