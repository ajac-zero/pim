import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { AppCard } from "~/components/apps-dialog";
import type { ConnectedApp, DirectoryApp } from "~/lib/pim-api";

const drive: DirectoryApp = {
  ref: "google/drive",
  name: "Google Drive",
  description: "Reads the Drive files you pick for it, and nothing else.",
  url: null,
  custom: false,
  icon: null,
  category: "productivity",
  page: {
    url: "/app-pages/google/drive",
    label: { en: "Choose files", es: "Elegir archivos" },
  },
};
const gmail: DirectoryApp = {
  ...drive,
  ref: "google/gmail",
  name: "Gmail",
  page: undefined,
};

const connection = (
  app: DirectoryApp,
  state: string,
  extra: Partial<ConnectedApp> = {},
): ConnectedApp => ({
  id: app.ref.replace("/", "_"),
  app: app.ref,
  name: app.name,
  url: "",
  state,
  error: null,
  authUrl: null,
  agents: [],
  tools: [],
  ...extra,
});

/** The card's links and buttons, as the person sees them. */
function card(app: DirectoryApp, connected?: ConnectedApp) {
  const html = renderToStaticMarkup(
    <AppCard
      row={{ app, connection: connected }}
      isAdmin={false}
      busy={false}
      onConnect={() => {}}
      onDisconnect={() => {}}
      onChangeIcon={() => {}}
      onUnlist={() => {}}
    />,
  );
  const links = [...html.matchAll(/<a ([^>]*)>(.*?)<\/a>/g)].map(
    ([, attributes = "", text = ""]) => ({
      href: /href="([^"]*)"/.exec(attributes)?.[1],
      target: /target="([^"]*)"/.exec(attributes)?.[1],
      rel: /rel="([^"]*)"/.exec(attributes)?.[1],
      text: text.replace(/<[^>]*>/g, "").trim(),
    }),
  );
  const buttons = [...html.matchAll(/<button [^>]*>(.*?)<\/button>/g)].map(
    ([, text = ""]) => text.replace(/<[^>]*>/g, "").trim(),
  );
  return { html, links, buttons };
}

it("offers a connected app's page, such as Drive's file picker, in a tab of its own", () => {
  const { links, buttons } = card(drive, connection(drive, "ready"));
  expect(links).toEqual([
    {
      href: "/app-pages/google/drive",
      target: "_blank",
      rel: "noopener",
      text: "Choose files",
    },
  ]);
  expect(buttons).not.toContain("Connect");
});

it("offers the page only once the app is connected, and only for an app that has one", () => {
  const picker = (links: { href?: string }[]) =>
    links.filter((link) => link.href?.startsWith("/app-pages/"));
  // Not connected yet: connect first.
  const offered = card(drive);
  expect(picker(offered.links)).toEqual([]);
  expect(offered.buttons).toContain("Connect");
  // Waiting for the person to sign in at Google: that, not the page.
  const signingIn = card(
    drive,
    connection(drive, "authenticating", {
      authUrl: "https://accounts.google.com/o/oauth2/v2/auth?state=x",
    }),
  );
  expect(signingIn.links).toEqual([
    expect.objectContaining({
      href: "https://accounts.google.com/o/oauth2/v2/auth?state=x",
      text: "Sign in",
    }),
  ]);
  // An app without a page has no such button.
  expect(picker(card(gmail, connection(gmail, "ready")).links)).toEqual([]);
});

it("says why a connection failed, and connects it again instead of offering its page", () => {
  const { html, links, buttons } = card(
    drive,
    connection(drive, "failed", {
      error: "Sign in again: Token has been expired or revoked.",
    }),
  );
  expect(links).toEqual([]);
  expect(buttons).toContain("Reconnect");
  expect(html).toContain("Sign in again: Token has been expired or revoked.");
  expect(html).toContain("Couldn&#x27;t connect");
});
