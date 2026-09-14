/* Ascent — glossy project management on Anytype */
"use strict";
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const view = $("#view");

async function api(method, path, body) {
  const r = await fetch(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `request failed (${r.status})`);
  return j;
}
const GET = (p) => api("GET", p);
const POST = (p, b) => api("POST", p, b);
const PATCH = (p, b) => api("PATCH", p, b);
const DEL = (p) => api("DELETE", p);

function toast(msg, err = false) {
  const t = document.createElement("div");
  t.className = "toast" + (err ? " err" : "");
  t.textContent = msg;
  $("#toasts").appendChild(t);
  setTimeout(() => { t.style.opacity = "0"; setTimeout(() => t.remove(), 300); }, 3400);
}

function openModal(title, bodyHtml, onSubmit, submitLabel = "Save") {
  const root = $("#modal-root");
  root.innerHTML = `
    <div class="overlay" id="ovl"><div class="modal">
      <h2>${esc(title)}</h2><div>${bodyHtml}</div>
      <div class="actions"><button class="btn ghost" id="m-cancel">Cancel</button>
      <button class="btn primary" id="m-ok">${esc(submitLabel)}</button></div>
    </div></div>`;
  const close = () => (root.innerHTML = "");
  $("#m-cancel").onclick = close;
  $("#ovl").addEventListener("mousedown", (e) => { if (e.target.id === "ovl") close(); });
  $("#m-ok").onclick = async () => {
    const data = {};
    root.querySelectorAll("[name]").forEach((el) => {
      if (el.type === "checkbox") data[el.name] = el.checked;
      else data[el.name] = el.value;
    });
    try { await onSubmit(data, close); } catch (e) { toast(e.message, true); }
  };
  const first = root.querySelector("input[name]:not([type=checkbox]), textarea[name]");
  if (first) setTimeout(() => first.focus(), 60);
  return close;
}

const field = (label, inner) => `<div class="field"><label>${esc(label)}</label>${inner}</div>`;
const input = (name, val = "", type = "text", extra = "") =>
  `<input name="${name}" type="${type}" value="${esc(val)}" ${extra}>`;
const select = (name, options, val = "") =>
  `<select name="${name}">${options.map(([v, l]) => `<option value="${esc(v)}" ${String(v) === String(val) ? "selected" : ""}>${esc(l)}</option>`).join("")}</select>`;

const COLUMNS = [
  ["backlog", "Backlog", "#8b99b0"],
  ["in_progress", "In progress", "#4f7cff"],
  ["review", "Review", "#d9931e"],
  ["done", "Done", "#1f9d63"],
];
const colName = (s) => (COLUMNS.find((c) => c[0] === s) || [])[1] || s;

function fmtDate(ms) {
  if (!ms) return "";
  const d = new Date(ms);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
function duePill(t) {
  if (!t.dueMs || t.status === "done") return "";
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const day = 86400000;
  if (t.dueMs < start.getTime()) return `<span class="pill overdue">◷ overdue · ${esc(fmtDate(t.dueMs))}</span>`;
  if (t.dueMs < start.getTime() + day) return `<span class="pill today">◷ today</span>`;
  if (t.dueMs < start.getTime() + 7 * day) return `<span class="pill soon">◷ ${esc(fmtDate(t.dueMs))}</span>`;
  return `<span class="pill">◷ ${esc(fmtDate(t.dueMs))}</span>`;
}
const isoDate = (ms) => {
  if (!ms) return "";
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

function setTitle(t, sub = "") {
  $("#page-title").textContent = t;
  $("#page-sub").textContent = sub;
  document.title = `${t} — Ascent`;
}
function setActions(html) { $("#topbar-actions").innerHTML = html; }
function setNav(key) {
  $$(".nav-item").forEach((a) => a.classList.toggle("active", a.dataset.nav === key));
}
function showChrome(show, spaceName = "") {
  $("#sidebar").style.display = show ? "" : "none";
  $("#topbar").style.display = show ? "" : "none";
  if (spaceName) $("#space-name").textContent = spaceName;
}

/* ---------- setup wizard ---------- */
let setupState = { step: 1, challenge_id: "", spaces: [] };

async function vSetup() {
  showChrome(false);
  const st = await GET("/api/status").catch(() => ({ paired: false, has_space: false }));
  if (st.paired && st.has_space) { location.hash = "#/overview"; return; }
  setupState.step = st.paired ? 2 : 1;
  if (st.paired) {
    try { setupState.spaces = (await GET("/api/spaces")).spaces; } catch (e) { toast(e.message, true); }
  }
  renderSetup();
}

function renderSetup() {
  const s = setupState;
  let body = "";
  if (s.step === 1) {
    body = `
      <div class="brand-mark" style="width:52px;height:52px;font-size:26px;margin:0 auto;border-radius:16px;">◭</div>
      <h2>Connect Anytype</h2>
      <p>Ascent stores every project and task as native objects in your Anytype space, through the official local API. Your data never leaves your machine.</p>
      <div id="pair-zone" style="margin-top:18px">
        <button class="btn primary" id="req-code" style="width:100%;justify-content:center;">Request pairing code</button>
      </div>`;
  } else {
    body = `
      <div class="brand-mark" style="width:52px;height:52px;font-size:26px;margin:0 auto;border-radius:16px;">◭</div>
      <h2>Choose a space</h2>
      <p>Pick the Anytype space where Ascent will create and manage projects.</p>
      <div style="margin-top:16px;text-align:left">
        ${s.spaces.length ? s.spaces.map((sp) => `
          <button class="space-row" data-space="${esc(sp.id)}"><span class="s-ico">◍</span><span>${esc(sp.name)}</span></button>`).join("")
        : `<div class="empty">No spaces found in your Anytype app.</div>`}
      </div>`;
  }
  view.innerHTML = `
    <div class="setup-wrap"><div class="panel setup-card">
      <div class="steps"><div class="step-dot ${s.step >= 1 ? "on" : ""}"></div><div class="step-dot ${s.step >= 2 ? "on" : ""}"></div></div>
      ${body}
    </div></div>`;

  if (s.step === 1) {
    $("#req-code").onclick = async () => {
      try {
        const { challenge_id } = await POST("/api/pair/challenge", {});
        s.challenge_id = challenge_id;
        $("#pair-zone").innerHTML = `
          <p style="margin-bottom:12px">A <b>4-digit code</b> is now showing in your Anytype app.<br>Enter it below to finish pairing.</p>
          <input class="code-input" id="pair-code" maxlength="4" inputmode="numeric" placeholder="····" style="margin-bottom:12px">
          <button class="btn primary" id="do-pair" style="width:100%;justify-content:center;">Pair with Anytype</button>`;
        $("#pair-code").focus();
        $("#do-pair").onclick = async () => {
          try {
            await POST("/api/pair/complete", { challenge_id: s.challenge_id, code: $("#pair-code").value });
            s.spaces = (await GET("/api/spaces")).spaces;
            s.step = 2;
            renderSetup();
            toast("Paired with Anytype");
          } catch (e) { toast(e.message, true); }
        };
      } catch (e) { toast(e.message, true); }
    };
  } else {
    $$(".space-row").forEach((b) => {
      b.onclick = async () => {
        try {
          const r = await POST("/api/config", { space_id: b.dataset.space });
          toast(`Space “${r.space.name}” connected`);
          location.hash = "#/overview";
        } catch (e) { toast(e.message, true); }
      };
    });
  }
}

/* ---------- overview ---------- */
async function vOverview() {
  const st = await GET("/api/status").catch(() => ({}));
  showChrome(true, st.space_name || "");
  setNav("overview");
  setTitle("Overview", st.space_name ? `Workspace · ${st.space_name}` : "Workspace");
  setActions(`<button class="btn primary" id="ov-new-project">+ New project</button>`);
  view.innerHTML = `<div class="empty"><span class="big">◌</span>Loading workspace…</div>`;
  let d;
  try { d = await GET("/api/overview"); }
  catch (e) { view.innerHTML = `<div class="empty"><span class="big">⚠</span>${esc(e.message)}</div>`; return; }

  const kpis = [
    ["Projects", d.projects, "tracked in Anytype", "var(--accent)"],
    ["Open tasks", d.open_tasks, "across all projects", "#d9931e"],
    ["Completed", d.done_tasks, "shipped", "var(--green)"],
    ["Overdue", d.overdue, "need attention", "var(--red)"],
  ];
  view.innerHTML = `
    <div class="kpi-grid">
      ${kpis.map(([l, v, s, c]) => `<div class="kpi" style="--kpi-accent:${c}">
        <div class="k-label">${l}</div><div class="k-value">${v}</div><div class="k-sub">${s}</div></div>`).join("")}
    </div>
    ${d.attention.length ? `
    <div class="section-title">Needs attention</div>
    <div class="panel" style="padding:8px 10px">
      ${d.attention.map((a) => `
        <div class="import-row" data-goto="${esc(a.project_id)}">
          <span class="pill ${a.overdue ? "overdue" : "today"}">${a.overdue ? "overdue" : "due soon"}</span>
          <span style="flex:1"><b>${esc(a.title)}</b> <span style="color:var(--faint)">· ${esc(a.project_name)} · ${esc(fmtDate(a.dueMs))}</span></span>
          <span style="color:var(--faint)">→</span>
        </div>`).join("")}
    </div>` : ""}
    <div class="section-title">Project health</div>
    ${d.project_list.length ? d.project_list.map((p) => `
      <div class="health-row" data-goto="${p.id}">
        <div class="p-ico">${esc(p.icon)}</div>
        <div class="p-main"><div class="p-name">${esc(p.name)}</div>
          <div class="p-sub">${p.done}/${p.total} tasks done${p.overdue ? ` · <b style="color:var(--red)">${p.overdue} overdue</b>` : ""}</div></div>
        <div class="pbar"><i style="width:${p.progress}%"></i></div>
        <div style="font-weight:750;font-variant-numeric:tabular-nums;width:44px;text-align:right">${p.progress}%</div>
      </div>`).join("")
    : `<div class="panel"><div class="empty"><span class="big">▦</span>No projects yet.<br><br><button class="btn primary" id="empty-new">Create your first project</button></div></div>`}`;

  $$("[data-goto]").forEach((el) => { el.onclick = () => { location.hash = `#/projects/${el.dataset.goto}`; }; });
  $("#ov-new-project").onclick = () => projectModal();
  const en = $("#empty-new");
  if (en) en.onclick = () => projectModal();
}

/* ---------- projects ---------- */
async function vProjects() {
  const st = await GET("/api/status").catch(() => ({}));
  showChrome(true, st.space_name || "");
  setNav("projects");
  setTitle("Projects", `${st.space_name || ""}`);
  setActions(`<button class="btn" id="pj-import">⇪ Import</button> <button class="btn primary" id="pj-new">+ New project</button>`);
  view.innerHTML = `<div class="empty"><span class="big">◌</span>Loading projects…</div>`;
  let d;
  try { d = await GET("/api/projects"); }
  catch (e) { view.innerHTML = `<div class="empty"><span class="big">⚠</span>${esc(e.message)}</div>`; return; }
  view.innerHTML = d.projects.length ? `
    <div class="proj-grid">
      ${d.projects.map((p) => `
        <div class="proj-card" data-goto="${p.id}">
          <div class="p-ico">${esc(p.icon)}</div>
          <h3>${esc(p.name)}</h3>
          <div class="p-desc">${esc(p.notes) || "&nbsp;"}</div>
          <div class="p-foot">
            <div class="pbar" style="flex:1;min-width:0"><i style="width:${p.progress}%"></i></div>
            <div class="p-counts">${p.done}/${p.total}</div>
            ${p.source === "imported" ? `<span class="pill imported">imported</span>` : ""}
          </div>
        </div>`).join("")}
    </div>`
    : `<div class="panel"><div class="empty"><span class="big">▦</span>No projects yet — create one to get started.</div></div>`;
  $$("[data-goto]").forEach((el) => { el.onclick = () => { location.hash = `#/projects/${el.dataset.goto}`; }; });
  $("#pj-new").onclick = () => projectModal();
  $("#pj-import").onclick = () => importModal("page");
}

function projectModal(existing) {
  const p = existing || {};
  openModal(existing ? "Edit project" : "New project", `
    ${field("Name", input("name", p.name || ""))}
    ${field("Icon", input("icon", p.icon || "📁", "text", 'maxlength="4"'))}
    ${field("Description", `<textarea name="description" rows="3">${esc(p.notes || "")}</textarea>`)}
    ${existing ? `<div style="margin-top:14px"><button class="btn danger small" id="m-delete">Delete project</button></div>
      <div style="font-size:12px;color:var(--faint);margin-top:8px">Tasks stay in Anytype — they are only unlinked from this project.</div>` : ""}`,
    async (d, close) => {
      if (!d.name.trim()) { toast("Project name is required", true); return; }
      if (existing) await PATCH(`/api/projects/${existing.id}`, { name: d.name, description: d.description, icon: d.icon });
      else await POST("/api/projects", { name: d.name, description: d.description, icon: d.icon });
      close();
      toast(existing ? "Project updated" : "Project created in Anytype");
      route();
    }, existing ? "Save changes" : "Create project");
  const del = $("#m-delete");
  if (del) del.onclick = async () => {
    if (!confirm(`Delete “${existing.name}”? The page is removed from Anytype; its tasks stay, unlinked.`)) return;
    try {
      await DEL(`/api/projects/${existing.id}`);
      $("#modal-root").innerHTML = "";
      toast("Project deleted");
      location.hash = "#/projects";
    } catch (e) { toast(e.message, true); }
  };
}

function importModal(kind, projectId) {
  const isTask = kind === "task";
  openModal(isTask ? "Import tasks" : "Import project",
    `<div class="search-row"><input id="imp-q" placeholder="Search your ${isTask ? "tasks" : "pages"} in Anytype…"><button class="btn" id="imp-go">Search</button></div>
     <div id="imp-results" style="max-height:300px;overflow:auto"></div>
     <p style="font-size:12px;color:var(--faint)">Already-tracked items are hidden. Imported items keep living in Anytype — Ascent only links to them.</p>`,
    async (_d, close) => {
      const ids = $$("#imp-results input[type=checkbox]:checked").map((c) => c.value);
      if (!ids.length) { toast("Select at least one item", true); return; }
      if (isTask) await POST(`/api/projects/${projectId}/tasks/import`, { object_ids: ids });
      else for (const id of ids) await POST("/api/projects/import", { object_id: id });
      close();
      toast(`Imported ${ids.length} item${ids.length > 1 ? "s" : ""}`);
      route();
    }, "Import selected");
  const run = async () => {
    const q = $("#imp-q").value.trim();
    $("#imp-results").innerHTML = `<div class="empty" style="padding:16px">Searching…</div>`;
    try {
      const { items } = await GET(`/api/search?q=${encodeURIComponent(q)}&kind=${kind}`);
      $("#imp-results").innerHTML = items.length
        ? items.map((it) => `<label class="import-row"><input type="checkbox" value="${esc(it.id)}"><span>${esc(it.title)}</span></label>`).join("")
        : `<div class="empty" style="padding:16px">Nothing found.</div>`;
    } catch (e) { $("#imp-results").innerHTML = `<div class="empty" style="padding:16px">${esc(e.message)}</div>`; }
  };
  $("#imp-go").onclick = run;
  $("#imp-q").addEventListener("keydown", (e) => { if (e.key === "Enter") run(); });
  run();
}

/* ---------- project detail + kanban ---------- */
let boardTasks = [];

async function vProjectDetail(id) {
  const st = await GET("/api/status").catch(() => ({}));
  showChrome(true, st.space_name || "");
  setNav("projects");
  view.innerHTML = `<div class="empty"><span class="big">◌</span>Loading project…</div>`;
  let d;
  try { d = await GET(`/api/projects/${id}`); }
  catch (e) { view.innerHTML = `<div class="empty"><span class="big">⚠</span>${esc(e.message)}<br><br><a class="btn" href="#/projects">Back to projects</a></div>`; return; }
  const p = d.project;
  boardTasks = d.tasks;
  const done = d.tasks.filter((t) => t.status === "done").length;
  setTitle(p.name, `${done}/${d.tasks.length} tasks complete`);
  setActions(`
    <button class="btn" id="pd-import">⇪ Import tasks</button>
    <button class="btn" id="pd-edit">Edit</button>
    <button class="btn primary" id="pd-new-task">+ New task</button>`);

  view.innerHTML = `
    <div class="proj-head">
      <div class="p-ico">${esc(p.icon)}</div>
      <div style="flex:1;min-width:0">
        <h2>${esc(p.name)}</h2>
        ${p.notes ? `<div class="p-desc">${esc(p.notes)}</div>` : ""}
        <div class="proj-stats">
          <span class="stat-chip"><b>${d.tasks.length}</b> tasks</span>
          <span class="stat-chip"><b>${done}</b> done</span>
          <span class="stat-chip"><b>${d.tasks.filter((t) => t.dueMs && t.status !== "done" && t.dueMs < Date.now()).length}</b> overdue</span>
          ${p.source === "imported" ? `<span class="stat-chip">imported from Anytype</span>` : `<span class="stat-chip">native Anytype page</span>`}
        </div>
      </div>
    </div>
    <div class="board" id="board">
      ${COLUMNS.map(([key, label, color]) => `
        <div class="kanban-col" data-col="${key}">
          <div class="col-head"><span class="col-dot" style="background:${color}"></span>${label}<span class="col-count" id="count-${key}"></span></div>
          <div class="col-body" data-col="${key}"></div>
        </div>`).join("")}
    </div>`;
  renderBoard();

  $("#pd-new-task").onclick = () => taskModal(id);
  $("#pd-edit").onclick = () => projectModal(p);
  $("#pd-import").onclick = () => importModal("task", id);
}

function taskCard(t) {
  const el = document.createElement("div");
  el.className = "task-card";
  el.draggable = true;
  el.dataset.tid = t.id;
  el.innerHTML = `
    <div class="task-top">
      <div class="task-check ${t.status === "done" ? "on" : ""}" data-check="${t.id}">${t.status === "done" ? "✓" : ""}</div>
      <div class="task-title ${t.status === "done" ? "done" : ""}">${esc(t.title)}</div>
    </div>
    ${t.notes ? `<div class="task-notes">${esc(t.notes)}</div>` : ""}
    <div class="task-meta">${duePill(t)}${t.source === "imported" ? `<span class="pill imported">imported</span>` : ""}</div>`;
  el.querySelector("[data-check]").onclick = async (e) => {
    e.stopPropagation();
    try {
      const { task } = await PATCH(`/api/tasks/${t.id}`, { done: t.status !== "done" });
      boardTasks = boardTasks.map((x) => (x.id === t.id ? task : x));
      renderBoard();
    } catch (err) { toast(err.message, true); }
  };
  el.onclick = (e) => { if (!e.target.closest("[data-check]")) taskModal(currentPid(), t); };
  el.addEventListener("dragstart", (e) => {
    e.dataTransfer.setData("text/plain", t.id);
    e.dataTransfer.effectAllowed = "move";
    setTimeout(() => el.classList.add("dragging"), 0);
  });
  el.addEventListener("dragend", () => el.classList.remove("dragging"));
  return el;
}

let _pid = "";
function currentPid() { return _pid; }

function renderBoard() {
  for (const [key] of COLUMNS) {
    const body = $(`.col-body[data-col="${key}"]`);
    const items = boardTasks.filter((t) => t.status === key);
    body.innerHTML = "";
    items.forEach((t) => body.appendChild(taskCard(t)));
    $(`#count-${key}`).textContent = items.length;
  }
  $$(".kanban-col").forEach((col) => {
    col.ondragover = (e) => { e.preventDefault(); col.classList.add("dragover"); };
    col.ondragleave = () => col.classList.remove("dragover");
    col.ondrop = async (e) => {
      e.preventDefault();
      col.classList.remove("dragover");
      const tid = e.dataTransfer.getData("text/plain");
      const target = col.dataset.col;
      const t = boardTasks.find((x) => x.id === tid);
      if (!t || t.status === target) return;
      const prev = t.status;
      t.status = target; // optimistic
      renderBoard();
      try {
        const { task } = await PATCH(`/api/tasks/${tid}`, { status: target });
        boardTasks = boardTasks.map((x) => (x.id === tid ? task : x));
      } catch (err) {
        t.status = prev;
        toast(err.message, true);
      }
      renderBoard();
    };
  });
}

function taskModal(pid, existing) {
  _pid = pid;
  const t = existing || {};
  openModal(existing ? "Edit task" : "New task", `
    ${field("Title", input("title", t.title || ""))}
    <div class="formgrid">
      ${field("Status", select("status", COLUMNS.map(([v, l]) => [v, l]), t.status || "backlog"))}
      ${field("Due date", input("due_date", isoDate(t.dueMs), "date"))}
    </div>
    ${field("Notes", `<textarea name="notes" rows="3">${esc(t.notes || "")}</textarea>`)}
    ${existing ? `<div style="margin-top:14px"><button class="btn danger small" id="m-delete">Delete task</button></div>
      ${t.source === "ascent" ? `<div style="font-size:12px;color:var(--faint);margin-top:8px">Also removes the task object from Anytype.</div>`
        : `<div style="font-size:12px;color:var(--faint);margin-top:8px">Only unlinks — the task stays in Anytype.</div>`}` : ""}
    <div style="font-size:12px;color:var(--faint);margin-top:10px">Saved as a native Anytype task object.</div>`,
    async (d, close) => {
      if (!d.title.trim()) { toast("Task title is required", true); return; }
      const payload = { title: d.title, notes: d.notes, due_date: d.due_date, status: d.status };
      if (existing) {
        const { task } = await PATCH(`/api/tasks/${existing.id}`, payload);
        boardTasks = boardTasks.map((x) => (x.id === existing.id ? task : x));
      } else {
        const { task } = await POST(`/api/projects/${pid}/tasks`, payload);
        boardTasks.push(task);
      }
      close();
      toast(existing ? "Task updated in Anytype" : "Task created in Anytype");
      renderBoard();
      const p = await GET(`/api/projects/${pid}`).catch(() => null);
      if (p) setTitle(p.project.name, `${p.tasks.filter((x) => x.status === "done").length}/${p.tasks.length} tasks complete`);
    }, existing ? "Save changes" : "Create task");
  const del = $("#m-delete");
  if (del) del.onclick = async () => {
    if (!confirm(`Delete “${existing.title}”?`)) return;
    try {
      await DEL(`/api/tasks/${existing.id}`);
      boardTasks = boardTasks.filter((x) => x.id !== existing.id);
      $("#modal-root").innerHTML = "";
      toast("Task deleted");
      renderBoard();
    } catch (e) { toast(e.message, true); }
  };
}

/* ---------- router ---------- */
async function route() {
  const h = location.hash || "#/overview";
  const st = await GET("/api/status").catch(() => ({ paired: false, has_space: false }));
  if ((!st.paired || !st.has_space) && h !== "#/setup") { location.hash = "#/setup"; return; }
  const pm = h.match(/^#\/projects\/([^/]+)$/);
  try {
    if (h === "#/setup") await vSetup();
    else if (h === "#/overview") await vOverview();
    else if (h === "#/projects") await vProjects();
    else if (pm) { _pid = pm[1]; await vProjectDetail(pm[1]); }
    else location.hash = "#/overview";
  } catch (e) {
    view.innerHTML = `<div class="empty"><span class="big">⚠</span>${esc(e.message)}</div>`;
  }
}
window.addEventListener("hashchange", route);
route();

// test seam
globalThis.__test = { taskCard, duePill, fmtDate, COLUMNS };
