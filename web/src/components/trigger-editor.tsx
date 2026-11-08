import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { useI18n } from "~/components/i18n";
import {
  ComputerDisclosure,
  ConditionText,
  ObservedText,
  ProblemNotice,
  SourceText,
  WhenText,
} from "~/components/triggers";
import { Button } from "~/components/ui/button";
import {
  type Agent,
  pim,
  type Session,
  type Trigger,
  type TriggerInput,
} from "~/lib/pim-api";
import {
  agentsQuery,
  sessionsQuery,
  triggerQuery,
  triggersQuery,
} from "~/lib/queries";
import {
  changeOf,
  conditionEditable,
  conditionOf,
  conditionText,
  conditionWords,
  creationKey,
  emptyForm,
  type FormProblem,
  formOf,
  inputOf,
  offeredKinds,
  runsCommands,
  SOURCE_TEXT,
  sourceOf,
  type TriggerForm,
  type TriggerProblem,
  triggerProblem,
} from "~/lib/triggers";
import { cn } from "~/lib/utils";

/*
 * Making or changing a trigger, draft first: the person fills in the form,
 * reviews it in words, and only then saves it. A new trigger is always a
 * draft; turning it on is its own confirmed step on the trigger's page.
 */

const FIELD_CLASS =
  "w-full rounded-xl border bg-background px-3 text-[15px] outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/20 aria-invalid:border-destructive";

/**
 * The buttons of a step. On narrow screens they stick to the bottom of the
 * page, which ends where the app's bottom navigation begins, with room for the
 * device's safe area; on wider ones they stay inline.
 */
const ACTION_BAR =
  "flex flex-wrap justify-between gap-2 max-md:sticky max-md:bottom-0 max-md:z-10 max-md:-mx-4 max-md:border-t max-md:bg-background max-md:px-4 max-md:pt-3 max-md:pb-[max(0.75rem,env(safe-area-inset-bottom))]";

/** A labelled field, with the problem the form found in it, if any. */
function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: (props: {
    id: string;
    "aria-invalid"?: true;
    "aria-describedby"?: string;
  }) => ReactNode;
}) {
  const id = useId();
  const described = [hint && `${id}-hint`, error && `${id}-error`]
    .filter(Boolean)
    .join(" ");
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-[13px] text-muted-foreground">
        {label}
      </label>
      {children({
        id,
        ...(error ? { "aria-invalid": true } : {}),
        ...(described ? { "aria-describedby": described } : {}),
      })}
      {hint && (
        <p id={`${id}-hint`} className="text-[13px] text-muted-foreground">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} className="text-[13px] text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

function Choice<T extends string>({
  legend,
  name,
  value,
  options,
  onChange,
}: {
  legend: string;
  name: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <fieldset className="flex flex-col gap-1.5">
      <legend className="mb-1.5 text-[13px] text-muted-foreground">
        {legend}
      </legend>
      <div className="flex flex-wrap gap-2">
        {options.map((option) => (
          <label
            key={option.value}
            className="flex cursor-pointer items-center gap-2 rounded-full border px-3 py-1.5 text-sm has-[:checked]:bg-muted has-[:focus-visible]:ring-[3px] has-[:focus-visible]:ring-ring/20"
          >
            <input
              type="radio"
              name={name}
              value={option.value}
              checked={value === option.value}
              onChange={() => onChange(option.value)}
              className="accent-primary"
            />
            {option.label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/** The chats a trigger may deliver to: the agent's own, open, not a visit or a group chat. */
const chatsOf = (sessions: readonly Session[] | undefined, agentId: string) =>
  (sessions ?? []).filter(
    (session) =>
      session.agent?.id === agentId && !session.visit && !session.room,
  );

/** The form or its review, for a new trigger or for changing `trigger`. */
export function TriggerEditor({
  trigger,
  onDone,
  onReload,
}: {
  trigger?: Trigger;
  onDone?: () => void;
  /** Loads the trigger again, as Pim has it now. */
  onReload?: () => Promise<Trigger>;
}) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { data: agents } = useQuery(agentsQuery());
  const { data: sessions } = useQuery(sessionsQuery());
  const known = useInfiniteQuery(triggersQuery({}));
  const majordomo = agents?.find((agent) => agent.majordomo)?.id ?? "";
  const [form, setForm] = useState<TriggerForm>(() =>
    trigger ? formOf(trigger) : emptyForm(majordomo),
  );
  // The trigger as the person last saw it: an edit is made at its revision.
  const [base, setBase] = useState(trigger);
  const [reloaded, setReloaded] = useState(false);
  const [step, setStep] = useState<"edit" | "review">("edit");
  const [formProblem, setFormProblem] = useState<FormProblem | null>(null);
  const [problem, setProblem] = useState<TriggerProblem | null>(null);
  const [key, setKey] = useState(creationKey);
  const [status, setStatus] = useState("");
  const heading = useRef<HTMLHeadingElement>(null);

  // The majordomo is known only once agents load: a new trigger is its by default.
  useEffect(() => {
    if (!trigger && !form.agentId && majordomo) {
      setForm((current) => ({ ...current, agentId: majordomo }));
    }
  }, [trigger, form.agentId, majordomo]);

  const loadedKinds = offeredKinds(
    known.data?.pages.flatMap((page) => page.triggers) ?? [],
  );
  const kinds =
    trigger && !loadedKinds.includes(trigger.source.kind)
      ? [...loadedKinds, trigger.source.kind]
      : loadedKinds;
  const read = inputOf(form);
  const input = "input" in read ? read.input : null;
  // Review waits for the two things every trigger needs; Pim checks the rest.
  const complete = !!form.label.trim() && !!form.instruction.trim();

  const save = useMutation({
    mutationFn: async (input: TriggerInput) => {
      if (!base) return pim.createTrigger(input, key);
      return pim.updateTrigger(
        base.id,
        base.revision,
        changeOf(base, form, input),
      );
    },
    onMutate: () => {
      setProblem(null);
      setStatus(t("triggerSaving"));
    },
    onSuccess: (saved) => {
      setStatus(t("triggerSaved"));
      queryClient.setQueryData(triggerQuery(saved.id).queryKey, saved);
      void queryClient.invalidateQueries({ queryKey: ["triggers", "list"] });
      if (base) onDone?.();
      else {
        void navigate({
          to: "/triggers/$triggerId",
          params: { triggerId: saved.id },
        });
      }
    },
    onError: (error) => {
      setStatus("");
      setProblem(triggerProblem(error));
    },
  });

  const set = <K extends keyof TriggerForm>(name: K, value: TriggerForm[K]) => {
    setForm((current) => ({ ...current, [name]: value }));
    setFormProblem(null);
  };
  const errorOf = (name: keyof TriggerForm) =>
    formProblem?.field === name ? t(formProblem.key) : undefined;

  const review = () => {
    if ("problem" in read) {
      setFormProblem(read.problem);
      return;
    }
    setFormProblem(null);
    setProblem(null);
    setStep("review");
    // The heading stays and says the step: focus there for what changed.
    heading.current?.focus();
  };

  const reload = async () => {
    if (!onReload) return;
    setProblem(null);
    const fresh = await onReload();
    setBase(fresh);
    setReloaded(true);
    setStep("review");
    // The heading stays and says the step: focus there for what changed.
    heading.current?.focus();
  };

  const agentName = (id: string) =>
    agents?.find((agent: Agent) => agent.id === id)?.name ?? id;
  const chatTitle = (destination: TriggerInput["destination"]) =>
    destination.type === "new_chat"
      ? null
      : (sessions?.find((session) => session.id === destination.chatId)
          ?.title ?? t("triggerAChat"));
  const cancel = () => (onDone ? onDone() : void navigate({ to: "/triggers" }));
  const chats = chatsOf(sessions, form.agentId);
  const unchanged =
    !!base && !!input && Object.keys(changeOf(base, form, input)).length === 0;

  return (
    <div className="mt-6">
      <h1
        ref={heading}
        tabIndex={-1}
        className="font-semibold text-xl outline-none"
      >
        {step === "review"
          ? t("triggerReview")
          : trigger
            ? t("triggerEditTitle")
            : t("newTrigger")}
      </h1>
      <p className="mt-1 mb-6 text-muted-foreground text-sm">
        {step === "review"
          ? trigger
            ? t("triggerReviewEditHint")
            : t("triggerReviewDraftHint")
          : t("triggerFormHint")}
        {trigger && ` ${t("triggerEditFutureOnly")}`}
      </p>
      {step === "edit" ? (
        <form
          className="flex flex-col gap-5"
          onSubmit={(event) => {
            event.preventDefault();
            review();
          }}
          noValidate
        >
          <TriggerSummary
            form={form}
            agent={agentName(form.agentId)}
            chat={
              form.destination === "existing_chat" && form.chatId
                ? chats.find((chat) => chat.id === form.chatId)?.title ||
                  t("newChat")
                : null
            }
          />
          <Field label={t("triggerLabel")} error={errorOf("label")}>
            {(props) => (
              <input
                {...props}
                value={form.label}
                maxLength={120}
                onChange={(event) => set("label", event.target.value)}
                className={cn(FIELD_CLASS, "h-10")}
              />
            )}
          </Field>
          <Field
            label={t("triggerInstruction")}
            hint={t("triggerInstructionHint")}
            error={errorOf("instruction")}
          >
            {(props) => (
              <textarea
                {...props}
                value={form.instruction}
                maxLength={10_000}
                rows={4}
                onChange={(event) => set("instruction", event.target.value)}
                className={cn(FIELD_CLASS, "py-2")}
              />
            )}
          </Field>
          {trigger ? (
            <p className="text-sm">
              <span className="text-[13px] text-muted-foreground">
                {t("triggerAgent")}:{" "}
              </span>
              {agentName(trigger.agentId)}
            </p>
          ) : (
            <Field label={t("triggerAgent")}>
              {(props) => (
                <select
                  {...props}
                  value={form.agentId}
                  onChange={(event) => {
                    set("agentId", event.target.value);
                    set("chatId", "");
                  }}
                  className={cn(FIELD_CLASS, "h-10")}
                >
                  {(agents ?? []).map((agent) => (
                    <option key={agent.id} value={agent.id}>
                      {agent.name}
                    </option>
                  ))}
                </select>
              )}
            </Field>
          )}
          <Choice
            legend={t("triggerDestination")}
            name="destination"
            value={form.destination}
            onChange={(value) => set("destination", value)}
            options={[
              { value: "new_chat", label: t("triggerNewChatEachTime") },
              { value: "existing_chat", label: t("triggerExistingChat") },
            ]}
          />
          {form.destination === "existing_chat" && (
            <Field label={t("triggerChat")} error={errorOf("chatId")}>
              {(props) => (
                <select
                  {...props}
                  value={form.chatId}
                  onChange={(event) => set("chatId", event.target.value)}
                  className={cn(FIELD_CLASS, "h-10")}
                >
                  <option value="">{t("triggerChooseChat")}</option>
                  {chats.map((session) => (
                    <option key={session.id} value={session.id}>
                      {session.title ?? t("newChat")}
                    </option>
                  ))}
                </select>
              )}
            </Field>
          )}
          <Choice
            legend={t("triggerSource")}
            name="kind"
            value={form.kind}
            onChange={(value) => set("kind", value)}
            options={kinds.map((kind) => ({
              value: kind,
              label: t(SOURCE_TEXT[kind]),
            }))}
          />
          <SourceFields
            form={form}
            set={set}
            errorOf={errorOf}
            keepsCondition={!!trigger && !conditionEditable(trigger)}
            trigger={trigger}
          />
          {problem && <ProblemNotice problem={problem} onReload={reload} />}
          {!complete && (
            <p
              id="trigger-incomplete"
              className="text-[13px] text-muted-foreground"
            >
              {t("triggerIncomplete")}
            </p>
          )}
          <div className={ACTION_BAR}>
            <Button type="button" variant="outline" onClick={cancel}>
              {t("cancel")}
            </Button>
            <Button
              type="submit"
              disabled={!complete}
              aria-describedby={complete ? undefined : "trigger-incomplete"}
            >
              {t("triggerReviewButton")}
            </Button>
          </div>
        </form>
      ) : (
        input && (
          <div className="flex flex-col gap-5">
            {reloaded && base && (
              <section
                aria-label={t("triggerSavedNow", { revision: base.revision })}
                className="rounded-2xl border px-4 py-4"
              >
                <h2 className="mb-2 text-[13px] text-muted-foreground">
                  {t("triggerSavedNow", { revision: base.revision })}
                </h2>
                <TriggerReview
                  input={base}
                  agent={agentName(base.agentId)}
                  chat={chatTitle(base.destination)}
                />
              </section>
            )}
            <section aria-label={t("triggerYours")}>
              {reloaded && (
                <h2 className="mb-2 text-[13px] text-muted-foreground">
                  {t("triggerYours")}
                </h2>
              )}
              <TriggerReview
                input={input}
                agent={agentName(input.agentId ?? "")}
                chat={chatTitle(input.destination)}
              />
            </section>
            {unchanged && (
              <p className="text-muted-foreground text-sm">
                {t("triggerNothingChanged")}
              </p>
            )}
            {problem && <ProblemNotice problem={problem} onReload={reload} />}
            <div className={ACTION_BAR}>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setStep("edit");
                  setProblem(null);
                  heading.current?.focus();
                  // A changed request needs a key of its own.
                  setKey(creationKey());
                }}
              >
                {t("back")}
              </Button>
              <Button
                type="button"
                disabled={save.isPending || unchanged}
                onClick={() => save.mutate(input)}
              >
                {save.isPending
                  ? t("triggerSaving")
                  : trigger
                    ? t("triggerSaveChanges")
                    : t("triggerSaveDraft")}
              </Button>
            </div>
          </div>
        )
      )}
      <p role="status" aria-live="polite" className="sr-only">
        {status}
      </p>
    </div>
  );
}

/**
 * What the trigger will do, in three lines that follow the form: when it
 * fires, what the agent is told and where the result goes, and what it
 * watches. Each says "not set yet" until its part of the form is complete.
 */
export function TriggerSummary({
  form,
  agent,
  chat,
}: {
  form: TriggerForm;
  agent: string;
  /** The existing chat it delivers to, by title; null for a new chat each time. */
  chat: string | null;
}) {
  const i18n = useI18n();
  const { t } = i18n;
  const instruction = form.instruction.trim();
  const read = sourceOf(form);
  const source = "source" in read ? read.source : null;
  const condition = form.kind === "time" ? null : conditionOf(form);
  const notSet = (
    <span className="text-muted-foreground">{t("triggerSummaryNotSet")}</span>
  );
  return (
    <section
      aria-label={t("triggerSummary")}
      className="rounded-2xl border bg-muted/40 px-4 py-3"
    >
      <h2 className="text-[13px] text-muted-foreground">
        {t("triggerSummary")}
      </h2>
      <dl className="mt-1 divide-y divide-border">
        <ReviewRow label={t("triggerSummaryWhen")}>
          {source ? <WhenText source={source} /> : notSet}
        </ReviewRow>
        <ReviewRow label={t("triggerSummaryDo")}>
          <span className="whitespace-pre-wrap">
            {instruction
              ? t("triggerSummaryDoText", { agent, instruction })
              : t("triggerSummaryNoInstruction", { agent })}
          </span>
          <span className="block text-muted-foreground text-sm">
            {chat === null
              ? t("triggerSummaryResultNewChat")
              : t("triggerSummaryResultChat", { chat })}
          </span>
        </ReviewRow>
        <ReviewRow label={t("triggerSummaryObserve")}>
          {source ? (
            <ObservedText source={source} />
          ) : form.kind === "time" ? (
            t("triggerObserveNothing")
          ) : (
            notSet
          )}
          {condition && (
            <>
              {" "}
              {t("triggerSummaryObserveCondition", {
                condition:
                  conditionWords(condition.when, i18n) ??
                  conditionText(condition.when),
              })}
            </>
          )}
        </ReviewRow>
      </dl>
    </section>
  );
}

/** The fields of the chosen kind of source, and what the person should know of it. */
export function SourceFields({
  form,
  set,
  errorOf,
  keepsCondition,
  trigger,
}: {
  form: TriggerForm;
  set: <K extends keyof TriggerForm>(name: K, value: TriggerForm[K]) => void;
  errorOf: (name: keyof TriggerForm) => string | undefined;
  /** The trigger's condition is more than the form edits: it is kept as it is. */
  keepsCondition: boolean;
  trigger?: Trigger;
}) {
  const { t } = useI18n();
  const condition =
    form.kind === "time" ? null : keepsCondition &&
      trigger?.condition &&
      form.kind === trigger.source.kind ? (
      <p className="text-sm">
        <span className="text-[13px] text-muted-foreground">
          {t("triggerCondition")}:{" "}
        </span>
        <ConditionText expression={trigger.condition.when} />{" "}
        <span className="text-[13px] text-muted-foreground">
          {t("triggerConditionKept")}
        </span>
      </p>
    ) : (
      <ConditionFields form={form} set={set} errorOf={errorOf} />
    );
  switch (form.kind) {
    case "time":
      return (
        <div className="flex flex-col gap-5">
          <Choice
            legend={t("triggerWhen")}
            name="timeSchedule"
            value={form.timeSchedule}
            onChange={(value) => set("timeSchedule", value)}
            options={[
              { value: "once", label: t("triggerOnce") },
              { value: "cron", label: t("triggerCron") },
              { value: "interval", label: t("triggerInterval") },
            ]}
          />
          {form.timeSchedule === "once" && (
            <Field label={t("triggerAt")} error={errorOf("at")}>
              {(props) => (
                <input
                  {...props}
                  type="datetime-local"
                  value={form.at}
                  onChange={(event) => set("at", event.target.value)}
                  className={cn(FIELD_CLASS, "h-10")}
                />
              )}
            </Field>
          )}
          {form.timeSchedule === "cron" && (
            <>
              <Field
                label={t("triggerCronExpression")}
                hint={t("triggerCronHint")}
                error={errorOf("expression")}
              >
                {(props) => (
                  <input
                    {...props}
                    value={form.expression}
                    onChange={(event) => set("expression", event.target.value)}
                    className={cn(FIELD_CLASS, "h-10 font-mono")}
                    spellCheck={false}
                  />
                )}
              </Field>
              <Field
                label={t("triggerTimeZone")}
                hint={t("triggerTimeZoneHint")}
              >
                {(props) => (
                  <input
                    {...props}
                    value={form.timeZone}
                    onChange={(event) => set("timeZone", event.target.value)}
                    className={cn(FIELD_CLASS, "h-10")}
                    spellCheck={false}
                  />
                )}
              </Field>
            </>
          )}
          {form.timeSchedule === "interval" && (
            <Field
              label={t("triggerEveryMinutes")}
              error={errorOf("everyMinutes")}
            >
              {(props) => (
                <input
                  {...props}
                  type="number"
                  min={1}
                  inputMode="numeric"
                  value={form.everyMinutes}
                  onChange={(event) => set("everyMinutes", event.target.value)}
                  className={cn(FIELD_CLASS, "h-10")}
                />
              )}
            </Field>
          )}
        </div>
      );
    case "connector_event":
      return (
        <div className="flex flex-col gap-5">
          <p role="note" className="rounded-xl bg-muted px-4 py-3 text-sm">
            {t("triggerConnectorDraftOnly")}
          </p>
          <Field label={t("triggerConnectorId")} error={errorOf("connectorId")}>
            {(props) => (
              <input
                {...props}
                value={form.connectorId}
                onChange={(event) => set("connectorId", event.target.value)}
                className={cn(FIELD_CLASS, "h-10")}
                spellCheck={false}
              />
            )}
          </Field>
          <Field label={t("triggerEventName")} error={errorOf("event")}>
            {(props) => (
              <input
                {...props}
                value={form.event}
                onChange={(event) => set("event", event.target.value)}
                className={cn(FIELD_CLASS, "h-10")}
                spellCheck={false}
              />
            )}
          </Field>
          {condition}
        </div>
      );
    case "poll":
    case "stream":
      return (
        <div className="flex flex-col gap-5">
          <ComputerDisclosure />
          <Field label={t("triggerCommand")} error={errorOf("command")}>
            {(props) => (
              <input
                {...props}
                value={form.command}
                onChange={(event) => set("command", event.target.value)}
                className={cn(FIELD_CLASS, "h-10 font-mono")}
                spellCheck={false}
                autoComplete="off"
              />
            )}
          </Field>
          <Field label={t("triggerFolder")} hint={t("triggerFolderHint")}>
            {(props) => (
              <input
                {...props}
                value={form.cwd}
                onChange={(event) => set("cwd", event.target.value)}
                className={cn(FIELD_CLASS, "h-10 font-mono")}
                spellCheck={false}
              />
            )}
          </Field>
          {form.kind === "poll" && (
            <Field
              label={t("triggerEveryMinutes")}
              error={errorOf("pollMinutes")}
            >
              {(props) => (
                <input
                  {...props}
                  type="number"
                  min={1}
                  inputMode="numeric"
                  value={form.pollMinutes}
                  onChange={(event) => set("pollMinutes", event.target.value)}
                  className={cn(FIELD_CLASS, "h-10")}
                />
              )}
            </Field>
          )}
          {condition}
        </div>
      );
    case "process":
      return (
        <div className="flex flex-col gap-5">
          <ComputerDisclosure />
          <Field label={t("triggerHandle")} error={errorOf("handle")}>
            {(props) => (
              <input
                {...props}
                value={form.handle}
                onChange={(event) => set("handle", event.target.value)}
                className={cn(FIELD_CLASS, "h-10 font-mono")}
                spellCheck={false}
              />
            )}
          </Field>
          <Field
            label={t("triggerExpiresAt")}
            hint={t("triggerExpiresHint")}
            error={errorOf("expiresAt")}
          >
            {(props) => (
              <input
                {...props}
                type="datetime-local"
                value={form.expiresAt}
                onChange={(event) => set("expiresAt", event.target.value)}
                className={cn(FIELD_CLASS, "h-10")}
              />
            )}
          </Field>
          {condition}
        </div>
      );
    case "file":
      return (
        <div className="flex flex-col gap-5">
          <Field label={t("triggerPath")} error={errorOf("path")}>
            {(props) => (
              <input
                {...props}
                value={form.path}
                onChange={(event) => set("path", event.target.value)}
                className={cn(FIELD_CLASS, "h-10 font-mono")}
                spellCheck={false}
              />
            )}
          </Field>
          <fieldset className="flex flex-col gap-1.5">
            <legend className="mb-1.5 text-[13px] text-muted-foreground">
              {t("triggerFileEvents")}
            </legend>
            <div className="flex flex-wrap gap-3">
              {(["created", "modified", "deleted"] as const).map((event) => (
                <label key={event} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={form.fileEvents.includes(event)}
                    onChange={(change) =>
                      set(
                        "fileEvents",
                        change.target.checked
                          ? [...form.fileEvents, event]
                          : form.fileEvents.filter((each) => each !== event),
                      )
                    }
                    className="accent-primary"
                  />
                  {t(
                    event === "created"
                      ? "triggerFileCreated"
                      : event === "modified"
                        ? "triggerFileModified"
                        : "triggerFileDeleted",
                  )}
                </label>
              ))}
            </div>
            {errorOf("fileEvents") && (
              <p className="text-[13px] text-destructive">
                {errorOf("fileEvents")}
              </p>
            )}
          </fieldset>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={form.recursive}
              onChange={(event) => set("recursive", event.target.checked)}
              className="accent-primary"
            />
            {t("triggerRecursive")}
          </label>
          {condition}
        </div>
      );
  }
}

/** One field compared, present, or changed: a condition the form can make. */
function ConditionFields({
  form,
  set,
  errorOf,
}: {
  form: TriggerForm;
  set: <K extends keyof TriggerForm>(name: K, value: TriggerForm[K]) => void;
  errorOf: (name: keyof TriggerForm) => string | undefined;
}) {
  const { t } = useI18n();
  const needsValue =
    form.conditionOp !== "exists" && form.conditionOp !== "changed";
  return (
    <fieldset className="flex flex-col gap-3 rounded-2xl border px-4 py-4">
      <legend className="px-1 text-[13px] text-muted-foreground">
        {form.kind === "poll"
          ? t("triggerCondition")
          : t("triggerConditionOptional")}
      </legend>
      <Field
        label={t("triggerConditionField")}
        hint={t("triggerConditionFieldHint")}
        error={errorOf("conditionPath")}
      >
        {(props) => (
          <input
            {...props}
            value={form.conditionPath}
            onChange={(event) => set("conditionPath", event.target.value)}
            className={cn(FIELD_CLASS, "h-10 font-mono")}
            spellCheck={false}
          />
        )}
      </Field>
      <Field label={t("triggerConditionTest")}>
        {(props) => (
          <select
            {...props}
            value={form.conditionOp}
            onChange={(event) =>
              set(
                "conditionOp",
                event.target.value as TriggerForm["conditionOp"],
              )
            }
            className={cn(FIELD_CLASS, "h-10")}
          >
            <option value="eq">=</option>
            <option value="ne">≠</option>
            <option value="lt">&lt;</option>
            <option value="lte">≤</option>
            <option value="gt">&gt;</option>
            <option value="gte">≥</option>
            <option value="exists">{t("triggerConditionExists")}</option>
            <option value="changed">{t("triggerConditionChanged")}</option>
          </select>
        )}
      </Field>
      {needsValue && (
        <Field label={t("triggerConditionValue")}>
          {(props) => (
            <input
              {...props}
              value={form.conditionValue}
              onChange={(event) => set("conditionValue", event.target.value)}
              className={cn(FIELD_CLASS, "h-10")}
            />
          )}
        </Field>
      )}
    </fieldset>
  );
}

/** A trigger as it would be saved, in words, with what the person should know before saving it. */
export function TriggerReview({
  input,
  agent,
  chat,
}: {
  input: Pick<TriggerInput, "label" | "instruction" | "source" | "condition">;
  agent: string;
  /** The existing chat it delivers to, by title; null for a new chat each time. */
  chat: string | null;
}) {
  const { t } = useI18n();
  const kind = input.source.kind;
  return (
    <div className="flex flex-col gap-4">
      <dl className="divide-y divide-border">
        <ReviewRow label={t("triggerLabel")}>{input.label}</ReviewRow>
        <ReviewRow label={t("triggerInstruction")}>
          <span className="whitespace-pre-wrap">{input.instruction}</span>
        </ReviewRow>
        <ReviewRow label={t("triggerAgent")}>{agent}</ReviewRow>
        <ReviewRow label={t("triggerDestination")}>
          {chat ?? t("triggerNewChatEachTime")}
        </ReviewRow>
        <ReviewRow label={t("triggerSource")}>
          <span className="block text-[13px] text-muted-foreground">
            {t(SOURCE_TEXT[kind])}
          </span>
          <SourceText source={input.source} />
        </ReviewRow>
        {input.condition && (
          <ReviewRow label={t("triggerCondition")}>
            <ConditionText expression={input.condition.when} />
          </ReviewRow>
        )}
      </dl>
      {kind === "connector_event" && (
        <p role="note" className="rounded-xl bg-muted px-4 py-3 text-sm">
          {t("triggerConnectorDraftOnly")}
        </p>
      )}
      {runsCommands(kind) && <ComputerDisclosure />}
      <p className="text-muted-foreground text-sm">{t("triggerDraftNote")}</p>
    </div>
  );
}

function ReviewRow({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-0.5 py-2 sm:flex-row sm:gap-4">
      <dt className="shrink-0 text-[13px] text-muted-foreground sm:w-44">
        {label}
      </dt>
      <dd className="min-w-0 break-words text-[15px]">{children}</dd>
    </div>
  );
}
