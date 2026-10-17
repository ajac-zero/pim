import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import type { BundledLanguage } from "shiki";
import { toast } from "sonner";
import { AgentIcon } from "~/components/agent-icon";
import { Markdown } from "~/components/chat/markdown";
import { useI18n } from "~/components/i18n";
import {
  ArrowLeft,
  Check,
  ChevronRight,
  FileIcon,
  History,
  RotateCcw,
  Trash2,
} from "~/components/icons";
import { Button } from "~/components/ui/button";
import { CodeBlock } from "~/components/ui/code-block";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "~/components/ui/collapsible";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { previewOf } from "~/lib/files";
import { type Agent, ApiError, pim, type SkillVersion } from "~/lib/pim-api";
import { agentsQuery, skillQuery, skillVersionQuery } from "~/lib/queries";
import { cn } from "~/lib/utils";

export const Route = createFileRoute("/skills/$skillName")({
  validateSearch: (search: Record<string, unknown>): { v?: number } => {
    const v = Number(search.v);
    return Number.isSafeInteger(v) && v > 0 ? { v } : {};
  },
  component: SkillPage,
});

/** A skill your agents wrote: what it says, at any version kept, and which agents use it. */
function SkillPage() {
  const { t, formatDate } = useI18n();
  const { skillName } = Route.useParams();
  const { v } = Route.useSearch();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: skill, error } = useQuery(skillQuery(skillName));
  const { data: agents } = useQuery(agentsQuery());
  const version = v ?? skill?.version;
  const isLatest = version === skill?.version;
  const listed = skill?.history.find((entry) => entry.version === version);
  // The latest version comes with the skill; an older one is read on its own.
  const older = useQuery({
    ...skillVersionQuery(skillName, version ?? 0),
    enabled: !!listed && !isLatest,
  });
  const shown = isLatest ? skill : older.data;

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["skills"] });
    void queryClient.invalidateQueries({ queryKey: ["agents"] });
  };

  const restore = useMutation({
    mutationFn: ({ from, base }: { from: number; base: number }) =>
      pim.restoreSkill(skillName, from, base),
    onSuccess: (restored, { from }) => {
      toast.success(t("skillRestored", { from, version: restored.version }));
      queryClient.setQueryData(skillQuery(skillName).queryKey, restored);
      refresh();
      void navigate({
        to: "/skills/$skillName",
        params: { skillName },
        search: {},
      });
    },
    onError: (failure) => {
      toast.error(failure.message);
      refresh();
    },
  });

  const remove = useMutation({
    mutationFn: () => pim.deleteSkill(skillName),
    onSuccess: () => {
      queryClient.removeQueries({ queryKey: ["skills", skillName] });
      refresh();
      toast.success(t("skillDeletedToast"));
      void navigate({ to: "/skills" });
    },
    onError: (failure) => toast.error(failure.message),
  });

  const toggle = useMutation({
    mutationFn: (agent: Agent) =>
      pim.updateAgent(agent.id, {
        skills: agent.skills.includes(skillName)
          ? agent.skills.filter((name) => name !== skillName)
          : [...agent.skills, skillName],
      }),
    onSettled: refresh,
    onError: (failure) => toast.error(failure.message),
  });

  if (error) {
    const gone = error instanceof ApiError && error.status === 404;
    return (
      <main className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-4 text-center">
        <p className="text-muted-foreground">
          {gone ? t("skillDeleted") : error.message}
        </p>
        <Button asChild variant="outline">
          <Link to="/skills">{t("allSkills")}</Link>
        </Button>
      </main>
    );
  }
  if (!skill || version === undefined) return null;
  if (!listed) {
    return (
      <main className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-4 text-center">
        <p className="text-muted-foreground">
          {t("skillVersionMissing", { version })}
        </p>
        <Button asChild variant="outline">
          <Link to="/skills/$skillName" params={{ skillName }} search={{}}>
            {t("skillLatest", { version: skill.version })}
          </Link>
        </Button>
      </main>
    );
  }
  const date = (at: number) =>
    formatDate(new Date(at), { dateStyle: "medium", timeStyle: "short" });

  return (
    <main className="flex min-h-0 flex-1 flex-col">
      <header className="flex flex-wrap items-center gap-2 border-b px-4 py-3">
        <Button asChild size="icon" variant="ghost" className="size-8 shrink-0">
          <Link to="/skills" aria-label={t("allSkills")}>
            <ArrowLeft className="size-4" />
          </Link>
        </Button>
        <h1 className="min-w-32 flex-1 truncate font-semibold">{skill.name}</h1>
        <Select
          value={String(version)}
          onValueChange={(value) => {
            const chosen = Number(value);
            void navigate({
              to: "/skills/$skillName",
              params: { skillName },
              search: chosen === skill.version ? {} : { v: chosen },
            });
          }}
        >
          <SelectTrigger
            size="sm"
            aria-label={t("skillHistory")}
            className="gap-1.5 rounded-full px-3"
          >
            <History className="size-4" />
            <SelectValue />
          </SelectTrigger>
          <SelectContent position="popper" align="end">
            {skill.history.map((entry) => (
              <SelectItem key={entry.version} value={String(entry.version)}>
                {entry.version === skill.version
                  ? t("skillLatestVersion")
                  : t("skillVersion", { version: entry.version })}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {!isLatest && (
          <Button
            size="icon"
            variant="ghost"
            className="size-8"
            aria-label={t("skillRestore")}
            title={t("skillRestore")}
            disabled={restore.isPending}
            onClick={() =>
              restore.mutate({ from: version, base: skill.version })
            }
          >
            <RotateCcw className="size-4" />
          </Button>
        )}
        <Button
          size="icon"
          variant="ghost"
          className="size-8 text-destructive"
          aria-label={t("skillDelete")}
          disabled={remove.isPending}
          onClick={() => {
            if (window.confirm(t("skillDeleteConfirm", { name: skill.name })))
              remove.mutate();
          }}
        >
          <Trash2 className="size-4" />
        </Button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
        <div className="mx-auto flex max-w-[720px] flex-col gap-8 px-6 py-6">
          <section>
            <p className="text-[15px]">{shown?.description}</p>
            <dl className="mt-2 flex flex-wrap gap-x-6 gap-y-1 text-[13px]">
              <div className="flex gap-2">
                <dt className="text-muted-foreground">{t("skillAuthor")}</dt>
                <dd>{listed.author ?? t("skillAuthorYou")}</dd>
              </div>
              <div className="flex gap-2">
                <dt className="text-muted-foreground">{t("skillDate")}</dt>
                <dd>{date(listed.createdAt)}</dd>
              </div>
            </dl>
          </section>
          <section>
            <h2 className="text-[13px] text-muted-foreground">
              {t("skillUsedBy")}
            </h2>
            <p className="text-[13px] text-muted-foreground">
              {t("skillUsedByHint")}
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              {agents?.map((agent) => {
                const uses = agent.skills.includes(skill.name);
                return (
                  <button
                    key={agent.id}
                    type="button"
                    aria-pressed={uses}
                    disabled={toggle.isPending}
                    onClick={() => toggle.mutate(agent)}
                    className={cn(
                      "flex items-center gap-2 rounded-full border py-1 pr-3 pl-1 text-sm transition-colors disabled:opacity-60",
                      uses
                        ? "border-transparent bg-secondary"
                        : "text-muted-foreground hover:bg-accent",
                    )}
                  >
                    <AgentIcon agent={agent} tile className="size-6" />
                    {agent.name}
                    {uses && <Check className="size-3.5" />}
                  </button>
                );
              })}
            </div>
          </section>
          <section>
            <h2 className="mb-2 text-[13px] text-muted-foreground">
              {t("skillInstructions")}
            </h2>
            <div className="rounded-xl border px-4 py-3">
              {shown ? (
                <Markdown text={shown.instructions} untrusted />
              ) : (
                <p className="text-muted-foreground text-sm">
                  {older.error?.message ?? t("loading")}
                </p>
              )}
            </div>
          </section>
          {shown && shown.files.length > 0 && (
            <section>
              <h2 className="mb-2 text-[13px] text-muted-foreground">
                {t("skillFiles")}
              </h2>
              <ul className="divide-y rounded-xl border">
                {shown.files.map((file) => (
                  <SkillFileRow key={file.path} file={file} />
                ))}
              </ul>
            </section>
          )}
        </div>
      </div>
    </main>
  );
}

/** A supporting file: its path, opening to its text. */
function SkillFileRow({ file }: { file: SkillVersion["files"][number] }) {
  const preview = previewOf(file.path);
  const language =
    preview.kind === "code"
      ? preview.language
      : preview.kind === "markdown"
        ? "markdown"
        : "text";
  return (
    <li>
      <Collapsible>
        <CollapsibleTrigger className="group flex w-full items-center gap-2 px-4 py-2.5 text-left text-[15px]">
          <FileIcon className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate">{file.path}</span>
          <ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-90" />
        </CollapsibleTrigger>
        <CollapsibleContent className="px-3 pb-3">
          <CodeBlock
            code={file.content}
            language={language as BundledLanguage}
          />
        </CollapsibleContent>
      </Collapsible>
    </li>
  );
}
