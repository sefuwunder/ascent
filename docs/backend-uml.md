# Ascent backend UML

**Architecture snapshot:** 15 September 2026  
**Implementation:** Bun + TypeScript, zero runtime dependencies  
**Source:** [sefuwunder/ascent](https://github.com/sefuwunder/ascent)

Ascent is a local-first project-management application. Its browser client talks only to a Bun HTTP server. The server treats Anytype as the content system of record, while two gitignored JSON files retain configuration, object relationships, and integration state. ClickUp and IMAP are optional server-side integrations.

---

## 1. System context

```mermaid
flowchart LR
    User["User"]
    Browser["Ascent browser client"]
    Server["Ascent Bun backend\nHTTP API + static server"]
    Anytype["Anytype desktop app\nLocal HTTP API"]
    ClickUp["ClickUp API v2"]
    Mail["IMAP mail server"]
    Files[("Local JSON state")]

    User --> Browser
    Browser -->|"HTTP /api/*"| Server
    Server -->|"HTTP + bearer key"| Anytype
    Server -->|"HTTPS + personal token"| ClickUp
    Server -->|"Implicit TLS IMAP"| Mail
    Server --> Files
```

### Architectural boundary

- **Browser client:** renders the overview, project board/table/wiki, setup, imports, and sync controls. It never receives the Anytype API key, ClickUp token, or IMAP password.
- **Bun backend:** owns routing, validation, orchestration, synchronization, link integrity, error translation, and static-file delivery.
- **Anytype:** owns project, task, and wiki content as native objects.
- **Local JSON state:** owns associations and integration metadata, not canonical content.
- **ClickUp and IMAP:** are optional external sources reached only through backend adapters.

---

## 2. Backend component view

```mermaid
flowchart TB
    subgraph BunProcess["Bun process :3004"]
        Router["server.ts\nHTTP router and orchestrator"]
        Domain["Domain services\ntasksFor, wikiFor, createLinkedTask,\napplyTaskUpdate, wouldCycle"]
        AnyAdapter["anytype.ts\nAnytype API adapter"]
        CuAdapter["clickup.ts\nClickUp API adapter"]
        ImapAdapter["imap.ts\nIMAP protocol client"]
        Static["Static asset handler\npublic/* + SPA fallback"]
        ErrorMap["Error mapper\nAnytype / ClickUp / IMAP to HTTP"]
        State["JSON state repository\nloadJson + saveJson"]
    end

    Browser["Browser SPA"] --> Router
    Router --> Domain
    Router --> Static
    Router --> ErrorMap
    Domain --> AnyAdapter
    Domain --> CuAdapter
    Domain --> ImapAdapter
    Domain --> State
    Router --> State

    AnyAdapter --> Anytype["Anytype local API"]
    CuAdapter --> ClickUp["ClickUp API v2"]
    ImapAdapter --> Mail["IMAP server"]
    State --> Config[("data/config.json")]
    State --> Links[("data/links.json")]
```

### Component responsibilities

| Component | Owns | Does not own |
|---|---|---|
| `server.ts` | Routes, workflows | Remote protocols |
| `anytype.ts` | Anytype normalization | Project membership |
| `clickup.ts` | ClickUp mapping | Sync snapshots |
| `imap.ts` | IMAP parsing | Task creation |
| `config.json` | Pairing and space | User content |
| `links.json` | Links and sync state | Canonical content |

---

## 3. Deployment view

```mermaid
flowchart LR
    subgraph Workstation["User workstation / self-hosted machine"]
        Browser["Web browser"]
        Bun["Bun runtime\nAscent server :3004"]
        Disk[("Local filesystem\ndata/*.json")]
        Anytype["Anytype desktop app\n127.0.0.1:31009 by default"]
        Browser -->|"HTTP"| Bun
        Bun --> Disk
        Bun -->|"Local HTTP"| Anytype
    end

    Bun -->|"HTTPS"| ClickUp["api.clickup.com"]
    Bun -->|"TLS, port 993 default"| IMAP["Mail provider"]
```

**Deployment constraint:** the default Anytype base URL is loopback, so Anytype and the Ascent backend normally run on the same machine. `ANYTYPE_BASE_URL`, `ANYTYPE_VERSION`, and `PORT` can override their defaults.

---

## 4. Domain and persistence model

```mermaid
classDiagram
    class Config {
      +string api_key
      +string space_id
      +string space_name
      +TaskKeys task_keys
    }

    class TaskKeys {
      +string done
      +string due
    }

    class Links {
      +ProjectLink[] projects
      +Map tasks
      +Map wiki
      +ClickUpState clickup
      +EmailState email
    }

    class ProjectLink {
      +string id
      +Source source
      +string added_at
    }

    class TaskLink {
      +string project_id
      +string status
      +Source source
      +string parent_id
    }

    class WikiLink {
      +string project_id
      +Source source
      +string added_at
    }

    class ClickUpState {
      +string token
      +Map tasks
      +Map bindings
      +Map sync
    }

    class CuBinding {
      +string list_id
      +string list_name
      +string last_sync
    }

    class CuSyncState {
      +string clickup_id
      +string anytype_id
      +number clickup_updated
      +number anytype_updated
      +CuSyncFields fields
    }

    class CuSyncFields {
      +string name
      +string desc
      +string due
      +string column
    }

    class EmailState {
      +string host
      +number port
      +string user
      +string pass
      +string project_id
      +Map uids
    }

    class AnytypeProject {
      +string id
      +string name
      +string icon
      +string markdown
    }

    class AnytypeTask {
      +string id
      +string name
      +boolean done
      +date due
      +string markdown
      +timestamp updated_at
    }

    class AnytypeWikiPage {
      +string id
      +string name
      +string markdown
      +timestamp updated_at
    }

    Config *-- TaskKeys
    Links *-- ProjectLink
    Links *-- TaskLink
    Links *-- WikiLink
    Links *-- ClickUpState
    Links *-- EmailState
    ClickUpState *-- CuBinding
    ClickUpState *-- CuSyncState
    CuSyncState *-- CuSyncFields
    ProjectLink --> AnytypeProject : identifies
    TaskLink --> AnytypeTask : identifies
    WikiLink --> AnytypeWikiPage : identifies
    TaskLink --> TaskLink : parent_id
    AnytypeProject "1" <-- "0..*" TaskLink : project_id
    AnytypeProject "1" <-- "0..*" WikiLink : project_id
```

### Ownership rules

- **Canonical content:** names, descriptions, markdown bodies, done flags, due dates, icons, and update timestamps live in Anytype objects.
- **Ascent relationships:** project membership, kanban status, prerequisite parentage, source markers, and integration bindings live in `links.json`.
- **Configuration:** the Anytype key, selected space, and discovered task-property keys live in `config.json`.
- **Secrets:** the Anytype API key is stored in `config.json`; ClickUp and IMAP credentials are stored in `links.json`. Both files are server-side and gitignored.
- **Source semantics:** `ascent` means Ascent created the object; `imported` means Ascent only linked an existing/external object.

### Object lifecycle

```mermaid
stateDiagram-v2
    [*] --> Tracked : create or import
    Tracked --> Updated : PATCH
    Updated --> Tracked : refresh from Anytype
    Tracked --> Nested : set parent_id
    Nested --> Tracked : clear parent_id
    Tracked --> Unlinked : delete imported link
    Tracked --> Deleted : delete Ascent-created object
    Tracked --> Pruned : Anytype GET returns 404
    Unlinked --> [*]
    Deleted --> [*]
    Pruned --> [*]
```

Imported projects, tasks, and wiki pages are unlinked rather than deleted from Anytype. Ascent-created tasks and wiki pages may be deleted from Anytype. Deleting a project removes its Ascent links but deliberately leaves its linked task and wiki objects in Anytype.

---

## 5. HTTP API surface

| Area | Representative routes | Purpose |
|---|---|---|
| Setup | `/api/status`, `/api/pair/*` | Pair with Anytype |
| Config | `/api/spaces`, `/api/config` | Select a space |
| Overview | `/api/overview` | Aggregate workload |
| Projects | `/api/projects/*` | CRUD and import |
| Tasks | `/api/tasks/*` | CRUD and nesting |
| Wiki | `/api/wiki/*` | CRUD and import |
| ClickUp | `/api/integrations/clickup/*` | Import and sync |
| Email | `/api/integrations/email/*` | Starred-mail import |
| Search | `/api/search` | Anytype picker data |

All API errors are returned as JSON. Adapter-specific failures are translated centrally: authentication failures become actionable `401` responses, unavailable upstreams become `502`, missing Anytype objects become `404`, and unexpected failures become `500`.

---

## 6. Anytype pairing and space selection

```mermaid
sequenceDiagram
    actor User
    participant UI as Browser SPA
    participant API as Bun server
    participant AT as Anytype local API
    participant CFG as config.json

    User->>UI: Start pairing
    UI->>API: POST /api/pair/challenge
    API->>AT: POST /v1/auth/challenges
    AT-->>API: challenge_id
    API-->>UI: challenge_id
    AT-->>User: Display 4-digit code
    User->>UI: Enter code
    UI->>API: POST /api/pair/complete
    API->>AT: POST /v1/auth/api_keys
    AT-->>API: api_key
    API->>CFG: Persist api_key
    API-->>UI: paired
    UI->>API: GET /api/spaces
    API->>AT: GET /v1/spaces
    AT-->>API: spaces
    API-->>UI: spaces
    User->>UI: Select space
    UI->>API: POST /api/config
    API->>AT: GET space properties
    API->>API: Discover done and due keys
    API->>CFG: Persist space + task keys
    API-->>UI: setup complete
```

The backend validates that the pairing code is exactly four digits. Property discovery avoids assuming stable relation keys: it matches the selected space's definitions by name and format, then falls back to `done` and `due_date`.

---

## 7. Project and task write path

```mermaid
sequenceDiagram
    actor User
    participant UI as Browser SPA
    participant API as server.ts
    participant AT as anytype.ts
    participant LS as links.json

    User->>UI: Create task
    UI->>API: POST /api/projects/:id/tasks
    API->>API: Validate space, project, title
    API->>API: createLinkedTask()
    API->>AT: createObject(type=task)
    AT->>AT: POST Anytype object
    AT-->>API: Native task object
    API->>API: Normalize with toTaskView()
    API->>LS: Save project/status/source link
    API-->>UI: 201 task view

    User->>UI: Edit task
    UI->>API: PATCH /api/tasks/:id
    API->>API: applyTaskUpdate()
    API->>AT: PATCH Anytype object
    API->>LS: Save Ascent status
    API->>AT: GET refreshed object
    API-->>UI: Updated task view
```

`createLinkedTask()` and `applyTaskUpdate()` are shared orchestration paths. Manual edits, ClickUp imports, ClickUp pulls, and email imports therefore use the same native Anytype representation and status semantics.

---

## 8. Read hydration and repair

```mermaid
sequenceDiagram
    participant UI as Browser SPA
    participant API as Bun server
    participant LS as links.json
    participant AT as Anytype local API

    UI->>API: GET /api/projects/:id
    API->>LS: Read linked task IDs
    loop Each linked task
        API->>AT: GET object
        alt Object exists
            AT-->>API: Object data
            API->>API: Normalize and merge link state
        else Genuine Anytype 404
            API->>LS: Prune stale task link
        else Outage or auth failure
            API->>API: Keep link intact
        end
    end
    API->>API: Remove invalid parent links
    API->>API: Count children and sort tasks
    API-->>UI: Project + hydrated tasks
```

Only a genuine Anytype `404` removes a stale link. Authentication errors and outages do not erase relationships. If a parent task disappeared or belongs to another project, its children are unnested rather than orphaned.

---

## 9. Prerequisite nesting

```mermaid
sequenceDiagram
    actor User
    participant UI as Table view
    participant API as Bun server
    participant LS as links.json

    User->>UI: Drag task onto parent
    UI->>API: PATCH /api/tasks/:id/parent
    API->>LS: Load child and parent links
    alt Parent is missing
        API-->>UI: 404 parent not tracked
    else Different projects
        API-->>UI: 400 same-project rule
    else Self or ancestor cycle
        API-->>UI: 400 cycle rejected
    else Valid relationship
        API->>LS: Persist parent_id
        API-->>UI: parent_id confirmed
    end
```

`wouldCycle()` walks upward from the proposed parent while retaining the child ID in a visited set. This rejects both self-parenting and ancestor cycles. Parentage is metadata in `links.json`; it does not change the Anytype task object.

---

## 10. ClickUp manual two-way sync

```mermaid
sequenceDiagram
    actor User
    participant UI as Browser SPA
    participant API as Sync orchestrator
    participant CU as ClickUp adapter
    participant AT as Anytype adapter
    participant LS as links.json

    User->>UI: Click Sync
    UI->>API: POST /api/integrations/clickup/sync
    API->>LS: Load project binding + snapshots
    par Fetch remote state
        API->>CU: List tasks + statuses
    and Hydrate local state
        API->>AT: Read project tasks
    end

    loop Mapped task
        API->>API: Compare timestamps + normalized fields
        alt Only ClickUp changed
            API->>AT: Pull through applyTaskUpdate()
        else Only Anytype changed
            API->>CU: Update ClickUp task
        else Both changed
            API->>API: Most-recent-wins
            alt ClickUp wins or Anytype has no timestamp
                API->>AT: Apply ClickUp fields
            else Anytype wins
                API->>CU: Apply Anytype fields
            end
        else Neither changed
            API->>API: Skip
        end
        API->>LS: Refresh sync snapshot
    end

    loop Unmapped ClickUp task
        API->>AT: Create native Anytype task
        API->>LS: Save ID map + snapshot
    end

    loop Unmapped Anytype task
        API->>CU: Create ClickUp task
        API->>LS: Save ID map + snapshot
    end

    API->>LS: Save last_sync + report
    API-->>UI: Counts and conflict outcome
```

### Sync policy

- **Trigger:** manual only; there is no background polling or writer.
- **Binding:** one ClickUp list is bound per Ascent project.
- **Change detection:** compare ClickUp `date_updated`, Anytype `updated_at`, and normalized fields retained in `CuSyncFields`.
- **Conflict rule:** the most recently updated side wins; ClickUp wins when Anytype has no usable timestamp.
- **Status mapping:** ClickUp workflow names/types map to `backlog`, `in_progress`, `review`, or `done`; reverse mapping chooses a valid list status.
- **Creation:** unmapped tasks are created on the opposite side and receive a baseline snapshot.
- **Deletion:** never propagated. Missing mapped tasks are reported and left untouched on the surviving side.
- **Deduplication:** `clickup.tasks` maps ClickUp IDs to Anytype IDs across restarts and reconnects.

---

## 11. Starred-email synchronization

```mermaid
sequenceDiagram
    actor User
    participant UI as Browser SPA
    participant API as Email orchestrator
    participant IMAP as imap.ts
    participant Mail as IMAP server
    participant AT as Anytype adapter
    participant LS as links.json

    User->>UI: Click Sync email
    UI->>API: POST /api/integrations/email/sync
    API->>IMAP: fetchStarred(credentials)
    IMAP->>Mail: LOGIN
    IMAP->>Mail: SELECT INBOX
    IMAP->>Mail: UID SEARCH FLAGGED
    IMAP->>Mail: UID FETCH envelope + snippet
    Mail-->>IMAP: Starred messages
    IMAP-->>API: Normalized mail records
    API->>LS: Filter already-seen UIDs

    alt No new UIDs
        API-->>UI: up_to_date=true
    else Email project missing
        API->>AT: Create Anytype project for account
        API->>LS: Save email project_id
    end

    loop Each new starred UID
        API->>AT: Create native backlog task
        API->>LS: Map mailbox UID to task ID
    end
    API-->>UI: Imported/skipped counts
```

The IMAP adapter is a purpose-built Bun socket client. It uses implicit TLS by default, logs in, selects `INBOX`, searches for `\Flagged`, fetches envelopes, and retrieves a best-effort 2,048-byte text snippet. Mailbox UIDs provide durable deduplication. Disconnecting clears credentials but retains the email project, imported tasks, and UID map.

---

## 12. Wiki flow

```mermaid
sequenceDiagram
    actor User
    participant UI as Wiki view
    participant API as Bun server
    participant AT as Anytype adapter
    participant LS as links.json

    User->>UI: Create article
    UI->>API: POST /api/projects/:id/wiki
    API->>AT: Create page with markdown body
    AT-->>API: Native page object
    API->>LS: Save WikiLink
    API-->>UI: Article view

    User->>UI: Edit article
    UI->>API: PATCH /api/wiki/:id
    API->>AT: PATCH name / markdown
    API->>AT: GET refreshed object
    API-->>UI: Updated article
```

Wiki articles are native Anytype pages. The local wiki link stores only project membership, source, and added timestamp.

---

## 13. Backend invariants

1. **Anytype is the content authority.** Ascent does not duplicate project, task, or article bodies in local state.
2. **A linked task belongs to one Ascent project.** The project relationship is represented by `TaskLink.project_id`.
3. **A prerequisite parent must be tracked in the same project.** Self-links and ancestor cycles are invalid.
4. **Imported objects are preserved.** Removing them from Ascent unlinks them rather than deleting their Anytype object.
5. **Upstream outages must not destroy links.** Automatic pruning occurs only after a confirmed Anytype `404`.
6. **Integration credentials remain server-side.** GET responses expose status and account labels, not secrets.
7. **ClickUp synchronization is explicit and non-destructive.** It runs only on request and never propagates deletion.
8. **Email import is idempotent per mailbox UID.** Repeated syncs do not create duplicate tasks.
9. **Task writes converge through shared paths.** Manual edits and integration-driven updates use the same creation/update rules.
10. **Status has two layers.** Anytype owns the done checkbox; Ascent owns the four-column workflow state and derives the effective status from both.

---

## 14. Security and failure model

```mermaid
flowchart TD
    Req["Incoming API request"] --> Gate{"Paired and space selected?"}
    Gate -->|"No"| Client4["400 / 401 JSON error"]
    Gate -->|"Yes"| Work["Run domain workflow"]
    Work --> Result{"Outcome"}
    Result -->|"Success"| Ok["2xx JSON response"]
    Result -->|"Anytype auth"| Auth["401 pair again"]
    Result -->|"Anytype missing"| Missing["404 not found"]
    Result -->|"ClickUp auth"| CuAuth["401 check token"]
    Result -->|"Upstream unavailable"| BadGateway["502 upstream error"]
    Result -->|"Validation"| BadRequest["400 JSON error"]
    Result -->|"Unexpected"| ServerError["500 generic error"]
```

### Trust boundaries

- The browser is not trusted with integration secrets; all provider calls are proxied.
- Credentials are persisted unencrypted in gitignored local JSON files, so host filesystem permissions and disk security remain operational requirements.
- The Anytype base URL is configurable, but the default is local loopback.
- IMAP uses TLS unless the adapter's test-only `secure: false` option is supplied.
- ClickUp calls use HTTPS and send the personal token in the `Authorization` header.

---

## 15. Module dependency summary

```mermaid
flowchart LR
    Public["public/app.js"] --> Server["src/server.ts"]
    Server --> Anytype["src/anytype.ts"]
    Server --> ClickUp["src/clickup.ts"]
    Server --> IMAP["src/imap.ts"]
    Server --> Config["data/config.json"]
    Server --> Links["data/links.json"]
```

The design is intentionally monolithic at the process level and modular at the protocol boundary: one Bun server coordinates workflows, while separate adapters isolate Anytype HTTP, ClickUp HTTP, and IMAP socket behavior.
