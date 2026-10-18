/**
 * The React runtime a JSX artifact runs on, inside its sandboxed frame. The
 * Worker compiles the artifact to a CommonJS function and calls `__pimMount`
 * with it; `require` gives it only the modules this runtime and the other
 * runtime files (charts, icons) registered. Nothing here can reach the app:
 * the frame has an opaque origin and no network.
 */
import * as React from "react";
import * as JsxRuntime from "react/jsx-runtime";
import * as ReactDOM from "react-dom";
import * as ReactDOMClient from "react-dom/client";

type Factory = (
  require: (name: string) => unknown,
  module: { exports: Record<string, unknown> },
  exports: Record<string, unknown>,
) => void;

type Registry = Record<string, unknown>;

const scope = globalThis as unknown as {
  __pimModules: Registry;
  __pimMount: (factory: Factory) => void;
};

scope.__pimModules = Object.assign(scope.__pimModules ?? {}, {
  react: React,
  "react-dom": ReactDOM,
  "react-dom/client": ReactDOMClient,
  "react/jsx-runtime": JsxRuntime,
});

function require(name: string): unknown {
  const found = scope.__pimModules[name];
  if (!found) throw new Error(`The module "${name}" isn't available here.`);
  return found;
}

function showError(error: unknown) {
  const box = document.createElement("pre");
  box.setAttribute(
    "style",
    "margin:16px;padding:12px 14px;border-radius:8px;background:#fef2f2;color:#991b1b;font:13px/1.5 ui-monospace,monospace;white-space:pre-wrap",
  );
  box.textContent = `This artifact stopped with an error:\n${error instanceof Error ? error.message : String(error)}`;
  document.body.replaceChildren(box);
}

class Boundary extends React.Component<
  { children: React.ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: unknown) {
    showError(error);
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

scope.__pimMount = (factory) => {
  try {
    const module = { exports: {} as Record<string, unknown> };
    factory(require, module, module.exports);
    const App = module.exports.default;
    if (typeof App !== "function") {
      throw new Error("The artifact must export a component as its default.");
    }
    const root = document.getElementById("root");
    if (!root) throw new Error("The page has no root element.");
    ReactDOMClient.createRoot(root).render(
      <Boundary>{React.createElement(App as React.ComponentType)}</Boundary>,
    );
  } catch (error) {
    showError(error);
  }
};

addEventListener("error", (event) => showError(event.error ?? event.message));
