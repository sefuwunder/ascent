// Ascent — ClickUp API v2 client (import + two-way sync: ClickUp ⇄ Ascent).
// Every call is proxied through the Ascent server; the user's Personal API
// token lives only in the gitignored server-side store and is never sent
// to the browser, never logged, and never appears in any GET response.

export const CLICKUP_BASE = "https://api.clickup.com/api/v2";

export class ClickUpError extends Error {
  status: number;
  constructor(status: number, msg: string) {
    super(msg);
    this.status = status;
  }
}

export interface CuIdName {
  id: string;
  name: string;
}
export interface CuTask extends CuIdName {
  status: string;
  statusType: string;
  dueDate: string | null; // epoch-ms string, as ClickUp returns it
  priority: string | null;
  description: string;
  /** ClickUp `date_updated` as epoch-ms (0 when the API omits it). */
  updatedMs: number;
}

/** A list's workflow status as ClickUp reports it. */
export interface CuStatus {
  id: string;
  name: string;
  /** "open" | "closed" (ClickUp occasionally uses other labels). */
  type: string;
}

export async function cuFetch(token: string, path: string): Promise<any> {
  let res: Response;
  try {
    res = await fetch(CLICKUP_BASE + path, {
      headers: {
        Authorization: token,
        "User-Agent": "ascent-clickup-import/1.0",
      },
    });
  } catch {
    throw new ClickUpError(0, "ClickUp not reachable — check your connection");
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg =
      (body as any)?.err || (body as any)?.error || (body as any)?.message || `ClickUp HTTP ${res.status}`;
    throw new ClickUpError(res.status, String(msg));
  }
  return body;
}

/** POST/PUT helper for the write half of two-way sync. */
async function cuSend(token: string, path: string, method: "POST" | "PUT", body: any): Promise<any> {
  let res: Response;
  try {
    res = await fetch(CLICKUP_BASE + path, {
      method,
      headers: {
        Authorization: token,
        "Content-Type": "application/json",
        "User-Agent": "ascent-clickup-sync/1.0",
      },
      body: JSON.stringify(body),
    });
  } catch {
    throw new ClickUpError(0, "ClickUp not reachable — check your connection");
  }
  const jb = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg =
      (jb as any)?.err || (jb as any)?.error || (jb as any)?.message || `ClickUp HTTP ${res.status}`;
    throw new ClickUpError(res.status, String(msg));
  }
  return jb;
}

function arr(j: any, key: string): any[] {
  if (Array.isArray(j)) return j;
  if (j && Array.isArray(j[key])) return j[key];
  return [];
}

function mapIdName(items: any[]): CuIdName[] {
  return items.map((x) => ({
    id: String(x.id),
    name: String(x.name ?? "Untitled"),
  }));
}

export async function validateToken(token: string): Promise<CuIdName[]> {
  return mapIdName(arr(await cuFetch(token, "/team"), "teams"));
}

export async function getTeams(token: string): Promise<CuIdName[]> {
  return mapIdName(arr(await cuFetch(token, "/team"), "teams"));
}

export async function getSpaces(token: string, teamId: string): Promise<CuIdName[]> {
  return mapIdName(arr(await cuFetch(token, `/team/${teamId}/space`), "spaces"));
}

export async function getFolders(token: string, spaceId: string): Promise<CuIdName[]> {
  return mapIdName(arr(await cuFetch(token, `/space/${spaceId}/folder`), "folders"));
}

export async function getSpaceLists(token: string, spaceId: string): Promise<CuIdName[]> {
  return mapIdName(arr(await cuFetch(token, `/space/${spaceId}/list`), "lists"));
}

export async function getFolderLists(token: string, folderId: string): Promise<CuIdName[]> {
  return mapIdName(arr(await cuFetch(token, `/folder/${folderId}/list`), "lists"));
}

export function mapTask(t: any): CuTask {
  const n = Number(t?.date_updated);
  return {
    id: String(t.id),
    name: String(t.name ?? "Untitled task"),
    status: String(t.status?.status ?? ""),
    statusType: String(t.status?.type ?? "open"),
    dueDate: t.due_date != null ? String(t.due_date) : null,
    priority: t.priority ? String(t.priority.priority ?? "") : null,
    description: String(t.text_content ?? t.description ?? ""),
    updatedMs: Number.isFinite(n) ? n : 0,
  };
}

/** Fetch one task by id (used after a push to refresh the sync snapshot). */
export async function getCuTask(token: string, taskId: string): Promise<CuTask> {
  return mapTask(await cuFetch(token, `/task/${taskId}`));
}

/** Fetch a list's metadata (name) and its workflow statuses in one call. */
export async function getListInfo(token: string, listId: string): Promise<CuIdName & { statuses: CuStatus[] }> {
  const j = await cuFetch(token, `/list/${listId}`);
  return {
    id: String(j.id ?? listId),
    name: String(j.name ?? "Untitled list"),
    statuses: arr(j, "statuses").map((x) => ({
      id: String(x.id ?? ""),
      name: String(x.status ?? x.name ?? ""),
      type: String(x.type ?? "open"),
    })),
  };
}

/** Update a ClickUp task (sync push of Ascent-side edits). */
export async function updateCuTask(token: string, taskId: string, patch: Record<string, any>): Promise<any> {
  return cuSend(token, `/task/${taskId}`, "PUT", patch);
}

/** Create a ClickUp task in a list (sync push of an unmapped Ascent task). */
export async function createCuTask(
  token: string,
  listId: string,
  draft: { name: string; description?: string; due_date?: number | null; status?: string },
): Promise<CuTask> {
  const body: Record<string, any> = { name: draft.name };
  if (draft.description !== undefined) body.description = draft.description;
  if (draft.due_date !== undefined && draft.due_date != null) body.due_date = draft.due_date;
  if (draft.status) body.status = draft.status;
  return mapTask(await cuSend(token, `/list/${listId}/task`, "POST", body));
}

// Fetch every page of a list's tasks. ClickUp paginates with ?page=N;
// stop at the first empty page and cap at 20 pages (2000 tasks) to stay polite.
export async function getListTasks(token: string, listId: string): Promise<CuTask[]> {
  const out: CuTask[] = [];
  for (let page = 0; page < 20; page++) {
    const tasks = arr(await cuFetch(token, `/list/${listId}/task?page=${page}`), "tasks");
    if (!tasks.length) break;
    out.push(...tasks.map(mapTask));
    if (tasks.length < 100) break; // short page = last page
  }
  return out;
}

// Convert a ClickUp task into an Ascent task draft — the same shape the
// manual task-creation endpoint accepts, so imports go through the same path.
// The column reflects the full workflow mapping (done / in_progress /
// review / backlog), matching what sync uses for the initial snapshot.
export function taskToDraft(t: CuTask): {
  title: string;
  notes: string;
  due_date: string;
  status: "done" | "in_progress" | "review" | "backlog";
} {
  return {
    title: t.name,
    notes: t.description || "",
    due_date: t.dueDate ? new Date(Number(t.dueDate)).toISOString().slice(0, 10) : "",
    status: cuStatusToColumn(t.status, t.statusType),
  };
}

/** Map a ClickUp status onto an Ascent kanban column. */
export function cuStatusToColumn(status: string, statusType: string): "done" | "in_progress" | "review" | "backlog" {
  const s = (status || "").toLowerCase();
  if (statusType === "closed" || /complete|done|closed|finished/.test(s)) return "done";
  if (/progress|doing|started/.test(s)) return "in_progress";
  if (/review|qa|testing/.test(s)) return "review";
  return "backlog";
}

/**
 * Map an Ascent kanban column back onto one of the list's ClickUp statuses.
 * Prefers a same-kind status whose name hints at the column; falls back to
 * the first open (or closed) status so the result is always valid.
 */
export function columnToCuStatus(statuses: CuStatus[], column: string): string | null {
  if (!statuses.length) return null;
  const open = statuses.filter((x) => x.type !== "closed");
  const closed = statuses.filter((x) => x.type === "closed");
  const find = (re: RegExp, pool: CuStatus[]) => {
    const hit = pool.find((x) => re.test(x.name.toLowerCase()));
    return hit ? hit.name : null;
  };
  if (column === "done")
    return find(/complete|done|closed|finished/i, closed) || closed[0]?.name || statuses[0].name;
  if (column === "in_progress")
    return find(/progress|doing|started/i, open) || open[0]?.name || statuses[0].name;
  if (column === "review")
    return find(/review|qa|testing/i, open) || open[0]?.name || statuses[0].name;
  return open[0]?.name || statuses[0].name; // backlog
}

// Dedupe helper: split candidate ClickUp task ids into ones to import and
// ones already imported (already mapped to an Anytype task id).
export function planImport(
  already: Record<string, string>,
  ids: string[],
): { toImport: string[]; skipped: string[] } {
  const toImport: string[] = [];
  const skipped: string[] = [];
  for (const id of ids) {
    if (id && already[id]) skipped.push(id);
    else if (id) toImport.push(id);
  }
  return { toImport, skipped };
}
