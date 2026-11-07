/**
 * Takes a picture of an app's page for its card, inside the sandboxed frame
 * (the page asks for it with `?thumbnail`, see `framePage` in
 * src/artifacts.ts), and sends it to the app that shows the frame. The frame
 * is laid out at the size of a desktop window; the picture is that window's
 * top, small, as a JPEG. It waits for the page to load and stop changing,
 * for what an app draws once it runs.
 */
import { toJpeg } from "html-to-image";

const WIDTH = 1024;
const HEIGHT = 640;
/** The picture's size: the window's, halved, which is sharp at the size of a card. */
const SCALE = 0.5;
/** How long the page must stop changing before it's taken to be drawn, and the longest it's waited for. */
const QUIET_MS = 500;
const SETTLE_MS = 5_000;

function send(message: { image?: string; failed?: true }) {
  parent.postMessage({ type: "pim:artifact-thumbnail", ...message }, "*");
}

/** Waits for what an app draws once it runs: until its page stops changing, or the longest wait. */
function settle() {
  return new Promise<void>((resolve) => {
    let quiet = setTimeout(done, QUIET_MS);
    const watch = new MutationObserver(() => {
      clearTimeout(quiet);
      quiet = setTimeout(done, QUIET_MS);
    });
    const limit = setTimeout(done, SETTLE_MS);
    function done() {
      watch.disconnect();
      clearTimeout(quiet);
      clearTimeout(limit);
      resolve();
    }
    watch.observe(document, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
  });
}

/** The page's background, which the page itself paints over everything: the body's, or the root's. */
function background() {
  for (const node of [document.body, document.documentElement]) {
    const color = getComputedStyle(node).backgroundColor;
    if (color && color !== "rgba(0, 0, 0, 0)" && color !== "transparent")
      return color;
  }
  return "#fff";
}

async function take() {
  if (document.readyState !== "complete")
    await new Promise((resolve) => addEventListener("load", resolve));
  await settle();
  try {
    send({
      image: await toJpeg(document.documentElement, {
        width: WIDTH,
        height: HEIGHT,
        canvasWidth: WIDTH * SCALE,
        canvasHeight: HEIGHT * SCALE,
        pixelRatio: 1,
        quality: 0.8,
        backgroundColor: background(),
      }),
    });
  } catch {
    send({ failed: true });
  }
}

void take();
