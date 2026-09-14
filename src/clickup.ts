// Ascent — ClickUp API v2 client (one-way import: ClickUp → Ascent).
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
  return {
    id: String(t.id),
    name: String(t.name ?? "Untitled task"),
    status: String(t.status?.status ?? ""),
    statusType: String(t.status?.type ?? "open"),
    dueDate: t.due_date != null ? String(t.due_date) : null,
    priority: t.priority ? String(t.priority.priority ?? "") : null,
    description: String(t.text_content ?? t.description ?? ""),
  };
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
export function taskToDraft(t: CuTask): {
  title: string;
  notes: string;
  due_date: string;
  status: "done" | "backlog";
} {
  const closed = t.statusType === "closed" || /complete|done|closed/i.test(t.status);
  return {
    title: t.name,
    notes: t.description || "",
    due_date: t.dueDate ? new Date(Number(t.dueDate)).toISOString().slice(0, 10) : "",
    status: closed ? "done" : "backlog",
  };
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
