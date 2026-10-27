import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { ComputerSection } from "~/components/computer-settings";
import { I18nProvider } from "~/components/i18n";
import type { ComputerStatus, Observations } from "~/lib/pim-api";

const machine = {
  agent: "pim-computer",
  hostname: "cua-vm-1",
  platform: "linux",
  arch: "x64",
  user: "shared",
  root: "/workspace",
  browser: "chrome",
  connectedAt: 1,
};
const base: ComputerStatus = {
  state: "none",
  managed: false,
  pairedAt: null,
  computer: null,
};

/** The section as the person sees it for a computer status, and the observations this Pim offers, if it offers them. */
function section(status: ComputerStatus, observations?: Observations | null) {
  const queryClient = new QueryClient();
  queryClient.setQueryData(["computer"], status);
  if (observations !== undefined)
    queryClient.setQueryData(["observations"], observations);
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <I18nProvider>
        <ComputerSection />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

it("shows a Cua computer as the operator's, online or offline, with no controls", () => {
  for (const state of ["online", "offline"] as const) {
    const html = section({
      ...base,
      state,
      provider: "cua",
      startable: false,
      computer: machine,
    });
    expect(html).toContain("cua-vm-1");
    expect(html).toContain("Managed by your operator");
    expect(html).toContain(state === "online" ? "Online" : "Offline");
    expect(html).toContain("Taking over its screen isn&#x27;t available");
    expect(html).not.toMatch(
      /<button|Start a computer|Connect a|Remove computer|PIM_COMPUTER_TOKEN/,
    );
  }
  expect(section({ ...base, state: "offline", provider: "cua" })).toContain(
    "Managed by your operator",
  );
});

it("shows an unreadable choice as unavailable, with no way to repair it here", () => {
  const html = section({ ...base, provider: "unreadable", startable: false });
  expect(html).toContain("Computer unavailable");
  expect(html).toContain("can&#x27;t read that choice");
  expect(html).not.toMatch(/<button|Start a computer|Connect|Remove computer/);
  expect(html).not.toContain("No computer");
});

it("keeps the paired and started computer controls when no provider is set", () => {
  const none = section({ ...base, startable: true });
  expect(none).toContain("Start a computer for me");
  expect(none).toContain("Connect my own");
  expect(section(base)).toContain("Connect a computer");
  const offline = section({
    ...base,
    state: "offline",
    pairedAt: 1,
    computer: machine,
  });
  expect(offline).toContain("Offline");
  expect(offline).toContain('aria-label="Remove computer"');
  expect(offline).toContain("Make a new one");
});

it("offers watching the Cua desktop, view only, only where this Pim offers it, and says when an observation isn't settled", () => {
  const cua: ComputerStatus = {
    ...base,
    state: "online",
    provider: "cua",
    startable: false,
    computer: machine,
  };
  // Not offered (a deployment answers not found): nothing to press, as before.
  expect(section(cua, null)).not.toMatch(/<button|Watch desktop/);

  const offered = section(cua, {
    blocked: null,
    observations: [],
    agent: "stand-in",
  });
  expect(offered).toContain("Watch desktop");
  expect(offered).toContain("View only");
  expect(offered).toContain("You can&#x27;t take over");
  expect(offered).toContain("stand-in model");
  expect(offered).not.toMatch(/Take over|Stop watching|Ask to end it/);

  const unsettled = section(cua, {
    blocked: null,
    agent: "real",
    observations: [
      {
        id: "observation-000001",
        status: "unconfirmed",
        notAfter: 1,
        evidence: "the host's answer to launch was lost (timeout)",
      },
    ],
  });
  expect(unsettled).toContain("Not confirmed closed");
  expect(unsettled).toContain("Check again");
  // Its end may be asked for again, which is not closure: never offered as stopping it.
  expect(unsettled).toContain("Ask to end it");
  expect(unsettled).not.toContain("Stop watching");
  expect(unsettled).not.toContain("stand-in model");
  // Watching again waits for it to settle.
  expect(unsettled).toMatch(/<button[^>]*disabled=""[^>]*>Watch desktop/);

  const blocked = section(cua, {
    blocked: "no ledger is stored",
    observations: [],
  });
  expect(blocked).toContain(
    "Watching isn&#x27;t available here: no ledger is stored",
  );
  expect(blocked).toMatch(/<button[^>]*disabled=""[^>]*>Watch desktop/);

  // An unreadable choice never offers it.
  expect(
    section(
      { ...base, provider: "unreadable", startable: false },
      { blocked: null, observations: [] },
    ),
  ).not.toContain("Watch desktop");
});
