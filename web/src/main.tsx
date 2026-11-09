import {
  MutationCache,
  QueryCache,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { createRouter, RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouteError } from "~/components/route-error";
import { authSessionQuery, deviceCode } from "~/lib/auth";
import { NoAddress, SignInRequired } from "~/lib/pim-api";
import { registerServiceWorker } from "~/lib/push";
import {
  accountQuery,
  agentsQuery,
  approvalsQuery,
  artifactsQuery,
  computerQuery,
  extensionsQuery,
  majordomoQuery,
  notificationsQuery,
  sessionsQuery,
} from "~/lib/queries";
import { restoreSavedQueries } from "~/lib/saved-queries";
import { routeTree } from "~/routeTree.gen";
import "~/styles/app.css";

// A device link's code leaves the address bar before the app makes any request.
deviceCode();

/**
 * Sessions expire: asking again shows the sign-in screen in place of the app.
 * While Pim is already being asked, its answer will tell.
 */
function onError(error: Error) {
  if (
    error instanceof SignInRequired &&
    !queryClient.isFetching({ queryKey: ["auth", "session"] })
  ) {
    queryClient.invalidateQueries({ queryKey: ["auth", "session"] });
  }
}

const queryClient = new QueryClient({
  queryCache: new QueryCache({ onError }),
  mutationCache: new MutationCache({ onError }),
  defaultOptions: {
    queries: {
      retry: (count, error) =>
        !(error instanceof SignInRequired || error instanceof NoAddress) &&
        count < 2,
      staleTime: 10_000,
    },
  },
});

const router = createRouter({
  routeTree,
  context: { queryClient },
  defaultPreload: "intent",
  defaultPreloadStaleTime: 0,
  // A chat keeps its own place (see `Thread`). The router's would put the
  // last chat's offset on the next one, whose transcript has the same element.
  scrollRestoration: ({ location }) => !location.pathname.startsWith("/chat/"),
  defaultErrorComponent: RouteError,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

registerServiceWorker();

// After a deploy, a page from before it may ask for files that are gone: it
// reloads into the new app, though not again and again when that doesn't help.
window.addEventListener("vite:preloadError", (event) => {
  const last = Number(sessionStorage.getItem("pim-reloaded") ?? 0);
  if (Date.now() - last < 10_000) return;
  sessionStorage.setItem("pim-reloaded", String(Date.now()));
  event.preventDefault();
  location.reload();
});

// The app draws once what this device kept of the lists is back, so it opens
// with them. (Not with a top-level await: that keeps the bundler from merging
// small chunks, so the first load would ask for many more files.)
restoreSavedQueries(queryClient, import.meta.env.PIM_BUILD).then(() => {
  // What the first screen shows, asked for all at once rather than each after
  // the one it waits behind (the session, then the majordomo, then the lists).
  // A chat's or a bot's public link is for anyone, so it asks for none of it.
  // A device signed out last time, or a guest's, which reaches only its bot,
  // asks only for the session. The session is always asked, however recent
  // the kept answer: signing in elsewhere changes it.
  if (!/^\/(shared|b)\//.test(location.pathname)) {
    queryClient.prefetchQuery({ ...authSessionQuery(), staleTime: 0 });
    const kept = queryClient.getQueryData(authSessionQuery().queryKey);
    if (kept?.signedIn !== false && kept?.account?.role !== "guest") {
      queryClient.prefetchQuery(majordomoQuery());
      queryClient.prefetchQuery(sessionsQuery());
      queryClient.prefetchQuery(agentsQuery());
      queryClient.prefetchQuery(extensionsQuery());
      queryClient.prefetchQuery(approvalsQuery());
      queryClient.prefetchQuery(notificationsQuery());
      queryClient.prefetchQuery(accountQuery());
      queryClient.prefetchQuery(computerQuery());
      queryClient.prefetchQuery(artifactsQuery());
    }
  }
  // biome-ignore lint/style/noNonNullAssertion: index.html has #root
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </StrictMode>,
  );
});
