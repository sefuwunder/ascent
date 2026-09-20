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
  if (!r.ok) {
    const e = new Error(j.error || `request failed (${r.status})`);
    e.status = r.status;
    e.data = j;
    throw e;
  }
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
  if (t.dueMs < start.getTime()) return `<span class="badge badge-urgent">◷ overdue · ${esc(fmtDate(t.dueMs))}</span>`;
  if (t.dueMs < start.getTime() + day) return `<span class="badge badge-warning">◷ today</span>`;
  if (t.dueMs < start.getTime() + 7 * day) return `<span class="badge badge-secondary">◷ ${esc(fmtDate(t.dueMs))}</span>`;
  return `<span class="badge badge-secondary">◷ ${esc(fmtDate(t.dueMs))}</span>`;
}
const isoDate = (ms) => {
  if (!ms) return "";
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/* Estimate chip honoring an explicit quick-add estimate override; falls back
   to the word-bag estimator. */
function estChipFor(t) {
  if (t && typeof t.estimate_min === "number" && t.estimate_min > 0) {
    const size = estSizeForMins(t.estimate_min);
    return `<span class="est-chip est-${size}" title="Explicit estimate: ${Estimate.fmtMins(t.estimate_min)}">⏱ ≈${Estimate.fmtMins(t.estimate_min)}</span>`;
  }
  return Estimate.estChip(t && t.title);
}

/* Billable minutes for a task: explicit override, else the word-bag point
   estimate, else 0. Feeds sprint velocity and My Day readouts. */
function taskMinutes(t) {
  if (t && typeof t.estimate_min === "number" && t.estimate_min > 0) return t.estimate_min;
  const e = Estimate.estimateTask(t && t.title);
  return e ? e.point : 0;
}

/* Parse an estimate override like "30m", "45 min", "2h", "1.5 hours". */
function parseEstInput(s) {
  const m = String(s || "").trim().match(/^(\d+(?:\.\d+)?)\s*(h|hr|hrs|hours?|m|min|mins|minutes?)$/i);
  if (!m) return null;
  return Math.round(parseFloat(m[1]) * (m[2].toLowerCase().startsWith("h") ? 60 : 1));
}

/* Mark a task done/undone through the blocked-completion guard: a blocked
   task needs explicit confirmation (the server enforces it with 409; the
   client asks once and retries with confirm:true). Returns the updated task,
   or null when the user cancelled the confirmation. */
async function patchDone(t, wantDone, confirm) {
  const r = await PATCH(`/api/tasks/${t.id}`, { done: wantDone, ...(confirm ? { confirm: true } : {}) });
  const task = r.task;
  if (wantDone && task.next_instance) {
    toast(`🔁 Next “${task.next_instance.title}” created — due ${fmtDate(task.next_instance.dueMs)}`);
  }
  return task;
}
async function setTaskDone(t, wantDone) {
  try {
    return await patchDone(t, wantDone, false);
  } catch (e) {
    if (wantDone && e && e.status === 409 && e.data && e.data.needs_confirm) {
      const names = (e.data.blockers || []).map((b) => `“${b && b.title ? b.title : b}”`).join(", ");
      if (confirm(`“${t.title}” is blocked by ${names}.\n\nMark it done anyway?`)) {
        return await patchDone(t, wantDone, true);
      }
      return null;
    }
    throw e;
  }
}

function shakeCard(tid) {
  const sel = (typeof CSS !== "undefined" && CSS.escape) ? CSS.escape(tid) : tid;
  const el = document.querySelector(`[data-tid="${sel}"]`);
  if (!el || !el.classList) return;
  el.classList.remove("shake");
  void el.offsetWidth; // restart the animation
  el.classList.add("shake");
  setTimeout(() => el.classList.remove("shake"), 500);
}

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
  if (st.paired && st.has_space) { location.hash = "#/myday"; return; }
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
          location.hash = "#/myday";
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
  const otaskMap = await fetchProjectTasks(d.project_list);

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
    ${timeHealthWidget(otaskMap, d.project_list)}
    ${d.attention.length ? `
    <div class="section-title">Needs attention</div>
    <div class="card" style="padding:8px 10px">
      ${d.attention.map((a) => `
        <div class="import-row" data-goto="${esc(a.project_id)}">
          <span class="badge ${a.overdue ? "badge-urgent" : "badge-warning"}">${a.overdue ? "overdue" : "due soon"}</span>
          <span style="flex:1"><b>${esc(a.title)}</b> <span style="color:var(--muted-foreground)">· ${esc(a.project_name)} · ${esc(fmtDate(a.dueMs))}</span></span>
          <span style="color:var(--muted-foreground)">→</span>
        </div>`).join("")}
    </div>` : ""}
    <div class="section-title">Project health</div>
    ${d.project_list.length ? d.project_list.map((p) => {
      const est = projectRemainingEst(otaskMap[p.id]);
      return `
      <div class="card health-row" data-goto="${p.id}">
        <div class="p-ico">${esc(p.icon)}</div>
        <div class="p-main"><div class="p-name">${esc(p.name)}</div>
          <div class="p-sub">${p.done}/${p.total} tasks done${est ? ` · <span class="est-chip">⏱ ${est} remaining</span>` : ""}${p.overdue ? ` · <b style="color:var(--urgent)">${p.overdue} overdue</b>` : ""}</div></div>
        <div class="progress"><div class="progress-indicator" style="width:${p.progress}%"></div></div>
        <div style="font-weight:600;font-variant-numeric:tabular-nums;width:44px;text-align:right">${p.progress}%</div>
      </div>`;
    }).join("")
    : `<div class="card"><div class="empty"><span class="big">▦</span>No projects yet.<br><br><button class="btn btn-default" id="empty-new">Create your first project</button></div></div>`}`;

  $$("[data-goto]").forEach((el) => { el.onclick = () => { location.hash = `#/projects/${el.dataset.goto}`; }; });
  $("#ov-new-project").onclick = () => projectModal();
  const en = $("#empty-new");
  if (en) en.onclick = () => projectModal();
}

/* ---------- per-project remaining-time estimates (word-bag estimator) ---------- */
// Raw per-project estimate: sum of point estimates for open (non-done) tasks,
// plus coverage counts (estimated vs open-but-unestimable tasks).
function projectEstRaw(tasks) {
  let sum = 0, estimated = 0, total = 0;
  for (const t of tasks || []) {
    if (!t || t.status === "done") continue;
    total++;
    const e = Estimate.estimateTask(t.title);
    if (e) { sum += e.point; estimated++; }
  }
  return { sum, estimated, total };
}

// Sum of point estimates for a project's open (non-done) tasks; "" when none estimable.
function projectRemainingEst(tasks) {
  const r = projectEstRaw(tasks);
  return r.estimated ? `≈${Estimate.fmtMins(r.sum)}` : "";
}

// T-shirt size bucket for a raw minute figure (mirrors estimate.js classifyTask).
function estSizeForMins(m) {
  return m < 15 ? "xs" : m < 30 ? "s" : m < 60 ? "m" : m < 120 ? "l" : "xl";
}

// Overall time-health widget: total remaining across all projects, a per-project
// bar list, and an honest coverage footer. Empty state when nothing is estimable.
function timeHealthWidget(taskMap, projectList) {
  const rows = (projectList || [])
    .map((p) => Object.assign({ p }, projectEstRaw(taskMap[p.id])))
    .sort((a, b) => b.sum - a.sum);
  const estimated = rows.reduce((s, r) => s + r.estimated, 0);
  if (!estimated) {
    return `<div class="card time-health"><div class="th-label">Time health</div>
      <div class="empty th-empty"><span class="big">⏱</span>No estimates yet — tasks with recognizable words will show up here.</div></div>`;
  }
  const listed = rows.filter((r) => r.estimated > 0);
  const total = listed.reduce((s, r) => s + r.sum, 0);
  const max = listed[0].sum;
  const shown = listed.slice(0, 8);
  const hidden = listed.length - shown.length;
  const unestimated = rows.reduce((s, r) => s + (r.total - r.estimated), 0);
  return `<div class="card time-health">
    <div class="th-label">Time health</div>
    <div class="th-total">≈${Estimate.fmtMins(total)} <span class="th-total-sub">remaining</span></div>
    <div class="th-bars">
      ${shown.map((r) => `
      <div class="th-row">
        <span class="th-name">${esc(r.p.name)}</span>
        <div class="th-track"><div class="th-bar est-${estSizeForMins(r.sum)}" style="width:${Math.round((r.sum / max) * 100)}%"></div></div>
        <span class="th-val">≈${Estimate.fmtMins(r.sum)}</span>
      </div>`).join("")}
    </div>
    ${hidden > 0 ? `<div class="th-more">+${hidden} more</div>` : ""}
    <div class="th-foot">based on ${estimated} estimated task${estimated === 1 ? "" : "s"} · ${unestimated} task${unestimated === 1 ? "" : "s"} had no estimate</div>
  </div>`;
}

// Fetch task lists for the displayed projects; a failed project just yields no estimate.
async function fetchProjectTasks(projects) {
  const lists = await Promise.all((projects || []).map(async (p) => {
    try { return (await GET(`/api/projects/${encodeURIComponent(p.id)}`)).tasks || []; }
    catch (e) { return []; }
  }));
  const m = {};
  (projects || []).forEach((p, i) => { m[p.id] = lists[i]; });
  return m;
}

/* ---------- My Day: cross-project home view ---------- */
let pendingTaskOpen = null;    // {pid, tid} — open the task modal after routing
let pendingArticleOpen = null; // {pid, aid} — select the article after routing
function openTaskInProject(pid, tid) {
  pendingTaskOpen = { pid, tid };
  const h = `#/projects/${pid}`;
  if (location.hash === h) route();
  else location.hash = h;
}

/* ---------- My Day: section folding ---------- */
const MYDAY_FOLD_AFTER = 4; // fold a My Day section after this many rows
const mydayExpanded = {};   // session-only: section key -> expanded
let mydayData = null;

function mydaySectionHtml(key, label, items) {
  if (!items.length) return "";
  const expanded = !!mydayExpanded[key];
  const foldable = items.length > MYDAY_FOLD_AFTER;
  const shown = (expanded || !foldable) ? items : items.slice(0, MYDAY_FOLD_AFTER);
  const hidden = items.length - shown.length;
  const btn = foldable
    ? `<button class="btn btn-ghost btn-sm myday-fold" id="myday-fold-${key}" data-sec="${key}" aria-expanded="${expanded}" aria-controls="myday-list-${key}">${expanded ? "Show less" : `Show ${hidden} more`}</button>`
    : "";
  return `<div class="myday-section">
    <div class="section-title">${label} <span class="col-count">${items.length}</span></div>
    <div class="myday-list" id="myday-list-${key}">${shown.map(mydayRowHtml).join("")}</div>${btn}</div>`;
}

function renderMyDay() {
  const d = mydayData;
  if (!d) return;
  const all = [...d.overdue, ...d.today, ...d.in_progress];
  const byId = new Map(all.map((t) => [t.id, t]));
  view.innerHTML = all.length
    ? mydaySectionHtml("overdue", "Overdue", d.overdue)
      + mydaySectionHtml("today", "Due today", d.today)
      + mydaySectionHtml("in_progress", "In progress", d.in_progress)
    : `<div class="card"><div class="empty"><span class="big">☀</span>Nothing due — your day is clear.<br><br><button class="btn btn-default" id="md-empty-add">Quick add a task</button></div></div>`;
  $$(".myday-row").forEach((el) => {
    const chk = el.querySelector(".task-check");
    if (chk) chk.onclick = async (e) => {
      e.stopPropagation();
      const t = byId.get(el.dataset.mtid);
      if (!t || t.status === "done") return;
      try { const nt = await setTaskDone(t, true); if (nt) route(); }
      catch (err) { toast(err.message, true); }
    };
    el.onclick = () => openTaskInProject(el.dataset.mpid, el.dataset.mtid);
  });
  $$(".myday-fold").forEach((b) => { b.onclick = () => mydayFoldToggle(b.dataset.sec); });
  $("#md-quick").onclick = () => quickAddModal();
  const ea = $("#md-empty-add");
  if (ea) ea.onclick = () => quickAddModal();
}

function mydayFoldToggle(key) {
  mydayExpanded[key] = !mydayExpanded[key];
  renderMyDay();
  const btn = $("#myday-fold-" + key); // keep focus on the toggled expander
  if (btn && btn.focus) btn.focus();
}

function mydayRowHtml(t) {
  return `
    <div class="card myday-row" data-mpid="${esc(t.project_id)}" data-mtid="${esc(t.id)}">
      <div class="checkbox task-check ${t.status === "done" ? "on" : ""}">${t.status === "done" ? "✓" : ""}</div>
      <div style="flex:1;min-width:0">
        <div class="task-title ${t.status === "done" ? "done" : ""}">${esc(t.title)}</div>
        <div class="task-meta">${estChipFor(t)}${duePill(t)}${blockedBadge(t)}${recurrenceBadge(t)}${subtaskBadge(t)}
          <span class="myday-proj">${esc(t.project_icon || "")} ${esc(t.project_name || "")}</span></div>
      </div>
      <span style="color:var(--muted-foreground)">→</span>
    </div>`;
}

async function vMyDay() {
  const st = await GET("/api/status").catch(() => ({}));
  showChrome(true, st.space_name || "");
  setNav("myday");
  setTitle("My Day", st.space_name ? `Workspace · ${st.space_name}` : "Workspace");
  setActions(`<button class="btn btn-default" id="md-quick">+ Quick add</button>`);
  view.innerHTML = `<div style="display:grid;gap:12px"><div class="skeleton" style="height:64px"></div><div class="skeleton" style="height:64px"></div></div>`;
  let d;
  try { d = await GET("/api/myday"); }
  catch (e) { view.innerHTML = `<div class="empty"><span class="big">⚠</span>${esc(e.message)}</div>`; return; }
  mydayData = d;
  renderMyDay();
}

/* ---------- Cmd+K command palette ---------- */
let cmdkSel = 0;
let cmdkItems = []; // {kind, id, pid?, title, sub?}
function cmdkClose() {
  const r = $("#cmdk-root");
  if (r) r.remove();
  cmdkItems = []; cmdkSel = 0;
}
function openCmdK() {
  if ($("#cmdk-root")) return;
  const root = document.createElement("div");
  root.id = "cmdk-root";
  root.innerHTML = `
    <div class="cmdk-overlay" id="cmdk-ovl">
      <div class="cmdk" role="dialog" aria-modal="true" aria-label="Search">
        <input id="cmdk-input" placeholder="Search tasks, projects, wiki…" autocomplete="off">
        <div id="cmdk-list" class="cmdk-list"></div>
        <div class="cmdk-foot"><span><kbd>↑</kbd><kbd>↓</kbd> navigate</span><span><kbd>↵</kbd> open</span><span><kbd>esc</kbd> close</span></div>
      </div>
    </div>`;
  document.body.appendChild(root);
  $("#cmdk-ovl").addEventListener("mousedown", (e) => { if (e.target.id === "cmdk-ovl") cmdkClose(); });
  const input = $("#cmdk-input");
  let timer = null;
  input.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(() => cmdkSearch(input.value), 160); });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); cmdkMove(1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); cmdkMove(-1); }
    else if (e.key === "Enter") { e.preventDefault(); cmdkActivate(); }
    else if (e.key === "Escape") { cmdkClose(); }
    e.stopPropagation();
  });
  cmdkSearch("");
  setTimeout(() => input.focus(), 30);
}
async function cmdkSearch(q) {
  const list = $("#cmdk-list");
  if (!list) return;
  const query = q.trim();
  let tasks = [], projects = [], articles = [];
  if (query) {
    try {
      const r = await GET(`/api/quicksearch?q=${encodeURIComponent(query)}`);
      tasks = r.tasks || []; projects = r.projects || []; articles = r.articles || [];
    } catch (e) { list.innerHTML = `<div class="empty" style="padding:16px">${esc(e.message)}</div>`; return; }
  }
  cmdkItems = [];
  if (query) cmdkItems.push({ kind: "create", id: "", title: `＋ Create task “${query}”`, sub: "quick add" });
  for (const p of projects) cmdkItems.push({ kind: "project", id: p.id, title: `${p.icon} ${p.name}`, sub: "project" });
  for (const t of tasks) cmdkItems.push({ kind: "task", id: t.id, pid: t.project_id, title: t.title, sub: t.project_name });
  for (const a of articles) cmdkItems.push({ kind: "article", id: a.id, pid: a.project_id, title: `📄 ${a.title}`, sub: `${a.project_name} · wiki` });
  cmdkSel = 0;
  cmdkRender(query);
}
function cmdkRender(query) {
  const list = $("#cmdk-list");
  if (!list) return;
  if (!cmdkItems.length) {
    list.innerHTML = `<div class="empty" style="padding:20px">${query ? "No matches." : "Type to search tasks, projects, and wiki."}</div>`;
    return;
  }
  list.innerHTML = cmdkItems.map((it, i) => `
    <div class="cmdk-item ${i === cmdkSel ? "sel" : ""}" data-ci="${i}">
      <span class="cmdk-kind">${esc(it.kind === "create" ? "＋" : it.kind)}</span>
      <span class="cmdk-title">${esc(it.title)}</span>
      ${it.sub ? `<span class="cmdk-sub">${esc(it.sub)}</span>` : ""}
    </div>`).join("");
  $$("#cmdk-list [data-ci]").forEach((el) => {
    el.onclick = () => { cmdkSel = Number(el.dataset.ci); cmdkActivate(); };
    el.onmousemove = () => {
      const n = Number(el.dataset.ci);
      if (n !== cmdkSel) { cmdkSel = n; cmdkRender(query); }
    };
  });
  const sel = list.querySelector(".cmdk-item.sel");
  if (sel && sel.scrollIntoView) sel.scrollIntoView({ block: "nearest" });
}
function cmdkMove(d) {
  if (!cmdkItems.length) return;
  cmdkSel = (cmdkSel + d + cmdkItems.length) % cmdkItems.length;
  cmdkRender($("#cmdk-input") ? $("#cmdk-input").value : "");
}
function cmdkActivate() {
  const it = cmdkItems[cmdkSel];
  if (!it) return;
  const q = $("#cmdk-input") ? $("#cmdk-input").value.trim() : "";
  cmdkClose();
  if (it.kind === "create") { quickAddModal(q); return; }
  if (it.kind === "project") { location.hash = `#/projects/${it.id}`; return; }
  if (it.kind === "task") { openTaskInProject(it.pid, it.id); return; }
  if (it.kind === "article") {
    pendingArticleOpen = { pid: it.pid, aid: it.id };
    const h = `#/projects/${it.pid}/wiki`;
    if (location.hash === h) route(); else location.hash = h;
  }
}

/* ---------- quick-add: natural-language task creation ---------- */
async function quickAddModal(preset) {
  let projects = [];
  try { projects = (await GET("/api/projects")).projects || []; }
  catch (e) { toast(e.message, true); return; }
  if (!projects.length) { toast("Create a project first", true); return; }
  openModal("Quick add", `
    ${field("Task", input("text", preset || "", "text", 'placeholder="Call dentist tomorrow 30m" autocomplete="off"'))}
    <div id="qa-preview" class="qa-preview"></div>
    <div class="formgrid">
      ${field("Project", select("project_id", projects.map((p) => [p.id, `${p.icon} ${p.name}`])))}
      ${field("Due date (override)", input("due", "", "date"))}
    </div>
    ${field("Estimate (override)", input("estimate_min", "", "text", 'placeholder="30m, 2h — blank for auto"'))}
    <div style="font-size:12px;color:var(--muted-foreground);margin-top:10px">Natural language: “tomorrow”, “friday”, “in 3 days”, “next monday”, “2h”, “30m”.</div>`,
    async (d, close) => {
      if (!d.text.trim()) { toast("Task title is required", true); return; }
      try {
        const { parsed } = await POST("/api/quick-add", {
          text: d.text,
          project_id: d.project_id,
          ...(d.due ? { due: d.due } : {}),
          estimate_min: parseEstInput(d.estimate_min),
        });
        close();
        let when = "";
        if (parsed.dueISO) {
          const m = parsed.dueISO.match(/^(\d{4})-(\d{2})-(\d{2})$/);
          if (m) when = ` — due ${fmtDate(new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime())}`;
        }
        toast(`Task created${when}`);
        route();
      } catch (e) { toast(e.message, true); }
    }, "Add task");
  const tin = $("#modal-root [name=text]") || document.querySelector('#modal-root [name="text"]');
  let timer = null;
  const prev = async () => {
    const box = $("#qa-preview");
    if (!box || !tin) return;
    const v = tin.value.trim();
    if (!v) { box.innerHTML = ""; return; }
    try {
      const p = await POST("/api/quick-add/parse", { text: v });
      const bits = [];
      if (p.dueISO) bits.push(`📅 ${p.dueISO}`);
      if (p.estimateMin) bits.push(`⏱ ≈${Estimate.fmtMins(p.estimateMin)}`);
      box.innerHTML = `<span class="qa-title">${esc(p.title) || "…"}</span> ` +
        bits.map((b) => `<span class="badge badge-secondary">${esc(b)}</span>`).join(" ");
    } catch (e) { /* preview is best-effort */ }
  };
  if (tin && tin.addEventListener) tin.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(prev, 200); });
}

/* ---------- sprints ---------- */
function sprintStats(tasks) {
  let total = 0, done = 0, estimated = 0, count = 0, doneCount = 0;
  for (const t of tasks || []) {
    count++;
    const m = taskMinutes(t);
    const explicit = typeof t.estimate_min === "number" && t.estimate_min > 0;
    if (m > 0) { total += m; if (explicit) estimated++; }
    if (t.status === "done") {
      doneCount++;
      if (m > 0) done += m;
    }
  }
  return {
    total, done, estimated, count, doneCount,
    pct: count ? Math.round((doneCount / count) * 100) : 0,
  };
}

async function vSprints() {
  const st = await GET("/api/status").catch(() => ({}));
  showChrome(true, st.space_name || "");
  setNav("sprints");
  setTitle("Sprints", "Time-boxed focus");
  setActions(`<button class="btn btn-default" id="sp-new">+ New sprint</button>`);
  view.innerHTML = `<div class="skeleton" style="height:120px"></div>`;
  let d;
  try { d = await GET("/api/sprints"); }
  catch (e) { view.innerHTML = `<div class="empty"><span class="big">⚠</span>${esc(e.message)}</div>`; return; }
  const card = (s) => `
    <div class="card sprint-card" data-sprint="${esc(s.id)}">
      <div style="display:flex;align-items:center;gap:10px">
        <div style="flex:1;min-width:0"><div class="p-name">${esc(s.name)}</div>
        <div class="p-sub">${esc(s.start)} → ${esc(s.end)} · ${s.total} task${s.total === 1 ? "" : "s"}</div></div>
        <span class="badge ${s.status === "open" ? "badge-default" : "badge-secondary"}">${esc(s.status)}</span>
      </div>
    </div>`;
  view.innerHTML = `
    ${d.open.length ? `<div class="section-title">Open</div><div class="sprint-grid">${d.open.map(card).join("")}</div>` : ""}
    ${d.closed.length ? `<div class="section-title">Archived</div><div class="sprint-grid">${d.closed.map(card).join("")}</div>` : ""}
    ${!d.open.length && !d.closed.length ? `<div class="card"><div class="empty"><span class="big">🏁</span>No sprints yet — time-box your next week of work.</div></div>` : ""}`;
  $$("[data-sprint]").forEach((el) => { el.onclick = () => { location.hash = `#/sprints/${el.dataset.sprint}`; }; });
  $("#sp-new").onclick = () => sprintModal();
}

function sprintModal(existing) {
  // New sprints default to this week Monday–Sunday, computed client-side.
  const now = new Date();
  const dow = (now.getDay() + 6) % 7;
  const mon = new Date(now.getFullYear(), now.getMonth(), now.getDate() - dow);
  const sun = new Date(mon.getTime() + 6 * 86400000);
  const s = existing || {};
  openModal(existing ? "Edit sprint" : "New sprint", `
    ${field("Name", input("name", s.name || ""))}
    <div class="formgrid">
      ${field("Start", input("start", s.start || isoDate(mon.getTime()), "date"))}
      ${field("End", input("end", s.end || isoDate(sun.getTime()), "date"))}
    </div>`,
    async (d, close) => {
      if (!d.name.trim()) { toast("Sprint name is required", true); return; }
      if (existing) await PATCH(`/api/sprints/${existing.id}`, { name: d.name, start: d.start, end: d.end });
      else await POST("/api/sprints", { name: d.name, start: d.start, end: d.end });
      close();
      toast(existing ? "Sprint updated" : "Sprint created");
      route();
    }, existing ? "Save changes" : "Create sprint");
}

async function vSprintDetail(id) {
  const st = await GET("/api/status").catch(() => ({}));
  showChrome(true, st.space_name || "");
  setNav("sprints");
  view.innerHTML = `<div class="empty"><span class="big">◌</span>Loading sprint…</div>`;
  let d;
  try { d = await GET(`/api/sprints/${id}`); }
  catch (e) { view.innerHTML = `<div class="empty"><span class="big">⚠</span>${esc(e.message)}<br><br><a class="btn btn-outline" href="#/sprints">Back to sprints</a></div>`; return; }
  const s = d.sprint;
  const stats = sprintStats(d.tasks);
  setTitle(s.name, `${s.start} → ${s.end}`);
  setActions(`
    ${s.status === "open" ? `<button class="btn btn-outline btn-sm" id="sd-add">+ Add tasks</button>
    <button class="btn btn-outline btn-sm" id="sd-edit">Edit</button>
    <button class="btn btn-default btn-sm" id="sd-close">Close sprint</button>` : ""}
    <a class="btn btn-ghost btn-sm" href="#/sprints">Back</a>`);
  const cols = COLUMNS.map(([key, label]) => {
    const items = d.tasks.filter((t) => t.status === key);
    return `<div class="kanban-col"><div class="col-head">${label}<span class="col-count">${items.length}</span></div>
      <div class="col-body">${items.map((t) => `
        <div class="card task-card" data-tid="${esc(t.id)}" data-spid="${esc(t.project_id)}">
          <div class="task-title">${esc(t.title)}</div>
          <div class="task-meta">${estChipFor(t)}${duePill(t)}${blockedBadge(t)}${subtaskBadge(t)}
            <span class="myday-proj">${esc(t.project_name)}</span></div>
        </div>`).join("") || `<div class="st-empty">—</div>`}</div></div>`;
  }).join("");
  view.innerHTML = `
    <div class="card sprint-sum">
      <div class="th-label">Sprint velocity</div>
      <div class="th-total">${stats.doneCount}/${stats.count} tasks
        <span class="th-total-sub">≈${Estimate.fmtMins(stats.done)} of ≈${Estimate.fmtMins(stats.total)} completed</span></div>
      <div class="progress" style="margin-top:8px"><div class="progress-indicator" style="width:${stats.pct}%"></div></div>
      <div class="th-foot">${stats.estimated} of ${stats.count} tasks had explicit estimates${stats.estimated < stats.count ? "; others auto-estimated" : ""}</div>
    </div>
    <div class="board">${cols}</div>`;
  $$("#view [data-tid]").forEach((el) => {
    el.onclick = () => openTaskInProject(el.dataset.spid, el.dataset.tid);
  });
  const add = $("#sd-add");
  if (add) add.onclick = () => {
    crossProjectTaskPicker("Add to sprint…", d.tasks.map((t) => t.id), async (pick) => {
      if (!pick) return;
      try { await POST(`/api/sprints/${id}/tasks`, { task_id: pick.id }); toast(`Added “${pick.title}”`); route(); }
      catch (e) { toast(e.message, true); }
    });
  };
  const edit = $("#sd-edit");
  if (edit) edit.onclick = () => sprintModal(s);
  const closeBtn = $("#sd-close");
  if (closeBtn) closeBtn.onclick = async () => {
    const unfinished = d.tasks.filter((t) => t.status !== "done").length;
    if (!confirm(`Close “${s.name}”? ${unfinished} unfinished task${unfinished === 1 ? "" : "s"} return${unfinished === 1 ? "s" : ""} to the project backlog.`)) return;
    try {
      const r = await POST(`/api/sprints/${id}/close`, {});
      toast(`Sprint closed — ${r.returned_to_backlog} task${r.returned_to_backlog === 1 ? "" : "s"} back to backlog`);
      route();
    } catch (e) { toast(e.message, true); }
  };
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
  const taskMap = await fetchProjectTasks(d.projects);
  view.innerHTML = d.projects.length ? `
    <div class="proj-grid">
      ${d.projects.map((p) => {
        const est = projectRemainingEst(taskMap[p.id]);
        return `
        <div class="card proj-card" data-goto="${p.id}">
          <div class="p-ico">${esc(p.icon)}</div>
          <h3>${esc(p.name)}</h3>
          <div class="p-desc">${esc(p.notes) || "&nbsp;"}</div>
          ${est ? `<div class="p-est"><span class="est-chip">⏱ ${est} remaining</span></div>` : ""}
          <div class="p-foot">
            <div class="progress" style="flex:1;min-width:0"><div class="progress-indicator" style="width:${p.progress}%"></div></div>
            <div class="p-counts">${p.done}/${p.total}</div>
            ${p.source === "imported" ? `<span class="badge badge-outline">imported</span>` : ""}
          </div>
        </div>`;
      }).join("")}
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
  if (isTask) cuProjectId = projectId; // the ClickUp tab binds/imports into this project
  const anyPane = `<div class="search-row"><input id="imp-q" placeholder="Search your ${isTask ? "tasks" : "pages"} in Anytype…"><button class="btn btn-outline" id="imp-go">Search</button></div>
     <div id="imp-results" style="max-height:300px;overflow:auto"></div>
     <p style="font-size:12px;color:var(--muted-foreground)">Already-tracked items are hidden. Imported items keep living in Anytype — Ascent only links to them.</p>`;
  openModal(isTask ? "Import tasks" : isWiki ? "Import wiki pages" : "Import project",
    isTask
      ? `<div class="tabs-list" role="tablist" style="margin-bottom:12px">
           <button class="tabs-trigger on" id="imp-tab-any">Anytype</button>
           <button class="tabs-trigger" id="imp-tab-cu">ClickUp</button>
           <button class="tabs-trigger" id="imp-tab-em">Email</button>
         </div>
         <div id="imp-any">${anyPane}</div>
         <div id="imp-cu" style="display:none"></div>
         <div id="imp-em" style="display:none"></div>`
      : anyPane,
    async (_d, close) => {
      if (isTask && cuTab === "cu") {
        const { imported, skipped } = await clickupImportSelected(projectId);
        close();
        toast(`Imported ${imported}${skipped ? `, ${skipped} already imported — skipped` : ""}`);
        route();
        return;
      }
      if (isTask && emTab === "em") {
        const { imported, skipped } = await emailImportSelected();
        close();
        toast(`Imported ${imported}${skipped ? `, ${skipped} already imported — skipped` : ""} — find them in the ✉ project`);
        route();
        return;
      }
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
  if (isTask) {
    cuTab = "any";
    emTab = "any";
    $("#imp-tab-any").onclick = () => { cuShowTab("any"); emShowTab("any"); };
    $("#imp-tab-cu").onclick = () => cuShowTab("cu");
    $("#imp-tab-em").onclick = () => emShowTab("em");
  }
}

/* ---------- ClickUp integration: one-way import + manual two-way sync ----------
   The token is pasted by the user and POSTed to the server, which stores it
   in gitignored data/links.json and proxies every ClickUp call. The browser
   never sees the token again: status returns only a boolean.
   A ClickUp list can be BOUND to a project (via "Link this list" or by
   importing from it); the ⇄ Sync button in the project view then runs a
   manual two-way sync with that list. There is no polling: nothing syncs
   unless the user presses the button. */
let cuTab = "any";
let cu = null;
let cuProjectId = null; // project the ClickUp tab currently imports/binds into
function cuInit() {
  cu = { connected: false, trail: [], level: "", items: [], tasks: [], loading: false, error: "" };
}
function cuShowTab(which) {
  cuTab = which;
  if (which === "cu") emTab = "any";
  const any = $("#imp-tab-any"), ctab = $("#imp-tab-cu"), etab = $("#imp-tab-em");
  if (any && any.classList) any.classList.toggle("on", which === "any");
  if (ctab && ctab.classList) ctab.classList.toggle("on", which === "cu");
  if (etab && etab.classList) etab.classList.toggle("on", false);
  const ap = $("#imp-any"), cp = $("#imp-cu"), ep = $("#imp-em");
  if (ap && ap.style) ap.style.display = which === "any" ? "" : "none";
  if (cp && cp.style) cp.style.display = which === "cu" ? "" : "none";
  if (ep && ep.style) ep.style.display = "none";
  if (which === "cu") cuShowPane();
}
async function cuShowPane() {
  const box = $("#imp-cu");
  if (!box) return;
  if (!cu) cuInit();
  try { cu.connected = !!(await GET("/api/integrations/clickup/status")).connected; }
  catch { cu.connected = false; }
  cuRender();
  if (cu.connected && !cu.level) await cuLoadTeams();
}
function cuRender() {
  const box = $("#imp-cu");
  if (!box) return;
  box.innerHTML = cuPaneHtml();
  cuWirePane();
}
function cuCrumbHtml() {
  const bits = [`<button class="btn btn-link btn-sm" data-cu-crumb="-1">Workspaces</button>`];
  cu.trail.forEach((t, i) => {
    bits.push(`<button class="btn btn-link btn-sm" data-cu-crumb="${i}">${esc(t.name)}</button>`);
  });
  return bits.join('<span style="color:var(--muted-foreground);font-size:12px"> / </span>');
}
function cuPaneHtml() {
  if (!cu.connected) return `
    <p style="font-size:12px;color:var(--muted-foreground);margin:0 0 10px">Paste a <strong>Personal API token</strong> — in ClickUp: your avatar → <em>Apps</em> → <em>Personal API token</em>. The token is stored on this server only and never sent back to your browser.</p>
    <div class="search-row"><input id="cu-token" type="password" placeholder="pk_…" autocomplete="off" style="flex:1"><button class="btn btn-default" id="cu-connect">Connect</button></div>
    <div id="cu-msg" style="margin-top:8px;min-height:1.4em"></div>`;
  const icon = { team: "◈", space: "▦", folder: "🗂", list: "☰" };
  let list;
  if (cu.loading) list = `<div class="empty" style="padding:16px">Loading…</div>`;
  else if (cu.error) list = `<div class="empty" style="padding:16px">⚠ ${esc(cu.error)}</div>`;
  else if (cu.level === "tasks") {
    list = cu.tasks.length ? `
      <label class="import-row" style="font-weight:600"><input type="checkbox" id="cu-all"><span>Select all (${cu.tasks.length})</span></label>
      ${cu.tasks.map((t) => `<label class="import-row"><input type="checkbox" class="cu-task" value="${esc(t.id)}"><span>${esc(t.name)}${t.status ? ` <span class="badge badge-secondary">${esc(t.status)}</span>` : ""}${t.dueDate ? ` <span style="color:var(--muted-foreground);font-size:12px">◷ ${esc(fmtDate(Number(t.dueDate)))}</span>` : ""}</span></label>`).join("")}`
      : `<div class="empty" style="padding:16px">No tasks in this list.</div>`;
  } else {
    list = cu.items.length ? cu.items.map((it) => `
      <button class="import-row" data-cu-open="${esc(it.id)}" data-cu-kind="${esc(it.kind)}" style="width:100%;text-align:left;cursor:pointer;background:none;border:none;color:inherit;font:inherit">
        <span>${icon[it.kind] || "›"}</span><span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(it.name)}</span><span style="color:var(--muted-foreground)">›</span>
      </button>`).join("") : `<div class="empty" style="padding:16px">Nothing here.</div>`;
  }
  return `
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
      <div style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${cuCrumbHtml()}</div>
      <button class="btn btn-link btn-sm" id="cu-disconnect" style="color:var(--destructive);flex-shrink:0">Disconnect</button>
    </div>
    <div id="cu-items" style="max-height:300px;overflow:auto">${list}</div>
    ${cu.level === "tasks" ? `
    <div style="margin-top:10px;display:flex;gap:8px;align-items:center;flex-wrap:wrap">
      <button class="btn btn-outline btn-sm" id="cu-link-list">⛓ Link this list to the project</button>
      <span style="font-size:12px;color:var(--muted-foreground)">…without importing, for ⇄ Sync</span>
    </div>` : ""}
    <p style="font-size:12px;color:var(--muted-foreground);margin:10px 0 0">Tasks are created as native Anytype tasks in this project. Re-importing skips tasks already imported. A linked list powers the ⇄ Sync button in the project view.</p>`;
}
function cuWirePane() {
  const conn = $("#cu-connect");
  if (conn) conn.onclick = cuConnect;
  const tok = $("#cu-token");
  if (tok && tok.addEventListener) tok.addEventListener("keydown", (e) => { if (e.key === "Enter") cuConnect(); });
  const dis = $("#cu-disconnect");
  if (dis) dis.onclick = cuDisconnect;
  const linkBtn = $("#cu-link-list");
  if (linkBtn) linkBtn.onclick = cuLinkList;
  $$("#imp-cu [data-cu-crumb]").forEach((b) => { b.onclick = () => cuCrumb(Number(b.dataset.cuCrumb)); });
  $$("#imp-cu [data-cu-open]").forEach((b) => { b.onclick = () => cuOpen(b.dataset.cuOpen, b.dataset.cuKind); });
  const all = $("#cu-all");
  if (all) all.onclick = () => { $$("#imp-cu .cu-task").forEach((c) => { c.checked = all.checked; }); };
}
/** Bind the browsed ClickUp list to the project without importing any tasks. */
async function cuLinkList() {
  const listCrumb = [...cu.trail].reverse().find((t) => t.kind === "list");
  if (!listCrumb) { toast("Pick a ClickUp list first", true); return; }
  if (!cuProjectId) { toast("Open this from a project first", true); return; }
  try {
    const { binding } = await POST(`/api/integrations/clickup/lists/${encodeURIComponent(listCrumb.id)}/bind`,
      { project_id: cuProjectId });
    $("#modal-root").innerHTML = "";
    toast(`Linked to ClickUp list “${binding.list_name}” — use ⇄ Sync in the project view`);
    route();
  } catch (e) { toast(e.message, true); }
}
async function cuConnect() {
  const token = $("#cu-token").value.trim();
  const msg = $("#cu-msg");
  const say = (html) => { if (msg) msg.innerHTML = html; };
  if (!token) { say(`<span class="badge badge-destructive">Paste your token first</span>`); return; }
  say(`<span style="font-size:12px;color:var(--muted-foreground)">Connecting…</span>`);
  try { await POST("/api/integrations/clickup/connect", { token }); }
  catch (e) { say(`<span class="badge badge-destructive">${esc(e.message)}</span>`); return; }
  cuInit();
  await cuShowPane(); // re-renders as connected, then loads teams
}
async function cuDisconnect() {
  await DEL("/api/integrations/clickup/disconnect").catch(() => {});
  cuInit();
  cuRender();
}
async function cuLoadTeams() {
  cu.loading = true; cu.error = ""; cu.trail = []; cu.level = "teams"; cuRender();
  try {
    const { teams } = await GET("/api/integrations/clickup/teams");
    cu.items = (teams || []).map((t) => ({ ...t, kind: "team" }));
  } catch (e) { cu.error = e.message; }
  cu.loading = false; cuRender();
}
async function cuOpen(id, kind) {
  const it = cu.items.find((x) => String(x.id) === String(id));
  cu.trail = [...cu.trail, { id, name: (it && it.name) || kind, kind }];
  await cuOpenInto(id, kind);
}
async function cuOpenInto(id, kind) {
  cu.loading = true; cu.error = ""; cuRender();
  try {
    if (kind === "team") {
      const { spaces } = await GET(`/api/integrations/clickup/teams/${encodeURIComponent(id)}/spaces`);
      cu.items = (spaces || []).map((s) => ({ ...s, kind: "space" }));
      cu.level = "browse";
    } else if (kind === "space") {
      const [f, l] = await Promise.all([
        GET(`/api/integrations/clickup/spaces/${encodeURIComponent(id)}/folders`).catch(() => ({ folders: [] })),
        GET(`/api/integrations/clickup/spaces/${encodeURIComponent(id)}/lists`).catch(() => ({ lists: [] })),
      ]);
      cu.items = [
        ...(f.folders || []).map((x) => ({ ...x, kind: "folder" })),
        ...(l.lists || []).map((x) => ({ ...x, kind: "list" })),
      ];
      cu.level = "browse";
    } else if (kind === "folder") {
      const { lists } = await GET(`/api/integrations/clickup/folders/${encodeURIComponent(id)}/lists`);
      cu.items = (lists || []).map((x) => ({ ...x, kind: "list" }));
      cu.level = "browse";
    } else if (kind === "list") {
      const { tasks } = await GET(`/api/integrations/clickup/lists/${encodeURIComponent(id)}/tasks`);
      cu.tasks = tasks || [];
      cu.level = "tasks";
    }
  } catch (e) { cu.error = e.message; }
  cu.loading = false; cuRender();
}
async function cuCrumb(i) {
  const target = i < 0 ? null : cu.trail[i];
  cu.trail = i < 0 ? [] : cu.trail.slice(0, i);
  if (!target) { await cuLoadTeams(); return; }
  await cuOpenInto(target.id, target.kind);
}
async function clickupImportSelected(projectId) {
  const listCrumb = [...cu.trail].reverse().find((t) => t.kind === "list");
  if (!listCrumb) throw new Error("Pick a ClickUp list first");
  const checked = $$("#imp-cu .cu-task:checked").map((c) => c.value);
  if (!checked.length) throw new Error("Select at least one task");
  const tasks = cu.tasks.filter((t) => checked.includes(String(t.id)));
  return POST(`/api/integrations/clickup/lists/${encodeURIComponent(listCrumb.id)}/import`,
    { project_id: projectId, tasks });
}

/* ---------- Email integration: starred IMAP emails → tasks ----------
   Credentials are pasted by the user and POSTed to the server, which stores
   them in gitignored data/links.json and proxies every IMAP call. The
   browser never sees the password again: status returns only an account
   label. The mail account IS the project: the first import creates a
   native Anytype project named after the account (✉ user@host) and later
   imports reuse it. Re-imports skip UIDs already imported (dedupe survives
   disconnects). */
let emTab = "any";
let em = null;
function emInit() {
  em = { connected: false, account: "", mails: [], loaded: false, loading: false, error: "" };
}
function emShowTab(which) {
  emTab = which;
  if (which === "em") cuTab = "any";
  const any = $("#imp-tab-any"), ctab = $("#imp-tab-cu"), etab = $("#imp-tab-em");
  if (any && any.classList) any.classList.toggle("on", which === "any");
  if (ctab && ctab.classList) ctab.classList.toggle("on", false);
  if (etab && etab.classList) etab.classList.toggle("on", which === "em");
  const ap = $("#imp-any"), cp = $("#imp-cu"), ep = $("#imp-em");
  if (ap && ap.style) ap.style.display = which === "any" ? "" : "none";
  if (cp && cp.style) cp.style.display = "none";
  if (ep && ep.style) ep.style.display = which === "em" ? "" : "none";
  if (which === "em") emShowPane();
}
async function emShowPane() {
  const box = $("#imp-em");
  if (!box) return;
  if (!em) emInit();
  try {
    const s = await GET("/api/integrations/email/status");
    em.connected = !!s.connected;
    em.account = s.account || "";
  } catch { em.connected = false; }
  emRender();
  if (em.connected && !em.loaded) await emLoadStarred();
}
function emRender() {
  const box = $("#imp-em");
  if (!box) return;
  box.innerHTML = emPaneHtml();
  emWirePane();
}
function emPaneHtml() {
  if (!em.connected) return `
    <p style="font-size:12px;color:var(--muted-foreground);margin:0 0 10px">Connect a mail account over <strong>IMAP</strong> — starred (⭐) emails become tasks in a project named after the account. Most providers use port <strong>993</strong> with your login email as the username. The password is stored on this server only and never sent back to your browser.</p>
    <div class="search-row" style="margin-bottom:8px"><input id="em-host" placeholder="Mail host — imap.gmail.com" autocomplete="off" style="flex:1"><input id="em-port" placeholder="993" inputmode="numeric" style="width:76px"></div>
    <div class="search-row" style="margin-bottom:8px"><input id="em-user" placeholder="Username — you@example.com" autocomplete="off" style="flex:1"></div>
    <div class="search-row"><input id="em-pass" type="password" placeholder="Password (or app password)" autocomplete="off" style="flex:1"><button class="btn btn-default" id="em-connect">Connect</button></div>
    <div id="em-msg" style="margin-top:8px;min-height:1.4em"></div>`;
  let list;
  if (em.loading) list = `<div class="empty" style="padding:16px">Loading starred emails…</div>`;
  else if (em.error) list = `<div class="empty" style="padding:16px">⚠ ${esc(em.error)}</div>`;
  else if (em.mails.length) {
    const fresh = em.mails.filter((m) => !m.imported).length;
    list = (fresh ? `<label class="import-row" style="font-weight:600"><input type="checkbox" id="em-all"><span>Select all (${fresh} new)</span></label>` : "") +
      em.mails.map((m) => `
        <label class="import-row"><input type="checkbox" class="em-mail" value="${esc(m.uid)}"${m.imported ? " disabled" : ""}>
          <span>⭐ <strong>${esc(m.subject)}</strong>${m.imported ? ` <span class="badge badge-secondary">imported</span>` : ""}
          <br><span style="color:var(--muted-foreground);font-size:12px">${esc(m.from)}${m.date ? ` · ${esc(m.date)}` : ""}</span>
          ${m.snippet ? `<br><span style="font-size:12px">${esc(m.snippet)}</span>` : ""}</span></label>`).join("");
  } else list = `<div class="empty" style="padding:16px">No starred emails found in this account.</div>`;
  return `
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
      <div style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">✉ <strong>${esc(em.account)}</strong></div>
      <button class="btn btn-link btn-sm" id="em-refresh">↻ Refresh</button>
      <button class="btn btn-link btn-sm" id="em-disconnect" style="color:var(--destructive);flex-shrink:0">Disconnect</button>
    </div>
    <div id="em-items" style="max-height:300px;overflow:auto">${list}</div>
    <p style="font-size:12px;color:var(--muted-foreground);margin:10px 0 0">Starred emails become tasks in a project named after this account. Re-importing skips emails already imported.</p>`;
}
function emWirePane() {
  const conn = $("#em-connect");
  if (conn) conn.onclick = emConnect;
  const pw = $("#em-pass");
  if (pw && pw.addEventListener) pw.addEventListener("keydown", (e) => { if (e.key === "Enter") emConnect(); });
  const dis = $("#em-disconnect");
  if (dis) dis.onclick = emDisconnect;
  const ref = $("#em-refresh");
  if (ref) ref.onclick = () => { em.loaded = false; emLoadStarred(); };
  const all = $("#em-all");
  if (all) all.onclick = () => { $$("#imp-em .em-mail:not([disabled])").forEach((c) => { c.checked = all.checked; }); };
}
async function emConnect() {
  const host = $("#em-host").value.trim();
  const user = $("#em-user").value.trim();
  const pass = $("#em-pass").value;
  const port = $("#em-port").value.trim();
  const msg = $("#em-msg");
  const say = (html) => { if (msg) msg.innerHTML = html; };
  if (!host || !user || !pass) { say(`<span class="badge badge-destructive">Fill in host, username and password</span>`); return; }
  say(`<span style="font-size:12px;color:var(--muted-foreground)">Connecting…</span>`);
  try { await POST("/api/integrations/email/connect", { host, port, user, pass }); }
  catch (e) { say(`<span class="badge badge-destructive">${esc(e.message)}</span>`); return; }
  emInit();
  await emShowPane(); // re-renders as connected, then loads starred
}
async function emDisconnect() {
  await POST("/api/integrations/email/disconnect").catch(() => {});
  emInit();
  emRender();
}
async function emLoadStarred() {
  em.loading = true; em.error = ""; em.loaded = false; emRender();
  try {
    const { mails, account } = await GET("/api/integrations/email/starred");
    em.mails = mails || [];
    if (account) em.account = account;
    em.loaded = true;
  } catch (e) { em.error = e.message; }
  em.loading = false; emRender();
}
async function emailImportSelected() {
  const checked = $$("#imp-em .em-mail:checked").map((c) => c.value);
  if (!checked.length) throw new Error("Select at least one email");
  return POST("/api/integrations/email/import", { uids: checked });
}

/** Compact, human-readable summary of a sync report for the toast. */
function syncReportText(r) {
  const bits = [];
  if (r.pulled) bits.push(`${r.pulled} pulled from ClickUp`);
  if (r.pushed) bits.push(`${r.pushed} pushed to ClickUp`);
  if (r.imported_new) bits.push(`${r.imported_new} new from ClickUp`);
  if (r.pushed_new) bits.push(`${r.pushed_new} new to ClickUp`);
  if (r.conflicts) {
    const winner = r.conflicts_cu_won && !r.conflicts_at_won ? "ClickUp"
      : r.conflicts_at_won && !r.conflicts_cu_won ? "Ascent" : "newest";
    bits.push(`${r.conflicts} conflict${r.conflicts > 1 ? "s" : ""} (${winner} won)`);
  }
  const gone = (r.gone_clickup || 0) + (r.gone_anytime || 0);
  if (gone) bits.push(`${gone} missing on one side — left alone`);
  return bits.length ? `⇄ Sync: ${bits.join(" · ")}` : "⇄ Sync complete — everything already in sync";
}
function fmtSyncTime(iso) {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  return new Date(ms).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
/** Manual two-way sync with the project's bound ClickUp list. */
async function syncNow(pid) {
  const btn = $("#pd-sync"), sub = $("#pd-sync-sub");
  if (btn) { btn.disabled = true; btn.textContent = "Syncing…"; }
  try {
    const { report } = await POST("/api/integrations/clickup/sync", { project_id: pid });
    toast(syncReportText(report));
    route(); // re-renders the board and the "Last synced" label
  } catch (e) {
    toast(e.message, true);
    if (btn) { btn.disabled = false; btn.textContent = "⇄ Sync"; }
    if (sub) sub.textContent = sub.textContent; // keep the previous label
  }
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
  const binding = d.clickup_binding;
  let emSyncBtn = "";
  try {
    const es = await GET("/api/integrations/email/status");
    if (es.connected && es.project_id === id) {
      emSyncBtn = `<button class="btn btn-outline btn-sm" id="pd-email-sync" title="Import newly starred emails from ${esc(es.account)}">⇅ Sync email</button>`;
    }
  } catch (e) {}
  setActions(tab === "wiki"
    ? `<button class="btn btn-outline btn-sm" id="pd-import-wiki">⇪ Import pages</button> <button class="btn btn-default btn-sm" id="pd-new-article">+ New article</button>`
    : `
    ${binding ? `<span class="sync-wrap"><button class="btn btn-outline btn-sm" id="pd-sync" title="Sync with ClickUp list “${esc(binding.list_name)}”">⇄ Sync</button><span class="sync-sub" id="pd-sync-sub">${binding.last_sync ? "Last synced " + esc(fmtSyncTime(binding.last_sync)) : "Not synced yet"}</span></span>` : ""}
    ${emSyncBtn}
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
      <a class="tabs-trigger ${tab === "table" ? "on" : ""}" href="#/projects/${id}/table">▤ Table</a>
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
    if (pendingArticleOpen && pendingArticleOpen.pid === id) {
      const aid = pendingArticleOpen.aid;
      pendingArticleOpen = null;
      selectArticle(aid);
    }
    return;
  }

  if (tab === "table") {
    renderTable();
  } else {
    $("#tab-body").innerHTML = `
      <div class="board" id="board">
        ${COLUMNS.map(([key, label, color]) => `
          <div class="kanban-col" data-col="${key}">
            <div class="col-head"><span class="col-dot" style="background:${color}"></span>${label}<span class="col-count" id="count-${key}"></span><span class="col-est" id="est-${key}"></span></div>
            <div class="col-body" data-col="${key}"></div>
          </div>`).join("")}
      </div>`;
    renderBoard();
  }

  $("#pd-new-task").onclick = () => taskModal(id);
  $("#pd-edit").onclick = () => projectModal(p);
  $("#pd-import").onclick = () => importModal("task", id);
  if (pendingTaskOpen && pendingTaskOpen.pid === id && tab !== "wiki") {
    const t = boardTasks.find((x) => x.id === pendingTaskOpen.tid);
    pendingTaskOpen = null;
    if (t) setTimeout(() => taskModal(id, t), 0);
  }
  const syncBtn = $("#pd-sync");
  if (syncBtn) syncBtn.onclick = () => syncNow(id);
  const emSyncBtnEl = $("#pd-email-sync");
  if (emSyncBtnEl) emSyncBtnEl.onclick = async () => {
    emSyncBtnEl.disabled = true;
    const orig = emSyncBtnEl.textContent;
    emSyncBtnEl.textContent = "Syncing…";
    try {
      const r = await POST("/api/integrations/email/sync", {});
      await refreshTasks(id);
      toast(r.up_to_date
        ? "Already up to date — no new starred emails"
        : `Imported ${r.imported} new starred email${r.imported === 1 ? "" : "s"}`);
    } catch (e) { toast(e.message, true); }
    emSyncBtnEl.disabled = false;
    emSyncBtnEl.textContent = orig;
  };
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

function blockedBadge(t) {
  if (!t.blocked) return "";
  const names = (t.blockers || []).map((b) => b.title).join(", ");
  return `<span class="badge badge-blocked" title="Blocked by: ${esc(names)}">⛔ blocked</span>`;
}
function recurrenceBadge(t) {
  if (!t.recurrence) return "";
  return `<span class="badge badge-secondary" title="Repeats ${esc(t.recurrence.kind)} — completing spawns the next instance">🔁 ${esc(t.recurrence.kind)}</span>`;
}
function subtaskBadge(t) {
  if (!t.subtask_total) return "";
  return `<span class="badge badge-secondary" title="${t.subtask_done} of ${t.subtask_total} subtasks done">✓ ${t.subtask_done}/${t.subtask_total}</span>`;
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
    <div class="task-meta">${estChipFor(t)}${duePill(t)}${blockedBadge(t)}${recurrenceBadge(t)}${subtaskBadge(t)}${t.child_count ? `<span class="badge badge-secondary" title="${t.child_count} prerequisite${t.child_count === 1 ? "" : "s"}">▸ ${t.child_count}</span>` : ""}${t.source === "imported" ? `<span class="badge badge-outline">imported</span>` : ""}</div>`;
  el.querySelector("[data-check]").onclick = async (e) => {
    e.stopPropagation();
    const wantDone = t.status !== "done";
    if (wantDone && !checkPrereqsDone(t)) return;
    try {
      const task = await setTaskDone(t, wantDone);
      if (!task) return; // user cancelled the blocked-task confirmation
      boardTasks = boardTasks.map((x) => (x.id === t.id ? task : x));
      renderBoard();
      await refreshTasks(currentPid()); // propagate unblock states to other cards
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
      if (target === "done" && !checkPrereqsDone(t)) return;
      if (target === "done" && t.blocked) {
        // Blocked tasks cannot be dropped into Done: shake the card and name
        // the blockers. (The checkbox path asks for confirmation instead.)
        shakeCard(tid);
        toast(`Blocked by ${(t.blockers || []).map((b) => `“${b.title}”`).join(", ")}`, true);
        return;
      }
      const prev = t.status;
      t.status = target; // optimistic
      renderBoard();
      try {
        let task;
        if (target === "done") {
          task = await setTaskDone(t, true);
          if (!task) { t.status = prev; renderBoard(); return; }
        } else {
          task = (await PATCH(`/api/tasks/${tid}`, { status: target })).task;
        }
        boardTasks = boardTasks.map((x) => (x.id === tid ? task : x));
      } catch (err) {
        t.status = prev;
        toast(err.message, true);
      }
      renderBoard();
      if (target === "done") await refreshTasks(currentPid()); // propagate unblocks
    };
  });
}

/* "Blocked by" section: immediate PATCH on add/remove (needs a picker), so the
   modal re-opens fresh from server truth. */
function blockerBoxHtml(t) {
  return `<div class="prereq-box" style="margin-top:12px">
    <div style="font-weight:600;margin-bottom:6px">Blocked by</div>
    <div id="m-blockers"></div>
    <button class="btn btn-outline btn-sm" id="m-block-add" style="margin-top:8px">⛔ Add blocker…</button>
    <div style="font-size:12px;color:var(--muted-foreground);margin-top:6px">A blocked task can't be dropped into Done; completing it asks for confirmation.</div>
  </div>`;
}

/* Recurrence picker section (saved with the modal form). */
function recurrenceBoxHtml(t) {
  const r = t.recurrence || {};
  const days = ["S", "M", "T", "W", "T", "F", "S"];
  return `<div class="recur-box" style="margin-top:12px">
    <div style="font-weight:600;margin-bottom:6px">Repeats</div>
    <div class="formgrid">
      ${field("Frequency", select("recurrence", [["", "Never"], ["daily", "Daily"], ["weekly", "Weekly"], ["monthly", "Monthly"]], r.kind || ""))}
    </div>
      <div id="m-wdwrap" style="${r.kind === "weekly" ? "" : "display:none"}">
        <div class="field"><label>On weekdays</label><div class="wd-row">
          ${days.map((d, i) => `<label class="wd"><input type="checkbox" name="wd${i}"${r.weekdays && r.weekdays.includes(i) ? " checked" : ""}>${d}</label>`).join("")}
        </div></div>
      </div>
    <div style="font-size:12px;color:var(--muted-foreground)">Completing a repeating task spawns the next instance automatically.</div>
  </div>`;
}
function readRecurrence(d) {
  const kind = d.recurrence;
  if (kind !== "daily" && kind !== "weekly" && kind !== "monthly") return null;
  const r = { kind };
  if (kind === "weekly") r.weekdays = [0, 1, 2, 3, 4, 5, 6].filter((i) => d["wd" + i]);
  return r;
}

/* Subtask checklist section: local state, saved with the modal form. */
function subtaskBoxHtml() {
  return `<div class="subtask-box" style="margin-top:12px">
    <div style="font-weight:600;margin-bottom:6px">Subtasks <span id="m-st-count" class="st-count"></span></div>
    <div id="m-subtasks"></div>
    <div class="st-add"><input id="m-st-new" placeholder="Add a subtask…" autocomplete="off"><button class="btn btn-outline btn-sm" id="m-st-add">Add</button></div>
  </div>`;
}

/* Cross-project task picker (blockers, sprint membership). Rendered as a
   stacked overlay so cancelling returns to the underlying modal. */
function crossProjectTaskPicker(title, excludeIds, onPick) {
  const root = $("#modal-root");
  const wrap = document.createElement("div");
  wrap.innerHTML = `
    <div class="dialog-overlay" id="pk-ovl"><div class="dialog-content" role="dialog" aria-modal="true">
      <h2 class="dialog-title">${esc(title)}</h2>
      <input id="pk-search" placeholder="Search all tasks…" autocomplete="off" style="margin-bottom:10px">
      <div id="pk-list" style="max-height:40vh;overflow:auto"><div class="empty" style="padding:16px">Type to search across all projects.</div></div>
      <div class="dialog-footer"><button class="btn btn-ghost" id="pk-cancel">Cancel</button></div>
    </div></div>`;
  root.appendChild(wrap);
  const close = () => wrap.remove();
  $("#pk-cancel").onclick = close;
  $("#pk-ovl").addEventListener("mousedown", (e) => { if (e.target.id === "pk-ovl") close(); });
  let timer = null;
  const draw = async () => {
    const q = $("#pk-search").value.trim();
    const list = $("#pk-list");
    if (!q) { list.innerHTML = `<div class="empty" style="padding:16px">Type to search across all projects.</div>`; return; }
    list.innerHTML = `<div class="empty" style="padding:16px">Searching…</div>`;
    try {
      const { tasks } = await GET(`/api/quicksearch?q=${encodeURIComponent(q)}`);
      const cands = (tasks || []).filter((x) => !excludeIds.includes(x.id));
      list.innerHTML = cands.length ? cands.map((x) => `
        <button class="import-row" data-pk="${esc(x.id)}" style="width:100%;text-align:left;cursor:pointer;background:none;border:none;color:inherit;font:inherit">
          <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(x.title)}</span>
          <span style="color:var(--muted-foreground);font-size:12px">${esc(x.project_name || "")}</span>
          <span class="badge badge-secondary">${esc(colName(x.status))}</span>
        </button>`).join("") : `<div class="empty" style="padding:16px">No matches.</div>`;
      $$("#pk-list [data-pk]").forEach((el) => {
        el.onclick = () => { const pick = cands.find((x) => x.id === el.dataset.pk); close(); onPick(pick); };
      });
    } catch (e) { list.innerHTML = `<div class="empty" style="padding:16px">${esc(e.message)}</div>`; }
  };
  $("#pk-search").oninput = () => { clearTimeout(timer); timer = setTimeout(draw, 180); };
  setTimeout(() => $("#pk-search").focus(), 60);
}

function taskModal(pid, existing) {
  _pid = pid;
  const t = existing || {};
  let mst = (t.subtasks || []).map((s) => ({ id: s.id, title: s.title, done: !!s.done }));
  openModal(existing ? "Edit task" : "New task", `
    ${field("Title", input("title", t.title || ""))}
    <div id="m-est-wrap" style="margin:-6px 0 10px;min-height:1.6em">${estChipFor(t)}</div>
    <div class="formgrid">
      ${field("Status", select("status", COLUMNS.map(([v, l]) => [v, l]), t.status || "backlog"))}
      ${field("Due date", input("due_date", isoDate(t.dueMs), "date"))}
    </div>
    ${field("Notes", `<textarea name="notes" rows="3">${esc(t.notes || "")}</textarea>`)}
    ${existing ? field("Estimate override", input("estimate_min", t.estimate_min || "", "text", 'placeholder="e.g. 30m, 2h — blank for auto"')) : ""}
    ${existing ? recurrenceBoxHtml(t) : ""}
    ${existing ? blockerBoxHtml(t) : ""}
    ${existing ? subtaskBoxHtml() : ""}
    ${existing ? prereqBoxHtml(t) : ""}
    ${existing ? `<div style="margin-top:14px"><button class="btn btn-destructive btn-sm" id="m-delete">Delete task</button></div>
      ${t.source === "ascent" ? `<div style="font-size:12px;color:var(--muted-foreground);margin-top:8px">Also removes the task object from Anytype.</div>`
        : `<div style="font-size:12px;color:var(--muted-foreground);margin-top:8px">Only unlinks — the task stays in Anytype.</div>`}` : ""}
    <div style="font-size:12px;color:var(--muted-foreground);margin-top:10px">Saved as a native Anytype task object.</div>`,
    async (d, close) => {
      if (!d.title.trim()) { toast("Task title is required", true); return; }
      const payload = {
        title: d.title, notes: d.notes, due_date: d.due_date, status: d.status,
        estimate_min: parseEstInput(d.estimate_min),
        recurrence: readRecurrence(d),
        subtasks: mst,
      };
      const saveOnce = async (withConfirm) => {
        const { task } = await PATCH(`/api/tasks/${existing.id}`,
          withConfirm ? { ...payload, confirm: true } : payload);
        boardTasks = boardTasks.map((x) => (x.id === existing.id ? task : x));
        if (task.next_instance) {
          toast(`🔁 Next “${task.next_instance.title}” created — due ${fmtDate(task.next_instance.dueMs)}`);
        }
        return task;
      };
      if (existing) {
        if (d.status === "done" && existing.status !== "done" && !checkPrereqsDone(existing)) return;
        try {
          await saveOnce(false);
        } catch (e) {
          if (e && e.status === 409 && e.data && e.data.needs_confirm) {
            const names = (e.data.blockers || []).map((b) => `“${b && b.title ? b.title : b}”`).join(", ");
            if (!confirm(`“${d.title}” is blocked by ${names}.\n\nSave as done anyway?`)) return;
            try { await saveOnce(true); }
            catch (e2) { toast(e2.message, true); return; }
          } else { toast(e.message, true); return; }
        }
      } else {
        const { task } = await POST(`/api/projects/${pid}/tasks`, payload);
        boardTasks.push(task);
      }
      close();
      toast(existing ? "Task updated in Anytype" : "Task created in Anytype");
      await refreshTasks(pid);
      const p = await GET(`/api/projects/${pid}`).catch(() => null);
      if (p) setTitle(p.project.name, `${p.tasks.filter((x) => x.status === "done").length}/${p.tasks.length} tasks complete`);
    }, existing ? "Save changes" : "Create task");
  const del = $("#m-delete");
  const root = $("#modal-root");
  const ti0 = root.querySelector('[name="title"]');
  if (ti0 && ti0.addEventListener) ti0.addEventListener("input", () => {
    const w = $("#m-est-wrap");
    if (w) w.innerHTML = estChipFor({ title: ti0.value, estimate_min: parseEstInput(root.querySelector('[name="estimate_min"]')?.value) });
  });
  const estIn = root.querySelector('[name="estimate_min"]');
  if (estIn && estIn.addEventListener) estIn.addEventListener("input", () => {
    const w = $("#m-est-wrap");
    if (w && ti0) w.innerHTML = estChipFor({ title: ti0.value, estimate_min: parseEstInput(estIn.value) });
  });
  const recSel = root.querySelector('[name="recurrence"]');
  if (recSel) recSel.onchange = () => {
    const w = $("#m-wdwrap");
    if (w) w.style.display = recSel.value === "weekly" ? "" : "none";
  };
  /* --- blockers (immediate PATCH; modal re-opens fresh) --- */
  const drawBlockers = () => {
    const box = $("#m-blockers");
    if (!box || !existing) return;
    const bs = existing.blockers || [];
    box.innerHTML = bs.length ? bs.map((b) => `
      <div class="prereq-row">
        <span class="${b.status === "done" ? "tt-title done" : ""}">${esc(b.title)} <span class="badge badge-secondary">${esc(colName(b.status))}</span></span>
        <button class="btn btn-ghost btn-sm" data-unblock="${esc(b.id)}">Remove</button>
      </div>`).join("")
      : `<div style="font-size:12px;color:var(--muted-foreground);margin-bottom:6px">No blockers — this task can be completed freely.</div>`;
    $$("#m-blockers [data-unblock]").forEach((btn) => {
      btn.onclick = async () => {
        try {
          await PATCH(`/api/tasks/${existing.id}`, {
            blocked_by: (existing.blocked_by || []).filter((id) => id !== btn.dataset.unblock),
          });
          await refreshTasks(pid);
          taskModal(pid, boardTasks.find((x) => x.id === existing.id) || existing);
        } catch (e) { toast(e.message, true); }
      };
    });
  };
  drawBlockers();
  const blockAdd = $("#m-block-add");
  if (blockAdd) blockAdd.onclick = () => {
    crossProjectTaskPicker("“" + existing.title + "” is blocked by…",
      [existing.id, ...(existing.blocked_by || [])],
      async (pick) => {
        if (!pick) return;
        try {
          await PATCH(`/api/tasks/${existing.id}`, { blocked_by: [...(existing.blocked_by || []), pick.id] });
          await refreshTasks(pid);
          taskModal(pid, boardTasks.find((x) => x.id === existing.id) || existing);
          toast(`Blocked by “${pick.title}”`);
        } catch (e) { toast(e.message, true); }
      });
  };
  /* --- subtasks (local state; saved with the form) --- */
  const drawSubtasks = () => {
    const box = $("#m-subtasks");
    const cnt = $("#m-st-count");
    if (!box) return;
    const done = mst.filter((s) => s.done).length;
    if (cnt) cnt.textContent = mst.length ? `${done}/${mst.length}` : "";
    box.innerHTML = mst.length ? mst.map((s) => `
      <div class="st-row">
        <div class="checkbox st-check ${s.done ? "on" : ""}" data-stcheck="${esc(s.id)}">${s.done ? "✓" : ""}</div>
        <span class="st-title ${s.done ? "done" : ""}" data-sttitle="${esc(s.id)}" title="Click to rename">${esc(s.title)}</span>
        <button class="btn btn-ghost btn-icon btn-sm" data-stdel="${esc(s.id)}" title="Delete subtask">✕</button>
      </div>`).join("")
      : `<div class="st-empty">No subtasks yet — break it down.</div>`;
    $$("#m-subtasks [data-stcheck]").forEach((el) => {
      el.onclick = () => {
        const s = mst.find((x) => x.id === el.dataset.stcheck);
        if (!s) return;
        s.done = !s.done;
        drawSubtasks();
        // All subtasks complete: suggest (never force) completing the parent.
        if (mst.length && mst.every((x) => x.done)) {
          const sel = root.querySelector('[name="status"]');
          if (sel && sel.value !== "done" && confirm("All subtasks are complete.\n\nMark the task itself done?")) {
            sel.value = "done";
          }
        }
      };
    });
    $$("#m-subtasks [data-sttitle]").forEach((el) => {
      el.onclick = () => {
        const s = mst.find((x) => x.id === el.dataset.sttitle);
        if (!s || el.querySelector("input")) return;
        el.innerHTML = `<input class="st-edit" value="${esc(s.title)}">`;
        const inp = el.querySelector("input");
        inp.focus(); inp.select();
        let done = false;
        const finish = (save) => {
          if (done) return; done = true;
          if (save && inp.value.trim()) s.title = inp.value.trim().slice(0, 200);
          drawSubtasks();
        };
        inp.onkeydown = (e) => { e.stopPropagation(); if (e.key === "Enter") finish(true); else if (e.key === "Escape") finish(false); };
        inp.onblur = () => finish(true);
      };
    });
    $$("#m-subtasks [data-stdel]").forEach((el) => {
      el.onclick = () => { mst = mst.filter((x) => x.id !== el.dataset.stdel); drawSubtasks(); };
    });
  };
  drawSubtasks();
  const stAdd = $("#m-st-add");
  if (stAdd) stAdd.onclick = () => {
    const inp = $("#m-st-new");
    const v = inp.value.trim().slice(0, 200);
    if (!v) return;
    mst.push({ id: `st${Date.now().toString(36)}${Math.floor(Math.random() * 1e6)}`, title: v, done: false });
    inp.value = "";
    drawSubtasks();
    inp.focus();
  };
  const stNew = $("#m-st-new");
  if (stNew) stNew.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); stAdd.onclick(); }
  });
  if (del) del.onclick = async () => {
    if (!confirm(`Delete “${existing.title}”?`)) return;
    try {
      await DEL(`/api/tasks/${existing.id}`);
      $("#modal-root").innerHTML = "";
      toast("Task deleted");
      await refreshTasks(pid);
    } catch (e) { toast(e.message, true); }
  };
  const nestBtn = $("#m-nest");
  if (nestBtn) nestBtn.onclick = () => nestPicker(existing.id, () => taskModal(pid, boardTasks.find((x) => x.id === existing.id) || existing));
  $$("#modal-root [data-unnest]").forEach((b) => {
    b.onclick = async () => {
      try {
        await PATCH(`/api/tasks/${b.dataset.unnest}/parent`, { parent_id: null });
        await refreshTasks(pid);
        taskModal(pid, boardTasks.find((x) => x.id === existing.id));
      } catch (e) { toast(e.message, true); }
    };
  });
}

/* ---------- table view: colorful spreadsheet + nested prerequisites ---------- */
let tblSort = { key: "due", dir: "asc" };
let tblQuery = "";
let tblCollapsed = new Set();
let tblTreeCache = null;

function tblLoadCollapsed(pid) {
  try { tblCollapsed = new Set(Object.keys(JSON.parse(localStorage.getItem("ascent-table-collapse:" + pid) || "{}"))); }
  catch (e) { tblCollapsed = new Set(); }
}
function tblSaveCollapsed(pid) {
  try { localStorage.setItem("ascent-table-collapse:" + pid, JSON.stringify(Object.fromEntries([...tblCollapsed].map((x) => [x, 1])))); } catch (e) {}
}

/* Shared prerequisite helpers (kanban + table both use these). */
function taskChildren(tid) { return boardTasks.filter((x) => x.parent_id === tid); }
function checkPrereqsDone(t) {
  const kids = taskChildren(t.id).filter((x) => x.status !== "done");
  if (!kids.length) return true;
  const names = kids.slice(0, 3).map((k) => `“${k.title}”`).join(", ") + (kids.length > 3 ? ", …" : "");
  return confirm(`${kids.length} prerequisite${kids.length === 1 ? "" : "s"} still incomplete: ${names}\n\nMark “${t.title}” done anyway?`);
}
async function refreshTasks(pid) {
  try { boardTasks = (await GET(`/api/projects/${pid}/tasks`)).tasks; } catch (e) { toast(e.message, true); return; }
  if ($("#board")) renderBoard();
  if ($("#tt-body")) { tblTreeCache = buildTaskTree(boardTasks); drawRows(); }
}

function buildTaskTree(tasks) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const children = new Map();
  const roots = [];
  for (const t of tasks) {
    const p = t.parent_id && byId.has(t.parent_id) ? t.parent_id : null;
    if (p) { if (!children.has(p)) children.set(p, []); children.get(p).push(t); }
    else roots.push(t);
  }
  const depth = new Map();
  const walk = (list, d) => {
    for (const t of list) { depth.set(t.id, d); const c = children.get(t.id); if (c) walk(c, d + 1); }
  };
  walk(roots, 0);
  return { byId, children, roots, depth };
}

const STATUS_RANK = { backlog: 0, in_progress: 1, review: 2, done: 3 };
function tblCmp(a, b) {
  const { key, dir } = tblSort;
  let r = 0;
  if (key === "title") r = String(a.title).localeCompare(String(b.title));
  else if (key === "status") r = ((STATUS_RANK[a.status] ?? 9) - (STATUS_RANK[b.status] ?? 9)) || String(a.title).localeCompare(String(b.title));
  else r = ((a.dueMs || Infinity) - (b.dueMs || Infinity)) || String(a.title).localeCompare(String(b.title));
  return dir === "desc" ? -r : r;
}

function statusPill(s) {
  return `<span class="st-pill st-${esc(s)}" title="Click to change status">${esc(colName(s))}</span>`;
}
function tblDueCell(t) {
  if (!t.dueMs) return `<span class="tt-due-empty">—</span>`;
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const cls = t.status === "done" ? "tt-due-done"
    : t.dueMs < start.getTime() ? "tt-due-overdue"
    : t.dueMs < start.getTime() + 86400000 ? "tt-due-today" : "tt-due-future";
  return `<span class="${cls}">${esc(fmtDate(t.dueMs))}</span>`;
}

function tblRowHtml(t, d) {
  const hasKids = (t.child_count || 0) > 0;
  const open = !tblCollapsed.has(t.id);
  const chev = hasKids
    ? `<button class="tt-chev" data-chev="${esc(t.id)}" title="${open ? "Collapse prerequisites" : "Expand prerequisites"}">${open ? "▾" : "▸"}</button>`
    : `<span class="tt-chev-sp"></span>`;
  return `<tr data-row="${esc(t.id)}">
    <td class="tt-handle-cell"><span class="tt-handle" data-handle="${esc(t.id)}" title="Drag onto another task to nest as prerequisite">⋮⋮</span></td>
    <td data-act="title" style="padding-left:${10 + d * 22}px">${chev}<span class="tt-title ${t.status === "done" ? "done" : ""}">${esc(t.title)}</span>${t.child_count ? ` <span class="badge badge-secondary tt-kids">▸ ${t.child_count}</span>` : ""}</td>
    <td data-act="status">${statusPill(t.status)}</td>
    <td data-act="due">${tblDueCell(t)}</td>
    <td>${t.source === "imported" ? `<span class="badge badge-outline">imported</span>` : ""}</td>
    <td class="tt-notes" title="${esc(t.notes || "")}">${esc((t.notes || "").slice(0, 90))}</td>
    <td class="tt-menu-cell"><button class="btn btn-ghost btn-icon tt-menu-btn" data-menu="${esc(t.id)}" title="Row actions">⋯</button></td>
  </tr>`;
}

function toggleTblCollapse(tid) {
  if (tblCollapsed.has(tid)) tblCollapsed.delete(tid); else tblCollapsed.add(tid);
}
function drawRows() {
  const tbody = $("#tt-body");
  if (!tbody || !tblTreeCache) return;
  const { children, roots, depth } = tblTreeCache;
  let rows;
  if (tblQuery) {
    const q = tblQuery.toLowerCase();
    rows = boardTasks
      .filter((t) => String(t.title).toLowerCase().includes(q) || String(t.notes || "").toLowerCase().includes(q))
      .slice().sort(tblCmp).map((t) => ({ t, d: depth.get(t.id) || 0 }));
  } else {
    const ch = new Map();
    for (const [k, v] of children) ch.set(k, v.slice().sort(tblCmp));
    rows = [];
    const walk = (list, d) => {
      for (const t of list) {
        rows.push({ t, d });
        const c = ch.get(t.id);
        if (c && !tblCollapsed.has(t.id)) walk(c, d + 1);
      }
    };
    walk(roots.slice().sort(tblCmp), 0);
  }
  tbody.innerHTML = rows.length
    ? rows.map(({ t, d }) => tblRowHtml(t, d)).join("")
    : `<tr><td colspan="7"><div class="empty" style="padding:24px">No tasks match.</div></td></tr>`;
  const cnt = $("#tt-count");
  if (cnt) cnt.textContent = `${rows.length} of ${boardTasks.length} shown`;
  $$("#tab-body th[data-sort]").forEach((th) => {
    const k = th.dataset.sort;
    const base = th.textContent.replace(/ [▲▼]$/, "");
    th.textContent = base + (tblSort.key === k ? (tblSort.dir === "asc" ? " ▲" : " ▼") : "");
    th.classList.toggle("sorted", tblSort.key === k);
  });
}

function renderTable() {
  const pid = currentPid();
  tblLoadCollapsed(pid);
  tblTreeCache = buildTaskTree(boardTasks);
  const body = $("#tab-body");
  body.innerHTML = `
    <div class="tt-toolbar">
      <input id="tt-search" class="tt-search" placeholder="Filter ${boardTasks.length} tasks…" value="${esc(tblQuery)}" autocomplete="off">
      <span class="tt-count" id="tt-count"></span>
    </div>
    <div class="tt-unnest-zone" id="tt-unnest">⤴ Drop here to move to top level</div>
    <div class="card tt-wrap">
      <table class="ttable">
        <thead><tr>
          <th style="width:30px" title="Drag handle"></th>
          <th data-sort="title">Task</th>
          <th data-sort="status">Status</th>
          <th data-sort="due">Due</th>
          <th>Source</th>
          <th>Notes</th>
          <th style="width:44px"></th>
        </tr></thead>
        <tbody id="tt-body"></tbody>
      </table>
    </div>`;
  drawRows();
  const search = $("#tt-search");
  search.oninput = () => { tblQuery = search.value; drawRows(); };
  $$("#tab-body th[data-sort]").forEach((th) => {
    th.onclick = () => {
      const k = th.dataset.sort;
      if (tblSort.key === k) tblSort.dir = tblSort.dir === "asc" ? "desc" : "asc";
      else tblSort = { key: k, dir: "asc" };
      drawRows();
    };
  });
  $("#tt-body").addEventListener("click", (e) => {    const chev = e.target.closest("[data-chev]");
    if (chev) {
      toggleTblCollapse(chev.dataset.chev);
      tblSaveCollapsed(pid);
      drawRows();
      return;
    }
    const menuBtn = e.target.closest("[data-menu]");
    if (menuBtn) { openRowMenu(menuBtn); return; }
    const tr = e.target.closest("tr[data-row]");
    if (!tr || e.target.closest(".tt-edit, select, input")) return;
    const t = boardTasks.find((x) => x.id === tr.dataset.row);
    if (!t) return;
    const td = e.target.closest("td[data-act]");
    if (!td) return;
    const act = td.dataset.act;
    if (act === "title") editTitleInline(td, t);
    else if (act === "status") editStatusInline(td, t);
    else if (act === "due") editDueInline(td, t);
  });
  /* Pointer-based drag-and-drop nesting: native HTML5 drag on <tr> is
     unreliable in Chrome (mousedown+move selects text instead of starting
     the drag), so dragging starts from the ⋮⋮ handle cell and is tracked
     with pointer events. Plain clicks still hit the click handler above. */
  const tbody = $("#tt-body");
  tbody.addEventListener("pointerdown", tblPtrDown);
  if (!tblDocPtrWired) {
    tblDocPtrWired = true;
    document.addEventListener("pointermove", tblPtrMove);
    document.addEventListener("pointerup", tblPtrUp);
    document.addEventListener("pointercancel", tblPtrUp);
    document.addEventListener("keydown", tblPtrKey);
  }
}

/* Inline editors (event-delegated; Enter saves, Esc cancels). */
function editTitleInline(td, t) {
  if (td.querySelector(".tt-edit")) return;
  const old = t.title;
  td.innerHTML = `<input class="tt-edit" value="${esc(old)}">`;
  const inp = td.querySelector("input");
  inp.focus(); inp.select();
  let done = false;
  const finish = async (save) => {
    if (done) return; done = true;
    const val = inp.value.trim();
    if (save && val && val !== old) {
      try {
        const { task } = await PATCH(`/api/tasks/${t.id}`, { title: val });
        boardTasks = boardTasks.map((x) => (x.id === t.id ? task : x));
        tblTreeCache = buildTaskTree(boardTasks);
      } catch (e) { toast(e.message, true); }
    }
    drawRows();
  };
  inp.onkeydown = (e) => {
    e.stopPropagation();
    if (e.key === "Enter") finish(true);
    else if (e.key === "Escape") finish(false);
  };
  inp.onblur = () => finish(true);
}
function editStatusInline(td, t) {
  if (td.querySelector("select")) return;
  const old = t.status;
  const sel = document.createElement("select");
  sel.className = "tt-edit";
  sel.innerHTML = COLUMNS.map(([v, l]) => `<option value="${v}" ${v === old ? "selected" : ""}>${esc(l)}</option>`).join("");
  td.innerHTML = "";
  td.appendChild(sel);
  sel.focus();
  let done = false;
  const finish = async (save) => {
    if (done) return; done = true;
    const val = sel.value;
    if (save && val !== old) {
      if (val === "done" && !checkPrereqsDone(t)) { drawRows(); return; }
      try {
        const { task } = await PATCH(`/api/tasks/${t.id}`, { status: val });
        boardTasks = boardTasks.map((x) => (x.id === t.id ? task : x));
        tblTreeCache = buildTaskTree(boardTasks);
      } catch (e) { toast(e.message, true); }
    }
    drawRows();
  };
  sel.onkeydown = (e) => { e.stopPropagation(); if (e.key === "Escape") finish(false); };
  sel.onchange = () => finish(true);
  sel.onblur = () => finish(false);
}
function editDueInline(td, t) {
  if (td.querySelector("input")) return;
  const inp = document.createElement("input");
  inp.type = "date";
  inp.className = "tt-edit";
  inp.value = isoDate(t.dueMs);
  td.innerHTML = "";
  td.appendChild(inp);
  inp.focus();
  let done = false;
  const finish = async (save) => {
    if (done) return; done = true;
    const val = inp.value;
    if (save && val !== isoDate(t.dueMs)) {
      try {
        const { task } = await PATCH(`/api/tasks/${t.id}`, { due_date: val });
        boardTasks = boardTasks.map((x) => (x.id === t.id ? task : x));
        tblTreeCache = buildTaskTree(boardTasks);
      } catch (e) { toast(e.message, true); }
    }
    drawRows();
  };
  inp.onkeydown = (e) => { e.stopPropagation(); if (e.key === "Enter") finish(true); else if (e.key === "Escape") finish(false); };
  inp.onblur = () => finish(true);
}

/* Row actions menu + nest picker. */
function closeRowMenu() { const m = $(".tt-menu"); if (m) m.remove(); }
function openRowMenu(btn) {
  const wasOpen = !!btn.parentElement.querySelector(".tt-menu");
  closeRowMenu();
  if (wasOpen) return;
  const tid = btn.dataset.menu;
  const t = boardTasks.find((x) => x.id === tid);
  if (!t) return;
  const div = document.createElement("div");
  div.className = "tt-menu";
  div.innerHTML = `
    <button data-m="nest">Nest under…</button>
    ${t.parent_id ? `<button data-m="unnest">Remove from parent</button>` : ""}
    <button data-m="detail">Open details</button>`;
  btn.parentElement.style.position = "relative";
  btn.parentElement.appendChild(div);
  div.onclick = async (e) => {
    const m = e.target.closest("[data-m]") && e.target.closest("[data-m]").dataset.m;
    closeRowMenu();
    if (!m) return;
    if (m === "nest") nestPicker(tid);
    else if (m === "unnest") {
      try { await PATCH(`/api/tasks/${tid}/parent`, { parent_id: null }); await refreshTasks(currentPid()); toast("Removed from parent"); }
      catch (err) { toast(err.message, true); }
    } else if (m === "detail") taskModal(currentPid(), boardTasks.find((x) => x.id === tid));
  };
  setTimeout(() => document.addEventListener("click", closeRowMenu, { once: true }), 0);
}
/* IDs that task `tid` may not be nested under: itself, its descendants,
   and its ancestors — any of those would create a cycle. */
function prereqBannedIds(tid) {
  const banned = new Set([tid]);
  const stack = [tid];
  while (stack.length) {
    const cur = stack.pop();
    for (const x of boardTasks) {
      if (x.parent_id === cur && !banned.has(x.id)) { banned.add(x.id); stack.push(x.id); }
    }
  }
  let cur = (boardTasks.find((x) => x.id === tid) || {}).parent_id;
  while (cur) { banned.add(cur); const p = boardTasks.find((x) => x.id === cur); cur = p ? p.parent_id : null; }
  return banned;
}
function nestPicker(tid, onDone) {
  const t = boardTasks.find((x) => x.id === tid);
  if (!t) return;
  // Banned from candidacy: self, descendants, and ancestors (all would cycle).
  const banned = prereqBannedIds(tid);
  const root = $("#modal-root");
  root.innerHTML = `
    <div class="dialog-overlay" id="ovl"><div class="dialog-content" role="dialog" aria-modal="true">
      <h2 class="dialog-title">Nest “${esc(t.title)}” under…</h2>
      <input id="pk-search" placeholder="Filter tasks…" autocomplete="off" style="margin-bottom:10px">
      <div id="pk-list" style="max-height:40vh;overflow:auto"></div>
      <div class="dialog-footer"><button class="btn btn-ghost" id="m-cancel">Cancel</button></div>
    </div></div>`;
  const close = () => { root.innerHTML = ""; };
  $("#m-cancel").onclick = close;
  $("#ovl").addEventListener("mousedown", (e) => { if (e.target.id === "ovl") close(); });
  const draw = () => {
    const q = ($("#pk-search").value || "").toLowerCase();
    const cands = boardTasks.filter((x) => !banned.has(x.id) && String(x.title).toLowerCase().includes(q));
    $("#pk-list").innerHTML = cands.length ? cands.map((x) => `
      <button class="import-row" data-pk="${esc(x.id)}" style="width:100%;text-align:left;cursor:pointer;background:none;border:none;color:inherit;font:inherit">
        <span>${esc(x.title)}</span> <span class="badge badge-secondary">${esc(colName(x.status))}</span>
      </button>`).join("") : `<div class="empty" style="padding:16px">No eligible tasks.</div>`;
    $$("#pk-list [data-pk]").forEach((el) => {
      el.onclick = async () => {
        try {
          await PATCH(`/api/tasks/${tid}/parent`, { parent_id: el.dataset.pk });
          close();
          await refreshTasks(currentPid());
          toast("Task nested");
          if (onDone) onDone();
        } catch (e) { toast(e.message, true); }
      };
    });
  };
  $("#pk-search").oninput = draw;
  draw();
  setTimeout(() => $("#pk-search").focus(), 60);
}

/* ---------- table drag-and-drop nesting ---------- */
/* Pointer-based: native HTML5 drag on <tr> is unreliable in Chrome
   (mousedown+move selects text instead of starting the drag), so the drag
   starts on the ⋮⋮ handle cell and is tracked with pointer events. */
let tblDragId = null;
let tblPtr = null;        // pending press: { id, x0, y0 }
let tblDragging = false;
let tblGhost = null;
let tblHoverId = null;    // row id currently under the pointer while dragging
let tblHoverZone = false; // unnest zone currently under the pointer
let tblDocPtrWired = false;

/* Why is this drop rejected? "self" | "desc" | "anc" | null */
function tblNestRejectReason(tid, targetId) {
  if (targetId === tid) return "self";
  const seen = new Set([tid]);
  const stack = [tid];
  while (stack.length) {
    const cur = stack.pop();
    for (const x of boardTasks) {
      if (x.parent_id === cur && !seen.has(x.id)) {
        if (x.id === targetId) return "desc";
        seen.add(x.id); stack.push(x.id);
      }
    }
  }
  let cur = (boardTasks.find((x) => x.id === tid) || {}).parent_id;
  while (cur) {
    if (cur === targetId) return "anc";
    const p = boardTasks.find((x) => x.id === cur);
    cur = p ? p.parent_id : null;
  }
  return null;
}

function tblPtrDown(e) {
  const h = e.target && e.target.closest ? e.target.closest("[data-handle]") : null;
  if (!h || (e.button !== undefined && e.button !== 0)) return;
  tblPtr = { id: h.dataset.handle, x0: e.clientX, y0: e.clientY };
}

function tblBeginDrag() {
  tblDragging = true;
  tblDragId = tblPtr.id;
  document.body.classList.add("tt-nodrag");
  const sel = (typeof CSS !== "undefined" && CSS.escape) ? CSS.escape(tblDragId) : tblDragId;
  const tr = document.querySelector(`#tt-body tr[data-row="${sel}"]`);
  if (tr) tr.classList.add("tt-dragging");
  const zone = $("#tt-unnest");
  if (zone) zone.classList.add("show");
  const g = document.createElement("div");
  g.className = "tt-drag-ghost";
  const t = boardTasks.find((x) => x.id === tblDragId);
  g.textContent = t ? t.title : "";
  document.body.appendChild(g);
  tblGhost = g;
}

function tblClearHover() {
  $$("#tt-body tr.tt-drop-ok, #tt-body tr.tt-drop-bad")
    .forEach((tr) => tr.classList.remove("tt-drop-ok", "tt-drop-bad"));
  const zone = $("#tt-unnest");
  if (zone) zone.classList.remove("tt-drop-ok");
  tblHoverId = null; tblHoverZone = false;
}

function tblPtrMove(e) {
  if (!tblPtr) return;
  if (!tblDragging) {
    if (Math.hypot(e.clientX - tblPtr.x0, e.clientY - tblPtr.y0) < 6) return;
    tblBeginDrag();
  }
  if (e.cancelable) e.preventDefault();
  if (tblGhost) {
    tblGhost.style.left = (e.clientX + 12) + "px";
    tblGhost.style.top = (e.clientY + 14) + "px";
  }
  const el = document.elementFromPoint ? document.elementFromPoint(e.clientX, e.clientY) : null;
  const tr = el && el.closest ? el.closest("#tt-body tr[data-row]") : null;
  const zone = !tr && el && el.closest ? el.closest("#tt-unnest") : null;
  tblClearHover();
  if (tr) {
    const ok = !tblNestRejectReason(tblDragId, tr.dataset.row);
    tr.classList.toggle("tt-drop-ok", ok);
    tr.classList.toggle("tt-drop-bad", !ok);
    tblHoverId = tr.dataset.row;
  } else if (zone) {
    zone.classList.add("tt-drop-ok");
    tblHoverZone = true;
  }
}

function tblPtrUp(e) {
  if (!tblPtr) return;
  const wasDrag = tblDragging;
  const dragId = tblDragId, targetId = tblHoverId, toZone = tblHoverZone;
  tblPtr = null; tblDragging = false;
  tblDragEnd();
  if (!wasDrag) return; // plain click on the handle — nothing to do
  if (toZone) { moveTaskNesting(dragId, null); return; }
  if (!targetId) return;
  const reason = tblNestRejectReason(dragId, targetId);
  if (reason) {
    toast(reason === "anc" ? "That would create a cycle" : "Can't nest a task inside itself or its own subtasks", true);
    return;
  }
  moveTaskNesting(dragId, targetId);
}

function tblPtrKey(e) {
  if (e && e.key === "Escape" && tblDragging) {
    tblPtr = null; tblDragging = false;
    tblDragEnd();
  }
}

function tblDragEnd() {
  tblDragId = null;
  $$("#tt-body tr.tt-dragging, #tt-body tr.tt-drop-ok, #tt-body tr.tt-drop-bad")
    .forEach((tr) => tr.classList.remove("tt-dragging", "tt-drop-ok", "tt-drop-bad"));
  const zone = $("#tt-unnest");
  if (zone) zone.classList.remove("show", "tt-drop-ok");
  if (tblGhost) { tblGhost.remove(); tblGhost = null; }
  if (document.body) document.body.classList.remove("tt-nodrag");
  tblClearHover();
}

async function moveTaskNesting(tid, parentId) {
  try {
    await PATCH(`/api/tasks/${tid}/parent`, { parent_id: parentId });
    await refreshTasks(currentPid());
    if (parentId) {
      const p = boardTasks.find((x) => x.id === parentId);
      toast(`Moved under “${p ? p.title : "task"}”`);
    } else {
      toast("Moved to top level");
    }
  } catch (e) {
    toast(e.message, true);
    await refreshTasks(currentPid()); // revert to server truth
  }
}

/* (Drop handling now lives in tblPtrUp via elementFromPoint — the unnest
   zone is highlighted and activated while a pointer drag is over it.) */

/* Prerequisites section inside the task detail modal. */
function prereqBoxHtml(t) {
  const kids = taskChildren(t.id);
  return `<div class="prereq-box">
    <div style="font-weight:600;margin-bottom:6px">Prerequisites (${kids.length})</div>
    ${kids.length ? kids.map((k) => `
      <div class="prereq-row">
        <span class="${k.status === "done" ? "tt-title done" : ""}">${esc(k.title)} <span class="badge badge-secondary">${esc(colName(k.status))}</span></span>
        <button class="btn btn-ghost btn-sm" data-unnest="${esc(k.id)}">Remove</button>
      </div>`).join("") : `<div style="font-size:12px;color:var(--muted-foreground);margin-bottom:6px">No prerequisites yet — this task stands alone.</div>`}
    <button class="btn btn-outline btn-sm" id="m-nest" style="margin-top:8px">Nest this task under…</button>
  </div>`;
}

/* ---------- router ---------- */
async function route() {
  closeDrawer();
  const h = location.hash || "#/myday";
  const st = await GET("/api/status").catch(() => ({ paired: false, has_space: false }));
  if ((!st.paired || !st.has_space) && h !== "#/setup") { location.hash = "#/setup"; return; }
  const psm = h.match(/^#\/sprints\/([^/]+)$/);
  const pm = h.match(/^#\/projects\/([^/]+)$/);
  const pw = h.match(/^#\/projects\/([^/]+)\/wiki$/);
  const ptable = h.match(/^#\/projects\/([^/]+)\/table$/);
  try {
    if (h === "#/setup") await vSetup();
    else if (h === "#/myday") await vMyDay();
    else if (h === "#/overview") await vOverview();
    else if (h === "#/projects") await vProjects();
    else if (h === "#/sprints") await vSprints();
    else if (psm) await vSprintDetail(decodeURIComponent(psm[1]));
    else if (pw) { _pid = pw[1]; await vProjectDetail(pw[1], "wiki"); }
    else if (ptable) { _pid = ptable[1]; await vProjectDetail(ptable[1], "table"); }
    else if (pm) { _pid = pm[1]; await vProjectDetail(pm[1]); }
    else location.hash = "#/myday";
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
  window.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key && e.key.toLowerCase() === "k") {
      e.preventDefault();
      if ($("#cmdk-root")) cmdkClose(); else openCmdK();
    }
  });
}
const quickAddBtn = $("#quick-add-btn");
if (quickAddBtn) quickAddBtn.onclick = () => quickAddModal();
const cmdkBtn = $("#cmdk-btn");
if (cmdkBtn) cmdkBtn.onclick = () => openCmdK();
initTheme();
route();

// test seam
globalThis.__test = { taskCard, duePill, fmtDate, COLUMNS, md, vOverview, vProjects, vProjectDetail, vSetup, renderSetup, renderWikiList, renderWikiPane, selectArticle, openModal, projectModal, taskModal, importModal, initTheme, toggleTheme, paintThemeToggle, route, openDrawer, closeDrawer, toggleDrawer, isDrawerOpen, renderBoard, projectRemainingEst, projectEstRaw, estSizeForMins, timeHealthWidget, fetchProjectTasks, Estimate, cuTabOf: () => cuTab, cuState: () => cu, cuInit, cuShowTab, cuShowPane, cuPaneHtml, cuConnect, cuDisconnect, cuLoadTeams, cuOpen, cuCrumb, clickupImportSelected, cuLinkList, cuProjectIdOf: () => cuProjectId, syncNow, syncReportText, fmtSyncTime, emTabOf: () => emTab, emState: () => em, emInit, emShowTab, emShowPane, emPaneHtml, emConnect, emDisconnect, emLoadStarred, emailImportSelected,
  renderTable, drawRows, tblRowHtml, buildTaskTree, tblCmp, statusPill, tblDueCell, toggleTblCollapse,
  tblState: () => ({ sort: tblSort, query: tblQuery, collapsed: tblCollapsed }),
  tblSet: (s) => { if (s.sort) tblSort = s.sort; if (s.query !== undefined) tblQuery = s.query; if (s.collapsed) tblCollapsed = s.collapsed; },
  taskChildren, checkPrereqsDone, refreshTasks, nestPicker, openRowMenu, prereqBoxHtml,
  vMyDay, vSprints, vSprintDetail, sprintModal, sprintStats, mydayRowHtml, openTaskInProject,
  mydayFoldToggle, mydayExpandedOf: () => mydayExpanded, MYDAY_FOLD_AFTER,
  openCmdK, cmdkClose, cmdkSearch, cmdkRender, cmdkMove, cmdkActivate,
  cmdkState: () => ({ items: cmdkItems, sel: cmdkSel }),
  quickAddModal, taskMinutes, parseEstInput, estChipFor, blockedBadge, recurrenceBadge, subtaskBadge,
  shakeCard, readRecurrence, blockerBoxHtml, recurrenceBoxHtml, subtaskBoxHtml, crossProjectTaskPicker,
  setTaskDone,
  tblSaveCollapsed, tblLoadCollapsed,
  prereqBannedIds, tblNestRejectReason, moveTaskNesting,
  tblPtrDown, tblPtrMove, tblPtrUp, tblPtrKey, tblDragEnd, tblDragIdOf: () => tblDragId,
  setBoardTasks: (t) => { boardTasks = t; }, boardTasksOf: () => boardTasks,
  setPid: (p) => { _pid = p; } };
