// Ascent — glossy project management over the Anytype local API.
// Bun + zero dependencies. All project/task/article content lives in the user's
// Anytype space; data/links.json only remembers which task/article belongs to
// which project (and each card's kanban column), plus the pairing config.

import {
  setApiKey, getApiKey, baseUrl, AnytypeError,
  createChallenge, exchangeCode, listSpaces, listProperties, discoverTaskKeys,
  searchSpace, createObject, getObject, updateObject, deleteObject,
  toTaskView, toProjectView, toArticleView, type TaskKeys,
} from "./anytype";

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
interface TaskLink { project_id: string; status: string; source: "ascent" | "imported" }
interface ProjectLink { id: string; source: "ascent" | "imported"; added_at: string }
interface WikiLink { project_id: string; source: "ascent" | "imported"; added_at: string }
interface Links { projects: ProjectLink[]; tasks: Record<string, TaskLink>; wiki: Record<string, WikiLink> }

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
let links: Links = loadJson<Links>(LINKS_PATH, { projects: [], tasks: {}, wiki: {} });
if (config.api_key) setApiKey(config.api_key);

const saveConfig = () => saveJson(CONFIG_PATH, config);
const saveLinks = () => saveJson(LINKS_PATH, links);
if (!links.wiki) { links.wiki = {}; saveLinks(); } // upgrade path for pre-wiki link indexes

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
  out.sort((a, b) => (a.dueMs || Infinity) - (b.dueMs || Infinity) || b.updatedMs - a.updatedMs);
  return out;
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
        links = { projects: [], tasks: {}, wiki: {} };
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
        for (const pl of links.projects) {
          const p = await hydrateProject(pl);
          if (!p) continue;
          const tasks = await tasksFor(pl.id);
          const done = tasks.filter((t) => t.status === "done").length;
          const od = tasks.filter((t) => t.status !== "done" && t.dueMs && t.dueMs < now).length;
          open += tasks.length - done;
          doneCount += done;
          overdue += od;
          for (const t of tasks) {
            if (t.status !== "done" && t.dueMs && t.dueMs < now + 3 * dayMs) {
              attention.push({ project_id: pl.id, project_name: p.name, id: t.id, title: t.title, dueMs: t.dueMs, overdue: t.dueMs < now });
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
          return json({ project: p, tasks: await tasksFor(pid) });
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
        const status = STATUSES.includes(b.status) ? b.status : "backlog";
        const props: Array<Record<string, any>> = [{ key: config.task_keys.done, checkbox: status === "done" }];
        if (b.due_date) props.push({ key: config.task_keys.due, date: b.due_date });
        const o = await createObject(config.space_id, {
          name: b.title.trim(),
          type_key: "task",
          body: b.notes || "",
          properties: props,
        });
        const tv = toTaskView(o, config.task_keys);
        links.tasks[tv.id] = { project_id: pid, status, source: "ascent" };
        saveLinks();
        return json({ task: { ...tv, status: effectiveStatus(tv.done, links.tasks[tv.id]), source: "ascent" } }, 201);
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
          const patch: any = {};
          const props: Array<Record<string, any>> = [];
          if (b.title !== undefined) patch.name = b.title;
          if (b.notes !== undefined) patch.markdown = b.notes;
          let newStatus = link.status;
          if (b.done !== undefined || b.status !== undefined) {
            const wantDone = b.done !== undefined ? !!b.done : b.status === "done";
            props.push({ key: config.task_keys.done, checkbox: wantDone });
            if (b.status !== undefined && STATUSES.includes(b.status)) newStatus = b.status;
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
          const tv = toTaskView(await getObject(config.space_id, tid), config.task_keys);
          return json({ task: { ...tv, status: effectiveStatus(tv.done, links.tasks[tid]), source: link.source } });
        }
        if (method === "DELETE") {
          const gate = needSpace();
          if (gate) return gate;
          if (link.source === "ascent") {
            try { await deleteObject(config.space_id, tid); } catch { /* already gone */ }
          }
          delete links.tasks[tid];
          saveLinks();
          return json({ ok: true });
        }
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
