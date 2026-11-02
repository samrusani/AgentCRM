# Design system

AgentCRM is a precision instrument for relationship work. The design reads like a well made tool: dense, calm, and immediate. Speed is part of the aesthetic. Nothing shimmers, nothing bounces, and the one expressive element is the agent panel's run ledger.

## Direction

- The subject is relationship data and agent work. Structure carries the design: rules, alignment, and type weight encode hierarchy. Decoration that carries no information gets cut.
- Light appearance is the default because this is a daytime professional tool. Dark appearance is a first class equal, switched by system preference with a manual override stored locally.
- One place gets the boldness budget: the run ledger in the agent panel, where agent work renders as a precise live timeline. Everything else stays quiet.
- Density over whitespace theatre. Rows are 36px, type is small but crisp, and a laptop screen shows real amounts of data.

## Color tokens

Define as CSS custom properties on `:root`, redefined under the dark scheme. Never hardcode hex values in components.

| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| `--bg` | #F6F7F9 | #121418 | Page background |
| `--surface` | #FFFFFF | #191C21 | Panels, table rows, cards |
| `--surface-raised` | #FFFFFF | #1F232A | Popovers, command palette |
| `--ink` | #1A1D23 | #E7EAEE | Primary text |
| `--ink-muted` | #5B6472 | #959DAB | Secondary text, labels |
| `--line` | #E3E6EB | #262B33 | Hairline borders, table rules |
| `--accent` | #15685B | #43B39C | Primary actions, links, active nav, focus rings |
| `--on-accent` | #FFFFFF | #15211E | Text on accent fills; white on the dark appearance accent would fail the contrast floor |
| `--accent-tint` | #E7F2EF | #1A2B27 | Selected rows, active chip backgrounds |
| `--warn` | #8A5C00 | #E0A83E | Awaiting approval, needs attention |
| `--warn-tint` | #FBF3DF | #332A14 | Approval banners and chips |
| `--danger` | #B42318 | #F0756A | Destructive actions, failures |
| `--danger-tint` | #FBEAE8 | #33201E | Failure chips |

The viridian accent is the product's color identity. Amber is reserved for exactly one meaning: a human decision is needed. Red is reserved for failure and destruction. Do not use the accent for status; status has its own two colors plus muted ink for neutral states.

## Typography

- Family: Geist variable (`@fontsource-variable/geist`) with fallback `system-ui, -apple-system, "Segoe UI", sans-serif`. If the package is unavailable, ship the system stack alone; the design must hold up on it.
- Scale: 12, 13, 14, 16, 20, 26. Base UI text is 13px with line height 1.45. Page titles 20/600. Record names in tables 13/550.
- Numbers in tables, counts, and amounts always set `font-variant-numeric: tabular-nums`.
- Sentence case everywhere: headings, buttons, labels, table headers. No all caps labels anywhere.
- No em dashes in any UI copy. Use a comma, colon, or parentheses.

## Layout

```
+----+----------------------------------+-----------+
|nav | header: workspace, search (cmd k)| agent     |
|rail+----------------------------------+ panel     |
|    |                                  |           |
| T  |  content area                    |  context  |
| R  |  (table / board / record)        |  chip     |
| P  |  left aligned, max none          |  chat     |
| S  |                                  |  run      |
|    |                                  |  ledger   |
+----+----------------------------------+-----------+
```

- Nav rail: 208px, collapsible to 56px icon rail. Destinations: Today, Relationships, Pipeline, Research. Settings pinned at the bottom. Active item gets accent text and a 2px accent bar on the left edge, no filled pill.
- Header: 48px, contains workspace name, global search field that opens the command palette (cmd k or ctrl k), and the agent panel toggle.
- Agent panel: right side, default 360px, drag to resize between 300 and 520, collapses to a 28px edge tab that keeps a status dot (accent pulse while a run is active, amber when an approval waits). State persists in localStorage. Below 900px viewport width it becomes an overlay sheet.
- Content is left aligned, full width, no centered max width column. Tables run edge to edge of the content area with a hairline under the header row only; row separation comes from 1px `--line` rules, no zebra striping.

## Components

- Buttons: primary is accent fill, white text, 6px radius, 28px height. Secondary is `--surface` with 1px `--line` border. Destructive is danger text, filled only in confirmation dialogs. A button label says exactly what it does, never "Submit". In a bulk context it carries the quantity, "Approve 10 drafts"; on a card that already names its payload, "Approve" is enough.
- Chips: evidence and status chips are 20px tall, 4px radius, tint background with matching text color. An evidence chip shows source type and age, for example "imported, 3d" and opens the claim on click.
- Tables: virtualized above 200 rows (@tanstack/react-virtual). Sticky header. Row hover is `--accent-tint` at low strength. Selected rows show a left accent bar plus tint. Column headers are 12/500 `--ink-muted`.
- Pipeline board: columns are stage name plus count and amount sum, cards are flat surface with hairline border, 8px radius. Dragging is optional for v1; stage moves can use a menu. No shadows while static; a dragged card may lift with one small shadow.
- Record detail: opens as a 480px right sheet over the table (not a new page) with name, fields, evidence chips, timeline, tasks, and opportunities. Esc closes.
- Run ledger (the signature element): vertical timeline in the agent panel and on the Research screen. Each step is a row with a 8px status marker (hollow ring queued, accent pulse running, filled accent done, amber pause for waiting, danger for failed), title, and a muted detail line. The active step's ring pulses gently, the only unprompted motion in the product, disabled under `prefers-reduced-motion`. Counts render as plain tabular numbers, no progress bar theatrics.
- Approval card: warn tint background, title, payload summary, and two buttons, "Approve" and "Reject". After deciding it collapses to one line with the decision and timestamp.
- Command palette: center top overlay, groups People, Organizations, Opportunities, Actions. Keyboard first, arrow and enter navigation.
- Empty states: one sentence that says what the screen will show plus one action. No illustrations.

## Motion

- 120 to 160ms ease out transitions, only in response to a user action: sheet open, palette open, panel collapse, approval collapse.
- One exception: the active run step's pulse.
- Respect `prefers-reduced-motion: reduce` by disabling all transitions and the pulse.
- Never animate table rows, page loads, or numbers counting up.

## Performance rules

- Interactions render from cache first (TanStack Query), then reconcile. Stage moves apply optimistically and roll back visibly on failure. Send style actions are never shown optimistically.
- Virtualize long tables. Request only the fields a view renders.
- No layout shift from fonts: `font-display: swap` with metric compatible fallback, or system stack.
- Keep the main bundle lean. No component library, no CSS framework, no icon megapack. Hand write the CSS on the tokens above; use a small set of inline SVG icons (16px, 1.5px stroke) defined once.

## Voice

- Interface copy is calm and specific. "No model connected. Runs are simulated until you add one." beats any enthusiasm.
- Errors state what happened and what to do next. They do not apologize and they are never vague.
- An agent's uncertainty is stated as data: "2 of 12 addresses unverified", never hidden.
- Simulated or demo content is always labelled as such where it appears.

## Accessibility floor

- Visible 2px accent focus ring on every interactive element, offset 1px.
- All text at least 4.5:1 contrast against its background in both appearances.
- Full keyboard operation: tables, palette, approvals, and panel are reachable and operable without a mouse.
- Status is never conveyed by color alone; markers differ in shape or carry text.
