// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider, useI18n } from "~/components/i18n";
import { ThemeProvider, useTheme } from "~/components/theme";

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
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  document.documentElement.className = "";
  delete document.documentElement.dataset.theme;
});

function Probe() {
  const { preference, setPreference, setColorTheme } = useTheme();
  const { locale, setLocale } = useI18n();
  return (
    <div>
      <span data-testid="state">{`${preference}/${locale}`}</span>
      <button type="button" onClick={() => setPreference("dark")}>
        dark
      </button>
      <button type="button" onClick={() => setColorTheme("nord")}>
        nord
      </button>
      <button type="button" onClick={() => setLocale("es")}>
        es
      </button>
    </div>
  );
}

/** A signed-in Pim whose settings are `settings`; the puts it gets are returned. */
function mount(settings: Record<string, unknown>) {
  const puts: unknown[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      if (input === "/auth/session") return Response.json({ signedIn: true });
      if (input === "/api/themes")
        return Response.json({ default: "nord", themes: [] });
      if (input === "/api/settings" && init?.method === "PUT") {
        const update = JSON.parse(init.body as string);
        puts.push(update);
        Object.assign(settings, update);
      }
      if (input === "/api/settings") return Response.json({ ...settings });
      return Response.json({});
    }),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <I18nProvider>
        <ThemeProvider>
          <Probe />
        </ThemeProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );
  return { puts, client };
}

describe("appearance in settings", () => {
  it("applies what the server has over this browser's own, and keeps it as the paint cache", async () => {
    window.localStorage.setItem("pim-theme", "light");
    window.localStorage.setItem("pim-locale", "en");
    mount({ colorMode: "dark", colorTheme: "nord", locale: "es" });
    await waitFor(() =>
      expect(screen.getByTestId("state").textContent).toBe("dark/es"),
    );
    expect(document.documentElement.dataset.theme).toBe("nord");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(window.localStorage.getItem("pim-theme")).toBe("dark");
    expect(window.localStorage.getItem("pim-color-theme")).toBe("nord");
    expect(window.localStorage.getItem("pim-locale")).toBe("es");
  });

  it("leaves this browser's own choices alone when the server has none", async () => {
    window.localStorage.setItem("pim-theme", "dark");
    const { puts } = mount({});
    await waitFor(() =>
      expect(screen.getByTestId("state").textContent).toBe("dark/en"),
    );
    expect(puts).toEqual([]);
  });

  it("saves each change to the settings, and follows a change made elsewhere", async () => {
    const { puts, client } = mount({});
    await screen.findByTestId("state");
    act(() => screen.getByText("dark").click());
    act(() => screen.getByText("nord").click());
    act(() => screen.getByText("es").click());
    await waitFor(() =>
      expect(puts).toEqual([
        { colorMode: "dark" },
        { colorTheme: "nord" },
        { locale: "es" },
      ]),
    );
    // Another device, or an agent, changes it; the socket's event refetches the settings.
    await act(async () => {
      await client.setQueryData(["settings"], {
        colorMode: "light",
        colorTheme: "nord",
        locale: "en",
      });
    });
    await waitFor(() =>
      expect(screen.getByTestId("state").textContent).toBe("light/en"),
    );
    expect(document.documentElement.dataset.theme).toBe("nord");
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });
});
