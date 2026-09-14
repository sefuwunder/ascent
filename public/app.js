/* Ascent — project management on Anytype, styled with the shadcn/ui design system
   (ported to dependency-free CSS: no React, no Tailwind, no build step) */
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
    <div class="dialog-overlay" id="ovl"><div class="dialog-content" role="dialog" aria-modal="true">
      <h2 class="dialog-title">${esc(title)}</h2><div>${bodyHtml}</div>
      <div class="dialog-footer"><button class="btn btn-ghost" id="m-cancel">Cancel</button>
      <button class="btn btn-default" id="m-ok">${esc(submitLabel)}</button></div>
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
  ["backlog", "Backlog", "var(--muted-foreground)"],
  ["in_progress", "In progress", "var(--sol-blue)"],
  ["review", "Review", "var(--sol-orange)"],
  ["done", "Done", "var(--sol-cyan)"],
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
  if (t.dueMs < start.getTime()) return `<span class="badge badge-destructive">◷ overdue · ${esc(fmtDate(t.dueMs))}</span>`;
  if (t.dueMs < start.getTime() + day) return `<span class="badge badge-warning">◷ today</span>`;
  if (t.dueMs < start.getTime() + 7 * day) return `<span class="badge badge-secondary">◷ ${esc(fmtDate(t.dueMs))}</span>`;
  return `<span class="badge badge-secondary">◷ ${esc(fmtDate(t.dueMs))}</span>`;
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

/* ---------- Solarized day/night theme ---------- */
const THEME_KEY = "ascent-theme";
function paintThemeToggle() {
  const btn = $("#theme-toggle");
  if (!btn) return;
  const dark = document.documentElement.dataset.theme === "solarized-dark";
  btn.textContent = dark ? "☀" : "☾";
  btn.setAttribute("aria-label", dark ? "Switch to light theme" : "Switch to dark theme");
  btn.title = dark ? "Light theme" : "Dark theme";
}
function initTheme() {
  const el = document.documentElement;
  if (el.dataset.theme !== "solarized-dark" && el.dataset.theme !== "solarized-light") {
    let t = null;
    try { t = localStorage.getItem(THEME_KEY); } catch (e) {}
    if (t !== "solarized-dark" && t !== "solarized-light") {
      t = (typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches)
        ? "solarized-dark" : "solarized-light";
    }
    el.dataset.theme = t;
  }
  paintThemeToggle();
}
function toggleTheme() {
  const dark = document.documentElement.dataset.theme !== "solarized-dark";
  document.documentElement.dataset.theme = dark ? "solarized-dark" : "solarized-light";
  try { localStorage.setItem(THEME_KEY, dark ? "solarized-dark" : "solarized-light"); } catch (e) {}
  paintThemeToggle();
}
function setNav(key) {
  $$(".nav-item").forEach((a) => a.classList.toggle("active", a.dataset.nav === key));
}
function showChrome(show, spaceName = "") {
  $("#sidebar").style.display = show ? "" : "none";
  $("#topbar").style.display = show ? "" : "none";
  if (spaceName) $("#space-name").textContent = spaceName;
}

/* ---------- mobile drawer (off-canvas sidebar at <=900px) ---------- */
let drawerOpen = false;
function openDrawer() {
  drawerOpen = true;
  if (document.body && document.body.classList) document.body.classList.add("drawer-open");
  const sb = $("#sidebar");
  if (sb) { if (sb.classList) sb.classList.add("open"); if (sb.focus) sb.focus(); }
  const sc = $("#scrim");
  if (sc && sc.setAttribute) sc.setAttribute("aria-hidden", "false");
}
function closeDrawer() {
  if (!drawerOpen) return;
  drawerOpen = false;
  if (document.body && document.body.classList) document.body.classList.remove("drawer-open");
  const sb = $("#sidebar");
  if (sb && sb.classList) sb.classList.remove("open");
  const sc = $("#scrim");
  if (sc && sc.setAttribute) sc.setAttribute("aria-hidden", "true");
}
function toggleDrawer() { if (drawerOpen) closeDrawer(); else openDrawer(); }
function isDrawerOpen() { return drawerOpen; }

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
        <button class="btn btn-default" id="req-code" style="width:100%;justify-content:center;">Request pairing code</button>
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
    <div class="setup-wrap"><div class="card setup-card">
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
          <button class="btn btn-default" id="do-pair" style="width:100%;justify-content:center;">Pair with Anytype</button>`;
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
  setActions(`<button class="btn btn-default" id="ov-new-project">+ New project</button>`);
  view.innerHTML = `<div style="display:grid;gap:12px"><div class="skeleton" style="height:118px"></div><div class="skeleton" style="height:64px"></div><div class="skeleton" style="height:168px"></div></div>`;
  let d;
  try { d = await GET("/api/overview"); }
  catch (e) { view.innerHTML = `<div class="empty"><span class="big">⚠</span>${esc(e.message)}</div>`; return; }

  const kpis = [
    ["Projects", d.projects, "tracked in Anytype"],
    ["Open tasks", d.open_tasks, "across all projects"],
    ["Completed", d.done_tasks, "shipped"],
    ["Overdue", d.overdue, "need attention"],
  ];
  view.innerHTML = `
    <div class="kpi-grid">
      ${kpis.map(([l, v, s]) => `<div class="card kpi">
        <div class="k-label">${l}</div><div class="k-value">${v}</div><div class="k-sub">${s}</div></div>`).join("")}
    </div>
    ${d.attention.length ? `
    <div class="section-title">Needs attention</div>
    <div class="card" style="padding:8px 10px">
      ${d.attention.map((a) => `
        <div class="import-row" data-goto="${esc(a.project_id)}">
          <span class="badge ${a.overdue ? "badge-destructive" : "badge-warning"}">${a.overdue ? "overdue" : "due soon"}</span>
          <span style="flex:1"><b>${esc(a.title)}</b> <span style="color:var(--muted-foreground)">· ${esc(a.project_name)} · ${esc(fmtDate(a.dueMs))}</span></span>
          <span style="color:var(--muted-foreground)">→</span>
        </div>`).join("")}
    </div>` : ""}
    <div class="section-title">Project health</div>
    ${d.project_list.length ? d.project_list.map((p) => `
      <div class="card health-row" data-goto="${p.id}">
        <div class="p-ico">${esc(p.icon)}</div>
        <div class="p-main"><div class="p-name">${esc(p.name)}</div>
          <div class="p-sub">${p.done}/${p.total} tasks done${p.overdue ? ` · <b style="color:var(--destructive)">${p.overdue} overdue</b>` : ""}</div></div>
        <div class="progress"><div class="progress-indicator" style="width:${p.progress}%"></div></div>
        <div style="font-weight:600;font-variant-numeric:tabular-nums;width:44px;text-align:right">${p.progress}%</div>
      </div>`).join("")
    : `<div class="card"><div class="empty"><span class="big">▦</span>No projects yet.<br><br><button class="btn btn-default" id="empty-new">Create your first project</button></div></div>`}`;

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
  setActions(`<button class="btn btn-outline" id="pj-import">⇪ Import</button> <button class="btn btn-default" id="pj-new">+ New project</button>`);
  view.innerHTML = `<div style="display:grid;gap:16px;grid-template-columns:repeat(auto-fill,minmax(280px,1fr))"><div class="skeleton" style="height:168px"></div><div class="skeleton" style="height:168px"></div><div class="skeleton" style="height:168px"></div></div>`;
  let d;
  try { d = await GET("/api/projects"); }
  catch (e) { view.innerHTML = `<div class="empty"><span class="big">⚠</span>${esc(e.message)}</div>`; return; }
  view.innerHTML = d.projects.length ? `
    <div class="proj-grid">
      ${d.projects.map((p) => `
        <div class="card proj-card" data-goto="${p.id}">
          <div class="p-ico">${esc(p.icon)}</div>
          <h3>${esc(p.name)}</h3>
          <div class="p-desc">${esc(p.notes) || "&nbsp;"}</div>
          <div class="p-foot">
            <div class="progress" style="flex:1;min-width:0"><div class="progress-indicator" style="width:${p.progress}%"></div></div>
            <div class="p-counts">${p.done}/${p.total}</div>
            ${p.source === "imported" ? `<span class="badge badge-outline">imported</span>` : ""}
          </div>
        </div>`).join("")}
    </div>`
    : `<div class="card"><div class="empty"><span class="big">▦</span>No projects yet — create one to get started.</div></div>`;
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
    ${existing ? `<div style="margin-top:14px"><button class="btn btn-destructive btn-sm" id="m-delete">Delete project</button></div>
      <div style="font-size:12px;color:var(--muted-foreground);margin-top:8px">Tasks stay in Anytype — they are only unlinked from this project.</div>` : ""}`,
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
  const isWiki = kind === "wiki";
  openModal(isTask ? "Import tasks" : isWiki ? "Import wiki pages" : "Import project",
    `<div class="search-row"><input id="imp-q" placeholder="Search your ${isTask ? "tasks" : "pages"} in Anytype…"><button class="btn btn-outline" id="imp-go">Search</button></div>
     <div id="imp-results" style="max-height:300px;overflow:auto"></div>
     <p style="font-size:12px;color:var(--muted-foreground)">Already-tracked items are hidden. Imported items keep living in Anytype — Ascent only links to them.</p>`,
    async (_d, close) => {
      const ids = $$("#imp-results input[type=checkbox]:checked").map((c) => c.value);
      if (!ids.length) { toast("Select at least one item", true); return; }
      if (isTask) await POST(`/api/projects/${projectId}/tasks/import`, { object_ids: ids });
      else if (isWiki) await POST(`/api/projects/${projectId}/wiki/import`, { object_ids: ids });
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

/* ---------- project detail: kanban board + wiki ---------- */
let boardTasks = [];
let wikiArticles = [];
let wikiSel = null;
let wikiFull = {};
let wikiEditing = false;

/* tiny dependency-free markdown renderer (headings, lists, code, links, quotes) */
function md(src) {
  let t = esc(src || "");
  const blocks = [];
  t = t.replace(/```([\s\S]*?)```/g, (_m, c) => {
    blocks.push(`<pre><code>${c.replace(/^\n+|\n+$/g, "")}</code></pre>`);
    return `\u0000${blocks.length - 1}\u0000`;
  });
  const inline = (s) =>
    s.replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[^*\n])\*([^*\n]+)\*/g, "$1<em>$2</em>")
      .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  const lines = t.split("\n");
  const out = [];
  let list = null;
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^\u0000\d+\u0000$/.test(trimmed)) { closeList(); out.push(trimmed); continue; }
    const h = trimmed.match(/^(#{1,3})\s+(.+)$/);
    if (h) { closeList(); out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); continue; }
    if (/^---+$/.test(trimmed)) { closeList(); out.push("<hr>"); continue; }
    if (trimmed.startsWith("&gt;")) { closeList(); out.push(`<blockquote>${inline(trimmed.slice(4).trim())}</blockquote>`); continue; }
    const ul = trimmed.match(/^[-*]\s+(.+)$/);
    const ol = trimmed.match(/^\d+\.\s+(.+)$/);
    if (ul || ol) {
      const tag = ul ? "ul" : "ol";
      if (list !== tag) { closeList(); out.push(`<${tag}>`); list = tag; }
      out.push(`<li>${inline((ul || ol)[1])}</li>`);
      continue;
    }
    closeList();
    if (trimmed) out.push(`<p>${inline(trimmed)}</p>`);
  }
  closeList();
  return out.join("\n").replace(/\u0000(\d+)\u0000/g, (_m, i) => blocks[Number(i)] ?? "");
}

async function vProjectDetail(id, tab = "board") {
  const st = await GET("/api/status").catch(() => ({}));
  showChrome(true, st.space_name || "");
  setNav("projects");
  view.innerHTML = `<div class="empty"><span class="big">◌</span>Loading project…</div>`;
  let d;
  try { d = await GET(`/api/projects/${id}`); }
  catch (e) { view.innerHTML = `<div class="empty"><span class="big">⚠</span>${esc(e.message)}<br><br><a class="btn btn-outline" href="#/projects">Back to projects</a></div>`; return; }
  const p = d.project;
  boardTasks = d.tasks;
  try { wikiArticles = (await GET(`/api/projects/${id}/wiki`)).articles; }
  catch (e) { wikiArticles = []; }
  if (!wikiArticles.some((a) => a.id === wikiSel)) { wikiSel = wikiArticles.length ? wikiArticles[0].id : null; wikiEditing = false; }
  const done = d.tasks.filter((t) => t.status === "done").length;
  setTitle(p.name, `${done}/${d.tasks.length} tasks · ${wikiArticles.length} wiki article${wikiArticles.length === 1 ? "" : "s"}`);
  setActions(tab === "wiki"
    ? `<button class="btn btn-outline btn-sm" id="pd-import-wiki">⇪ Import pages</button> <button class="btn btn-default btn-sm" id="pd-new-article">+ New article</button>`
    : `
    <button class="btn btn-outline btn-sm" id="pd-import">⇪ Import tasks</button>
    <button class="btn btn-ghost btn-icon" id="pd-edit" title="Edit project">✎</button>
    <button class="btn btn-default btn-sm" id="pd-new-task">+ New task</button>`);

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
    <div class="tabs-list" style="margin-bottom:16px">
      <a class="tabs-trigger ${tab === "board" ? "on" : ""}" href="#/projects/${id}">▦ Board</a>
      <a class="tabs-trigger ${tab === "wiki" ? "on" : ""}" href="#/projects/${id}/wiki">📚 Wiki <span class="col-count">${wikiArticles.length}</span></a>
    </div>
    <div id="tab-body"></div>`;

  if (tab === "wiki") {
    $("#tab-body").innerHTML = `
      <div class="wiki">
        <aside class="card wiki-list"><div id="wk-items"></div></aside>
        <div class="card wiki-pane" id="wk-pane"></div>
      </div>`;
    renderWikiList();
    renderWikiPane();
    $("#pd-new-article").onclick = () => articleModal(id);
    $("#pd-import-wiki").onclick = () => importModal("wiki", id);
    return;
  }

  $("#tab-body").innerHTML = `
    <div class="board" id="board">
      ${COLUMNS.map(([key, label, color]) => `
        <div class="kanban-col" data-col="${key}">
          <div class="col-head"><span class="col-dot" style="background:${color}"></span>${label}<span class="col-count" id="count-${key}"></span><span class="col-est" id="est-${key}"></span></div>
          <div class="col-body" data-col="${key}"></div>
        </div>`).join("")}
    </div>`;
  renderBoard();

  $("#pd-new-task").onclick = () => taskModal(id);
  $("#pd-edit").onclick = () => projectModal(p);
  $("#pd-import").onclick = () => importModal("task", id);
}

/* ---------- wiki ---------- */
function renderWikiList() {
  const box = $("#wk-items");
  if (!box) return;
  box.innerHTML = wikiArticles.length ? wikiArticles.map((a) => `
    <div class="wiki-item ${a.id === wikiSel ? "on" : ""}" data-wk="${esc(a.id)}">
      <div class="wk-title">${esc(a.title)}</div>
      ${a.snippet ? `<div class="wk-snip">${esc(a.snippet)}</div>` : ""}
      ${a.source === "imported" ? `<span class="badge badge-outline">imported</span>` : ""}
    </div>`).join("")
    : `<div class="empty" style="padding:24px 12px">No articles yet.<br>Write the first page of this project's wiki.</div>`;
  $$("#wk-items [data-wk]").forEach((el) => { el.onclick = () => selectArticle(el.dataset.wk); });
}

async function selectArticle(aid) {
  wikiSel = aid;
  wikiEditing = false;
  renderWikiList();
  const pane = $("#wk-pane");
  if (!wikiFull[aid]) {
    if (pane) pane.innerHTML = `<div class="empty"><span class="big">◌</span>Loading article…</div>`;
    try { wikiFull[aid] = (await GET(`/api/wiki/${aid}`)).article; }
    catch (e) {
      wikiArticles = wikiArticles.filter((a) => a.id !== aid);
      wikiSel = wikiArticles.length ? wikiArticles[0].id : null;
      renderWikiList(); renderWikiPane();
      toast(e.message, true);
      return;
    }
  }
  renderWikiPane();
}

function renderWikiPane() {
  const pane = $("#wk-pane");
  if (!pane) return;
  const a = wikiFull[wikiSel];
  if (!a) {
    pane.innerHTML = `<div class="empty"><span class="big">📚</span>${wikiArticles.length ? "Select an article to read." : "No articles yet — create one with <b>+ New article</b>."}</div>`;
    return;
  }
  if (wikiEditing) {
    pane.innerHTML = `
      ${field("Title", input("wk-title", a.title))}
      ${field("Body (markdown)", `<textarea id="wk-body" rows="18">${esc(a.body)}</textarea>`)}
      <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:14px">
        <button class="btn btn-ghost" id="wk-cancel">Cancel</button>
        <button class="btn btn-default" id="wk-save">Save to Anytype</button>
      </div>`;
    $("#wk-cancel").onclick = () => { wikiEditing = false; renderWikiPane(); };
    $("#wk-save").onclick = async () => {
      const title = $("[name=wk-title]").value;
      const body = $("#wk-body").value;
      if (!title.trim()) { toast("Article title is required", true); return; }
      try {
        const { article } = await PATCH(`/api/wiki/${a.id}`, { title, body });
        wikiFull[a.id] = article;
        const li = wikiArticles.find((x) => x.id === a.id);
        if (li) { li.title = article.title; li.updatedMs = article.updatedMs; li.snippet = (article.body || "").slice(0, 140); }
        wikiEditing = false;
        toast("Article saved to Anytype");
        renderWikiList(); renderWikiPane();
      } catch (e) { toast(e.message, true); }
    };
    return;
  }
  pane.innerHTML = `
    <div class="wiki-read-head">
      <h2>${esc(a.title)}</h2>
      <button class="btn btn-outline btn-sm" id="wk-edit">Edit</button>
      <button class="btn btn-destructive btn-sm" id="wk-del">Delete</button>
    </div>
    ${a.source === "imported" ? `<div class="wk-imported-note">Imported from Anytype — deleting only unlinks it here; the page itself stays in Anytype.</div>` : ""}
    <div class="markdown">${a.body && a.body.trim() ? md(a.body) : `<div class="empty" style="padding:20px">This article is empty — hit <b>Edit</b> to write it.</div>`}</div>`;
  $("#wk-edit").onclick = () => { wikiEditing = true; renderWikiPane(); };
  $("#wk-del").onclick = () => deleteArticle();
}

function articleModal(pid) {
  openModal("New article", `
    ${field("Title", input("title", ""))}
    ${field("Body (markdown)", `<textarea name="body" rows="10" placeholder="# Heading&#10;&#10;Write the article in markdown…"></textarea>`)}
    <div style="font-size:12px;color:var(--muted-foreground);margin-top:10px">Saved as a native Anytype page, linked to this project.</div>`,
    async (d, close) => {
      if (!d.title.trim()) { toast("Article title is required", true); return; }
      const { article } = await POST(`/api/projects/${pid}/wiki`, { title: d.title, body: d.body });
      wikiFull[article.id] = article;
      wikiArticles.unshift({ id: article.id, title: article.title, updatedMs: article.updatedMs, source: "ascent", snippet: (article.body || "").slice(0, 140) });
      wikiSel = article.id;
      wikiEditing = false;
      close();
      toast("Article created in Anytype");
      renderWikiList(); renderWikiPane();
    }, "Create article");
}

async function deleteArticle() {
  const a = wikiFull[wikiSel];
  if (!a) return;
  const imported = a.source === "imported";
  if (!confirm(`Delete “${a.title}”?${imported ? " The page stays in Anytype — only the link is removed." : " The page is removed from Anytype."}`)) return;
  try {
    await DEL(`/api/wiki/${wikiSel}`);
    delete wikiFull[wikiSel];
    wikiArticles = wikiArticles.filter((x) => x.id !== wikiSel);
    wikiSel = wikiArticles.length ? wikiArticles[0].id : null;
    wikiEditing = false;
    toast(imported ? "Article unlinked" : "Article deleted from Anytype");
    renderWikiList(); renderWikiPane();
  } catch (e) { toast(e.message, true); }
}

function taskCard(t) {
  const el = document.createElement("div");
  el.className = "card task-card";
  el.draggable = true;
  el.dataset.tid = t.id;
  el.innerHTML = `
    <div class="task-top">
      <div class="checkbox task-check ${t.status === "done" ? "on" : ""}" data-check="${t.id}">${t.status === "done" ? "✓" : ""}</div>
      <div class="task-title ${t.status === "done" ? "done" : ""}">${esc(t.title)}</div>
    </div>
    ${t.notes ? `<div class="task-notes">${esc(t.notes)}</div>` : ""}
    <div class="task-meta">${Estimate.estChip(t.title)}${duePill(t)}${t.source === "imported" ? `<span class="badge badge-outline">imported</span>` : ""}</div>`;
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
    const estEl = $(`#est-${key}`);
    if (estEl) estEl.textContent = Estimate.colTotal(items);
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
    <div id="m-est-wrap" style="margin:-6px 0 10px;min-height:1.6em">${Estimate.estChip(t.title || "")}</div>
    <div class="formgrid">
      ${field("Status", select("status", COLUMNS.map(([v, l]) => [v, l]), t.status || "backlog"))}
      ${field("Due date", input("due_date", isoDate(t.dueMs), "date"))}
    </div>
    ${field("Notes", `<textarea name="notes" rows="3">${esc(t.notes || "")}</textarea>`)}
    ${existing ? `<div style="margin-top:14px"><button class="btn btn-destructive btn-sm" id="m-delete">Delete task</button></div>
      ${t.source === "ascent" ? `<div style="font-size:12px;color:var(--muted-foreground);margin-top:8px">Also removes the task object from Anytype.</div>`
        : `<div style="font-size:12px;color:var(--muted-foreground);margin-top:8px">Only unlinks — the task stays in Anytype.</div>`}` : ""}
    <div style="font-size:12px;color:var(--muted-foreground);margin-top:10px">Saved as a native Anytype task object.</div>`,
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
  const root = $("#modal-root");
  const ti0 = root.querySelector('[name="title"]');
  if (ti0 && ti0.addEventListener) ti0.addEventListener("input", () => {
    const w = $("#m-est-wrap");
    if (w) w.innerHTML = Estimate.estChip(ti0.value);
  });
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
  closeDrawer();
  const h = location.hash || "#/overview";
  const st = await GET("/api/status").catch(() => ({ paired: false, has_space: false }));
  if ((!st.paired || !st.has_space) && h !== "#/setup") { location.hash = "#/setup"; return; }
  const pm = h.match(/^#\/projects\/([^/]+)$/);
  const pw = h.match(/^#\/projects\/([^/]+)\/wiki$/);
  try {
    if (h === "#/setup") await vSetup();
    else if (h === "#/overview") await vOverview();
    else if (h === "#/projects") await vProjects();
    else if (pw) { _pid = pw[1]; await vProjectDetail(pw[1], "wiki"); }
    else if (pm) { _pid = pm[1]; await vProjectDetail(pm[1]); }
    else location.hash = "#/overview";
  } catch (e) {
    view.innerHTML = `<div class="empty"><span class="big">⚠</span>${esc(e.message)}</div>`;
  }
}
window.addEventListener("hashchange", route);
const themeBtn = $("#theme-toggle");
if (themeBtn) themeBtn.onclick = toggleTheme;
const navBtn = $("#nav-toggle");
if (navBtn) navBtn.onclick = toggleDrawer;
const scrimEl = $("#scrim");
if (scrimEl) scrimEl.onclick = closeDrawer;
const drawerCloseBtn = $("#drawer-close");
if (drawerCloseBtn) drawerCloseBtn.onclick = closeDrawer;
if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("keydown", (e) => { if (e && e.key === "Escape") closeDrawer(); });
}
initTheme();
route();

// test seam
globalThis.__test = { taskCard, duePill, fmtDate, COLUMNS, md, vOverview, vProjects, vProjectDetail, vSetup, renderSetup, renderWikiList, renderWikiPane, selectArticle, openModal, projectModal, taskModal, importModal, initTheme, toggleTheme, paintThemeToggle, route, openDrawer, closeDrawer, toggleDrawer, isDrawerOpen, renderBoard, Estimate };
