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
- Settings layout: sectioned, never one long page. A 168px sub navigation on the left lists General, Model providers, Connectors, Qualification, and Suppressions, each its own route under /settings. The active item gets accent text and a 2px accent bar on the left edge, the same language as the nav rail; hover is a faint ink tint, no pill. A section whose configuration needs attention shows a small amber dot in the sub navigation. Below 900px the sub navigation becomes a horizontal strip above the content that scrolls sideways, and the active bar moves under the item like a tab. Links elsewhere in the app point at the specific section (for example /settings/models from a model attention notice).
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
- Lead capture entry (Research): a quiet card at the top of the run list column titled "From a LinkedIn post". One URL field with placeholder "Paste a LinkedIn post URL" (a schemeless linkedin.com paste gets https:// prepended), then an options row labelled "Include" with two checkboxes ("People who reacted", "People who commented", both on), a people cap numeric input labelled "People per source" (default 50, max 500), an "Enrich new people" toggle with its own cap (default 25, max 200), and a primary "Capture leads" button that is disabled with a reason line when Apify is not connected or in error (link to /settings/connectors), the connection check itself failed, or the typed URL does not look like a LinkedIn post. Under the button, one muted sentence: runs on your own Apify account, the dated store prices for the default actors (per 1,000 results, with dollar signs), and the sentence that item caps bind only pay per result actors. Submitting starts the run and opens its detail; the run ledger shows the eight steps. No cost math, no fake totals.
- Lead capture actors (Settings, inside the Apify card body when connected): a subsection "Lead capture actors" with three labelled inputs (Reactions, Comments, Profile enrichment) prefilled with the defaults, a save action, and per field reset to default; one muted line says these actors run on your account and that agent started captures need them on the allowlist.
- Connector card (Settings): collapsible, with the same disclosure header as the model provider cards. The header row reads left to right: a 26px monogram mark (two plain letters on a bordered tile, accent tinted when that provider is in use; initials, never brand logos), the name, a muted summary when collapsed and connected (Apify: how many actors agents may use; AgentMail: the sending address), then at the right the state as a 7px dot with a 12px label (accent In use, danger Error, filled neutral Connected, hollow Not connected) and a chevron that rotates 90 degrees when open. The whole header is the toggle with a faint hover tint; the body fades in 2px from above, skipped under reduced motion. Cards start collapsed and a card whose connection has an error opens on its own. Expanded: connection state (Connected with the token masked to its last four characters, Not connected, or Error with the server's message), one primary action (Connect or Reconnect), a quiet Remove action, and the actor allowlist as removable chips with an add field. The token field is a password input with a one line note that the token is stored unencrypted in the local database file on this computer and sent only to the provider.
- Import setup (Research): a right sheet, same frame as the record sheet. Actor search field with result rows (title, author, short description, pricing hint), a selected actor summary, a JSON input editor prefilled from the actor's example input when available, a max items field showing the default and hard cap, and one note that the run bills the user's own Apify account. Primary button reads "Start import run".
- Model providers (Settings): one section holding a card per provider (Anthropic, OpenAI, DeepSeek, Z.ai, Ollama), each with the collapsible header described under Connector card (collapsed and connected, the summary is the model name). Above the cards, one status line states what chat and drafting use, led by an 8px dot: accent with a tint halo when a provider is ready, amber when it needs attention, hollow when none is in use. Expanded, each card is the same frame as the Apify card: key field with the unencrypted storage note (Ollama has a base URL field instead of a key, defaulting to the local server), a model select with price hints ("Opus 5.5, 4.00 in / 20.00 out per million tokens"; Ollama lists installed models with "local, no cost"; DeepSeek hints say peak price). A connected card shows a "Use this provider" control; exactly one configured provider is active, shown plainly at the top of the section and in the agent panel hint. One line says costs are estimates from list prices as of their stated date, and one line per card says chat and drafting send record contents to that provider (for Ollama, to the local server at the configured address).
- Draft outreach sheet (Research): audience picker (a tag, or everyone eligible), a plain multiline instructions field, max people (default 10, cap 25), optional budget in dollars, and a preflight line with the estimated cost range, labelled estimate. Primary button "Draft N messages". A line states drafts are created for review and nothing is sent.
- Draft review (approval card variant): count, estimated cost observed (labelled estimate), and every draft as a collapsible row (person and subject as the summary; body and the model reported facts expanded). Expanded by default in the Research run detail, collapsed in the compact panel and Today cards. The user must be able to read every word they approve. Approve button reads "Save N drafts". After approval each draft is an activity on its person, labelled "Draft, not sent".
- Chat usage line: when a model reply arrives, a muted line under it shows tokens and estimated cost ("312 in / 184 out, about $0.005, estimate"). Tabular numerals.
- AgentMail connector card (Settings): same frame as the other cards. Key field with the storage note, then the inbox: a select of existing inboxes by address, a quiet "Create inbox" action with an optional username field, and the connected inbox shown plainly. One line names the provider's own daily sending limits and the app's cap of 50 accepted sends per inbox per day.
- Send review (approval card variant): the strictest card in the product. Every message rendered in full (to, subject, body, sending inbox), expanded in the Research and Today surfaces, with the excluded list and its reasons above the fold, the remaining daily cap, and one line: "Approving sends these exact messages. Nothing can be edited after approval." Approve button reads "Send N messages"; Reject stays quiet. This card never collapses bodies.
- Outbox (Today section): intents grouped by state with honest labels: Waiting for your approval, Queued, Submitting, Accepted by the provider (not delivery), Replied, Blocked with reasons, Unknown outcome (needs you), Bounced, Failed. Unknown and blocked rows carry an acknowledge control. A muted line shows the remaining daily cap and the last sync time.
- Replies (Today section): inbound messages linked to people, newest first, each with an open record action and the task it created. Opt out detections show the matched wording and the suppression it created, with a lift control.
- Person timeline: email_out entries say "Sent (provider accepted)" and email_in entries say "Reply received"; bodies render as plain text, never HTML.
- CSV import sheet (Relationships): same right sheet frame. Step one: a file picker plus drop zone, then the parse summary (file name, row count, delimiter). Step two, mapping: one row per CSV column with the header, two sample values in muted text, and a field select defaulting to the server's suggestion (Ignore for unknowns). A plain inline error until email or a name field is mapped. Primary button "Stage N rows for review". The staging run then behaves like any import: ledger, review approval, batch sheet.
- Fit column (Relationships, people): tabular "4/6" for matched of total, followed by a muted "2 unknown" count when unknowns exist, an "Excluded" muted chip for excluded people, and quiet muted text "Not qualified yet" when no result exists. When the person changed after the result was computed, muted "out of date" text follows the numbers. Never a bare percentage, never a color scale; the numbers and the unknown count stay separate. Sortable by fit.
- Qualification section (person sheet): one row per criterion with a shaped marker (filled accent for matched, hollow ring for not matched, dashed ring for unknown), the label, and a muted reason naming the evidence and its age. Exclusions render first with their reasons. A quiet "Qualify now" action recomputes for this person via a qualify run scoped by tag when available, otherwise the full run.
- Qualification settings (Settings): two lists, Exclusions and Criteria. Each row: enable toggle, label, target and field selects, operator select, values as removable chips with an add field. Add and remove rows, no drag ordering. One line explains the semantics: a missing value is unknown and unknown never counts as a match.
- Import review (approval card variant): the warn tint frame, a counts row in tabular numerals (fetched, staged, duplicates, invalid), a sample table of up to five mapped rows (name, email, company; lead capture batches add title and profile URL columns and a "From a LinkedIn post" line with the post URL), a link to the full batch, and "Approve staged rows" and "Reject" buttons. Duplicates and invalid rows are listed as counts with reasons available in the batch view, never hidden.
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
