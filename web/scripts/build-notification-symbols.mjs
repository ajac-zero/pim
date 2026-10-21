/** The service worker uses the app's named symbols as SVGs in device notifications. */
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import viteReact from "@vitejs/plugin-react";
import dynamicIconImports from "lucide-react/dynamicIconImports.mjs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const web = fileURLToPath(new URL("..", import.meta.url));
const server = await createServer({
  root: web,
  configFile: false,
  resolve: { tsconfigPaths: true },
  plugins: [viteReact()],
  server: { middlewareMode: true },
  appType: "custom",
});
try {
  const { ICONS } = await server.ssrLoadModule("/src/components/agent-icon.tsx");
  const { tokyoNight } = await server.ssrLoadModule("../src/extensions/themes/tokyo-night.ts");
  const symbols = {};
  for (const name of Object.keys(ICONS)) {
    const { default: Icon } = await dynamicIconImports[name]();
    symbols[name] = renderToStaticMarkup(createElement(Icon, { x: 36, y: 36, width: 120, height: 120 }));
  }
  // Native alerts have no page or theme. Use the default light palette so
  // the same agent's color is recognizable on every subscribed device.
  const colors = Object.fromEntries(
    Object.entries(tokyoNight.light)
      .filter(([name]) => name.startsWith("agent-") || name === "primary")
      .map(([name, color]) => [name.replace("agent-", ""), color]),
  );
  await writeFile(`${web}dist/notification-symbols.json`, JSON.stringify({ symbols, colors }));
} finally {
  await server.close();
}
