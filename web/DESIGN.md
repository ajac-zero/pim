# Design

How Pim's web app should look and feel. Use this file when you build or change UI in `web/`.

Pim should feel like a quiet native messaging app, not an AI dashboard. The window is almost colorless, a solid primary color marks the action to take, and the only other color comes from agents' icons and from signals that mean something. Themes choose colors, fonts and icon style; layout, spacing and shapes stay consistent.

## Principles

- **Quiet surfaces.** Use the theme's background and muted tones for everything structural. Show hierarchy with surface tone and muted text, not borders, shadows, or bold type.
- **Color has meaning.** Color appears only on agent icons and on semantic signals (links, unread, success, diffs, errors). Never use it for decoration.
- **Primary is the action.** Each view has at most one solid primary button. Every other button is a muted pill or a ghost.
- **Content first.** Chrome stays thin: one header line, hairline dividers, and no panel borders inside the window.
- **Generous space.** Rows and messages get room to breathe. When something feels crowded, remove elements before shrinking them.

## Color

Components use the tokens in [`src/styles/app.css`](src/styles/app.css), never raw colors; they follow the shadcn/ui variable names. A theme gives every token a value.

| Token | Use |
| --- | --- |
| `--background` | Chat canvas and modals |
| `--sidebar` | Sidebar, one step off the canvas |
| `--muted` / `--secondary` | Cards in the transcript, search and input fills, selected rows, secondary buttons, chips |
| `--border` | Hairline dividers between panes and between an agent's consecutive messages, outlines on fields, tables and settings cards |
| `--foreground` | Body text and titles |
| `--muted-foreground` | Previews, timestamps, section labels, placeholders, system events |
| `--primary` | Primary buttons, the send button |
| `--primary-foreground` | Text and icons on primary |
| `--bubble` / `--bubble-foreground` | User message bubbles; the primary colors unless a theme sets them |
| `--agent-<color>` | An agent's icon and its tinted tile, one per color the API accepts |

Semantic colors, used only for their meaning:

| Token | Use |
| --- | --- |
| `--link` / `--ring` | Inline links, unread dots, toggles that are on, the focus ring |
| `--success` | The "Done" status, additions in diff stats |
| `--destructive` | Errors, deletions in diff stats, inline code text |

### Themes

A theme chooses colors and may choose bundled fonts and an icon set. Every theme has a light and a dark mode. People pick both in Settings, under General → Appearance, where each theme previews its colors, typography and icons in the current mode.

- **Tokyo Night** (the default in `pim.config.ts`): "Night" navy for dark mode and the "Day" palette for light mode, with text darkened for contrast. Its blue is the primary.
- **Pixel:** Tokyo Night's palettes with Pixeloid Sans (regular and bold) for interface text, Pixeloid Mono for code, and pixel-outline icons. Other themes keep system fonts and Lucide icons unless they explicitly choose another bundled style.
- **Gronk:** neutral grays, with a near-black primary in light mode that inverts to near-white in dark mode. User bubbles invert with it.
- **Classics:** Catppuccin (Latte / Mocha), Solarized, Gruvbox (medium), Rosé Pine (Dawn / Main), One (Light / Dark), Everforest (medium), Nord (a light mode built from its Snow Storm palette), Dracula (Alucard / Dracula), and Ayu (Light / Mirage). Each uses the official palette, adjusted only in lightness where a pair missed contrast; each theme's header comment lists its deviations.
- **Gronk:** neutral grays, with a near-black primary in light mode that inverts to near-white in dark mode. User bubbles invert with it.
- **Moose:** cool grays with black (light) or white (dark) buttons, white cards on a gray canvas in light mode, and sky-blue user bubbles.

Parody themes like Gronk and Moose are playful nods to apps that inspired Pim. Give them a spoof name and the inspiration's general palette, never its real name, logo, or other brand assets.

In every theme the sidebar is one step off the canvas, bubbles and fills are one step from the canvas, and body text on the canvas meets WCAG AA contrast (4.5:1).

Themes are data an extension brings (see [docs/extensions.md](../docs/extensions.md#themes)); Pim's own are the `pim.themes` extension in [`src/extensions/themes/`](../src/extensions/themes/), one file each. To add one, copy a file there, give every token a value in `light` and `dark`, name its Shiki code themes, and list it in that folder's `index.ts`. When Shiki ships only a dark code theme, make the light one by recoloring it: map each of its colors (`web/src/lib/themes.test.ts` checks none is left). Agent colors should take the theme's own hues, and none should match the primary, since "no color" means primary.

## Agent icons

An agent is identified by its own icon: a named symbol drawn in the theme's icon set or an emoji in the agent's color, or an image the person uploaded (see `AgentIcon` in `src/components/agent-icon.tsx`). Show it on a tile tinted with its color wherever it stands for the agent: about 24px in headers and menus, 32–40px in lists and cards. Pim's own mark is the pixel wordmark (`PimMark`). It keeps its own colors in every theme. Emoji, uploaded images and app logos do not change with the icon set.

## Typography

Use the theme's UI and monospace font variables (`--theme-font-ui` and `--theme-font-code`), including in forms, dialogs and notifications. They default to the system stacks, which use SF Pro on Apple devices for UI text. Pixel fonts are bundled and fall back to system fonts for unsupported characters. Keep the scale small:

| Style | Size / weight | Use |
| --- | --- | --- |
| Title | 20px, semibold | Modal and page titles |
| Body | 15px, regular | Messages, row titles, inputs, buttons |
| Meta | 13px, regular, muted | Timestamps, previews, section labels, field labels, system events |
| Code | 14px mono, destructive color on a muted chip | Inline code |

Use only regular and medium weight below title size. Show emphasis with color (foreground vs. muted), not weight. Previews and long titles truncate to one line with an ellipsis.

## Shape and elevation

| Radius | Use |
| --- | --- |
| Full (pill) | Every button, chip, tag, status badge, toggle, the composer's circular buttons |
| ~18px | User message bubbles, cards in the transcript, modals, the composer |
| ~12px | Sidebar selection, search field, text inputs, settings cards |
| ~10px | File and plugin icons |

Surfaces inside the window are flat. Only floating layers get elevation: modals, popovers, and menus have a soft, wide shadow, and modals dim the content behind them with a translucent black scrim in every theme.

## Layout

The app has two panes, a sidebar and the content, separated by a hairline divider.

- **Sidebar.** A rail of icons, one tone darker than the sidebar, beside a panel. The content stays on the conversation; the rail changes the panel. The rail has Pim's mark, then notifications, chats, artifacts, files, skills and schedules at the top, and discover, apps, sharing, settings and your profile at the bottom. The top icons choose what the panel lists, and the URL keeps that choice (`?panel=artifacts`) as you move between chats. The bottom ones open over the page instead, so you never lose your place: Discover, Apps, Sharing and Settings (with a tab per part) as modals, your profile (your initial) as a popover to edit it. Each icon's label is its tooltip, and a dot marks one with something waiting. Each panel has its title, with its one action, if any, as an icon button beside it (new chat, mark all as read). The chats panel then has a search field with a muted fill, then each agent's chats under the agent's name. The other panels list rows with a 32px icon tile, a title and a muted line below it. The selected row or icon gets a muted fill with a 12px radius. Choosing the panel that's already showing collapses the sidebar to the rail; choosing any panel brings it back.
- **Chat header.** The open chats as folder tabs on a shelf in the sidebar's tone. A tab shows the agent's icon, the chat's title, and a mark when the chat is working or waiting for an approval; the close button takes the mark's place on hover. The open chat's tab is the canvas's tone, with 12px top corners and bottom corners that flare into the shelf, so it runs into the transcript with no line between them. The others are muted text on the shelf. As in a browser, a chat opened from the sidebar shows in the current tab, in place of its chat; Open in new tab in the chat's menu, or dragging the chat onto the conversation, gives it a tab of its own. While a chat is dragged over the conversation, a small card in the middle, like a menu, says Open in new tab under its icon. With a single chat open there are no tabs: its agent's icon and title sit on the canvas. On narrow screens there are no tabs.
- **Transcript.** It has a readable max width (~720px) and wide gutters.

On narrow screens there is no sidebar. A bar along the bottom, in the sidebar's tone with a hairline above it, takes its place: notifications, chats, a centered primary New chat icon button, artifacts, and More. New chat opens the majordomo's dashboard, where sending the first message starts a chat. The chosen panel's icon sits on a muted pill, and a dot marks one with something waiting. Chats, notifications and artifacts fill the screen with their panel; choosing a row opens it. More opens a bottom sheet with your profile, then files, skills and schedules, then Discover, Apps, Sharing and Settings. The bar stays on every page, as the rail does; in a chat it sits below the composer, under a header line with the agent's icon and the chat's title, and the chats icon is the chosen one.

## Components

### Messages

- **Agent messages** are plain text on the canvas, without a bubble or icon, using the transcript's whole width so tables, code, and long formatted answers have room. A faint hairline separates an agent's consecutive messages.
- **User messages** are `--bubble` bubbles with `--bubble-foreground` text, aligned right. Their Markdown renders as in agent messages, except that line breaks stay as typed and headings are bold text. Links, code, and table lines take the bubble's text color.
- **Message times** are small muted text under each message: left-aligned under an agent's, right-aligned under a user's bubble. They fade in and out with the copy button on hover or keyboard focus, keeping their space when hidden. A message from another day shows its date too.
- **Hover actions** (copy, retry) are bare icons beside the message's time and appear only on hover or keyboard focus.
- **Timestamps** ("Today 10:01 AM") and **system events** ("Approved: rename the agent", "Scheduled check-in") are centered muted text, never bubbles. A referenced object shows its icon inline and is clickable.

### Cards in the transcript

Rich results render as muted cards with the bubble radius:

- **Approval card:** the action's summary with a status pill on the right, its details as muted rows, then an outline Deny button and a primary Approve button.
- **File card:** a file-type icon tile, the name, the size in muted text, and a download icon. It uses the background fill with a hairline border.

### Composer

The composer is a single rounded field at the bottom of the transcript with a hairline border and no fill change. The text takes its full width on top, with the placeholder "Message <agent name>", and grows up to eight lines before it scrolls. Below it is a row of controls: a muted circular `+` on the left, and on the right a primary circular send button, which becomes stop while the agent works. New composer controls go in that row.

On an agent's dashboard, the composer stays at the same bottom position as in a chat, with suggested first messages above the field. The header and widgets scroll independently above it, so starting a chat does not move the prompt bar.

The agent's name in the dashboard header is a compact dropdown with a small chevron. It lists only your other agents with their icons, without a selection indicator. With no other agents, the name has no dropdown. Choosing another updates the dashboard and composer without starting a chat, keeping unsent text; the first message starts the chat with the selected agent.

On touch-first devices, sending dismisses the keyboard, and opening a chat does not focus the input automatically. On desktop, sending keeps the input focused for the next message.

### Buttons

| Variant | Look | Use |
| --- | --- | --- |
| Primary | Primary pill, primary-foreground text | The single main action ("Approve", "Save", "Create") |
| Secondary | Muted pill, foreground text | Other actions ("Add", "Delete", "Use an existing agent") |
| Outline | Background pill, hairline border | Secondary actions next to a primary, split buttons |
| Ghost | Text and icon only, muted | Inline actions ("+ Add another", "View all") |
| Icon | Circular, muted fill or bare | Toolbar and composer actions |

A disabled button keeps its shape and turns muted with muted text. A destructive action uses the secondary style and confirms before acting.

### Forms

- A field has a muted 13px label above it and a 12px radius. Fields have the background fill with a hairline border, except search, which has a muted fill and no border.
- Related settings sit in a bordered settings card with rows inside it. Repeatable rows end with a ghost "+ Add another".
- Toggles are iOS-style switches that turn blue when on, with the label to their right.
- Empty states are a single muted line ("No runs yet", "No chats yet"), with no illustration.

### Chips and tags

- **Filter chips:** outlined pills. The selected chip has a muted fill.
- **Tags** next to a title ("Team", "SEO content"): small muted pills with 13px muted text and an optional leading icon.
- **Status pills:** a colored dot and a label, on a tint of the status color.

### Lists of apps and templates

Rows with an icon tile, a name, a one-line muted description, and a secondary pill action on the right. Name each section with a muted label.

### Modals

A modal is a centered background surface with an 18px radius, a soft shadow, and the dimming scrim. On narrow screens, large modals (Settings, Apps, Sharing, Discover) fill the screen, and small ones, such as an agent's settings, rise from the bottom as sheets with rounded top corners. It has a title, muted body copy, and actions at the bottom: the secondary button on the left and the primary on the right. Close with a bare `×` in the top right.

### Sign-in and onboarding

Keep these screens plain: Pim's mark, a title, one muted sentence, the fields, and one primary button.

## Icons

Import utility icons from `src/components/icons.tsx`, not directly from an icon library, so the theme selects their drawings. The default is Lucide; Pixel uses grid-aligned outlines. Use icons at 16–20px, in muted or foreground color. Icons support labels. Avoid filled or colored icons except brand logos for connected apps.

## Motion

Motion is quick and subtle: 150–200ms ease-out fades and small rises for new messages, popovers, and modals. Avoid bouncing, sliding panels, and looping animation except progress indicators and the gentle pulse of unread reply dots in Inbox. Respect `prefers-reduced-motion`.

## Writing

UI text is short and plain. Write labels in sentence case ("Add app", "Mark all as read"). Agents speak in first person and report results tersely. System events read as past-tense facts ("Approved the rename").
