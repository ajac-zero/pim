// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "~/components/i18n";
import { SettingsDialog } from "~/components/settings-dialog";
import { ThemeProvider } from "~/components/theme";

beforeEach(() => {
  const kept = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => kept.get(key) ?? null,
    setItem: (key: string, value: string) => void kept.set(key, value),
    clear: () => kept.clear(),
  });
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) =>
      input === "/api/themes"
        ? Response.json({ default: "nord", themes: [] })
        : new Response("{}", { status: 404 }),
    ),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function open() {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <I18nProvider>
        <ThemeProvider>
          <SettingsDialog open onOpenChange={() => {}} />
        </ThemeProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

describe("Appearance settings", () => {
  it("is its own tab, not part of General", () => {
    open();
    expect(screen.getByRole("button", { name: "Appearance" })).toBeTruthy();
    expect(screen.queryByRole("radiogroup", { name: "Mode" })).toBeNull();
  });

  it("shows the mode and theme controls on its tab", () => {
    open();
    fireEvent.click(screen.getByRole("button", { name: "Appearance" }));
    expect(screen.getByRole("radiogroup", { name: "Mode" })).toBeTruthy();
    expect(screen.getByRole("radiogroup", { name: "Theme" })).toBeTruthy();
  });
});
