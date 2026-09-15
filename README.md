# ◭ Ascent

Simple Simple & elegant glossy project management elegant project management with **Anytype as the data backend**. Every project is a native Anytype page, every task a native Anytype task, every wiki article a native Anytype page — created, read, updated and deleted through the official local API (`2025-11-08`). Your data never leaves your machine.

Bun + zero npm dependencies. Runs on port **3004**.

## Quick start

1. Open the **Anytype desktop app** (it serves the local API on `http://127.0.0.1:31009`).
2. Start Ascent:
   ```sh
   cd ascent
   bun src/server.ts
   ```
3. Open http://localhost:3004 — the setup wizard walks you through:
   - **Pair**: click "Request pairing code", enter the 4-digit code shown in your Anytype app.
   - **Choose a space**: pick where Ascent creates and manages projects.
4. Create projects, drag tasks across the kanban board. Everything appears in Anytype instantly.

You can also pair headlessly with env vars instead of the wizard:

```sh
ANYTYPE_API_KEY=... bun src/server.ts   # key from Anytype → Settings → API Keys
```

## How data is stored

| Concept | Anytype representation |
|---|---|
| Project | `page` object (name, icon, markdown description) |
| Task | `task` object (title, done checkbox, due date, markdown notes) |
| Wiki article | `page` object (title, markdown body) |
| Project ↔ task link | `data/links.json` (local index only) |
| Project ↔ article link | `data/links.json` (local index only) |
| Kanban column | `data/links.json` (`backlog` / `in_progress` / `review` / `done`) |

Due dates are calendar days, not instants: the day you pick in the task modal is the day that renders back, in every timezone (date-only values are parsed as local midnight, and "overdue" means the due day has passed).

All *content* lives in your Anytype space. The local `data/` directory (gitignored) holds only the API key, the chosen space, and the link index — which project each task belongs to and which board column it's in. Checking a task done in Ascent checks it done in Anytype, and vice versa.

Task property keys (`done`, `due_date`) are **discovered at setup** via `GET /v1/spaces/{id}/properties` — nothing is hardcoded, so it adapts to your space.

### Import, don't duplicate

Already track work in Anytype? Use **Import** on the Projects page or inside a project to link existing pages/tasks instead of recreating them. Imported items are never deleted by Ascent — removing one only unlinks it. Items Ascent created itself *are* deleted in Anytype when you delete them here (with a confirmation).

### ClickUp import + two-way sync (manual ⇄ Sync)

Coming from ClickUp? The task-import dialog has a second **ClickUp** tab next to Anytype. Paste a **Personal API token** (in ClickUp: your avatar → *Apps* → *Personal API token*) and browse workspace → space → folder/list → tasks, with a breadcrumb trail, select-all, and one-click import into the current project.

Imported tasks become **native Anytype tasks** through the exact same creation path as manually added tasks (title, done checkbox, due date, markdown notes — the done/due property keys are the ones discovered at setup). Importing from a list also **binds that list to the project**; or use **⛓ Link this list to the project** in the ClickUp task-list pane to bind a list *without* importing anything. A bound project shows a **⇄ Sync** button in the project view, with a "Last synced …" label next to it.

**Sync is manual only** — there is no polling and no background writer. Pressing ⇄ Sync:

- pulls ClickUp-side edits into Anytype, pushes Anytype-side edits to ClickUp (PUT), imports brand-new ClickUp tasks as native Anytype tasks, and creates brand-new Anytype tasks in the ClickUp list (POST);
- resolves conflicts by **most-recent-wins** when both sides changed, and **ClickUp wins when Anytype carries no usable timestamp**;
- **never synchronizes deletions** — a mapped task missing on one side is reported ("missing on one side — left alone") and untouched on the other;
- reports a summary like `⇄ Sync: 3 pulled from ClickUp · 2 pushed · 1 conflict (ClickUp won)`;
- maps statuses both ways: closed ClickUp statuses → `done`; `in_progress`/`review` by status-name hints; anything else → `backlog`, and the reverse picks the best-matching status of the bound list (falling back to the first open/closed status).

The token is **never returned to the browser** — `GET /api/integrations/clickup/status` only answers `{connected: true|false}`, the binding endpoints return only `{list_id, list_name, last_sync}`, and every ClickUp API call is proxied through the Ascent server. Disconnecting clears the token but keeps bindings, mappings, and sync snapshots; deleting a project drops its binding and sync state without touching the remote list.

The token lives only in the server-side `data/links.json` (gitignored, never committed). A `clickup_id → anytype_id` map in the same file **dedupes** imports: re-importing the same task skips it ("N imported, M already imported — skipped"), and the map survives disconnecting and reconnecting, so you can never double-import by accident.

### Starred emails → tasks (IMAP)

Turn your inbox into a project. The task-import dialog has a third **Email** tab next to Anytype and ClickUp: connect a mail account over **IMAP** (host, port — 993 by default, username, password) and Ascent lists your **starred (⭐) emails**, newest first, with a short text snippet under each subject.

Pick the ones you want and hit **Import selected**: the task title is the email subject, the notes carry the sender, date and snippet, and tasks land in a project **named after the mail account** (e.g. `✉ you@example.com`) — the account *is* the project, created once as a native Anytype page and reused for later imports. Re-importing skips emails already imported (the UID dedupe map survives disconnects, so you can never double-import), and a **↻ Refresh** button re-reads the starred list.

Like the ClickUp token, your mail password lives **only in the server-side `data/links.json`** (gitignored, never committed) and is proxied through the server — `GET /api/integrations/email/status` returns only an account label, never the password. **Disconnecting** clears the password but keeps the project, the tasks, and the dedupe map; deleting the ✉ project from Ascent forgets the binding, so the next import recreates it. IMAP is implemented with a tiny zero-dependency client over TLS sockets (`src/imap.ts`) — implicit TLS only, no app permissions or OAuth setup on most providers (for Gmail you need an [app password](https://support.google.com/accounts/answer/185833)).

### Project wiki

Each project has a **Wiki** tab next to its kanban board: a lightweight knowledge base of markdown articles (runbooks, specs, meeting notes) stored as native Anytype pages, so they're searchable and editable in Anytype itself. Articles render headings, lists, code blocks, quotes, links and inline formatting; the editor is plain markdown. You can also import existing Anytype pages into a project's wiki — same rule as tasks: imported pages are unlinked, never deleted.

### Table view + prerequisites

The project page has three tabs — **Board | Table | Wiki**. **Table** (`#/projects/:id/table`) is a colorful, dense spreadsheet built for large task counts: one row per task with a colored status pill per kanban column (gray backlog, blue in progress, amber review, green done), a color-coded due date (red overdue, amber today, muted future), the imported source badge, and a notes snippet. Zebra striping, hover highlight and a sticky header keep long lists readable, and rows render through event delegation so 300+ tasks stay snappy.

Click a column header to sort by title, status or due date; the filter box narrows rows by title or notes. **Inline editing** works cell by cell: click a title to edit it, click the status pill for a dropdown, click a due date for a date picker (Enter saves, Esc cancels).

Tasks can be **nested into each other as prerequisites**: each row's **⋯** menu offers *Nest under…* (a picker of eligible tasks — self, descendants and ancestors are excluded so you can't build a loop) and *Remove from parent*. Parents show a chevron to expand/collapse their prerequisites, with children indented; collapse state is remembered per browser (localStorage), not synced. Kanban cards with children carry a `▸ N` badge, and opening a task's detail dialog lists its prerequisites with one-click removal.

Two safety rules: marking a task **done while its prerequisites are incomplete** asks for confirmation listing the incomplete ones (you can still proceed); **deleting a parent unnests its children** — they're never deleted with it. The parent link lives in `data/links.json` alongside the kanban column, so imported tasks keep their unlinked-never-deleted semantics.

### Design system

Ascent's UI is a **dependency-free visual port of [shadcn/ui](https://ui.shadcn.com)'s design system** — CSS-variable theming, card anatomy, button variants/sizes, badges, dialogs, tabs, checkbox, progress, separators, skeletons, avatar, table, dropdown menu, and toast — recreated in vanilla CSS with zero dependencies and no build step. This is not a shadcn/React installation: there is no Tailwind, no Radix, no bundler.

The shadcn tokens carry a **Solarized day/night theme**: Solarized light (`#fdf6e3`) is the default, Solarized dark (`#002b36`) is one tap away via the ☾/☀ button in the topbar. The choice persists in `localStorage`; with no stored preference it follows your OS `prefers-color-scheme`. Status and severity colors (kanban column dots, due-date pills, badges) use the Solarized accent set in both themes.

### iOS look & feel

On top of the design system, Ascent wears an **iOS-style skin**:

- **Frosted glass** — the topbar, sidebar, dialogs, dropdowns, and toasts use `backdrop-filter: blur() saturate()` over theme-aware translucent surfaces (Solarized-tinted in both themes), with `-webkit-` prefixes for Safari.
- **Apple system typography** (`-apple-system, BlinkMacSystemFont, "SF Pro Text" …`), bolder view titles, and softer, larger corner radii.
- **iOS controls** — native checkboxes render as iOS switches, task checkmarks are iOS Reminders-style circles, and the Board | Table | Wiki tabs are a pill-shaped iOS segmented control.
- **Tasteful motion** — views fade-and-rise on navigation, dialogs spring in with the iOS easing (`cubic-bezier(0.32, 0.72, 0, 1)`), toasts slide up from the bottom edge, buttons press-scale, and project/task cards lift on hover. Everything is instant under `prefers-reduced-motion`.
- **Responsive drawer** — at **≤900px** the sidebar collapses into an off-canvas drawer: opened by the ☰ button in the topbar, it slides in with the iOS spring, and closes via the blurred scrim, the ✕ button, `Esc`, or any navigation (focus moves into the drawer for keyboard users). On small screens the kanban becomes a horizontally scrollable snap list, the topbar condenses (truncated title, hidden subtitle), and dashboards go single-column.

### Task-time estimator

Ascent embeds a **tiny word-bag task-time estimator** (`public/estimate.js`, a few KB, zero dependencies, fully deterministic): a seed lexicon of ~150 common task words, each mapped to a typical duration range in minutes. A task title's estimate pools the ranges of its matched words (median of typicals for the point estimate, pooled lo–hi for the range), scaled by effort modifiers (`quick` ×0.5 … `comprehensive` ×1.6). Titles with no known words get no estimate rather than noise — e.g. "email steve" → ≈10m, "contact bill" → ≈20–40m, "research vision" → ≈60–80m.

Estimates surface five ways, all styled with the Solarized accent palette and no animation:

- a **⏱ chip** on every kanban task card, color-coded by t-shirt size (XS <15m cyan · S 15–30m green · M 30–60m yellow · L 1–2h orange · XL 2h+ red), with the full range in its tooltip;
- the same chip inside the task modal, **updating live as you type the title**;
- a **per-column total** (sum of point estimates, e.g. `≈3.5h`) in each kanban column header;
- a **per-project estimate** on the projects grid — each project card shows `⏱ ≈40m remaining`, the sum of point estimates for that project's open (non-done) tasks;
- the same per-project figure inline in each overview **Project health** row;
- an overall **Time health widget** on the overview dashboard — a card showing the total estimated remaining across all projects (e.g. `≈38h`), a per-project horizontal bar list (proportional to the heaviest project, capped at 8 rows with `+N more`), and an honest coverage footer (`based on N estimated tasks · M tasks had no estimate`). A tasteful "No estimates yet" empty state appears when nothing is estimable.

Per-project estimates are computed client-side by fetching each displayed project's task list (one extra request per project; a project whose tasks fail to load simply shows no estimate).

### API

The Bun server exposes a small facade over Anytype:

```
GET    /api/status            pairing + space state
POST   /api/pair/challenge    start 4-digit-code pairing
POST   /api/pair/complete     {challenge_id, code} → stores API key
GET    /api/spaces            list Anytype spaces
GET/POST /api/config          chosen space
GET    /api/overview          KPIs + project health + overdue/due-soon (a task is overdue only once its due *day* has passed — due-today is never overdue)
GET    /api/projects          projects with progress
POST   /api/projects          {name, description, icon} → Anytype page
POST   /api/projects/import   {object_id} link an existing page
GET/PATCH/DELETE /api/projects/:id
GET    /api/projects/:id/tasks
POST   /api/projects/:id/tasks        {title, notes, due_date, status} → Anytype task
POST   /api/projects/:id/tasks/import {object_ids}
PATCH/DELETE /api/tasks/:id  {title?, done?, due_date?, notes?, status?}
PATCH /api/tasks/:id/parent  {parent_id | null} → nest as a prerequisite (400 on cycles or cross-project parents)
GET    /api/projects/:id/wiki     wiki articles for a project
POST   /api/projects/:id/wiki     {title, body} → Anytype page
POST   /api/projects/:id/wiki/import {object_ids}
GET/PATCH/DELETE /api/wiki/:id    {title?, body?}
GET    /api/search?q=&kind=task|page  import picker
POST   /api/integrations/clickup/connect     {token} → validated against ClickUp /team, stored server-side
GET    /api/integrations/clickup/status      {connected} — the token is never returned
DELETE /api/integrations/clickup/disconnect  clears the token (dedupe map is kept)
GET    /api/integrations/clickup/teams
GET    /api/integrations/clickup/teams/:id/spaces
GET    /api/integrations/clickup/spaces/:id/folders
GET    /api/integrations/clickup/spaces/:id/lists
GET    /api/integrations/clickup/folders/:id/lists
GET    /api/integrations/clickup/lists/:id/tasks
POST   /api/integrations/clickup/lists/:id/import {project_id, tasks} → native Anytype tasks, deduped by clickup_id; binds the list to the project
POST   /api/integrations/clickup/lists/:id/bind  {project_id} → bind a list without importing
GET    /api/integrations/clickup/bindings        sanitized bindings (no token)
DELETE /api/integrations/clickup/bindings/:project_id
POST   /api/integrations/clickup/sync            {project_id} → manual two-way sync; returns {pulled, pushed, imported_new, pushed_new, conflicts, skipped, gone_clickup, gone_anytime}
GET    /api/integrations/email/status      {connected, account, project_id} — the password is never returned
POST   /api/integrations/email/connect     {host, port?, user, pass} → validated with an IMAP login, stored server-side
POST   /api/integrations/email/disconnect  clears the credentials (project, tasks and dedupe map are kept)
GET    /api/integrations/email/starred     starred (\\Flagged) emails: {uid, from, subject, date, snippet, imported}
POST   /api/integrations/email/import      {uids} → native Anytype tasks in the ✉ account project, deduped by UID
```

## Troubleshooting

- **"Anytype app not reachable"** — the desktop app must be running; the API listens on `127.0.0.1:31009`. Override with `ANYTYPE_BASE_URL`.
- **403 "request origin is not allowed"** — Anytype validates the `Host` header; access it via `localhost`/`127.0.0.1` directly, not through a container alias or proxy that rewrites Host.
- **Pairing code rejected** — codes expire quickly; request a fresh one.
- **A project vanished from Ascent** — if its page was deleted in Anytype, Ascent drops it from the index automatically (tasks stay in Anytype, unlinked).

## Verification note

Built against the official spec at https://developers.anytype.io (v2025-11-08). The full flow — pairing, space selection, project/task CRUD, kanban moves, import, delete rules, property discovery — was verified end-to-end against a mock Anytype server implementing the spec'd endpoints. Against a live Anytype app, run through the setup wizard once and confirm a created task appears in your space.
