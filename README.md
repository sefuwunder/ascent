# ◭ Ascent

Simple & elegant glossy project management with **Anytype as the data backend**. Every project is a native Anytype page, every task a native Anytype task — created, read, updated and deleted through the official local API (`2025-11-08`). Your data never leaves your machine.

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
| Project ↔ task link | `data/links.json` (local index only) |
| Kanban column | `data/links.json` (`backlog` / `in_progress` / `review` / `done`) |

All *content* lives in your Anytype space. The local `data/` directory (gitignored) holds only the API key, the chosen space, and the link index — which project each task belongs to and which board column it's in. Checking a task done in Ascent checks it done in Anytype, and vice versa.

Task property keys (`done`, `due_date`) are **discovered at setup** via `GET /v1/spaces/{id}/properties` — nothing is hardcoded, so it adapts to your space.

### Import, don't duplicate

Already track work in Anytype? Use **Import** on the Projects page or inside a project to link existing pages/tasks instead of recreating them. Imported items are never deleted by Ascent — removing one only unlinks it. Items Ascent created itself *are* deleted in Anytype when you delete them here (with a confirmation).

### API

The Bun server exposes a small facade over Anytype:

```
GET    /api/status            pairing + space state
POST   /api/pair/challenge    start 4-digit-code pairing
POST   /api/pair/complete     {challenge_id, code} → stores API key
GET    /api/spaces            list Anytype spaces
GET/POST /api/config          chosen space
GET    /api/overview          KPIs + project health + overdue/due-soon
GET    /api/projects          projects with progress
POST   /api/projects          {name, description, icon} → Anytype page
POST   /api/projects/import   {object_id} link an existing page
GET/PATCH/DELETE /api/projects/:id
GET    /api/projects/:id/tasks
POST   /api/projects/:id/tasks        {title, notes, due_date, status} → Anytype task
POST   /api/projects/:id/tasks/import {object_ids}
PATCH/DELETE /api/tasks/:id  {title?, done?, due_date?, notes?, status?}
GET    /api/search?q=&kind=task|page  import picker
```

## Troubleshooting

- **"Anytype app not reachable"** — the desktop app must be running; the API listens on `127.0.0.1:31009`. Override with `ANYTYPE_BASE_URL`.
- **403 "request origin is not allowed"** — Anytype validates the `Host` header; access it via `localhost`/`127.0.0.1` directly, not through a container alias or proxy that rewrites Host.
- **Pairing code rejected** — codes expire quickly; request a fresh one.
- **A project vanished from Ascent** — if its page was deleted in Anytype, Ascent drops it from the index automatically (tasks stay in Anytype, unlinked).

## Verification note

Built against the official spec at https://developers.anytype.io (v2025-11-08). The full flow — pairing, space selection, project/task CRUD, kanban moves, import, delete rules, property discovery — was verified end-to-end against a mock Anytype server implementing the spec'd endpoints. Against a live Anytype app, run through the setup wizard once and confirm a created task appears in your space.
