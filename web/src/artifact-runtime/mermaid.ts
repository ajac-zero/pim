/**
 * Draws a Mermaid artifact inside its sandboxed frame. The Worker puts the
 * diagram's source, as text, in `<pre class="mermaid">`; Mermaid's strict
 * security level keeps the source from adding scripts or links that run.
 */
import mermaid from "mermaid";

mermaid.initialize({
  startOnLoad: false,
  securityLevel: "strict",
  // The frame is always white, like every artifact's.
  theme: "default",
});

mermaid.run({ querySelector: "pre.mermaid" }).catch((error: unknown) => {
  const box = document.createElement("pre");
  box.className = "error";
  box.textContent = `This diagram couldn't be drawn:\n${error instanceof Error ? error.message : String(error)}`;
  document.body.append(box);
});
