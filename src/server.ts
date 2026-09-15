// Ascent — project management over the Anytype local API (shadcn/ui Zinc visual port).
// Bun + zero dependencies. All project/task/article content lives in the user's
// Anytype space; data/links.json only remembers which task/article belongs to
// which project (and each card's kanban column), plus the pairing config.

import {
  setApiKey, getApiKey, baseUrl, AnytypeError,
  createChallenge, exchangeCode, listSpaces, listProperties, discoverTaskKeys,
  searchSpace, createObject, getObject, updateObject, deleteObject,
  toTaskView, toProjectView, toArticleView, type TaskKeys,
} from "./anytype";
import {
  ClickUpError, cuFetch, validateToken, getTeams, getSpaces, getFolders,
  getSpaceLists, getFolderLists, getListTasks, getListInfo, getCuTask,
  updateCuTask, createCuTask, taskToDraft, planImport,
  cuStatusToColumn, columnToCuStatus, type CuTask, type CuStatus,
} from "./clickup";
import {
  ImapError, validateImap, fetchStarred,
} from "./imap";

const PORT = Number(process.env.PORT || 3004);
const DATA = new URL("../data/", import.meta.url).pathname;
const CONFIG_PATH = DATA + "config.json";
const LINKS_PATH = DATA + "links.json";

interface Config {
  api_key: string;
  space_id: string;
  space_name: string;
  task_keys: TaskKeys;
}
interface TaskLink { project_id: string; status: string; source: "ascent" | "imported"; parent_id?: string }
interface ProjectLink { id: string; source: "ascent" | "imported"; added_at: string }
interface WikiLink { project_id: string; source: "ascent" | "imported"; added_at: string }
// ClickUp integration state: the Personal API token (server-side only), the
// clickup task id → Anytype task id dedupe map (survives disconnects), the
// per-project list bindings for two-way sync, and the per-task sync snapshots
// that make change detection and conflict resolution possible.
interface CuBinding { list_id: string; list_name: string; last_sync: string | null }
interface CuSyncFields { name: string; desc: string; due: string; column: string }
interface CuSyncState {
  clickup_id: string;
  anytype_id: string;
  clickup_updated: number; // ClickUp date_updated (epoch-ms) as of last sync
  anytype_updated: number; // Anytype updated_at (epoch-ms) as of last sync
  fields: CuSyncFields;    // normalized field values as of last sync
}
interface ClickUpState {
  token: string;
  tasks: Record<string, string>;
  bindings: Record<string, CuBinding>; // project_id → bound list
  sync: Record<string, CuSyncState>;   // anytype task id → sync state
}
// Email integration state: IMAP credentials (server-side only), the project
// that represents the mail account (created on first import), and the
// uid → Anytype task id dedupe map (survives disconnects — a disconnect
// clears the password only, never the imported tasks).
interface EmailState {
  host: string;
  port: number;
  user: string;
  pass: string;
  project_id: string;
  uids: Record<string, string>;
}
interface Links { projects: ProjectLink[]; tasks: Record<string, TaskLink>; wiki: Record<string, WikiLink>; clickup: ClickUpState; email: EmailState }

function loadJson<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(require("fs").readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}
function saveJson(path: string, v: unknown) {
  require("fs").mkdirSync(DATA, { recursive: true });
  require("fs").writeFileSync(path, JSON.stringify(v, null, 2));
}

let config: Config = loadJson<Config>(CONFIG_PATH, { api_key: "", space_id: "", space_name: "", task_keys: { done: "done", due: "due_date" } });
let links: Links = loadJson<Links>(LINKS_PATH, { projects: [], tasks: {}, wiki: {}, clickup: { token: "", tasks: {}, bindings: {}, sync: {} }, email: { host: "", port: 993, user: "", pass: "", project_id: "", uids: {} } });
if (config.api_key) setApiKey(config.api_key);

const saveConfig = () => saveJson(CONFIG_PATH, config);
const saveLinks = () => saveJson(LINKS_PATH, links);
if (!links.wiki) { links.wiki = {}; saveLinks(); } // upgrade path for pre-wiki link indexes
if (!links.clickup) { links.clickup = { token: "", tasks: {}, bindings: {}, sync: {} }; saveLinks(); } // upgrade path for pre-ClickUp link indexes
if (!links.clickup.bindings) { links.clickup.bindings = {}; saveLinks(); } // upgrade path for pre-sync stores
if (!links.clickup.sync) { links.clickup.sync = {}; saveLinks(); } // upgrade path for pre-sync stores
if (!links.email) { links.email = { host: "", port: 993, user: "", pass: "", project_id: "", uids: {} }; saveLinks(); } // upgrade path for pre-email link indexes

const STATUSES = ["backlog", "in_progress", "review", "done"] as const;

function effectiveStatus(tvDone: boolean, link?: TaskLink): string {
  if (tvDone) return "done";
  if (!link) return "backlog";
  return link.status === "done" ? "in_progress" : link.status;
}

const json = (v: unknown, status = 200) =>
  new Response(JSON.stringify(v), { status, headers: { "Content-Type": "application/json" } });

async function readBody(req: Request): Promise<any> {
  try {
    return await req.json();
  } catch {
    return {};
  }
}

function needSpace(): Response | null {
  if (!getApiKey()) return json({ error: "not paired with Anytype yet" }, 401);
  if (!config.space_id) return json({ error: "no space selected" }, 400);
  return null;
}

function atErr(e: unknown): Response {
  if (e instanceof ImapError) {
    if (e.status === 401) return json({ error: e.message }, 401);
    if (e.status === 400) return json({ error: e.message }, 400);
    return json({ error: `mail server: ${e.message}` }, 502);
  }
  if (e instanceof ClickUpError) {
    if (e.status === 401 || e.status === 403)
      return json({ error: "ClickUp rejected that token — check it and try again" }, 401);
    if (e.status === 0) return json({ error: e.message }, 502);
    return json({ error: `ClickUp: ${e.message}` }, 502);
  }
  if (e instanceof AnytypeError) {
    if (e.status === 0) return json({ error: e.message }, 502);
    if (e.status === 401 || e.status === 403)
      return json({ error: "Anytype rejected the API key — pair again" }, 401);
    if (e.status === 404) return json({ error: "not found in Anytype" }, 404);
    return json({ error: e.message }, 502);
  }
  return json({ error: "unexpected server error" }, 500);
}

async function hydrateProject(pl: ProjectLink): Promise<any | null> {
  try {
    const o = await getObject(config.space_id, pl.id);
    return { ...toProjectView(o), source: pl.source };
  } catch (e) {
    if (e instanceof AnytypeError && e.status === 404) return null; // deleted in Anytype — dropped
    throw e;
  }
}

async function tasksFor(projectId: string): Promise<any[]> {
  const ids = Object.entries(links.tasks)
    .filter(([, l]) => l.project_id === projectId)
    .map(([id]) => id);
  const out: any[] = [];
  let pruned = false;
  for (const id of ids) {
    try {
      const o = await getObject(config.space_id, id);
      const tv = toTaskView(o, config.task_keys);
      const link = links.tasks[id];
      out.push({ ...tv, status: effectiveStatus(tv.done, link), source: link.source });
    } catch (e) {
      // prune only genuine deletions — a bad key or outage must never wipe links
      if (e instanceof AnytypeError && e.status === 404) {
        delete links.tasks[id];
        pruned = true;
      }
    }
  }
  if (pruned) saveLinks();
  // Sanitize parent links: a parent that was pruned (deleted in Anytype) or
  // lives in another project unnests its children rather than orphaning them.
  const live = new Set(
    Object.entries(links.tasks).filter(([, l]) => l.project_id === projectId).map(([id]) => id),
  );
  let unnests = false;
  for (const [id, l] of Object.entries(links.tasks)) {
    if (l.project_id === projectId && l.parent_id && !live.has(l.parent_id)) {
      links.tasks[id] = { ...l, parent_id: undefined };
      unnests = true;
    }
  }
  if (unnests) saveLinks();
  const childCount: Record<string, number> = {};
  for (const l of Object.values(links.tasks)) {
    if (l.project_id === projectId && l.parent_id && live.has(l.parent_id)) {
      childCount[l.parent_id] = (childCount[l.parent_id] || 0) + 1;
    }
  }
  for (const t of out) {
    const l = links.tasks[t.id];
    t.parent_id = l && l.parent_id ? l.parent_id : null;
    t.child_count = childCount[t.id] || 0;
  }
  out.sort((a, b) => (a.dueMs || Infinity) - (b.dueMs || Infinity) || b.updatedMs - a.updatedMs);
  return out;
}

// True when nesting `tid` under `newParentId` would create a parent cycle
// (self-parent or ancestor-parent). Caller has already checked that both ids
// are tracked and in the same project.
function wouldCycle(tid: string, newParentId: string): boolean {
  const seen = new Set<string>([tid]);
  let cur: string | undefined = newParentId;
  while (cur) {
    if (seen.has(cur)) return true;
    seen.add(cur);
    cur = links.tasks[cur]?.parent_id;
  }
  return false;
}

async function wikiFor(projectId: string): Promise<any[]> {
  const ids = Object.entries(links.wiki)
    .filter(([, l]) => l.project_id === projectId)
    .map(([id]) => id);
  const out: any[] = [];
  let pruned = false;
  for (const id of ids) {
    try {
      const o = await getObject(config.space_id, id);
      const av = toArticleView(o);
      const link = links.wiki[id];
      out.push({ id: av.id, title: av.title, updatedMs: av.updatedMs, source: link.source,
        snippet: av.body.slice(0, 140) });
    } catch (e) {
      // prune only genuine deletions — a bad key or outage must never wipe links
      if (e instanceof AnytypeError && e.status === 404) {
        delete links.wiki[id];
        pruned = true;
      }
    }
  }
  if (pruned) saveLinks();
  out.sort((a, b) => b.updatedMs - a.updatedMs);
  return out;
}

// Shared task-creation path: builds a native Anytype task object and links it
// to the project. Used by manual task creation and the ClickUp importer alike.
async function createLinkedTask(
  pid: string,
  draft: { title: string; notes?: string; due_date?: string; status?: string },
  source: "ascent" | "imported",
) {
  const status = STATUSES.includes(draft.status as any) ? (draft.status as any) : "backlog";
  const props: Array<Record<string, any>> = [{ key: config.task_keys.done, checkbox: status === "done" }];
  if (draft.due_date) props.push({ key: config.task_keys.due, date: draft.due_date });
  const o = await createObject(config.space_id, {
    name: draft.title.trim(),
    type_key: "task",
    body: draft.notes || "",
    properties: props,
  });
  const tv = toTaskView(o, config.task_keys);
  links.tasks[tv.id] = { project_id: pid, status, source };
  saveLinks();
  return { ...tv, status: effectiveStatus(tv.done, links.tasks[tv.id]), source };
}

// Apply a partial update to a tracked task — shared by the manual task PATCH
// endpoint and the sync pull path so both go through identical semantics.
async function applyTaskUpdate(
  tid: string,
  b: { title?: string; notes?: string; due_date?: string; status?: string; done?: boolean },
) {
  const link = links.tasks[tid];
  if (!link) throw new AnytypeError(404, "task not tracked");
  const patch: any = {};
  const props: Array<Record<string, any>> = [];
  if (b.title !== undefined) patch.name = b.title;
  if (b.notes !== undefined) patch.markdown = b.notes;
  let newStatus = link.status;
  if (b.done !== undefined || b.status !== undefined) {
    const wantDone = b.done !== undefined ? !!b.done : b.status === "done";
    props.push({ key: config.task_keys.done, checkbox: wantDone });
    if (b.status !== undefined && STATUSES.includes(b.status as any)) newStatus = b.status as any;
    else newStatus = wantDone ? "done" : link.status === "done" ? "in_progress" : link.status;
    if (wantDone) newStatus = "done";
  }
  if (b.due_date !== undefined) {
    props.push(b.due_date
      ? { key: config.task_keys.due, date: b.due_date }
      : { key: config.task_keys.due, date: "" });
  }
  if (props.length) patch.properties = props;
  if (Object.keys(patch).length) await updateObject(config.space_id, tid, patch);
  links.tasks[tid] = { ...link, status: newStatus };
  saveLinks();
  const tv2 = toTaskView(await getObject(config.space_id, tid), config.task_keys);
  return { ...tv2, status: effectiveStatus(tv2.done, links.tasks[tid]), source: link.source };
}

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    try {
      // ---------- pairing & setup ----------
      if (path === "/api/status" && method === "GET") {
        return json({
          paired: !!getApiKey(),
          has_space: !!config.space_id,
          space_name: config.space_name,
          base_url: baseUrl(),
        });
      }
      if (path === "/api/pair/challenge" && method === "POST") {
        const cid = await createChallenge("ascent");
        return json({ challenge_id: cid });
      }
      if (path === "/api/pair/complete" && method === "POST") {
        const b = await readBody(req);
        if (!b.challenge_id || !/^\d{4}$/.test(String(b.code || "").trim()))
          return json({ error: "enter the 4-digit code shown in Anytype" }, 400);
        try {
          const key = await exchangeCode(b.challenge_id, String(b.code));
          setApiKey(key);
          config.api_key = key;
          saveConfig();
          return json({ ok: true });
        } catch (e) {
          if (e instanceof AnytypeError && [400, 401, 404].includes(e.status))
            return json({ error: "code not accepted — request a fresh code and try again" }, 401);
          throw e;
        }
      }
      if (path === "/api/spaces" && method === "GET") {
        if (!getApiKey()) return json({ error: "not paired" }, 401);
        return json({ spaces: await listSpaces() });
      }
      if (path === "/api/config" && method === "GET") {
        return json({ space_id: config.space_id, space_name: config.space_name });
      }
      if (path === "/api/config" && method === "POST") {
        const b = await readBody(req);
        if (!getApiKey()) return json({ error: "not paired" }, 401);
        const spaces = await listSpaces();
        const sp = spaces.find((s) => s.id === b.space_id);
        if (!sp) return json({ error: "unknown space" }, 400);
        const props = await listProperties(sp.id).catch(() => []);
        config.space_id = sp.id;
        config.space_name = sp.name;
        config.task_keys = discoverTaskKeys(props);
        saveConfig();
        return json({ ok: true, space: sp, task_keys: config.task_keys });
      }
      if (path === "/api/disconnect" && method === "POST") {
        config = { api_key: "", space_id: "", space_name: "", task_keys: { done: "done", due: "due_date" } };
        links = { projects: [], tasks: {}, wiki: {}, clickup: { token: "", tasks: {}, bindings: {}, sync: {} }, email: { host: "", port: 993, user: "", pass: "", project_id: "", uids: {} } };
        setApiKey("");
        saveConfig();
        saveLinks();
        return json({ ok: true });
      }

      // ---------- overview ----------
      if (path === "/api/overview" && method === "GET") {
        const gate = needSpace();
        if (gate) return gate;
        const projects: any[] = [];
        let open = 0, doneCount = 0, overdue = 0;
        const attention: any[] = [];
        const now = Date.now();
        const dayMs = 86400000;
        // Overdue means the due DAY is past, not the instant: a task due
        // today is not overdue. Compare against local start-of-day since
        // dueMs is a local-midnight calendar day.
        const todayStart = (() => { const s = new Date(); s.setHours(0, 0, 0, 0); return s.getTime(); })();
        for (const pl of links.projects) {
          const p = await hydrateProject(pl);
          if (!p) continue;
          const tasks = await tasksFor(pl.id);
          const done = tasks.filter((t) => t.status === "done").length;
          const od = tasks.filter((t) => t.status !== "done" && t.dueMs && t.dueMs < todayStart).length;
          open += tasks.length - done;
          doneCount += done;
          overdue += od;
          for (const t of tasks) {
            if (t.status !== "done" && t.dueMs && t.dueMs < now + 3 * dayMs) {
              attention.push({ project_id: pl.id, project_name: p.name, id: t.id, title: t.title, dueMs: t.dueMs, overdue: t.dueMs < todayStart });
            }
          }
          projects.push({ ...p, total: tasks.length, done, progress: tasks.length ? Math.round((done / tasks.length) * 100) : 0, overdue: od });
        }
        attention.sort((a, b) => a.dueMs - b.dueMs);
        projects.sort((a, b) => b.updatedMs - a.updatedMs);
        return json({
          projects: projects.length,
          open_tasks: open,
          done_tasks: doneCount,
          overdue,
          project_list: projects.slice(0, 6),
          attention: attention.slice(0, 8),
        });
      }

      // ---------- projects ----------
      if (path === "/api/projects" && method === "GET") {
        const gate = needSpace();
        if (gate) return gate;
        const out: any[] = [];
        for (const pl of links.projects) {
          const p = await hydrateProject(pl);
          if (!p) {
            // deleted directly in Anytype — drop from the index
            links.projects = links.projects.filter((x) => x.id !== pl.id);
            continue;
          }
          const tasks = await tasksFor(pl.id);
          const done = tasks.filter((t) => t.status === "done").length;
          out.push({ ...p, total: tasks.length, done, progress: tasks.length ? Math.round((done / tasks.length) * 100) : 0 });
        }
        saveLinks();
        return json({ projects: out });
      }
      if (path === "/api/projects" && method === "POST") {
        const gate = needSpace();
        if (gate) return gate;
        const b = await readBody(req);
        if (!b.name?.trim()) return json({ error: "project name is required" }, 400);
        const o = await createObject(config.space_id, {
          name: b.name.trim(),
          type_key: "page",
          body: b.description || "",
          icon: b.icon || "📁",
        });
        const pl: ProjectLink = { id: String(o.id), source: "ascent", added_at: new Date().toISOString() };
        links.projects.unshift(pl);
        saveLinks();
        return json({ project: { ...toProjectView(o), source: "ascent" } }, 201);
      }
      if (path === "/api/projects/import" && method === "POST") {
        const gate = needSpace();
        if (gate) return gate;
        const b = await readBody(req);
        if (!b.object_id) return json({ error: "object_id is required" }, 400);
        if (links.projects.some((p) => p.id === b.object_id)) return json({ error: "already tracked" }, 400);
        await getObject(config.space_id, b.object_id); // 404s if unknown
        links.projects.unshift({ id: b.object_id, source: "imported", added_at: new Date().toISOString() });
        saveLinks();
        return json({ ok: true }, 201);
      }

      const projMatch = path.match(/^\/api\/projects\/([^/]+)$/);
      if (projMatch) {
        const pid = projMatch[1];
        const pl = links.projects.find((p) => p.id === pid);
        if (!pl) return json({ error: "project not tracked" }, 404);
        if (method === "GET") {
          const gate = needSpace();
          if (gate) return gate;
          const p = await hydrateProject(pl);
          if (!p) return json({ error: "project no longer exists in Anytype" }, 404);
          return json({ project: p, tasks: await tasksFor(pid), clickup_binding: links.clickup.bindings[pid] || null });
        }
        if (method === "PATCH") {
          const gate = needSpace();
          if (gate) return gate;
          const b = await readBody(req);
          const patch: any = {};
          if (b.name !== undefined) patch.name = b.name;
          if (b.description !== undefined) patch.markdown = b.description;
          if (b.icon !== undefined) patch.icon = { emoji: b.icon, format: "emoji" };
          if (Object.keys(patch).length) await updateObject(config.space_id, pid, patch);
          const p = await hydrateProject(pl);
          return json({ project: p });
        }
        if (method === "DELETE") {
          const gate = needSpace();
          if (gate) return gate;
          if (pl.source === "ascent") {
            try { await deleteObject(config.space_id, pid); } catch { /* already gone */ }
          }
          for (const [tid, l] of Object.entries(links.tasks)) {
            if (l.project_id === pid) delete links.tasks[tid]; // tasks stay in Anytype, unlinked
          }
          for (const [aid, l] of Object.entries(links.wiki)) {
            if (l.project_id === pid) delete links.wiki[aid]; // articles stay in Anytype, unlinked
          }
          // ClickUp sync state for the project goes with it (the remote list is untouched)
          delete links.clickup.bindings[pid];
          for (const atId of Object.keys(links.clickup.sync)) {
            if (!links.tasks[atId]) delete links.clickup.sync[atId];
          }
          for (const cid of Object.keys(links.clickup.tasks)) {
            if (!links.tasks[links.clickup.tasks[cid]]) delete links.clickup.tasks[cid];
          }
          // A deleted email-account project is forgotten so the next import recreates it
          if (links.email && links.email.project_id === pid) links.email.project_id = "";
          links.projects = links.projects.filter((p) => p.id !== pid);
          saveLinks();
          return json({ ok: true });
        }
      }

      // ---------- tasks ----------
      const ptMatch = path.match(/^\/api\/projects\/([^/]+)\/tasks$/);
      if (ptMatch && method === "GET") {
        const gate = needSpace();
        if (gate) return gate;
        return json({ tasks: await tasksFor(ptMatch[1]) });
      }
      if (ptMatch && method === "POST") {
        const gate = needSpace();
        if (gate) return gate;
        const pid = ptMatch[1];
        if (!links.projects.some((p) => p.id === pid)) return json({ error: "project not tracked" }, 404);
        const b = await readBody(req);
        if (!b.title?.trim()) return json({ error: "task title is required" }, 400);
        const task = await createLinkedTask(pid, b, "ascent");
        return json({ task }, 201);
      }
      const impMatch = path.match(/^\/api\/projects\/([^/]+)\/tasks\/import$/);
      if (impMatch && method === "POST") {
        const gate = needSpace();
        if (gate) return gate;
        const pid = impMatch[1];
        if (!links.projects.some((p) => p.id === pid)) return json({ error: "project not tracked" }, 404);
        const b = await readBody(req);
        const ids: string[] = Array.isArray(b.object_ids) ? b.object_ids : [];
        let added = 0;
        for (const id of ids) {
          if (links.tasks[id]) continue;
          try {
            const o = await getObject(config.space_id, id);
            const tv = toTaskView(o, config.task_keys);
            const st = tv.done ? "done" : "backlog";
            links.tasks[id] = { project_id: pid, status: st, source: "imported" };
            added++;
          } catch { /* skip unreadable */ }
        }
        saveLinks();
        return json({ ok: true, added }, 201);
      }

      const taskMatch = path.match(/^\/api\/tasks\/([^/]+)$/);
      if (taskMatch) {
        const tid = taskMatch[1];
        const link = links.tasks[tid];
        if (!link) return json({ error: "task not tracked" }, 404);
        if (method === "PATCH") {
          const gate = needSpace();
          if (gate) return gate;
          const b = await readBody(req);
          return json({ task: await applyTaskUpdate(tid, b) });
        }
        if (method === "DELETE") {
          const gate = needSpace();
          if (gate) return gate;
          if (link.source === "ascent") {
            try { await deleteObject(config.space_id, tid); } catch { /* already gone */ }
          }
          delete links.tasks[tid];
          // Deleting a parent unnests (never deletes) its children.
          for (const [cid, l] of Object.entries(links.tasks)) {
            if (l.parent_id === tid) links.tasks[cid] = { ...l, parent_id: undefined };
          }
          saveLinks();
          return json({ ok: true });
        }
      }
      // ---------- prerequisites: nest a task under another task ----------
      const parentMatch = path.match(/^\/api\/tasks\/([^/]+)\/parent$/);
      if (parentMatch && method === "PATCH") {
        const gate = needSpace();
        if (gate) return gate;
        const tid = parentMatch[1];
        const link = links.tasks[tid];
        if (!link) return json({ error: "task not tracked" }, 404);
        const b = await readBody(req);
        const np = b.parent_id ? String(b.parent_id) : null;
        if (np) {
          const plink = links.tasks[np];
          if (!plink) return json({ error: "parent task not tracked" }, 404);
          if (plink.project_id !== link.project_id)
            return json({ error: "a task can only nest under a task in the same project" }, 400);
          if (wouldCycle(tid, np)) return json({ error: "nesting here would create a cycle" }, 400);
        }
        links.tasks[tid] = { ...link, parent_id: np || undefined };
        saveLinks();
        return json({ ok: true, parent_id: np });
      }

      // ---------- wiki ----------
      const wikiListMatch = path.match(/^\/api\/projects\/([^/]+)\/wiki$/);
      if (wikiListMatch && (method === "GET" || method === "POST")) {
        const pid = wikiListMatch[1];
        const gate = needSpace();
        if (gate) return gate;
        if (!links.projects.some((p) => p.id === pid)) return json({ error: "project not tracked" }, 404);
        if (method === "GET") {
          return json({ articles: await wikiFor(pid) });
        }
        const b = await readBody(req);
        if (!b.title?.trim()) return json({ error: "article title is required" }, 400);
        const o = await createObject(config.space_id, {
          name: b.title.trim(),
          type_key: "page",
          body: b.body || "",
          icon: "📄",
        });
        const av = toArticleView(o);
        links.wiki[av.id] = { project_id: pid, source: "ascent", added_at: new Date().toISOString() };
        saveLinks();
        return json({ article: { ...av, source: "ascent" } }, 201);
      }
      const wikiImpMatch = path.match(/^\/api\/projects\/([^/]+)\/wiki\/import$/);
      if (wikiImpMatch && method === "POST") {
        const gate = needSpace();
        if (gate) return gate;
        const pid = wikiImpMatch[1];
        if (!links.projects.some((p) => p.id === pid)) return json({ error: "project not tracked" }, 404);
        const b = await readBody(req);
        const ids: string[] = Array.isArray(b.object_ids) ? b.object_ids : [];
        let added = 0;
        for (const id of ids) {
          if (links.wiki[id] || links.tasks[id] || links.projects.some((p) => p.id === id)) continue;
          try {
            await getObject(config.space_id, id); // 404s if unknown
            links.wiki[id] = { project_id: pid, source: "imported", added_at: new Date().toISOString() };
            added++;
          } catch { /* skip unreadable */ }
        }
        saveLinks();
        return json({ ok: true, added }, 201);
      }
      const wikiMatch = path.match(/^\/api\/wiki\/([^/]+)$/);
      if (wikiMatch) {
        const aid = wikiMatch[1];
        const link = links.wiki[aid];
        if (!link) return json({ error: "article not tracked" }, 404);
        if (method === "GET") {
          const gate = needSpace();
          if (gate) return gate;
          try {
            const av = toArticleView(await getObject(config.space_id, aid));
            return json({ article: { ...av, source: link.source } });
          } catch (e) {
            if (e instanceof AnytypeError && e.status === 404) {
              delete links.wiki[aid];
              saveLinks();
            }
            throw e;
          }
        }
        if (method === "PATCH") {
          const gate = needSpace();
          if (gate) return gate;
          const b = await readBody(req);
          const patch: any = {};
          if (b.title !== undefined) patch.name = b.title;
          if (b.body !== undefined) patch.markdown = b.body;
          if (Object.keys(patch).length) await updateObject(config.space_id, aid, patch);
          const av = toArticleView(await getObject(config.space_id, aid));
          return json({ article: { ...av, source: link.source } });
        }
        if (method === "DELETE") {
          const gate = needSpace();
          if (gate) return gate;
          if (link.source === "ascent") {
            try { await deleteObject(config.space_id, aid); } catch { /* already gone */ }
          }
          delete links.wiki[aid];
          saveLinks();
          return json({ ok: true });
        }
      }

      // ---------- ClickUp integration (two-way sync: ClickUp ⇄ Ascent) ----------
      // The Personal API token lives only in gitignored data/links.json. It is
      // never returned by any GET, never logged, and every ClickUp call is
      // proxied through the server so the token never reaches the browser.
      // Sync is MANUAL only (the ⇄ Sync button): there is no polling and no
      // background writer, so nothing ever overwrites a task unprompted.
      // Deletions are never synchronized — a mapped task missing on one side
      // is reported and left alone on the other side.
      const cuToken = () => links.clickup.token;
      const needCu = (): Response | null =>
        cuToken() ? null : json({ error: "ClickUp not connected" }, 401);
      // epoch-ms → "YYYY-MM-DD" (UTC); "" when unknown. Used to compare due
      // dates across ClickUp (epoch-ms) and Anytype (date strings) snapshots.
      const isoDay = (ms: number): string =>
        ms > 0 ? new Date(ms).toISOString().slice(0, 10) : "";

      if (path === "/api/integrations/clickup/status" && method === "GET") {
        return json({ connected: !!cuToken() });
      }
      if (path === "/api/integrations/clickup/connect" && method === "POST") {
        const b = await readBody(req);
        const token = String(b.token || "").trim();
        if (!token) return json({ error: "paste your ClickUp Personal API token" }, 400);
        await validateToken(token); // throws ClickUpError(401) on a bad token
        links.clickup.token = token;
        saveLinks();
        return json({ ok: true });
      }
      if (path === "/api/integrations/clickup/disconnect" && method === "DELETE") {
        links.clickup.token = "";
        saveLinks();
        return json({ ok: true });
      }
      if (path === "/api/integrations/clickup/teams" && method === "GET") {
        const g = needCu();
        if (g) return g;
        return json({ teams: await getTeams(cuToken()) });
      }
      const cuTeamSpaces = path.match(/^\/api\/integrations\/clickup\/teams\/([^/]+)\/spaces$/);
      if (cuTeamSpaces && method === "GET") {
        const g = needCu();
        if (g) return g;
        return json({ spaces: await getSpaces(cuToken(), decodeURIComponent(cuTeamSpaces[1])) });
      }
      const cuSpaceFolders = path.match(/^\/api\/integrations\/clickup\/spaces\/([^/]+)\/folders$/);
      if (cuSpaceFolders && method === "GET") {
        const g = needCu();
        if (g) return g;
        return json({ folders: await getFolders(cuToken(), decodeURIComponent(cuSpaceFolders[1])) });
      }
      const cuSpaceLists = path.match(/^\/api\/integrations\/clickup\/spaces\/([^/]+)\/lists$/);
      if (cuSpaceLists && method === "GET") {
        const g = needCu();
        if (g) return g;
        return json({ lists: await getSpaceLists(cuToken(), decodeURIComponent(cuSpaceLists[1])) });
      }
      const cuFolderLists = path.match(/^\/api\/integrations\/clickup\/folders\/([^/]+)\/lists$/);
      if (cuFolderLists && method === "GET") {
        const g = needCu();
        if (g) return g;
        return json({ lists: await getFolderLists(cuToken(), decodeURIComponent(cuFolderLists[1])) });
      }
      const cuListTasks = path.match(/^\/api\/integrations\/clickup\/lists\/([^/]+)\/tasks$/);
      if (cuListTasks && method === "GET") {
        const g = needCu();
        if (g) return g;
        return json({ tasks: await getListTasks(cuToken(), decodeURIComponent(cuListTasks[1])) });
      }
      const cuImport = path.match(/^\/api\/integrations\/clickup\/lists\/([^/]+)\/import$/);
      if (cuImport && method === "POST") {
        const gate = needSpace();
        if (gate) return gate;
        const g = needCu();
        if (g) return g;
        const b = await readBody(req);
        const pid = String(b.project_id || "");
        if (!links.projects.some((p) => p.id === pid)) return json({ error: "project not tracked" }, 404);
        const picked: any[] = Array.isArray(b.tasks) ? b.tasks : [];
        const { toImport, skipped: alreadySkipped } = planImport(
          links.clickup.tasks,
          picked.map((t) => String(t.id || "")),
        );
        const byId = new Map(picked.map((t) => [String(t.id || ""), t]));
        let imported = 0;
        let skipped = alreadySkipped.length;
        for (const cid of toImport) {
          const t = byId.get(cid) || {};
          const cuTask: CuTask = {
            id: cid,
            name: String(t.name ?? ""),
            status: String(t.status ?? ""),
            statusType: String(t.statusType ?? "open"),
            dueDate: t.dueDate != null ? String(t.dueDate) : t.due_date != null ? String(t.due_date) : null,
            priority: t.priority != null ? String(t.priority) : null,
            description: String(t.description ?? ""),
            updatedMs: t.updatedMs != null && Number.isFinite(Number(t.updatedMs)) ? Number(t.updatedMs) : 0,
          };
          const draft = taskToDraft(cuTask);
          if (!draft.title.trim()) { skipped++; continue; }
          const task = await createLinkedTask(pid, draft, "ascent");
          links.clickup.tasks[cid] = task.id; // dedupe map survives restarts
          // Seed the sync snapshot so the first manual sync sees the import
          // as the baseline instead of a change on either side.
          links.clickup.sync[task.id] = {
            clickup_id: cid,
            anytype_id: task.id,
            clickup_updated: cuTask.updatedMs,
            anytype_updated: task.updatedMs,
            fields: {
              name: draft.title.trim(),
              desc: (draft.notes || "").trim(),
              due: draft.due_date || "",
              column: task.status,
            },
          };
          imported++;
        }
        // Importing from a list binds it to the project for future syncs
        // (only if the project isn't already bound to another list).
        if (imported > 0 && !links.clickup.bindings[pid]) {
          try {
            const info = await getListInfo(cuToken(), decodeURIComponent(cuImport[1]));
            links.clickup.bindings[pid] = { list_id: info.id, list_name: info.name, last_sync: null };
          } catch { /* binding is best-effort; the import already succeeded */ }
        }
        saveLinks();
        return json({ ok: true, imported, skipped }, 201);
      }

      // ---------- ClickUp two-way sync ----------
      // Bind a list to a project WITHOUT importing tasks, so ⇄ Sync can be
      // used on a project whose tasks were created in Ascent first.
      const cuBind = path.match(/^\/api\/integrations\/clickup\/lists\/([^/]+)\/bind$/);
      if (cuBind && method === "POST") {
        const gate = needSpace();
        if (gate) return gate;
        const g = needCu();
        if (g) return g;
        const b = await readBody(req);
        const pid = String(b.project_id || "");
        if (!links.projects.some((p) => p.id === pid)) return json({ error: "project not tracked" }, 404);
        const info = await getListInfo(cuToken(), decodeURIComponent(cuBind[1])); // also validates the list exists
        const prev = links.clickup.bindings[pid];
        if (prev && prev.list_id !== info.id) {
          // Rebinding to a DIFFERENT list: drop stale per-project sync
          // snapshots — they belong to the old list's task ids. A first-time
          // bind keeps any snapshots (e.g. seeded by an earlier import).
          for (const atId of Object.keys(links.clickup.sync)) {
            const l = links.tasks[atId];
            if (l && l.project_id === pid) delete links.clickup.sync[atId];
          }
        }
        links.clickup.bindings[pid] = {
          list_id: info.id,
          list_name: info.name,
          last_sync: prev && prev.list_id === info.id ? prev.last_sync : null,
        };
        saveLinks();
        return json({ ok: true, binding: links.clickup.bindings[pid] });
      }
      if (path === "/api/integrations/clickup/bindings" && method === "GET") {
        const g = needCu();
        if (g) return g;
        return json({ bindings: links.clickup.bindings }); // token is never included
      }
      const cuUnbind = path.match(/^\/api\/integrations\/clickup\/bindings\/([^/]+)$/);
      if (cuUnbind && method === "DELETE") {
        const g = needCu();
        if (g) return g;
        delete links.clickup.bindings[decodeURIComponent(cuUnbind[1])];
        saveLinks();
        return json({ ok: true });
      }

      // Manual two-way sync between a project and its bound ClickUp list.
      // Change detection: ClickUp date_updated vs the snapshot; Anytype
      // updated_at vs the snapshot (normalized field values as a fallback
      // when Anytype carries no usable timestamp). Both changed →
      // most-recent-wins; no Anytype timestamp → ClickUp wins. Deletions are
      // never synced — a mapped task missing on one side is only reported.
      if (path === "/api/integrations/clickup/sync" && method === "POST") {
        const gate = needSpace();
        if (gate) return gate;
        const g = needCu();
        if (g) return g;
        const b = await readBody(req);
        const pid = String(b.project_id || "");
        if (!links.projects.some((p) => p.id === pid)) return json({ error: "project not tracked" }, 404);
        const binding = links.clickup.bindings[pid];
        if (!binding) return json({ error: "no ClickUp list bound to this project — link a list first" }, 400);
        const token = cuToken();
        const report = {
          pulled: 0, pushed: 0, imported_new: 0, pushed_new: 0,
          conflicts: 0, conflicts_cu_won: 0, conflicts_at_won: 0,
          skipped: 0, gone_clickup: 0, gone_anytime: 0,
        };
        const cuFieldsOf = (t: CuTask): CuSyncFields => ({
          name: t.name.trim(),
          desc: t.description.trim(),
          due: t.dueDate ? isoDay(Number(t.dueDate)) : "",
          column: cuStatusToColumn(t.status, t.statusType),
        });
        const atFieldsOf = (t: { title: string; notes: string; dueMs: number; status: string }): CuSyncFields => ({
          name: String(t.title || "").trim(),
          desc: String(t.notes || "").trim(),
          due: t.dueMs ? isoDay(t.dueMs) : "",
          column: t.status,
        });
        const fieldsDiffer = (a: CuSyncFields, bb: CuSyncFields) =>
          a.name !== bb.name || a.desc !== bb.desc || a.due !== bb.due || a.column !== bb.column;
        // Refresh a sync snapshot from the current state of both sides.
        const snapshotAt = async (atId: string, cuId: string, cuUpdated: number) => {
          const tv = toTaskView(await getObject(config.space_id, atId), config.task_keys);
          const link = links.tasks[atId];
          links.clickup.sync[atId] = {
            clickup_id: cuId,
            anytype_id: atId,
            clickup_updated: cuUpdated,
            anytype_updated: tv.updatedMs,
            fields: {
              name: tv.title.trim(),
              desc: String(tv.notes || "").trim(),
              due: tv.dueMs ? isoDay(tv.dueMs) : "",
              column: effectiveStatus(tv.done, link),
            },
          };
        };
        const [cuTasks, listInfo] = await Promise.all([
          getListTasks(token, binding.list_id),
          getListInfo(token, binding.list_id),
        ]);
        const statuses: CuStatus[] = listInfo.statuses;
        const cuById = new Map(cuTasks.map((t) => [t.id, t]));
        const atTasks = await tasksFor(pid);
        const atById = new Map(atTasks.map((t) => [t.id, t]));
        const syncMap = links.clickup.sync;
        // Legacy (pre-sync) clickup_id → anytype_id entries belonging to this
        // project with no snapshot yet: baseline them from the current state
        // of both sides instead of duplicating tasks.
        for (const [cid, atId] of Object.entries(links.clickup.tasks)) {
          const l = links.tasks[atId];
          if (!l || l.project_id !== pid || syncMap[atId]) continue;
          const cu = cuById.get(cid);
          const at = atById.get(atId);
          if (!cu || !at) continue;
          await snapshotAt(atId, cid, cu.updatedMs);
          // no report increment here: the mapped-tasks loop below sees the
          // fresh snapshot and counts it as skipped on its own pass.
        }
        const mappedCuIds = new Set<string>();
        const mappedAtIds = new Set<string>();
        for (const st of Object.values(syncMap)) {
          const l = links.tasks[st.anytype_id];
          if (l && l.project_id === pid) { mappedCuIds.add(st.clickup_id); mappedAtIds.add(st.anytype_id); }
        }
        for (const [cid, atId] of Object.entries(links.clickup.tasks)) {
          const l = links.tasks[atId];
          if (l && l.project_id === pid) { mappedCuIds.add(cid); mappedAtIds.add(atId); }
        }
        // --- mapped tasks: pull, push, or resolve conflicts ---
        for (const st of Object.values(syncMap)) {
          const link = links.tasks[st.anytype_id];
          if (!link) {
            // The Anytype task is gone (its link was pruned): drop the stale
            // snapshot. The ClickUp task is left alone — never delete.
            delete syncMap[st.anytype_id];
            report.gone_anytime++;
            continue;
          }
          if (link.project_id !== pid) continue;
          const cu = cuById.get(st.clickup_id);
          const at = atById.get(st.anytype_id);
          if (!cu) { report.gone_clickup++; continue; } // deleted in ClickUp: leave the Anytype task alone
          if (!at) { delete syncMap[st.anytype_id]; report.gone_anytime++; continue; } // deleted in Anytype
          const cf = cuFieldsOf(cu);
          const af = atFieldsOf(at);
          const cuChanged = cu.updatedMs > st.clickup_updated;
          const atChanged = at.updatedMs > st.anytype_updated || (at.updatedMs === 0 && fieldsDiffer(af, st.fields));
          if (!cuChanged && !atChanged) { report.skipped++; continue; }
          const pull = async () => {
            const patch: { title?: string; notes?: string; due_date?: string; status?: string } = {};
            if (cf.name !== af.name) patch.title = cu.name;
            if (cf.desc !== af.desc) patch.notes = cu.description;
            if (cf.due !== af.due) patch.due_date = cf.due;
            if (cf.column !== af.column) patch.status = cf.column;
            if (Object.keys(patch).length) await applyTaskUpdate(st.anytype_id, patch);
            await snapshotAt(st.anytype_id, cu.id, cu.updatedMs);
          };
          const push = async () => {
            const cuPatch: Record<string, any> = {};
            if (af.name !== st.fields.name) cuPatch.name = at.title;
            if (af.desc !== st.fields.desc) cuPatch.description = at.notes || "";
            if (af.due !== st.fields.due) cuPatch.due_date = at.dueMs ? at.dueMs : null;
            if (af.column !== st.fields.column) {
              const cuStatus = columnToCuStatus(statuses, at.status);
              if (cuStatus) cuPatch.status = cuStatus;
            }
            if (Object.keys(cuPatch).length) await updateCuTask(token, cu.id, cuPatch);
            const fresh = await getCuTask(token, cu.id).catch(() => null);
            links.clickup.sync[st.anytype_id] = {
              clickup_id: cu.id,
              anytype_id: st.anytype_id,
              clickup_updated: fresh ? fresh.updatedMs : cu.updatedMs,
              anytype_updated: at.updatedMs,
              fields: af,
            };
          };
          if (cuChanged && !atChanged) { await pull(); report.pulled++; continue; }
          if (atChanged && !cuChanged) { await push(); report.pushed++; continue; }
          report.conflicts++;
          if (at.updatedMs === 0 || cu.updatedMs >= at.updatedMs) {
            await pull(); report.conflicts_cu_won++;
          } else {
            await push(); report.conflicts_at_won++;
          }
        }
        // --- unmapped ClickUp tasks → import as native Anytype tasks ---
        for (const cu of cuTasks) {
          if (mappedCuIds.has(cu.id)) continue;
          const draft = taskToDraft(cu);
          if (!draft.title.trim()) continue;
          const task = await createLinkedTask(pid, draft, "ascent");
          links.clickup.tasks[cu.id] = task.id;
          links.clickup.sync[task.id] = {
            clickup_id: cu.id,
            anytype_id: task.id,
            clickup_updated: cu.updatedMs,
            anytype_updated: task.updatedMs,
            fields: {
              name: draft.title.trim(),
              desc: (draft.notes || "").trim(),
              due: draft.due_date || "",
              column: task.status,
            },
          };
          mappedCuIds.add(cu.id);
          report.imported_new++;
        }
        // --- unmapped Anytype tasks in this project → create in ClickUp ---
        for (const at of atTasks) {
          if (mappedAtIds.has(at.id)) continue;
          const cuStatus = columnToCuStatus(statuses, at.status);
          const created = await createCuTask(token, binding.list_id, {
            name: at.title,
            description: at.notes || "",
            due_date: at.dueMs ? at.dueMs : null,
            status: cuStatus || undefined,
          });
          links.clickup.tasks[created.id] = at.id;
          links.clickup.sync[at.id] = {
            clickup_id: created.id,
            anytype_id: at.id,
            clickup_updated: created.updatedMs,
            anytype_updated: at.updatedMs,
            fields: atFieldsOf(at),
          };
          mappedAtIds.add(at.id);
          report.pushed_new++;
        }
        binding.last_sync = new Date().toISOString();
        saveLinks();
        return json({ ok: true, report, binding });
      }

      // ---------- email integration (IMAP: starred emails → tasks) ----------
      // Credentials live only in gitignored data/links.json and every mail
      // call is proxied through the server: the browser never sees the
      // password, and no GET ever returns it. The mail account IS the
      // project — the first import creates a native Anytype project named
      // after the account and later imports reuse it.
      const needEmail = (): Response | null =>
        links.email.host ? null : json({ error: "email not connected" }, 401);
      const emailLabel = (): string =>
        links.email.user.includes("@") ? links.email.user : `${links.email.user}@${links.email.host}`;

      if (path === "/api/integrations/email/status" && method === "GET") {
        return json({
          connected: !!links.email.host,
          account: links.email.host ? emailLabel() : "",
          project_id: links.email.project_id || null,
        });
      }
      if (path === "/api/integrations/email/connect" && method === "POST") {
        const b = await readBody(req);
        const cfg = {
          host: String(b.host || "").trim(),
          port: Number(b.port) > 0 ? Number(b.port) : 993,
          user: String(b.user || "").trim(),
          pass: String(b.pass || ""),
        };
        await validateImap(cfg); // throws ImapError on bad credentials / unreachable
        links.email.host = cfg.host;
        links.email.port = cfg.port;
        links.email.user = cfg.user;
        links.email.pass = cfg.pass;
        saveLinks();
        return json({ ok: true, account: emailLabel() });
      }
      if (path === "/api/integrations/email/disconnect" && method === "POST") {
        // Credentials go; the project and its imported tasks stay (they are
        // unlinked-never-deleted, like every other import). The uid dedupe
        // map survives so a reconnect doesn't duplicate tasks.
        links.email.host = "";
        links.email.user = "";
        links.email.pass = "";
        saveLinks();
        return json({ ok: true });
      }
      if (path === "/api/integrations/email/starred" && method === "GET") {
        const g = needEmail();
        if (g) return g;
        const mails = await fetchStarred(links.email);
        return json({
          account: emailLabel(),
          mails: mails.map((m) => ({ ...m, imported: !!links.email.uids[m.uid] })),
        });
      }
      if (path === "/api/integrations/email/import" && method === "POST") {
        const gate = needSpace();
        if (gate) return gate;
        const g = needEmail();
        if (g) return g;
        const b = await readBody(req);
        const uids: string[] = Array.isArray(b.uids) ? b.uids.map((u: any) => String(u)) : [];
        if (!uids.length) return json({ error: "pick at least one email" }, 400);
        // The email account is the project: create it once, reuse it after.
        let pid = links.email.project_id;
        if (!pid || !links.projects.some((p) => p.id === pid)) {
          const o = await createObject(config.space_id, {
            name: `✉ ${emailLabel()}`,
            type_key: "page",
            body: `Starred emails imported from ${emailLabel()} over IMAP.`,
            icon: "✉",
          });
          pid = String(o.id);
          links.projects.unshift({ id: pid, source: "imported", added_at: new Date().toISOString() });
          links.email.project_id = pid;
          saveLinks();
        }
        const mails = await fetchStarred(links.email);
        const byUid = new Map(mails.map((m) => [m.uid, m]));
        let imported = 0;
        let skipped = 0;
        for (const uid of uids) {
          if (links.email.uids[uid]) { skipped++; continue; } // already imported
          const m = byUid.get(uid);
          if (!m) { skipped++; continue; } // no longer starred / gone
          const notes = [
            `From: ${m.from || "unknown"}`,
            m.date ? `Date: ${m.date}` : "",
            "",
            m.snippet || "",
          ].join("\n").trim();
          const task = await createLinkedTask(pid, {
            title: m.subject || "(no subject)",
            notes,
            due_date: "",
            status: "backlog",
          }, "imported");
          links.email.uids[uid] = task.id;
          imported++;
        }
        saveLinks();
        return json({ ok: true, imported, skipped, project_id: pid }, 201);
      }

      // ---------- search (for import pickers) ----------
      if (path === "/api/search" && method === "GET") {
        const gate = needSpace();
        if (gate) return gate;
        const q = url.searchParams.get("q") || "";
        const kind = url.searchParams.get("kind") === "page" ? "page" : "task";
        const objs = await searchSpace(config.space_id, { query: q, types: [kind], limit: 30 });
        const linkedIds = new Set([
          ...links.projects.map((p) => p.id),
          ...Object.keys(links.tasks),
          ...Object.keys(links.wiki),
        ]);
        const items = objs
          .filter((o) => o.id && !linkedIds.has(String(o.id)))
          .map((o) => kind === "task"
            ? { id: String(o.id), title: toTaskView(o, config.task_keys).title }
            : { id: String(o.id), title: toProjectView(o).name });
        return json({ items });
      }

      // ---------- static ----------
      const filePath = "public" + (path === "/" ? "/index.html" : path);
      const file = Bun.file(filePath);
      if (await file.exists()) {
        return new Response(file, {
          headers: { "Content-Type": contentType(filePath) },
        });
      }
      if (!path.startsWith("/api/")) {
        return new Response(Bun.file("public/index.html"), {
          headers: { "Content-Type": "text/html" },
        });
      }
      return json({ error: "not found" }, 404);
    } catch (e) {
      return atErr(e);
    }
  },
});

function contentType(p: string): string {
  if (p.endsWith(".html")) return "text/html";
  if (p.endsWith(".js")) return "text/javascript";
  if (p.endsWith(".css")) return "text/css";
  if (p.endsWith(".svg")) return "image/svg+xml";
  return "application/octet-stream";
}

console.log(`ascent listening on http://localhost:${server.port} (Anytype: ${baseUrl()})`);
