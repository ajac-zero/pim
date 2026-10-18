import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import {
  type FormEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import {
  ARTIFACT_LANGUAGES,
  ArtifactCaution,
  ArtifactPreview,
  ArtifactPrint,
  formatBytes,
} from "~/components/artifact";
import { useI18n } from "~/components/i18n";
import {
  ArrowLeft,
  ArrowUp,
  Download,
  History,
  Pencil,
  Printer,
  Trash2,
  Users,
  X,
} from "~/components/icons";
import { SessionLink } from "~/components/page";
import { Button } from "~/components/ui/button";
import { CodeBlock } from "~/components/ui/code-block";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { Input } from "~/components/ui/input";
import {
  ApiError,
  type ArtifactDetail,
  artifactDownloadUrl,
  pim,
} from "~/lib/pim-api";
import {
  artifactQuery,
  artifactVersionQuery,
  circlesQuery,
} from "~/lib/queries";
import { cn } from "~/lib/utils";

export const Route = createFileRoute("/artifacts/$artifactId")({
  validateSearch: (search: Record<string, unknown>): { v?: number } => {
    const v = Number(search.v);
    return Number.isSafeInteger(v) && v > 0 ? { v } : {};
  },
  component: ArtifactPage,
});

function ArtifactPage() {
  const { t, formatDate, formatNumber } = useI18n();
  const { artifactId } = Route.useParams();
  const { v } = Route.useSearch();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [view, setView] = useState<"preview" | "source">("preview");
  // The source being edited, from the latest version; null when not editing.
  const [draft, setDraft] = useState<string | null>(null);
  const preview = useRef<HTMLDivElement>(null);
  const [printing, setPrinting] = useState(false);
  const donePrinting = useCallback(() => setPrinting(false), []);
  const {
    data: artifact,
    error,
    refetch,
  } = useQuery(artifactQuery(artifactId));
  const version = v ?? artifact?.version;
  const listed = artifact?.history.some((entry) => entry.version === version);
  // A version the cached history lacks may be one made since (the agent works on): ask once, for this artifact
  // and version, before calling it missing. An answer to an earlier artifact or version counts for nothing.
  const wanted = `${artifactId}:${version}`;
  const [askedFor, setAskedFor] = useState<string>();
  useEffect(() => {
    if (listed !== false || askedFor === wanted) return;
    let current = true;
    void refetch().finally(() => {
      if (current) setAskedFor(wanted);
    });
    return () => {
      current = false;
    };
  }, [listed, askedFor, wanted, refetch]);
  const source = useQuery({
    ...artifactVersionQuery(artifactId, version ?? 0),
    enabled: (view === "source" || draft !== null) && listed === true,
  });
  // Another version, or another artifact, isn't the one being edited.
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new version or artifact ends the edit
  useEffect(() => {
    setDraft(null);
  }, [artifactId, version]);

  const save = useMutation({
    mutationFn: ({ base, content }: { base: number; content: string }) =>
      pim.saveArtifact(artifactId, base, content),
    onSuccess: async (saved) => {
      setDraft(null);
      if (!saved.changed) {
        toast(t("artifactUnchanged"));
        return;
      }
      toast.success(t("artifactSaved", { version: saved.saved }));
      await queryClient.invalidateQueries({ queryKey: ["artifacts"] });
      await navigate({
        to: "/artifacts/$artifactId",
        params: { artifactId },
        search: { v: saved.saved },
      });
    },
    onError: (failure) => {
      toast.error(failure.message);
      void queryClient.invalidateQueries({
        queryKey: ["artifacts", artifactId],
      });
    },
  });

  const restore = useMutation({
    mutationFn: ({ from, base }: { from: number; base: number }) =>
      pim.restoreArtifact(artifactId, from, base),
    onSuccess: async (restored, { from }) => {
      toast.success(
        t("artifactRestored", { from, version: restored.restored }),
      );
      // The new version must be in the history before the page shows it.
      await queryClient.invalidateQueries({ queryKey: ["artifacts"] });
      await navigate({
        to: "/artifacts/$artifactId",
        params: { artifactId },
        search: { v: restored.restored },
      });
    },
    onError: (failure) => {
      toast.error(failure.message);
      void queryClient.invalidateQueries({
        queryKey: ["artifacts", artifactId],
      });
    },
  });

  const remove = useMutation({
    mutationFn: () => pim.deleteArtifact(artifactId),
    onSuccess: () => {
      queryClient.removeQueries({ queryKey: ["artifacts", artifactId] });
      void queryClient.invalidateQueries({ queryKey: ["artifacts"] });
      toast.success(t("artifactDeletedToast"));
      void navigate({ to: "/artifacts" });
    },
    onError: (failure) => toast.error(failure.message),
  });

  if (error) {
    const gone = error instanceof ApiError && error.status === 404;
    return (
      <main className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-4 text-center">
        <p className="text-muted-foreground">
          {gone ? t("artifactDeleted") : error.message}
        </p>
        <Button asChild variant="outline">
          <Link to="/artifacts">{t("allArtifacts")}</Link>
        </Button>
      </main>
    );
  }
  if (!artifact || version === undefined) return null;
  const current = artifact.history.find((entry) => entry.version === version);
  if (!current) {
    if (askedFor !== wanted) return null;
    return (
      <main className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-4 text-center">
        <p className="text-muted-foreground">
          {t("artifactVersionMissing", { version })}
        </p>
        <Button asChild variant="outline">
          <Link
            to="/artifacts/$artifactId"
            params={{ artifactId }}
            search={{ v: artifact.version }}
          >
            {t("artifactLatest", { version: artifact.version })}
          </Link>
        </Button>
      </main>
    );
  }
  const isLatest = version === artifact.version;

  return (
    <main className="flex min-h-0 flex-1 flex-col">
      <header className="flex flex-wrap items-center gap-2 border-b px-4 py-3">
        <Button asChild size="icon" variant="ghost" className="size-8 shrink-0">
          <Link to="/artifacts" aria-label={t("allArtifacts")}>
            <ArrowLeft className="size-4" />
          </Link>
        </Button>
        <h1 className="min-w-0 flex-1 truncate font-semibold">
          {artifact.title}
        </h1>
        <label className="flex items-center gap-1.5 text-sm">
          <History className="size-4 text-muted-foreground" />
          <span className="sr-only">{t("artifactHistory")}</span>
          <select
            value={version}
            onChange={(event) =>
              void navigate({
                to: "/artifacts/$artifactId",
                params: { artifactId },
                search: { v: Number(event.target.value) },
              })
            }
            className="h-9 max-w-48 rounded-xl border bg-background px-2 text-sm"
          >
            {artifact.history.map((entry) => (
              <option key={entry.version} value={entry.version}>
                {t(
                  entry.source === "restore"
                    ? "artifactVersionRestoredOption"
                    : entry.source === "person"
                      ? "artifactEditedBy"
                      : "artifactVersionOption",
                  {
                    version: entry.version,
                    from: entry.restoredFrom ?? 0,
                    date: formatDate(new Date(entry.createdAt), {
                      dateStyle: "short",
                      timeStyle: "short",
                    }),
                  },
                )}
              </option>
            ))}
          </select>
        </label>
        {draft === null ? (
          <>
            <div className="flex rounded-full border p-0.5 text-sm">
              {(["preview", "source"] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  aria-pressed={view === mode}
                  onClick={() => setView(mode)}
                  className={cn(
                    "rounded-full px-3 py-1",
                    view === mode && "bg-accent font-medium",
                  )}
                >
                  {t(mode === "preview" ? "artifactPreview" : "artifactSource")}
                </button>
              ))}
            </div>
            <Button asChild size="sm" variant="outline" className="h-8">
              <a href={artifactDownloadUrl(artifactId, version)} download>
                <Download className="size-3.5" />
                {t("download")}
              </a>
            </Button>
            <Button
              size="icon"
              variant="ghost"
              className="size-8"
              aria-label={t("artifactPrint")}
              title={t("artifactPrint")}
              disabled={printing}
              onClick={() => setPrinting(true)}
            >
              <Printer className="size-4" />
            </Button>
            <ShareMenu artifact={artifact} />
            {isLatest ? (
              <Button
                size="sm"
                variant="outline"
                className="h-8"
                disabled={!source.data && source.isFetching}
                onClick={async () => {
                  const latest =
                    source.data ?? (await source.refetch()).data ?? null;
                  if (latest) setDraft(latest.content);
                }}
              >
                <Pencil className="size-3.5" />
                {t("artifactEditSource")}
              </Button>
            ) : (
              <Button
                size="sm"
                className="h-8"
                disabled={restore.isPending}
                onClick={() =>
                  restore.mutate({ from: version, base: artifact.version })
                }
              >
                {t("artifactRestore", { version })}
              </Button>
            )}
          </>
        ) : (
          <>
            <Button
              size="sm"
              variant="ghost"
              className="h-8"
              onClick={() => setDraft(null)}
            >
              {t("cancel")}
            </Button>
            <Button
              size="sm"
              className="h-8"
              disabled={save.isPending || draft === source.data?.content}
              onClick={() =>
                save.mutate({ base: artifact.version, content: draft })
              }
            >
              {t("artifactSaveVersion", { version: artifact.version + 1 })}
            </Button>
          </>
        )}
        <Button
          size="icon"
          variant="ghost"
          className="size-8 text-destructive"
          aria-label={t("artifactDelete")}
          disabled={remove.isPending}
          onClick={() => {
            if (
              window.confirm(
                t("artifactDeleteConfirm", {
                  title: artifact.title,
                  versions: artifact.versions,
                }),
              )
            ) {
              remove.mutate();
            }
          }}
        >
          <Trash2 className="size-4" />
        </Button>
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-2 p-2 md:p-3">
        {draft !== null ? (
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            aria-label={t("artifactSource")}
            spellCheck={artifact.kind === "markdown"}
            className="min-h-0 flex-1 resize-none rounded-lg border bg-background p-3 font-mono text-sm leading-6 outline-none scrollbar-thin focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/20"
          />
        ) : view === "preview" ? (
          <div ref={preview} className="min-h-0 flex-1">
            <ArtifactPreview
              id={artifactId}
              version={version}
              kind={artifact.kind}
              title={artifact.title}
              fill
            />
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-auto scrollbar-thin">
            {source.data ? (
              <CodeBlock
                code={source.data.content}
                language={ARTIFACT_LANGUAGES[artifact.kind]}
              />
            ) : (
              <p className="text-muted-foreground text-sm">
                {source.error?.message ?? t("loading")}
              </p>
            )}
          </div>
        )}
        {isLatest && draft === null && (
          <AskPim artifact={artifact} preview={preview} />
        )}
        {printing && (
          <ArtifactPrint
            id={artifactId}
            version={version}
            kind={artifact.kind}
            title={artifact.title}
            onDone={donePrinting}
          />
        )}
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
          <ArtifactCaution />
          <p className="text-muted-foreground text-xs">
            {t("artifactVersionDetails", {
              version,
              latest: artifact.version,
              size: formatBytes(current.size, formatNumber),
              sha: current.sha256.slice(0, 12),
            })}
            {artifact.session && (
              <>
                {" · "}
                <SessionLink session={artifact.session} />
              </>
            )}
          </p>
        </div>
      </div>
    </main>
  );
}

/**
 * Shares the artifact with your circles, whose people then find its latest
 * version under Shared with you. Shown once you have a circle.
 */
function ShareMenu({ artifact }: { artifact: ArtifactDetail }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const { data: circles } = useQuery(circlesQuery());
  const share = useMutation({
    mutationFn: (shared: string[]) =>
      pim.setArtifactCircles(artifact.id, shared),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: ["artifacts", artifact.id] }),
    onError: (failure) => toast.error(failure.message),
  });
  if (!circles?.length) return null;
  const shared = artifact.circles.filter((id) =>
    circles.some((circle) => circle.id === id),
  );
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          size="sm"
          variant={shared.length ? "secondary" : "outline"}
          className="h-8"
        >
          <Users className="size-3.5" />
          {t(shared.length ? "artifactShared" : "artifactShare")}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel className="font-normal text-muted-foreground text-xs">
          {t("artifactShareHint")}
        </DropdownMenuLabel>
        {circles.map((circle) => (
          <DropdownMenuCheckboxItem
            key={circle.id}
            checked={shared.includes(circle.id)}
            disabled={share.isPending}
            onSelect={(event) => event.preventDefault()}
            onCheckedChange={(checked) =>
              share.mutate(
                checked
                  ? [...shared, circle.id]
                  : shared.filter((id) => id !== circle.id),
              )
            }
          >
            <span className="min-w-0 flex-1 truncate">{circle.name}</span>
            <span className="text-muted-foreground text-xs">
              {circle.members.length}
            </span>
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** What's selected in an element, as the person last left it there; kept when focus moves elsewhere. */
function useSelectionIn(
  container: React.RefObject<HTMLElement | null>,
  reset: unknown,
) {
  const [selected, setSelected] = useState("");
  // biome-ignore lint/correctness/useExhaustiveDependencies: another version starts with nothing selected
  useEffect(() => {
    setSelected("");
  }, [reset]);
  useEffect(() => {
    const onChange = () => {
      const selection = document.getSelection();
      const text = selection?.toString().trim() ?? "";
      if (
        text &&
        selection?.anchorNode &&
        container.current?.contains(selection.anchorNode)
      ) {
        setSelected(text.replace(/\s+/g, " ").slice(0, 500));
      }
    };
    document.addEventListener("selectionchange", onChange);
    return () => document.removeEventListener("selectionchange", onChange);
  }, [container]);
  return [selected, setSelected] as const;
}

/**
 * Asks the agent to change the artifact, in the chat it was made in (or a
 * new one, if that chat is gone), about what's selected in a Markdown
 * artifact if anything is, then opens that chat.
 */
function AskPim({
  artifact,
  preview,
}: {
  artifact: ArtifactDetail;
  preview: React.RefObject<HTMLDivElement | null>;
}) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [request, setRequest] = useState("");
  const [selected, setSelected] = useSelectionIn(
    preview,
    `${artifact.id}:${artifact.version}`,
  );
  const ask = useMutation({
    mutationFn: async (text: string) => {
      let session = artifact.session;
      if (session) {
        try {
          await pim.send(session, text);
          return session;
        } catch (failure) {
          if (!(failure instanceof ApiError && failure.status === 404)) {
            throw failure;
          }
        }
      }
      session = (await pim.createSession()).id;
      await pim.send(session, text);
      return session;
    },
    onSuccess: (session) =>
      void navigate({ to: "/chat/$sessionId", params: { sessionId: session } }),
    onError: (failure) => toast.error(failure.message),
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const wanted = request.trim();
    if (!wanted || ask.isPending) return;
    const message = t("artifactAskMessage", {
      title: artifact.title,
      id: artifact.id,
      version: artifact.version,
      request: wanted,
    });
    ask.mutate(
      selected
        ? `${message}\n\n${t("artifactAskAboutMessage", { text: selected })}`
        : message,
    );
  };
  return (
    <form onSubmit={submit} className="flex flex-col gap-1.5">
      {selected && (
        <span className="flex max-w-full items-center gap-1 self-start rounded-full bg-muted py-0.5 pr-1 pl-3 text-muted-foreground text-xs">
          <span className="truncate">
            {t("artifactAskAbout", { text: selected })}
          </span>
          <button
            type="button"
            aria-label={t("artifactAskClear")}
            onClick={() => setSelected("")}
            className="rounded-full p-0.5 hover:bg-accent"
          >
            <X className="size-3" />
          </button>
        </span>
      )}
      <div className="flex items-center gap-2">
        <Input
          value={request}
          onChange={(event) => setRequest(event.target.value)}
          placeholder={t("artifactAskPlaceholder")}
          aria-label={t("artifactAskPlaceholder")}
          maxLength={2000}
        />
        <Button
          type="submit"
          size="icon"
          className="size-10 shrink-0 rounded-full"
          aria-label={t("sendMessage")}
          disabled={!request.trim() || ask.isPending}
        >
          <ArrowUp className="size-4" />
        </Button>
      </div>
    </form>
  );
}
