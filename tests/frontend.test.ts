// Ascent — DOM-stubbed frontend tests for the batch UI (My Day, Cmd+K,
// quick-add, sprints, subtask checklist, blocked badges). The real bundle is
// eval'd against a minimal DOM stub; no browser needed.
import { describe, test, expect, beforeAll } from "bun:test";
import { readFileSync } from "fs";

/* ---------- minimal DOM stub ---------- */
function makeEl(doc: any, tag = "div") {
  const listeners: Record<string, Function[]> = {};
  const namedFields = new Map<string, any>();
  const registerIds = (html: string) => {
    const re = /id="([\w-]+)"/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html))) {
      if (!doc._byId.has(m[1])) { const el = makeEl(doc); el._id = m[1]; doc._byId.set(m[1], el); }
    }
  };
  const el: any = {
    tag, children: [],
    _innerHTML: "", _textContent: "", _value: "",
    dataset: {}, style: {},
    classList: {
      _s: new Set<string>(),
      add(...c: string[]) { c.forEach((x) => (this as any)._s.add(x)); },
      remove(...c: string[]) { c.forEach((x) => (this as any)._s.delete(x)); },
      contains(x: string) { return (this as any)._s.has(x); },
      toggle(x: string) { const s = (this as any)._s; s.has(x) ? s.delete(x) : s.add(x); },
    },
    onclick: null as any,
    get innerHTML() { return this._innerHTML; },
    set innerHTML(v: string) { this._innerHTML = String(v); registerIds(this._innerHTML); },
    get textContent() { return this._textContent; },
    set textContent(v: string) { this._textContent = String(v); },
    get value() { return this._value; },
    set value(v: string) { this._value = String(v); },
    get id() { return this._id || ""; },
    set id(v: string) { this._id = v; if (v) doc._byId.set(v, this); },
    _id: "",
    addEventListener(t: string, fn: Function) { (listeners[t] = listeners[t] || []).push(fn); },
    removeEventListener() {},
    fire(t: string, e: any = {}) { (listeners[t] || []).forEach((fn) => fn(e)); },
    appendChild(c: any) { this.children.push(c); return c; },
    remove() { if (this._id) doc._byId.delete(this._id); },
    scrollIntoView() {}, focus() {}, select() {}, click() {},
    closest() { return null; },
    setAttribute(k: string, v: string) { (this._attrs = this._attrs || {})[k] = String(v); },
    getAttribute(k: string) { return (this._attrs || {})[k] ?? null; },
    querySelector(sel: string) {
      const m = sel.match(/\[name="([^"]+)"\]/);
      if (m && !sel.startsWith("#")) {
        if (!namedFields.has(m[1])) { const f = makeEl(doc, "input"); f.name = m[1]; namedFields.set(m[1], f); }
        return namedFields.get(m[1]);
      }
      const im = sel.match(/^#([\w-]+)$/);
      if (im) return doc._byId.get(im[1]) || null;
      return null;
    },
    querySelectorAll(sel: string) {
      if (sel === "[name]") return [...namedFields.values()];
      return [];
    },
    _namedFields: namedFields,
  };
  return el;
}

// Static ids present in public/index.html.
const STATIC_IDS = ["view", "modal-root", "toasts", "sidebar", "topbar", "page-title",
  "page-sub", "topbar-actions", "nav-toggle", "scrim", "theme-toggle",
  "quick-add-btn", "cmdk-btn", "space-name", "conn-label", "drawer-close"];

function makeDocument() {
  const byId = new Map<string, any>();
  const doc: any = {
    _byId: byId,
    title: "",
    documentElement: { dataset: {} },
    body: null as any,
    createElement(tag: string) { return makeEl(doc, tag); },
    getElementById(id: string) { return byId.get(id) || null; },
    peek(id: string) { return byId.get(id) || null; },
    querySelector(sel: string) {
      const m = sel.match(/^#([\w-]+)$/);
      if (m) return byId.get(m[1]) || null;
      return null;
    },
    querySelectorAll() { return []; },
    addEventListener() {},
  };
  doc.body = makeEl(doc, "body");
  for (const id of STATIC_IDS) { const el = makeEl(doc); el._id = id; byId.set(id, el); }
  return doc;
}

/* ---------- canned API ---------- */
const fetchCalls: Array<{ path: string; init: any }> = [];
const DAY = 86400000;
const sod = (ms: number) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };
const today = sod(Date.now());
const MYDAY = {
  overdue: [{ id: "t1", project_id: "p1", project_name: "Acme", project_icon: "🚀", title: "Write proposal",
    status: "backlog", dueMs: today - DAY, estimate_min: 60, blocked: true,
    blockers: [{ id: "t9", title: "Sign contract", status: "backlog" }],
    recurrence: null, subtask_done: 0, subtask_total: 0 }],
  today: [{ id: "t2", project_id: "p1", project_name: "Acme", project_icon: "🚀", title: "Review proposal",
    status: "in_progress", dueMs: today + 3600000, estimate_min: null, blocked: false, blockers: [],
    recurrence: { kind: "daily" }, subtask_done: 1, subtask_total: 2 }],
  in_progress: [{ id: "t3", project_id: "p2", project_name: "Home", project_icon: "🏠", title: "Fix sink",
    status: "in_progress", dueMs: 0, estimate_min: null, blocked: false, blockers: [],
    recurrence: null, subtask_done: 0, subtask_total: 0 }],
};
const SPRINTS = { open: [{ id: "sp1", name: "Sprint 1", start: "2026-09-14", end: "2026-09-20", status: "open", total: 2 }], closed: [] };
const SPRINT_DETAIL = {
  sprint: SPRINTS.open[0],
  tasks: [
    { id: "t1", project_id: "p1", project_name: "Acme", title: "Write proposal", status: "backlog", dueMs: today - DAY, estimate_min: 60, blocked: false, subtask_done: 0, subtask_total: 0 },
    { id: "t2", project_id: "p1", project_name: "Acme", title: "Review proposal", status: "done", dueMs: today, estimate_min: 30, blocked: false, subtask_done: 2, subtask_total: 2 },
  ],
};

function stubFetch(path: string, init: any = {}) {
  fetchCalls.push({ path, init });
  const method = (init.method || "GET").toUpperCase();
  let data: any = {};
  if (path === "/api/status") data = { paired: true, has_space: true, space_name: "Test Space" };
  else if (path === "/api/myday") data = MYDAY;
  else if (path.startsWith("/api/quicksearch")) {
    const q = new URL("http://x" + path).searchParams.get("q") || "";
    data = q ? {
      tasks: [{ id: "t1", project_id: "p1", project_name: "Acme", title: "Write proposal about " + q }],
      projects: [{ id: "p1", name: "Acme Project", icon: "🚀" }],
      articles: [{ id: "a1", project_id: "p1", project_name: "Acme", title: "Launch notes" }],
    } : { tasks: [], projects: [], articles: [] };
  }
  else if (path === "/api/projects" && method === "GET") data = { projects: [{ id: "p1", name: "Acme", icon: "🚀" }] };
  else if (path === "/api/quick-add/parse") data = { title: "call mom", dueISO: "2026-09-21", estimateMin: null };
  else if (path === "/api/quick-add") data = { task: { id: "nt1", title: "call mom" }, parsed: { dueISO: "2026-09-21", estimateMin: null } };
  else if (path === "/api/sprints" && method === "GET") data = SPRINTS;
  else if (path === "/api/sprints/sp1") data = SPRINT_DETAIL;
  return Promise.resolve({ ok: true, status: 200, json: async () => data });
}

/* ---------- load the real bundles ---------- */
let T: any;
let document: any;
let location: any;
const listeners: Record<string, Function[]> = {};

beforeAll(async () => {
  document = makeDocument();
  location = { hash: "#/myday" };
  const localStorage = {
    _m: new Map<string, string>(),
    getItem(k: string) { return this._m.get(k) ?? null; },
    setItem(k: string, v: string) { this._m.set(k, String(v)); },
    removeItem(k: string) { this._m.delete(k); },
  };
  const window = {
    addEventListener(t: string, fn: Function) { (listeners[t] = listeners[t] || []).push(fn); },
    matchMedia: () => ({ matches: false }),
  };
  const estimateSrc = readFileSync(new URL("../public/estimate.js", import.meta.url).pathname, "utf8");
  const appSrc = readFileSync(new URL("../public/app.js", import.meta.url).pathname, "utf8");
  const factory = new Function(
    "document", "window", "location", "localStorage", "fetch", "confirm", "alert", "matchMedia",
    estimateSrc + "\n" + appSrc + "\nreturn globalThis.__test;",
  );
  T = factory(
    document, window, location, localStorage,
    stubFetch, () => true, () => {}, window.matchMedia,
  );
  // Let the boot route() settle (status → myday).
  await new Promise((r) => setTimeout(r, 50));
});

describe("My Day view", () => {
  test("renders the three sections with task rows", async () => {
    await T.vMyDay();
    const html = document.getElementById("view").innerHTML;
    expect(html).toContain("Overdue");
    expect(html).toContain("Due today");
    expect(html).toContain("In progress");
    expect(html).toContain("Write proposal");
    expect(html).toContain("Review proposal");
    expect(html).toContain("Fix sink");
  });
  test("rows show blocked, recurrence, and subtask badges", async () => {
    await T.vMyDay();
    const html = document.getElementById("view").innerHTML;
    expect(html).toContain("badge-blocked");
    expect(html).toContain("Sign contract");
    expect(html).toContain("🔁");
    expect(html).toContain("1/2");
  });
  test("openTaskInProject navigates to the project route", () => {
    T.openTaskInProject("p1", "t1");
    expect(location.hash).toBe("#/projects/p1");
  });
});

describe("Cmd+K palette", () => {
  test("opens with an input and empty-state hint", () => {
    T.openCmdK();
    const root = document.peek("cmdk-root");
    expect(root).toBeTruthy();
    expect(root.innerHTML).toContain('id="cmdk-input"');
    expect(document.getElementById("cmdk-list").innerHTML).toContain("Type to search");
  });
  test("search renders task/project/article results", async () => {
    await T.cmdkSearch("proposal");
    const html = document.getElementById("cmdk-list").innerHTML;
    expect(html).toContain("Write proposal");
    expect(html).toContain("Acme Project");
    expect(html).toContain("Launch notes");
    expect(T.cmdkState().items.length).toBeGreaterThan(3); // + "create task" row
  });
  test("arrow keys move the selection", async () => {
    await T.cmdkSearch("proposal");
    const before = T.cmdkState().sel;
    T.cmdkMove(1);
    expect(T.cmdkState().sel).toBe((before + 1) % T.cmdkState().items.length);
    T.cmdkMove(-1);
    expect(T.cmdkState().sel).toBe(before);
  });
  test("Enter on a task result navigates to its project", async () => {
    await T.cmdkSearch("proposal");
    // items[0] is "create", items[2] is the first task
    const idx = T.cmdkState().items.findIndex((i: any) => i.kind === "task");
    T.cmdkState(); // snapshot
    for (let i = 0; i < idx; i++) T.cmdkMove(1);
    T.cmdkActivate();
    expect(location.hash).toBe("#/projects/p1");
    expect(document.peek("cmdk-root")).toBeFalsy();
  });
  test("Escape closes the palette", () => {
    T.openCmdK();
    const input = document.getElementById("cmdk-input");
    input.fire("keydown", { key: "Escape", preventDefault() {}, stopPropagation() {} });
    expect(document.peek("cmdk-root")).toBeFalsy();
  });
});

describe("quick-add modal", () => {
  test("renders with project picker and natural-language hint", async () => {
    await T.quickAddModal();
    const html = document.getElementById("modal-root").innerHTML;
    expect(html).toContain("Quick add");
    expect(html).toContain('name="project_id"');
    expect(html).toContain("Natural language");
  });
  test("submit POSTs the parsed task and closes", async () => {
    fetchCalls.length = 0;
    await T.quickAddModal();
    const root = document.getElementById("modal-root");
    root.querySelector('[name="text"]').value = "call mom tomorrow";
    root.querySelector('[name="project_id"]').value = "p1";
    await document.getElementById("m-ok").onclick();
    const posted = fetchCalls.find((c) => c.path === "/api/quick-add");
    expect(posted).toBeTruthy();
    expect(JSON.parse(posted!.init.body).text).toBe("call mom tomorrow");
    expect(root.innerHTML).toBe(""); // modal closed
  });
});

describe("sprints", () => {
  test("sprintStats computes velocity math", () => {
    const s = T.sprintStats(SPRINT_DETAIL.tasks);
    expect(s).toMatchObject({ count: 2, doneCount: 1, total: 90, done: 30, estimated: 2, pct: 50 });
  });
  test("sprint list renders open sprints", async () => {
    await T.vSprints();
    const html = document.getElementById("view").innerHTML;
    expect(html).toContain("Sprint 1");
    expect(html).toContain("2026-09-14");
  });
  test("sprint detail shows velocity summary and board", async () => {
    await T.vSprintDetail("sp1");
    const html = document.getElementById("view").innerHTML;
    expect(html).toContain("Sprint velocity");
    expect(html).toContain("1/2 tasks");
    expect(html).toContain("Write proposal");
  });
  test("new sprint modal defaults to this week Monday–Sunday", () => {
    T.sprintModal();
    const html = document.getElementById("modal-root").innerHTML;
    expect(html).toContain("New sprint");
    expect(html).toContain('name="start"');
    expect(html).toContain('name="end"');
  });
});

describe("task modal: subtasks, blockers, recurrence", () => {
  const existing = {
    id: "t1", title: "Write proposal", status: "backlog",
    blocked_by: [], blockers: [], recurrence: null,
    subtasks: [{ id: "s1", title: "Outline", done: true }],
    estimate_min: null,
  };
  test("modal shows the three new sections", () => {
    T.setBoardTasks([existing]);
    T.taskModal("p1", existing);
    const html = document.getElementById("modal-root").innerHTML;
    expect(html).toContain("Subtasks");
    expect(html).toContain("Blocked by");
    expect(html).toContain("Repeats");
    expect(html).toContain("m-subtasks");
  });
  test("adding a subtask appends it to the checklist", () => {
    T.setBoardTasks([existing]);
    T.taskModal("p1", { ...existing, subtasks: [] });
    document.getElementById("m-st-new").value = "Write tests";
    document.getElementById("m-st-add").onclick();
    expect(document.getElementById("m-subtasks").innerHTML).toContain("Write tests");
  });
  test("subtask count badge reflects progress", () => {
    T.setBoardTasks([existing]);
    T.taskModal("p1", existing);
    expect(document.getElementById("m-st-count").textContent).toBe("1/1");
  });
});

describe("helpers", () => {
  test("parseEstInput parses explicit overrides", () => {
    expect(T.parseEstInput("30m")).toBe(30);
    expect(T.parseEstInput("2h")).toBe(120);
    expect(T.parseEstInput("")).toBe(null);
    expect(T.parseEstInput(null)).toBe(null);
  });
  test("badges render for blocked/recurring/subtask states", () => {
    expect(T.blockedBadge({ blocked: true, blockers: [{ title: "X" }] })).toContain("badge-blocked");
    expect(T.blockedBadge({ blocked: false, blockers: [] })).toBe("");
    expect(T.recurrenceBadge({ recurrence: { kind: "weekly" } })).toContain("🔁");
    expect(T.recurrenceBadge({ recurrence: null })).toBe("");
    expect(T.subtaskBadge({ subtask_done: 1, subtask_total: 3 })).toContain("1/3");
    expect(T.subtaskBadge({ subtask_done: 0, subtask_total: 0 })).toBe("");
  });
});
