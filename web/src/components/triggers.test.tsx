import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AppSidebar } from "~/components/app-sidebar";
import {
  SourceFields,
  TriggerEditor,
  TriggerReview,
} from "~/components/trigger-editor";
import {
  ConfirmAction,
  GrantReview,
  ProblemNotice,
  RunHistory,
  TestResult,
  TriggerActions,
  TriggerDetail,
  TriggersPage,
} from "~/components/triggers";
import {
  ApiError,
  type ApprovalPolicy,
  type Trigger,
  type TriggerRun,
} from "~/lib/pim-api";
import {
  agentsQuery,
  computerQuery,
  settingsQuery,
  triggerRunsQuery,
  triggersAvailableQuery,
  triggersQuery,
} from "~/lib/queries";
import {
  emptyForm,
  grantStanding,
  MAX_PAGES,
  triggerProblem,
} from "~/lib/triggers";
import {
  connectorFixture,
  grantApprovalFixture,
  pollFixture,
  runFixture,
  triggerFixture,
} from "~/test/trigger-fixtures";

const agents = [
  { id: "p_ada", name: "Ada", majordomo: true },
  { id: "p_rowan", name: "Rowan", majordomo: false },
];

function clientWith() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, retryOnMount: false } },
  });
  client.setQueryData(agentsQuery().queryKey, agents as never);
  return client;
}

const page = (triggers: Trigger[], nextCursor: string | null = null) => ({
  triggers,
  nextCursor,
});

function setList(client: QueryClient, pages: ReturnType<typeof page>[]) {
  client.setQueryData(triggersQuery({}).queryKey, {
    pages,
    pageParams: pages.map((_, index) => (index ? `c${index}` : undefined)),
  });
}

function setRuns(client: QueryClient, id: string, runs: TriggerRun[]) {
  client.setQueryData(triggerRunsQuery(id).queryKey, {
    pages: [{ runs, nextCursor: null }],
    pageParams: [undefined],
  });
}

/** Draws a component as the page first does, from what the queries hold, inside a router. */
async function render(Component: () => ReactNode, client = clientWith()) {
  const root = createRootRoute({ component: Component });
  const router = createRouter({
    routeTree: root.addChildren(
      [
        "/",
        "/triggers",
        "/triggers/new",
        "/triggers/$triggerId",
        "/triggers/$triggerId/grant",
        "/chat/$sessionId",
      ].map((path) => createRoute({ getParentRoute: () => root, path })),
    ),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await router.load();
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

/** The opening tag of the link to `href`, whatever the order of its attributes. */
const linkTo = (html: string, href: string) =>
  [...html.matchAll(/<a [^>]*>/g)]
    .map(([tag]) => tag)
    .find((tag) => tag.includes(`href="${href}"`));

/** The text a screen reader reads, without tags. */
const textOf = (html: string) =>
  html
    .replace(/<[^>]+>/g, "")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");

describe("the list", () => {
  it("shows lifecycle and health apart, each named, and no date it wasn't given", async () => {
    const client = clientWith();
    setList(client, [page([triggerFixture(), pollFixture()])]);
    const text = textOf(await render(TriggersPage, client));
    expect(text).toContain("State: Draft");
    expect(text).toContain("Health: Health unknown");
    expect(text).toContain("State: On");
    expect(text).toContain("Health: Waiting for computer");
    expect(text).toContain("Waiting for your computer");
    expect(text).toMatch(/Not on yet\. First run would be Nov 9, 2026/);
    expect(text).toContain("Command, checked · Ada");
  });

  it("words paused and ended rows, with no time for paused", async () => {
    const client = clientWith();
    const at = Date.UTC(2026, 10, 9, 9);
    const schedule = { nextFiringAt: at, nextCheckAt: at };
    setList(client, [
      page([
        triggerFixture({ id: "t_paused", lifecycle: "paused", schedule }),
        triggerFixture({ id: "t_ended", lifecycle: "ended" }),
      ]),
    ]);
    const text = textOf(await render(TriggersPage, client));
    expect(text).toContain(
      "Paused. Will resume at the next scheduled time when turned on.",
    );
    expect(text).toContain("Ended.");
    expect(text).not.toMatch(/Missed \d|Missed [A-Z][a-z]{2} /);
  });

  it("labels every filter, including health, source and agent", async () => {
    const client = clientWith();
    setList(client, [page([])]);
    const html = await render(TriggersPage, client);
    for (const label of ["State", "Health", "Source", "Agent"]) {
      const match = new RegExp(
        `<label for="([^"]+)"[^>]*>${label}</label>`,
      ).exec(html);
      expect(match, label).not.toBeNull();
      expect(html).toContain(`<select id="${match?.[1]}"`);
    }
    expect(html).toContain('<option value="waiting_computer">');
    expect(html).toContain('<option value="p_rowan">Rowan</option>');
  });

  it("shows an empty line for no triggers, and no rows", async () => {
    const client = clientWith();
    setList(client, [page([])]);
    const html = await render(TriggersPage, client);
    expect(textOf(html)).toContain("No triggers yet");
    expect(html).not.toContain("<li");
  });

  it("offers the next page while there is one, and stops after the bound", async () => {
    const client = clientWith();
    setList(client, [page([triggerFixture()], "c1")]);
    expect(textOf(await render(TriggersPage, client))).toContain("Load more");

    const bounded = clientWith();
    setList(
      bounded,
      Array.from({ length: MAX_PAGES }, (_, index) =>
        page([triggerFixture({ id: `trg_${index}` })], `c${index + 1}`),
      ),
    );
    const text = textOf(await render(TriggersPage, bounded));
    expect(text).not.toContain("Load more");
    expect(text).toContain(`Showing the first ${MAX_PAGES}.`);
  });

  it("shows nothing of triggers where the gate is off", async () => {
    const client = clientWith();
    await client.prefetchInfiniteQuery({
      ...triggersQuery({}),
      queryFn: () =>
        Promise.reject(new ApiError(404, "Not found", { error: "Not found" })),
    });
    const html = await render(TriggersPage, client);
    expect(textOf(html)).toContain("Triggers aren't available in this space.");
    expect(html).not.toContain("New trigger");
    expect(html).not.toContain("<select");
  });

  it("says why a listing failed, with the API's code", async () => {
    const client = clientWith();
    await client.prefetchInfiniteQuery({
      ...triggersQuery({}),
      queryFn: () =>
        Promise.reject(
          new ApiError(400, "cursor: is not valid", {
            error: "cursor: is not valid",
            code: "invalid_cursor",
            field: "cursor",
          }),
        ),
    });
    const html = await render(TriggersPage, client);
    expect(html).toContain('role="alert"');
    expect(textOf(html)).toContain("That page of the list is out of date.");
  });
});

describe("the entry point", () => {
  it("appears in the rail only once the API answers", async () => {
    const off = clientWith();
    off.setQueryData(triggersAvailableQuery().queryKey, false);
    expect(await render(() => <AppSidebar />, off)).not.toContain(
      'href="/triggers"',
    );

    const unknown = clientWith();
    expect(await render(() => <AppSidebar />, unknown)).not.toContain(
      'href="/triggers"',
    );

    const on = clientWith();
    on.setQueryData(triggersAvailableQuery().queryKey, true);
    const html = await render(() => <AppSidebar />, on);
    expect(linkTo(html, "/triggers")).toContain('aria-label="Triggers"');
    // Schedules stay where they were.
    expect(html).toContain('aria-label="Schedules"');
  });
});

describe("a trigger's page", () => {
  it("shows the fixed instruction, who and where, policies and an honest last check", async () => {
    const client = clientWith();
    setRuns(client, "trg_morning", [runFixture()]);
    const text = textOf(
      await render(() => <TriggerDetail trigger={triggerFixture()} />, client),
    );
    expect(text).toContain("Summarize my calendar for today.");
    expect(text).toContain("On the schedule 0 9 * * 1-5, in Europe/Lisbon");
    expect(text).toContain("A new chat each time");
    expect(text).toContain("Here, by you");
    expect(text).toContain("Not reported by Pim yet");
    expect(text).toContain("Last occurrence");
    expect(text).toMatch(/Nov 6, 2026/);
    expect(text).toContain(
      "Runs the latest firing up to 1 hour late; older ones are recorded as missed",
    );
    expect(text).toContain("Not kept");
  });

  it("shows one Next run row, and Pim looks next at only when it differs", async () => {
    const fire = Date.UTC(2026, 10, 9, 9, 0);
    const detail = async (nextCheckAt: number | null) => {
      const trigger = triggerFixture({
        lifecycle: "enabled",
        schedule: { nextFiringAt: fire, nextCheckAt },
      });
      return textOf(
        await render(() => <TriggerDetail trigger={trigger} />, clientWith()),
      );
    };
    for (const check of [null, fire]) {
      const text = await detail(check);
      expect(text).toContain("Next run");
      expect(text).not.toContain("Next at");
      expect(text).not.toContain("Pim looks next at");
      expect(text).not.toContain("Source");
    }
    expect(await detail(fire - 60_000)).toContain("Pim looks next at");
  });

  it("says a computer source runs with the user's full access, and where its grant stands", async () => {
    const client = clientWith();
    setRuns(client, "trg_build", []);
    const text = textOf(
      await render(() => <TriggerDetail trigger={pollFixture()} />, client),
    );
    expect(text).toContain("make check");
    expect(text).toContain("with all of that user's access");
    expect(text).toContain("They aren't sandboxed.");
    expect(text).toContain("Waiting for your approval");
    expect(text).toContain("status ≠ 0");
    expect(text).toContain("None yet");
  });

  it("links a computer source's grant to its request, and nothing else's", async () => {
    const client = clientWith();
    setRuns(client, "trg_build", []);
    setRuns(client, "trg_morning", []);
    const pending = await render(
      () => <TriggerDetail trigger={pollFixture()} />,
      client,
    );
    expect(linkTo(pending, "/triggers/trg_build/grant")).toBeDefined();
    expect(textOf(pending)).toContain("Review the request");
    const granted = await render(
      () => (
        <TriggerDetail
          trigger={pollFixture({ grant: { required: true, state: "current" } })}
        />
      ),
      client,
    );
    expect(textOf(granted)).toContain("Grant requests");
    const off = await render(
      () => (
        <TriggerDetail
          trigger={pollFixture({
            grant: { required: true, state: "unavailable" },
          })}
        />
      ),
      client,
    );
    expect(off).not.toContain("/grant");
    const time = await render(
      () => <TriggerDetail trigger={triggerFixture()} />,
      client,
    );
    expect(time).not.toContain("/grant");
  });

  it("never shows a connector's arguments", async () => {
    const client = clientWith();
    setRuns(client, "trg_mail", []);
    const html = await render(
      () => <TriggerDetail trigger={connectorFixture()} />,
      client,
    );
    expect(html).not.toContain("SECRET");
    expect(html).not.toContain("label:invoices");
    expect(textOf(html)).toContain("(arguments not shown: 2)");
    expect(textOf(html)).toContain(
      "Draft only: Pim doesn't take connector events in yet, so it can't be turned on",
    );
  });

  it("marks a shadow as its schedule's, and offers nothing that would change it", async () => {
    const shadow = triggerFixture({
      migration: {
        kind: "schedule",
        legacyId: "s1",
        owner: "legacy",
        phase: "shadow",
        enableable: false,
        ownerSince: null,
      },
    });
    const client = clientWith();
    setRuns(client, shadow.id, []);
    const detail = textOf(
      await render(() => <TriggerDetail trigger={shadow} />, client),
    );
    expect(detail).toContain("Owned by its schedule");
    expect(detail).toContain("Runs through its schedule, not as a trigger");
    const actions = textOf(
      await render(() => (
        <TriggerActions
          trigger={shadow}
          onEdit={() => {}}
          onReload={() => {}}
        />
      )),
    );
    expect(actions).toContain("Test");
    for (const action of ["Turn on", "Edit", "Pause", "Delete"]) {
      expect(actions).not.toContain(action);
    }
  });

  it("marks a shadow that took its schedule over as running it, still changed only through the migration", async () => {
    const takenOver = triggerFixture({
      lifecycle: "enabled",
      migration: {
        kind: "schedule",
        legacyId: "s1",
        owner: "trigger",
        phase: "shadow",
        enableable: true,
        ownerSince: 1_700_000_000_000,
      },
    });
    const client = clientWith();
    setRuns(client, takenOver.id, []);
    const detail = textOf(
      await render(() => <TriggerDetail trigger={takenOver} />, client),
    );
    expect(detail).toContain("Took over its schedule");
    expect(detail).not.toContain("Runs through its schedule, not as a trigger");
    const actions = textOf(
      await render(() => (
        <TriggerActions
          trigger={takenOver}
          onEdit={() => {}}
          onReload={() => {}}
        />
      )),
    );
    for (const action of ["Edit", "Pause", "Delete"]) {
      expect(actions).not.toContain(action);
    }
  });

  it("offers what each lifecycle allows", async () => {
    const actions = async (trigger: Trigger) =>
      textOf(
        await render(() => (
          <TriggerActions
            trigger={trigger}
            onEdit={() => {}}
            onReload={() => {}}
          />
        )),
      );
    const draft = await actions(triggerFixture());
    expect(draft).toContain("Turn on");
    expect(draft).not.toContain("Pause");
    const unavailable = await actions(connectorFixture());
    expect(unavailable).not.toContain("Turn on");
    expect(unavailable).toContain("Draft only");
    expect(unavailable).toContain("Edit");
    const on = await actions(triggerFixture({ lifecycle: "enabled" }));
    expect(on).toContain("Pause");
    expect(on).not.toContain("Turn on");
    const deleted = await actions(triggerFixture({ lifecycle: "deleted" }));
    for (const action of ["Turn on", "Edit", "Pause", "Delete", "Test"]) {
      expect(deleted).not.toContain(action);
    }
  });
});

describe("turning on a computer source", () => {
  const ACCESS =
    "Runs a script as your computer user. It can access anything that user can.";
  const UNDERSTAND = "I understand this script has my computer user's access";

  function withComputer(
    hostname: string | null,
    approvalPolicy: ApprovalPolicy | null = "explicit",
  ) {
    const client = clientWith();
    if (approvalPolicy) {
      client.setQueryData(settingsQuery().queryKey, {
        timeZone: "Europe/Lisbon",
        approvalPolicy,
        deviceAlerts: "important",
        approvalTimeoutSeconds: approvalPolicy === "auto" ? 30 : null,
      });
    }
    client.setQueryData(computerQuery().queryKey, {
      state: hostname ? "online" : "none",
      managed: false,
      pairedAt: hostname ? Date.UTC(2026, 10, 1) : null,
      error: null,
      computer: hostname
        ? {
            agent: "pim-computer",
            hostname,
            platform: "linux",
            arch: "x64",
            user: "ada",
            root: "/home/ada/pim",
            browser: null,
            screen: false,
            desktop: false,
            connectedAt: Date.UTC(2026, 10, 1),
          }
        : null,
    });
    return client;
  }

  const confirm = (
    trigger: Trigger,
    action: "resume" | "delete",
    client: QueryClient,
  ) =>
    render(
      () => (
        <ConfirmAction
          trigger={trigger}
          action={action}
          onConfirm={() => {}}
          onCancel={() => {}}
        />
      ),
      client,
    );

  /** The disabled attribute, not the `disabled:` styles every button has. */
  const DISABLED = /\sdisabled=""/;

  /** The opening tag of the button that reads `label`. */
  const buttonFor = (html: string, label: string) =>
    [...html.matchAll(/<button([^>]*)>([\s\S]*?)<\/button>/g)].find(
      ([, , inner]) => textOf(inner ?? "") === label,
    )?.[1];

  it("discloses a script's access, computer, version and frequency, and keeps Turn on off until understood", async () => {
    const trigger = pollFixture({
      lifecycle: "paused",
      revision: 7,
      grant: { required: true, state: "current" },
    });
    const html = await confirm(trigger, "resume", withComputer("ada-laptop"));
    const text = textOf(html);
    expect(text).toContain(ACCESS);
    expect(text).toContain("Computerada-laptop");
    expect(text).toContain("Script versionRevision 7");
    expect(text).toContain("FrequencyEvery 5 minutes");
    expect(text).toContain("Approval policyAsks before external actions");
    expect(text).toContain(UNDERSTAND);
    // The disclosure and the box come before the action they gate.
    expect(text.indexOf(ACCESS)).toBeLessThan(text.indexOf(UNDERSTAND));
    expect(text.indexOf(UNDERSTAND)).toBeLessThan(text.lastIndexOf("Turn on"));
    const box = html.match(/<input[^>]*type="checkbox"[^>]*>/)?.[0];
    expect(box).toContain("required");
    expect(box).not.toMatch(/\schecked/);
    expect(buttonFor(html, "Turn on")).toMatch(DISABLED);
    expect(buttonFor(html, "Cancel")).not.toMatch(DISABLED);
  });

  it("discloses each watch's frequency from its own source", async () => {
    const client = withComputer("ada-laptop");
    const cases: [Trigger["source"], string][] = [
      [
        { kind: "stream", command: "tail -f log", cwd: null },
        "Each time the script prints a line",
      ],
      [
        { kind: "process", handle: "proc_1", expiresAt: Date.UTC(2026, 10, 9) },
        "Once, when the process exits",
      ],
      [
        {
          kind: "file",
          path: "/home/ada/inbox",
          events: ["created"],
          recursive: false,
        },
        "Each time /home/ada/inbox changes",
      ],
    ];
    for (const [source, frequency] of cases) {
      const html = await confirm(
        pollFixture({ lifecycle: "draft", source, condition: null }),
        "resume",
        client,
      );
      expect(textOf(html)).toContain(ACCESS);
      expect(textOf(html)).toContain(`Frequency${frequency}`);
      expect(buttonFor(html, "Turn on")).toMatch(DISABLED);
    }
  });

  it("says the computer isn't reported rather than naming one", async () => {
    const html = await confirm(
      pollFixture({ lifecycle: "paused" }),
      "resume",
      withComputer(null),
    );
    expect(textOf(html)).toContain("ComputerNot reported by Pim yet");
  });

  it("says it asks first only where the approval policy waits for the person", async () => {
    const approvals = async (policy: ApprovalPolicy | null) =>
      textOf(
        await confirm(
          pollFixture({ lifecycle: "paused" }),
          "resume",
          withComputer("ada-laptop", policy),
        ),
      );
    const auto = await approvals("auto");
    expect(auto).toContain("Approval policyApprove it if I don't answer");
    expect(auto).not.toContain("Asks before external actions");
    const majordomo = await approvals("majordomo");
    expect(majordomo).toContain("Approval policyMy majordomo decides");
    expect(majordomo).not.toContain("Asks before external actions");
    const unread = await approvals(null);
    expect(unread).not.toContain("Approval policy");
    expect(unread).not.toContain("Asks before external actions");
    // The rest of the disclosure, and its box, stay whatever the policy.
    for (const text of [auto, majordomo, unread]) {
      expect(text).toContain(ACCESS);
      expect(text).toContain(UNDERSTAND);
    }
  });

  it("asks nothing more of a time trigger, or of deleting a computer source", async () => {
    const client = withComputer("ada-laptop");
    const time = await confirm(triggerFixture(), "resume", client);
    expect(textOf(time)).not.toContain(ACCESS);
    expect(time).not.toContain('type="checkbox"');
    expect(buttonFor(time, "Turn on")).not.toMatch(DISABLED);
    const deleting = await confirm(
      pollFixture({ lifecycle: "paused" }),
      "delete",
      client,
    );
    expect(textOf(deleting)).not.toContain(UNDERSTAND);
    expect(buttonFor(deleting, "Delete")).not.toMatch(DISABLED);
  });
});

describe("runs", () => {
  it("says the agent finished, never that the work succeeded, and links its chat", async () => {
    const client = clientWith();
    setRuns(client, "trg_morning", [
      runFixture(),
      runFixture({
        id: "occ_2",
        state: "outcome_unknown",
        outcomeKnown: false,
        chatId: null,
      }),
      runFixture({ id: "occ_3", state: "accepted", outcomeKnown: false }),
    ]);
    const html = await render(
      () => <RunHistory trigger={triggerFixture()} />,
      client,
    );
    const text = textOf(html);
    expect(text).toContain("Run: Agent finished");
    expect(text).toContain("Check the chat for what it did.");
    expect(text).toContain("Run: Outcome unknown");
    expect(text).toContain("Run: Handed to the agent");
    expect(text).not.toMatch(/succe/i);
    expect(linkTo(html, "/chat/chat_brief")).toContain(
      'aria-label="Open the chat of the run at Nov 6, 2026',
    );
    // Only the runs pinned to a chat link one.
    expect(html.match(/href="\/chat\//g)).toHaveLength(2);
  });

  it("shows an empty line for no runs", async () => {
    const client = clientWith();
    setRuns(client, "trg_morning", []);
    const text = textOf(
      await render(() => <RunHistory trigger={triggerFixture()} />, client),
    );
    expect(text).toContain("No runs yet");
  });
});

describe("refusals", () => {
  const notice = (status: number, body: Record<string, unknown>) =>
    render(() => (
      <ProblemNotice
        problem={triggerProblem(new ApiError(status, String(body.error), body))}
        onReload={() => {}}
      />
    ));

  it("offers to reload and review after a conflict or a missing revision", async () => {
    const conflict = await notice(409, {
      error: "Trigger is at revision 5",
      code: "revision_conflict",
      currentRevision: 5,
    });
    expect(conflict).toContain('role="alert"');
    expect(textOf(conflict)).toContain("Someone changed this trigger");
    expect(textOf(conflict)).toContain("It's at revision 5 now.");
    expect(textOf(conflict)).toContain("Reload and review");
    const required = await notice(428, {
      error: "If-Match: required",
      code: "revision_required",
    });
    expect(textOf(required)).toContain("Reload and review");
  });

  it("explains the rest of the table without offering a reload", async () => {
    for (const [status, code, text] of [
      [409, "source_not_wired", "Pim doesn't deliver this kind of source yet."],
      [409, "grant_required", "It needs your grant for exactly this source"],
      [409, "owned_elsewhere", "still owns it"],
      [409, "invalid_transition", "can't do that in its current state"],
      [422, "chat_unavailable", "That chat can't take"],
      [404, "not_found", "There's no such trigger."],
    ] as const) {
      const html = textOf(await notice(status, { error: "x", code }));
      expect(html, code).toContain(text);
      expect(html, code).not.toContain("Reload and review");
    }
  });
});

describe("a test", () => {
  it("says it had no effects, and lists what would refuse turning it on", async () => {
    const text = textOf(
      await render(() => (
        <TestResult
          result={{
            dryRun: true,
            valid: true,
            sourceKind: "time",
            capability: triggerFixture().capability,
            grant: triggerFixture().grant,
            policies: triggerFixture().policies,
            blockers: ["schedule_exhausted"],
            firings: [],
            exhausted: true,
          }}
        />
      )),
    );
    expect(text).toContain(
      "nothing was saved, no agent started, no command ran and no request was sent",
    );
    expect(text).toContain("It has no firing left.");
  });
});

describe("the editor", () => {
  it("labels its fields and offers time and draft connector events, not computer sources Pim didn't offer", async () => {
    const client = clientWith();
    setList(client, [
      page([
        pollFixture({
          capability: {
            status: "unavailable",
            delivers: false,
            reason: "computer_triggers_off",
          },
        }),
      ]),
    ]);
    const html = await render(() => <TriggerEditor />, client);
    for (const label of ["Name", "Instruction", "Agent"]) {
      const match = new RegExp(
        `<label for="([^"]+)"[^>]*>${label}</label>`,
      ).exec(html);
      expect(match, label).not.toBeNull();
      expect(html).toMatch(new RegExp(`id="${match?.[1]}"`));
    }
    const text = textOf(html);
    expect(text).toContain("Time");
    expect(text).toContain("Connector event");
    expect(text).not.toContain("Command, checked");
    expect(text).not.toContain("Save draft");
  });

  it("offers a computer source where Pim said it's available, with the access disclosed", async () => {
    const client = clientWith();
    setList(client, [page([pollFixture()])]);
    expect(textOf(await render(() => <TriggerEditor />, client))).toContain(
      "Command, checked",
    );
    const fields = textOf(
      await render(() => (
        <SourceFields
          form={{ ...emptyForm("p_ada"), kind: "poll" }}
          set={() => {}}
          errorOf={() => undefined}
          keepsCondition={false}
        />
      )),
    );
    expect(fields).toContain("with all of that user's access");
    expect(fields).toContain("Condition");
  });

  it("explains that a connector event is a draft only", async () => {
    const fields = textOf(
      await render(() => (
        <SourceFields
          form={{ ...emptyForm("p_ada"), kind: "connector_event" }}
          set={() => {}}
          errorOf={() => undefined}
          keepsCondition={false}
        />
      )),
    );
    expect(fields).toContain("can be saved only as drafts");
    expect(fields).toContain("source_not_wired");
  });

  it("reviews in words, says it's a draft, and discloses a command's access", async () => {
    const poll = pollFixture();
    const text = textOf(
      await render(() => (
        <TriggerReview input={poll} agent="Ada" chat={null} />
      )),
    );
    expect(text).toContain("Build watcher");
    expect(text).toContain("Tell me when the build breaks.");
    expect(text).toContain("A new chat each time");
    expect(text).toContain("Runs this command every 5 minutes:");
    expect(text).toContain("They aren't sandboxed.");
    expect(text).toContain("Its instruction is fixed");
    const mail = textOf(
      await render(() => (
        <TriggerReview input={connectorFixture()} agent="Ada" chat="Inbox" />
      )),
    );
    expect(mail).toContain("can be saved only as drafts");
    expect(mail).not.toContain("SECRET");
  });

  it("opens an edit with the trigger's own values", async () => {
    const client = clientWith();
    setList(client, [page([])]);
    const html = await render(
      () => <TriggerEditor trigger={pollFixture()} onDone={() => {}} />,
      client,
    );
    expect(textOf(html)).toContain("Edit trigger");
    expect(html).toContain('value="Build watcher"');
    expect(html).toContain('value="make check"');
    // A poll stays offered when editing one, whatever Pim offers new triggers.
    expect(textOf(html)).toContain("Command, checked");
  });
});

describe("a grant request's page", () => {
  const now = Date.UTC(2026, 10, 8, 12, 0);
  const review = (
    trigger: Trigger,
    approvals = [grantApprovalFixture()],
    currentHash = "hash_now",
  ) =>
    render(() => (
      <GrantReview
        trigger={trigger}
        standing={grantStanding(trigger, approvals, currentHash, now)}
        currentHash={currentHash}
      />
    ));
  const buttons = (html: string) =>
    [...html.matchAll(/<button[^>]*>(.*?)<\/button>/g)].map(([, inner]) =>
      textOf(inner ?? ""),
    );

  it("asks in Pim's words, shows exactly what it covers, and offers approve and decline", async () => {
    const html = await review(pollFixture());
    const text = textOf(html);
    expect(text).toContain("Computer access for Build watcher");
    expect(text).toContain("Request: Waiting for your decision");
    expect(text).toContain(
      'Let the trigger "Build watcher" run `make check` in /home/ada/project on your computer every 5 minutes.',
    );
    expect(text).toContain("They aren't sandboxed.");
    expect(text).toContain("This trigger only");
    expect(text).toContain("make check");
    expect(text).toContain("Exactly this configuration");
    expect(text).toContain("rt_laptop");
    expect(text).toContain("Approving doesn't turn the trigger on");
    expect(buttons(html)).toEqual(["Approve", "Decline"]);
    expect(linkTo(html, "/triggers/trg_build")).toBeDefined();
  });

  it("offers only to decline a request for a source the trigger no longer has, and doesn't show today's source as the one asked", async () => {
    const html = await review(pollFixture(), undefined, "hash_after_edit");
    const text = textOf(html);
    expect(text).toContain("Request: Out of date");
    expect(text).toContain(
      "The trigger's source changed after its agent asked",
    );
    expect(text).toContain("The source as it was when its agent asked");
    expect(text).not.toContain("Exactly this configuration");
    expect(buttons(html)).toEqual(["Decline"]);
  });

  it("says an expired request granted nothing, and offers to approve nothing", async () => {
    const lapsed = await review(pollFixture(), [
      grantApprovalFixture({ expiresAt: now - 1 }),
    ]);
    expect(textOf(lapsed)).toContain("Request: Expired");
    expect(textOf(lapsed)).toContain("This request expired before you decided");
    expect(buttons(lapsed)).toEqual(["Decline"]);
    const timedOut = await review(pollFixture(), [
      grantApprovalFixture({
        status: "denied",
        decidedBy: "timeout",
        decidedAt: now - 1,
      }),
    ]);
    expect(textOf(timedOut)).toContain("Request: Expired");
    expect(buttons(timedOut)).toEqual([]);
  });

  it("shows an approved request with where the grant stands now and what Pim recorded, and no buttons", async () => {
    const html = await review(
      pollFixture({ grant: { required: true, state: "current" } }),
      [
        grantApprovalFixture({
          status: "approved",
          decidedBy: "user",
          decidedAt: now - 60_000,
          result:
            'Granted: the trigger "Build watcher" may run its source on the person\'s computer.',
        }),
      ],
    );
    const text = textOf(html);
    expect(text).toContain("Request: Approved");
    expect(text).toContain("Granted for exactly this source");
    expect(text).toContain('Granted: the trigger "Build watcher" may run');
    expect(text).toContain("Decided");
    expect(buttons(html)).toEqual([]);
  });

  it("shows a declined request as granting nothing, with the note it was given", async () => {
    const html = await review(pollFixture(), [
      grantApprovalFixture({
        status: "denied",
        decidedBy: "user",
        decidedAt: now - 1,
        note: "Its chat stopped before the decision, so nothing ran.",
      }),
    ]);
    expect(textOf(html)).toContain("Request: Declined");
    expect(textOf(html)).toContain("Declined: this request granted nothing.");
    expect(textOf(html)).toContain("Its chat stopped before the decision");
    expect(buttons(html)).toEqual([]);
  });

  it("says when there is nothing to decide", async () => {
    const none = textOf(
      await review(
        pollFixture({ grant: { required: true, state: "missing" } }),
        [],
      ),
    );
    expect(none).toContain("Not granted. Ask its agent in chat");
    expect(none).toContain("No request from its agent is waiting.");
    expect(
      textOf(
        await review(
          pollFixture({ grant: { required: true, state: "unavailable" } }),
        ),
      ),
    ).toContain("Triggers on your computer are off in this space");
    const time = await review(triggerFixture());
    expect(textOf(time)).toContain("it needs no grant");
    expect(buttons(time)).toEqual([]);
  });
});
