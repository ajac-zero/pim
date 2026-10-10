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
import { deviceCode } from "~/lib/auth";
import { SignInRequired } from "~/lib/pim-api";
import { registerServiceWorker } from "~/lib/push";
import { routeTree } from "~/routeTree.gen";
import "~/styles/app.css";

// A device link's code leaves the address bar before the app makes any request.
deviceCode();

/** Sessions expire: asking again shows the sign-in screen in place of the app. */
function onError(error: Error) {
  if (error instanceof SignInRequired) {
    queryClient.invalidateQueries({ queryKey: ["auth", "session"] });
  }
}

const queryClient = new QueryClient({
  queryCache: new QueryCache({ onError }),
  mutationCache: new MutationCache({ onError }),
  defaultOptions: {
    queries: {
      retry: (count, error) => !(error instanceof SignInRequired) && count < 2,
      staleTime: 10_000,
    },
  },
});

const router = createRouter({
  routeTree,
  context: { queryClient },
  defaultPreload: "intent",
  defaultPreloadStaleTime: 0,
  scrollRestoration: true,
  defaultErrorComponent: RouteError,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

registerServiceWorker();

// biome-ignore lint/style/noNonNullAssertion: index.html has #root
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
