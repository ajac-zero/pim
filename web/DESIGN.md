# Design

How Pim's web app should look and feel. Use this file when you build or change UI in `web/`.

Pim should feel like a quiet native messaging app, not an AI dashboard. The window is almost colorless. Agent avatars supply the color, and solid black marks the action to take. Every other element stays restrained so the avatars stand out.

## Principles

- **Neutral surfaces.** Use white and light grays for everything structural. Show hierarchy with surface tone and text gray, not borders, shadows, or bold type.
- **Color has meaning.** Saturated color appears only on agent avatars and on semantic signals (links, unread, success, diffs, errors). Never use it for decoration.
- **Black is the primary action.** Each view has at most one solid black button. Every other button is a gray pill or a ghost.
- **Content first.** Chrome stays thin: one header line, hairline dividers, and no panel borders inside the window.
- **Generous space.** Rows and messages get room to breathe. When something feels crowded, remove elements before shrinking them.

## Color

All tokens live in [`src/styles/app.css`](src/styles/app.css) and follow the shadcn/ui variable names. Components use the tokens, never raw colors.

| Token | Light | Use |
| --- | --- | --- |
| `--background` | `oklch(0.985 0 0)` | Chat canvas, modals, inspector |
| `--sidebar` | `oklch(0.97 0 0)` | Sidebar, one step darker than the canvas |
| `--muted` / `--secondary` | `oklch(0.94 0 0)` | Agent message bubbles, cards in the transcript, search and input fills, selected rows, secondary buttons, chips |
| `--border` | `oklch(0.92 0 0)` | Hairline dividers between panes, outlines on fields and settings cards |
| `--foreground` | `oklch(0.18 0 0)` | Body text and titles |
| `--muted-foreground` | `oklch(0.6 0 0)` | Previews, timestamps, section labels, placeholders, system events |
| `--primary` | `oklch(0.145 0 0)` | Primary buttons, the send button, user message bubbles |
| `--primary-foreground` | `oklch(0.985 0 0)` | Text and icons on primary |

Semantic colors, used only for their meaning:

| Role | Light | Use |
| --- | --- | --- |
| Link / unread | `oklch(0.55 0.2 258)` | Inline links, unread dots, toggles that are on, the focus ring |
| Success | `oklch(0.65 0.17 152)` | The "Done" status, additions in diff stats |
| Destructive | `oklch(0.577 0.245 27)` | Errors, deletions in diff stats, inline code text |

**Dark mode** keeps the same structure with inverted steps. The canvas is a dark neutral gray, the sidebar is one step darker, and bubbles and fills are one step lighter. Primary inverts to near-white with dark text, and user bubbles invert with it. Avatar colors stay the same.

## Agent avatars

The avatar is Pim's only illustration and its main way to identify an agent. Each agent has:

- **A shape:** circle, blob, rounded square, pill, triangle, hexagon, cloud, or drop.
- **A color**, from one palette of 10 flat, saturated hues: brown, red, orange, amber, green, teal, blue, violet, pink, and gray.
- **A face:** two small white slanted strokes for eyes, placed in the upper right of the shape. The avatar has no mouth, outline, gradient, or shadow.

Avatars are flat filled vector shapes that render the same at every size:

| Size | Where |
| --- | --- |
| 16px | Inline mentions in text and system events ("Messages from ● Research") |
| 20px | Chat header, routine references |
| 40px | Sidebar rows |
| 96px+ | Agent creation and onboarding |

A group conversation shows a cluster of two or three overlapping avatars in the space of one. Pim's own mark is the circle avatar in black.

## Typography

Use the system UI font stack (`ui-sans-serif, system-ui, -apple-system, …`), which is SF Pro on Apple devices. Keep the scale small:

| Style | Size / weight | Use |
| --- | --- | --- |
| Display | 48–56px, semibold, tight tracking | Sign-in wordmark only |
| Title | 20px, semibold | Modal and page titles |
| Body | 15px, regular | Messages, row titles, inputs, buttons |
| Meta | 13px, regular, muted | Timestamps, previews, section labels, field labels, system events |
| Code | 14px mono, destructive color on a muted chip | Inline code |

Use only regular and medium weight below title size. Show emphasis with color (foreground vs. muted), not weight. Previews and long titles truncate to one line with an ellipsis.

## Shape and elevation

| Radius | Use |
| --- | --- |
| Full (pill) | Every button, chip, tag, status badge, toggle, the composer's circular buttons |
| ~18px | Message bubbles, cards in the transcript, modals, the composer |
| ~12px | Sidebar selection, search field, text inputs, settings cards |
| ~10px | File and plugin icons |

Surfaces inside the window are flat. Only floating layers get elevation: modals, popovers, and menus have a soft, wide shadow, and modals dim the content behind them with a translucent black scrim.

## Layout

The app uses three panes separated by hairline dividers:

```
┌──────────────┬───────────────────────────────┬──────────────┐
│ Sidebar      │ Header: avatar + name   icons │ Inspector    │
│  Search      ├───────────────────────────────┤ (optional)   │
│  Group label │                               │  ‹ Title  »  │
│   rows       │   Transcript                  │  fields      │
│  Group label │                               │              │
│   rows       │                               │              │
│              │  ┌ + ─ Message <agent> ── ● ┐ │              │
│ Apps / user  │  └──────────────────────────┘ │              │
└──────────────┴───────────────────────────────┴──────────────┘
```

- **Sidebar** (~320px). It holds a search field and a new-chat `+`, then conversations grouped under muted labels by cadence ("Daily", "Every week", "Unassigned"). The footer has entries for apps or plugins and the user's avatar and name.
- **Conversation row** (~60px tall). It shows the avatar, a one-line title, an optional tag chip, the time right-aligned in muted text, and a one-line preview. An unread conversation gets a blue dot on the right. The selected row gets a muted fill with a 12px radius.
- **Header.** It shows the agent's avatar and name on the left and icon-only actions (share, open screen) on the right. It has no background change, only a bottom hairline.
- **Transcript.** It has a readable max width (~720px) and wide gutters.
- **Inspector** (~360px). It opens on the right to edit an object such as a routine or an agent's settings. Its header has a back chevron, a centered title, and a collapse control.

On narrow screens, show one pane at a time and keep the same components.

## Components

### Messages

- **Agent messages** are muted bubbles without avatars, aligned left and up to ~85% of the transcript width. Consecutive messages stack with a small gap.
- **User messages** are primary (black) bubbles with light text, aligned right.
- **Reactions** sit as a small pill on the bubble's lower corner.
- **Hover actions** (react, reply, more) float as bare icons beside the bubble and appear only on hover.
- **Timestamps** ("Today 10:01 AM") and **system events** ("Created routine ⏱ Daily review", "Renamed to Research") are centered muted text, never bubbles. A referenced object shows its icon or avatar inline and is clickable.

### Cards in the transcript

Rich results render as muted cards with the bubble radius:

- **Task or PR card:** a title with a status pill on the right (a green dot + "Done"), then muted metadata lines with icons (branch, "± 10 files changed +189 −81"), then actions: a black primary button and an outlined secondary or split button.
- **File card:** a file-type icon tile, the name, the size in muted text, and a download icon. It uses a white fill with a hairline border.
- **Checklist summary:** one line per item, "✓ **Source** → result", with the source in medium weight.

### Composer

The composer is a single rounded field at the bottom of the transcript with a hairline border and no fill change. It has a muted circular `+` on the left, the placeholder "Message <agent name>", and a black circular button on the right. The button shows a mic when the field is empty and send when it has text.

### Buttons

| Variant | Look | Use |
| --- | --- | --- |
| Primary | Black pill, white text | The single main action ("Get started", "Test run", "View PR") |
| Secondary | Muted pill, foreground text | Other actions ("Add", "Delete", "Use an existing agent") |
| Outline | Background pill, hairline border | Secondary actions next to a primary, split buttons |
| Ghost | Text and icon only, muted | Inline actions ("+ Add another", "View all") |
| Icon | Circular, muted fill or bare | Toolbar and composer actions |

A disabled button keeps its shape and turns muted with muted text. A destructive action uses the secondary style and confirms before acting.

### Forms

- A field has a muted 13px label above it and a 12px radius. Fields have a white fill with a hairline border, except search, which has a muted fill and no border.
- Related settings sit in a bordered settings card with rows inside it. Repeatable rows end with a ghost "+ Add another".
- Toggles are iOS-style switches that turn blue when on, with the label to their right.
- Empty states are a single muted line ("No runs yet", "No chats yet"), with no illustration.

### Chips and tags

- **Filter chips:** outlined pills. The selected chip has a muted fill.
- **Tags** next to a title ("Team", "SEO content"): small muted pills with 13px muted text and an optional leading icon.
- **Status pills:** a colored dot and a label, on a tint of the status color.

### Lists of apps and templates

Use a two-column grid of rows: a 48px icon tile, a name, a one-line muted description, and a secondary "Add" pill on the right. Name each section with a muted label, with an optional "View all" ghost link on the right. Above the list, an installed summary shows a stack of overlapping icon tiles with "6 installed ›".

### Modals

A modal is a centered background surface with an 18px radius, a soft shadow, and the dimming scrim. It has a title, muted body copy, and actions at the bottom: the secondary button on the left and the black primary on the right. An announcement modal leads with a large avatar centered above the title. Close with a bare `×` in the top right.

### Agent creation

Center the layout on a large preview avatar. Below it, add a row of color swatches and a row of shape options; the selected option gets a ring in the link color. Then come the name field and a black "Get started" button, disabled until the name is valid. Show template suggestions below as large cards with an avatar, a title, and a two-line muted description.

### Sign-in

Show the black Pim mark and the wordmark centered on the bare canvas, with a one-sentence tagline and a single black pill "Sign in →" below. Add nothing else.

## Icons

Use lucide icons at a 1.5px stroke, 16–20px, in muted or foreground color. Icons support labels and never replace avatars. Avoid filled or colored icons except brand logos for connected apps.

## Motion

Motion is quick and subtle: 150–200ms ease-out fades and small rises for new messages, popovers, and modals. Avoid bouncing, sliding panels, and looping animation except progress indicators. Respect `prefers-reduced-motion`.

## Writing

UI text is short and plain. Write labels in sentence case ("Add another", "Run history"). Agents speak in first person and report results tersely. System events read as past-tense facts ("Created routine Daily review").
