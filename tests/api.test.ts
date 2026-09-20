// Ascent — API integration tests for the batch endpoints, against a stubbed
// Anytype local API. No live Anytype app is contacted.
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";

const PORT = 34197;
process.env.PORT = String(PORT);
const BASE = `http://127.0.0.1:${PORT}`;
const realFetch = globalThis.fetch.bind(globalThis);

const DATA_DIR = new URL("../data/", import.meta.url).pathname;
const CONFIG_PATH = DATA_DIR + "config.json";
const LINKS_PATH = DATA_DIR + "links.json";

// ---------- in-memory Anytype mock ----------
const store = new Map<string, any>();
let seq = 1;
function mkObject(name: string, props: any[] = [], extra: any = {}) {
  const id = `mock${seq++}`;
  const o = { id, name, properties: props, ...extra };
  store.set(id, o);
  return o;
}
const DAY = 86400000;
const startOfDay = (ms: number) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };
const isoDay = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const today = startOfDay(Date.now());
const doneProp = (done: boolean) => ({ key: "done", checkbox: done });
const dueProp = (iso: string) => ({ key: "due_date", date: iso });

const P = mkObject("Acme Project", [], { icon: { emoji: "🚀" } });
const A = mkObject("Launch notes", [], { markdown: "hello world launch plan" });
const T1 = mkObject("Write proposal", [doneProp(false), dueProp(isoDay(today - DAY))]);   // overdue
const T2 = mkObject("Review proposal", [doneProp(false), dueProp(isoDay(today))]);       // due today
const T3 = mkObject("Infra cleanup", [doneProp(false)]);                                  // in progress, no due
const T4 = mkObject("Done yesterday", [doneProp(true), dueProp(isoDay(today))]);          // done → excluded
const T5 = mkObject("Daily standup notes", [doneProp(false)]);                            // recurring test
const T6 = mkObject("Blocker task", [doneProp(false)]);

function anytypeMock(url: string, init: any): Response {
  const u = new URL(url);
  const path = u.pathname;
  const method = (init?.method || "GET").toUpperCase();
  let body: any = {};
  try { body = init?.body ? JSON.parse(init.body) : {}; } catch { /* ignore */ }
  const ok = (v: any, status = 200) =>
    new Response(JSON.stringify(v), { status, headers: { "Content-Type": "application/json" } });
  const err = (status: number, msg: string) => ok({ error: { message: msg } }, status);
  let m = path.match(/^\/v1\/spaces\/([^/]+)\/objects\/([^/]+)$/);
  if (m) {
    const id = m[2];
    const o = store.get(id);
    if (!o) return err(404, "not found");
    if (method === "GET") return ok({ object: o });
    if (method === "PATCH") {
      if (body.name !== undefined) o.name = body.name;
      if (Array.isArray(body.properties)) {
        for (const p of body.properties) {
          const i = o.properties.findIndex((x: any) => x.key === p.key);
          if (i >= 0) o.properties[i] = p; else o.properties.push(p);
        }
      }
      return ok({ object: o });
    }
    if (method === "DELETE") { store.delete(id); return ok({}); }
  }
  m = path.match(/^\/v1\/spaces\/([^/]+)\/objects$/);
  if (m && method === "POST") {
    const o = mkObject(body.name || "Untitled", body.properties || []);
    if (body.body) o.markdown = body.body;
    return ok({ object: o });
  }
  m = path.match(/^\/v1\/spaces\/([^/]+)\/search$/);
  if (m && method === "POST") return ok({ data: [...store.values()] });
  if (path === "/v1/spaces" && method === "GET") return ok({ data: [{ id: "spacetest", name: "Test Space" }] });
  return err(404, `mock: unhandled ${method} ${path}`);
}

globalThis.fetch = (async (url: any, init: any) => {
  const u = String(url);
  if (u.startsWith(BASE)) return realFetch(u, init);
  return anytypeMock(u, init);
}) as any;

let configBackup: string | null = null;
let linksBackup: string | null = null;

const api = async (path: string, init: any = {}) => {
  const res = await realFetch(BASE + path, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init.headers || {}) },
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
};
const GET = (p: string) => api(p);
const POST = (p: string, b: any) => api(p, { method: "POST", body: JSON.stringify(b) });
const PATCH = (p: string, b: any) => api(p, { method: "PATCH", body: JSON.stringify(b) });
const DEL = (p: string) => api(p, { method: "DELETE" });

beforeAll(async () => {
  mkdirSync(DATA_DIR, { recursive: true });
  if (existsSync(CONFIG_PATH)) configBackup = readFileSync(CONFIG_PATH, "utf8");
  if (existsSync(LINKS_PATH)) linksBackup = readFileSync(LINKS_PATH, "utf8");
  writeFileSync(CONFIG_PATH, JSON.stringify({
    api_key: "test-key", space_id: "spacetest", space_name: "Test Space",
    task_keys: { done: "done", due: "due_date" },
  }));
  writeFileSync(LINKS_PATH, JSON.stringify({
    projects: [{ id: P.id, source: "ascent" }],
    tasks: {
      [T1.id]: { project_id: P.id, status: "backlog", source: "ascent" },
      [T2.id]: { project_id: P.id, status: "in_progress", source: "ascent", blocked_by: [T1.id] },
      [T3.id]: { project_id: P.id, status: "in_progress", source: "ascent" },
      [T4.id]: { project_id: P.id, status: "done", source: "ascent" },
      [T5.id]: { project_id: P.id, status: "backlog", source: "ascent", recurrence: { kind: "daily" } },
      [T6.id]: { project_id: P.id, status: "backlog", source: "ascent" },
    },
    wiki: { [A.id]: { project_id: P.id, source: "ascent" } },
    clickup: { token: "", tasks: {}, bindings: {}, sync: {} },
    email: { host: "", port: 993, user: "", pass: "", project_id: "", uids: {} },
    sprints: [],
  }));
  await import("../src/server");
});

afterAll(() => {
  if (configBackup !== null) writeFileSync(CONFIG_PATH, configBackup);
  if (linksBackup !== null) writeFileSync(LINKS_PATH, linksBackup);
});

describe("My Day", () => {
  test("groups overdue / due-today / in-progress, excludes done", async () => {
    const { status, body } = await GET("/api/myday");
    expect(status).toBe(200);
    expect(body.overdue.map((t: any) => t.id)).toContain(T1.id);
    expect(body.today.map((t: any) => t.id)).toContain(T2.id);
    expect(body.in_progress.map((t: any) => t.id)).toContain(T3.id);
    const all = [...body.overdue, ...body.today, ...body.in_progress].map((t: any) => t.id);
    expect(all).not.toContain(T4.id);
    expect(new Set(all).size).toBe(all.length);
  });
  test("blocked task carries blocker details", async () => {
    const { body } = await GET("/api/myday");
    const t2 = body.today.find((t: any) => t.id === T2.id);
    expect(t2.blocked).toBe(true);
    expect(t2.blockers.map((b: any) => b.title)).toContain("Write proposal");
  });
});

describe("quicksearch (Cmd+K)", () => {
  test("finds tasks, projects, and wiki articles", async () => {
    const { body } = await GET("/api/quicksearch?q=proposal");
    expect(body.tasks.map((t: any) => t.id)).toEqual(expect.arrayContaining([T1.id, T2.id]));
    const { body: b2 } = await GET("/api/quicksearch?q=acme");
    expect(b2.projects.map((p: any) => p.id)).toContain(P.id);
    const { body: b3 } = await GET("/api/quicksearch?q=launch");
    expect(b3.articles.map((a: any) => a.id)).toContain(A.id);
  });
  test("empty query returns empty lists", async () => {
    const { body } = await GET("/api/quicksearch?q=");
    expect(body).toEqual({ tasks: [], projects: [], articles: [] });
  });
});

describe("quick-add", () => {
  test("parse endpoint strips natural language", async () => {
    const { body } = await POST("/api/quick-add/parse", { text: "call dentist tomorrow 30m" });
    expect(body.title).toBe("call dentist");
    expect(body.dueISO).toBe(isoDay(today + DAY));
    expect(body.estimateMin).toBe(30);
  });
  test("creates a task with parsed due date and estimate", async () => {
    const { status, body } = await POST("/api/quick-add", { text: "water plants in 2 days 15m", project_id: P.id });
    expect(status).toBe(201);
    expect(body.parsed.dueISO).toBe(isoDay(today + 2 * DAY));
    expect(body.parsed.estimateMin).toBe(15);
    const { body: proj } = await GET(`/api/projects/${P.id}`);
    const created = proj.tasks.find((t: any) => t.id === body.task.id);
    expect(created.estimate_min).toBe(15);
    expect(created.dueMs).toBe(startOfDay(today + 2 * DAY));
  });
  test("explicit due override wins over parsed text", async () => {
    const { body } = await POST("/api/quick-add", {
      text: "someday task tomorrow", project_id: P.id, due: "2026-12-25",
    });
    expect(body.parsed.dueISO).toBe("2026-12-25");
  });
  test("unknown project is 404", async () => {
    const { status } = await POST("/api/quick-add", { text: "x tomorrow", project_id: "nope" });
    expect(status).toBe(404);
  });
});

describe("dependencies", () => {
  test("completing a blocked task is rejected with 409 naming the blockers", async () => {
    const { status, body } = await PATCH(`/api/tasks/${T2.id}`, { done: true });
    expect(status).toBe(409);
    expect(body.needs_confirm).toBe(true);
    expect(body.blockers.map((b: any) => b.title)).toContain("Write proposal");
  });
  test("explicit confirmation completes the blocked task", async () => {
    const { status, body } = await PATCH(`/api/tasks/${T2.id}`, { done: true, confirm: true });
    expect(status).toBe(200);
    expect(body.task.status).toBe("done");
  });
  test("dependency cycles are rejected", async () => {
    // T2 is blocked by T1; making T1 blocked by T2 would cycle.
    const { status, body } = await PATCH(`/api/tasks/${T1.id}`, { blocked_by: [T2.id] });
    expect(status).toBe(400);
    expect(body.error).toMatch(/cycle/i);
  });
  test("self-blocking is rejected", async () => {
    const { status } = await PATCH(`/api/tasks/${T1.id}`, { blocked_by: [T1.id] });
    expect(status).toBe(400);
  });
  test("deleted tasks leave blocker lists", async () => {
    await PATCH(`/api/tasks/${T3.id}`, { blocked_by: [T6.id] });
    const { status } = await DEL(`/api/tasks/${T6.id}`);
    expect(status).toBe(200);
    const { body } = await GET(`/api/projects/${P.id}`);
    const t3 = body.tasks.find((t: any) => t.id === T3.id);
    expect(t3.blocked_by).toEqual([]);
    expect(t3.blocked).toBe(false);
  });
});

describe("recurring tasks", () => {
  test("completing a daily task spawns the next instance due tomorrow", async () => {
    const { status, body } = await PATCH(`/api/tasks/${T5.id}`, { done: true });
    expect(status).toBe(200);
    expect(body.task.status).toBe("done");
    expect(body.task.next_instance).toBeTruthy();
    expect(body.task.next_instance.dueMs).toBe(startOfDay(today + DAY));
    expect(body.task.next_instance.status).toBe("backlog");
    // The new instance is recurring too, so the chain continues.
    const { body: proj } = await GET(`/api/projects/${P.id}`);
    const next = proj.tasks.find((t: any) => t.id === body.task.next_instance.id);
    expect(next.recurrence).toEqual({ kind: "daily" });
  });
});

describe("sprints", () => {
  let sid = "";
  test("create defaults to this week Monday–Sunday", async () => {
    const { status, body } = await POST("/api/sprints", { name: "Sprint 1" });
    expect(status).toBe(201);
    sid = body.sprint.id;
    const dow = (new Date(today).getDay() + 6) % 7; // Mon=0
    const mon = today - dow * DAY;
    expect(body.sprint.start).toBe(isoDay(mon));
    expect(body.sprint.end).toBe(isoDay(mon + 6 * DAY));
    expect(body.sprint.status).toBe("open");
  });
  test("add tasks across the project, then read the board", async () => {
    const r = await POST(`/api/sprints/${sid}/tasks`, { task_id: T1.id });
    expect(r.status).toBe(200);
    const { body } = await GET(`/api/sprints/${sid}`);
    expect(body.tasks.map((t: any) => t.id)).toContain(T1.id);
    expect(body.tasks[0].project_name).toBe("Acme Project");
  });
  test("close returns unfinished tasks to backlog and archives", async () => {
    const { status, body } = await POST(`/api/sprints/${sid}/close`, {});
    expect(status).toBe(200);
    expect(body.sprint.status).toBe("closed");
    expect(body.returned_to_backlog).toBe(1);
    const { body: list } = await GET("/api/sprints");
    expect(list.open.map((s: any) => s.id)).not.toContain(sid);
    expect(list.closed.map((s: any) => s.id)).toContain(sid);
  });
  test("closed sprints refuse new tasks", async () => {
    const { status } = await POST(`/api/sprints/${sid}/tasks`, { task_id: T2.id });
    expect(status).toBe(400);
  });
});

describe("ClickUp regression", () => {
  test("status endpoint works with no token and sync state is untouched", async () => {
    const { status, body } = await GET("/api/integrations/clickup/status");
    expect(status).toBe(200);
    expect(body.connected).toBe(false);
  });
  test("tasks still hydrate after the batch changes", async () => {
    const { status, body } = await GET(`/api/projects/${P.id}`);
    expect(status).toBe(200);
    expect(body.tasks.length).toBeGreaterThan(0);
    // Ascent-only fields are present on hydrated tasks.
    const t = body.tasks[0];
    expect(t).toHaveProperty("blocked_by");
    expect(t).toHaveProperty("recurrence");
    expect(t).toHaveProperty("subtasks");
    expect(t).toHaveProperty("estimate_min");
  });
});
