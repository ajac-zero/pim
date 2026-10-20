/**
 * Draws Mermaid diagrams inside a sandboxed frame. A Mermaid artifact's page
 * has the diagram's source, as text, in `<pre class="mermaid">`; a diagram
 * in an agent's message is posted to its page by the app that shows it (see
 * `diagramPage` in src/artifacts.ts). Mermaid's strict security level keeps
 * the source from adding scripts or links that run.
 */
import mermaid from "mermaid";

function draw(
  node: HTMLElement,
  dark: boolean,
  inMessage: boolean,
): Promise<void> {
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    theme: dark ? "dark" : "default",
    // A message's diagram that fails becomes its source, in the app.
    suppressErrorRendering: inMessage,
  });
  return mermaid.run({ nodes: [node] });
}

function failed(error: unknown) {
  const box = document.createElement("pre");
  box.className = "error";
  box.textContent = `This diagram couldn't be drawn:\n${error instanceof Error ? error.message : String(error)}`;
  document.body.append(box);
}

const artifact = document.querySelector<HTMLElement>("pre.mermaid");
// An artifact's frame is always white, like every artifact's.
if (artifact) draw(artifact, false, false).catch(failed);

let observed = false;
/** How narrow a message's diagram may be drawn before it scrolls instead. */
const MIN_READABLE_WIDTH = 600;

/**
 * Draws a message's diagram in the app's light or dark mode, on the page's
 * transparent background. It tells the app its height once it's drawn, and
 * when it can't be, so the app shows the source instead.
 */
(window as { __pimDiagram?: unknown }).__pimDiagram = (
  source: string,
  dark: boolean,
) => {
  document.documentElement.style.colorScheme = dark ? "dark" : "light";
  const node = document.createElement("pre");
  node.className = "mermaid";
  node.textContent = source;
  document.body.replaceChildren(node);
  draw(node, dark, true).then(
    () => {
      // Fit to the message, but no narrower than a phone can read: a wider one scrolls sideways.
      const svg = node.querySelector("svg");
      const natural = svg?.viewBox.baseVal.width;
      if (svg && natural) {
        svg.style.minWidth = `${Math.min(natural, MIN_READABLE_WIDTH)}px`;
      }
      const post = () =>
        parent.postMessage(
          {
            type: "pim:diagram-height",
            height: Math.ceil(document.body.scrollHeight),
          },
          "*",
        );
      post();
      if (!observed) new ResizeObserver(post).observe(document.body);
      observed = true;
    },
    () => parent.postMessage({ type: "pim:diagram-failed" }, "*"),
  );
};
