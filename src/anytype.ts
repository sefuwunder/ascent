// Ascent — Anytype API client.
// Speaks to the Anytype desktop app's local HTTP API (default http://127.0.0.1:31009)
// following the official spec at https://developers.anytype.io (API version 2025-11-08).

const BASE = (process.env.ANYTYPE_BASE_URL || "http://127.0.0.1:31009").replace(/\/+$/, "");
const VERSION = process.env.ANYTYPE_VERSION || "2025-11-08";

export function baseUrl(): string {
  return BASE;
}

let apiKey = process.env.ANYTYPE_API_KEY || "";

export function setApiKey(k: string) {
  apiKey = k;
}
export function getApiKey(): string {
  return apiKey;
}

export class AnytypeError extends Error {
  status: number;
  constructor(status: number, msg: string) {
    super(msg);
    this.status = status;
  }
}

async function atFetch(path: string, init: RequestInit = {}): Promise<any> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Anytype-Version": VERSION,
    ...((init.headers as Record<string, string>) || {}),
  };
  if (apiKey && !headers["Authorization"]) headers["Authorization"] = `Bearer ${apiKey}`;
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, { ...init, headers });
  } catch {
    throw new AnytypeError(0, "Anytype app not reachable — is it running?");
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg =
      (body as any)?.error?.message || (body as any)?.error || (body as any)?.message || `Anytype HTTP ${res.status}`;
    throw new AnytypeError(res.status, String(msg));
  }
  return body;
}

// ---------- auth ----------

export async function createChallenge(appName: string): Promise<string> {
  const j = await atFetch("/v1/auth/challenges", {
    method: "POST",
    body: JSON.stringify({ app_name: appName }),
  });
  const cid = j.challenge_id || j.challengeId || j.id;
  if (!cid) throw new AnytypeError(500, "unexpected challenge response from Anytype");
  return String(cid);
}

export async function exchangeCode(challengeId: string, code: string): Promise<string> {
  const j = await atFetch("/v1/auth/api_keys", {
    method: "POST",
    body: JSON.stringify({ challenge_id: challengeId, code: code.trim() }),
  });
  const key = j.api_key || j.apiKey || j.key;
  if (!key) throw new AnytypeError(500, "unexpected pairing response from Anytype");
  return String(key);
}

// ---------- defensive parsing ----------
// The API returns objects with metadata plus a properties list whose exact
// shape varies by version, so unwrap the common wrappers.

export function anyObjects(j: any): any[] {
  if (Array.isArray(j)) return j;
  if (j && typeof j === "object") {
    for (const k of ["data", "objects", "results", "items"]) {
      if (Array.isArray(j[k])) return j[k];
    }
  }
  return [];
}

export interface AnyProp {
  key: string;
  name: string;
  value: any;
}

export function anyProps(obj: any): AnyProp[] {
  const p = obj?.properties ?? obj?.props ?? obj?.details ?? obj?.relations;
  if (Array.isArray(p)) {
    return p.map((x: any) => ({
      key: String(x.key || x.id || x.name || ""),
      name: String(x.name || x.key || x.id || ""),
      value: x.value ?? x.checkbox ?? x.date ?? x.text ?? x.number ?? x.select ?? x.status ?? x,
    }));
  }
  if (p && typeof p === "object") {
    return Object.entries(p).map(([k, v]) => ({ key: k, name: k, value: v }));
  }
  return [];
}

const WRAP_KEYS = new Set(["checkbox", "date", "number", "text", "select", "status", "timestamp", "value"]);

export function unwrap(v: any): any {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const keys = Object.keys(v);
    if (keys.length === 1 && WRAP_KEYS.has(keys[0])) {
      const inner = v[keys[0]];
      if (inner && typeof inner === "object" && "name" in inner) return (inner as any).name;
      return inner;
    }
    if (typeof (v as any).timestamp === "number") return (v as any).timestamp;
  }
  return v;
}

export function propValue(obj: any, keyRe: RegExp): any {
  for (const p of anyProps(obj)) {
    if (keyRe.test(p.key) || keyRe.test(p.name)) return unwrap(p.value);
  }
  return undefined;
}

export function asBool(v: any): boolean {
  v = unwrap(v);
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") return /^(true|1|yes|done|checked)$/i.test(v.trim());
  return false;
}

export function asMs(v: any): number {
  v = unwrap(v);
  if (typeof v === "number" && Number.isFinite(v)) return v > 1e12 ? v : v * 1000;
  if (typeof v === "string") {
    const t = v.trim();
    if (!t) return 0;
    if (/^\d+$/.test(t)) {
      const n = Number(t);
      return n > 1e12 ? n : n * 1000;
    }
    // Date-only strings are calendar days, not instants: parse as LOCAL
    // midnight so the day a user picked is the day that renders back, in
    // every timezone. (Date.parse treats them as UTC midnight, which shifts
    // the day for anyone west of UTC — the task modal's calendar would show
    // the previous day after saving.)
    const m = t.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (m) {
      const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
      return d.getFullYear() === Number(m[1]) && d.getMonth() === Number(m[2]) - 1 && d.getDate() === Number(m[3])
        ? d.getTime()
        : 0;
    }
    const ms = Date.parse(t);
    return Number.isNaN(ms) ? 0 : ms;
  }
  return 0;
}

// ---------- spaces ----------

export interface Space {
  id: string;
  name: string;
}

export async function listSpaces(): Promise<Space[]> {
  const j = await atFetch("/v1/spaces");
  return anyObjects(j).map((s: any) => ({
    id: String(s.id || s.space_id || s.spaceId || ""),
    name: String(s.name || s.title || "Untitled space"),
  })).filter((s) => s.id);
}

// ---------- property discovery ----------
// We never assume relation keys: list the space's properties once and match
// the task's done/due fields by name + format.

export interface PropDef {
  id: string;
  key: string;
  name: string;
  format: string;
}

export async function listProperties(spaceId: string): Promise<PropDef[]> {
  const j = await atFetch(`/v1/spaces/${spaceId}/properties`);
  return anyObjects(j).map((p: any) => ({
    id: String(p.id || ""),
    key: String(p.key || p.id || ""),
    name: String(p.name || p.key || p.id || ""),
    format: String(p.format || p.type || ""),
  }));
}

export interface TaskKeys {
  done: string; // property key for the done checkbox
  due: string; // property key for the due date
}

export function discoverTaskKeys(props: PropDef[]): TaskKeys {
  const byName = (re: RegExp, fmt: RegExp) =>
    props.find((p) => re.test(p.name) && fmt.test(p.format)) ||
    props.find((p) => re.test(p.key) && fmt.test(p.format)) ||
    props.find((p) => re.test(p.name)) ||
    props.find((p) => re.test(p.key));
  const done = byName(/done|complete|finished|checked/i, /checkbox|bool/i);
  const due = byName(/due|deadline/i, /date/i);
  return { done: done?.key || "done", due: due?.key || "due_date" };
}

// ---------- objects ----------

export interface NewObject {
  name: string;
  type_key: string;
  body?: string;
  icon?: string; // emoji
  properties?: Array<Record<string, any>>;
}

export async function createObject(spaceId: string, o: NewObject): Promise<any> {
  const payload: any = { name: o.name, type_key: o.type_key };
  if (o.body) payload.body = o.body;
  if (o.icon) payload.icon = { emoji: o.icon, format: "emoji" };
  if (o.properties) payload.properties = o.properties;
  const j = await atFetch(`/v1/spaces/${spaceId}/objects`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
  return j?.object ?? j?.data ?? j;
}

export async function getObject(spaceId: string, objectId: string): Promise<any> {
  const j = await atFetch(`/v1/spaces/${spaceId}/objects/${objectId}`);
  return j?.object ?? j?.data ?? j;
}

export async function updateObject(
  spaceId: string,
  objectId: string,
  patch: { name?: string; properties?: Array<Record<string, any>> }
): Promise<any> {
  const j = await atFetch(`/v1/spaces/${spaceId}/objects/${objectId}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
  return j?.object ?? j?.data ?? j;
}

export async function deleteObject(spaceId: string, objectId: string): Promise<void> {
  await atFetch(`/v1/spaces/${spaceId}/objects/${objectId}`, { method: "DELETE" });
}

export async function searchSpace(
  spaceId: string,
  opts: { query?: string; types?: string[]; limit?: number } = {}
): Promise<any[]> {
  const j = await atFetch(`/v1/spaces/${spaceId}/search`, {
    method: "POST",
    body: JSON.stringify({
      query: opts.query ?? "",
      types: opts.types ?? [],
      ...(opts.limit ? { limit: opts.limit } : {}),
    }),
  });
  return anyObjects(j);
}

// ---------- normalized views ----------

export interface TaskView {
  id: string;
  title: string;
  done: boolean;
  dueMs: number;
  notes: string;
  updatedMs: number;
}

export function toTaskView(o: any, keys: TaskKeys): TaskView {
  const name = o.name || o.title || "Untitled task";
  const doneRaw = propValue(o, new RegExp(`^${keys.done}$`, "i"));
  const dueRaw = propValue(o, new RegExp(`^${keys.due}$`, "i"));
  const upd = o.updated_at || o.updatedAt || o.last_modified_date;
  return {
    id: String(o.id),
    title: String(name),
    done: doneRaw === undefined ? asBool(propValue(o, /done|complete|finished|checked/i)) : asBool(doneRaw),
    dueMs: dueRaw === undefined ? asMs(propValue(o, /due|deadline/i)) : asMs(dueRaw),
    notes: String(o.snippet || o.description || ""),
    updatedMs: asMs(upd),
  };
}

export interface ArticleView {
  id: string;
  title: string;
  body: string; // full markdown
  updatedMs: number;
}

export function toArticleView(o: any): ArticleView {
  const bodyRaw = o.markdown ?? o.body ?? o.snippet ?? o.description ?? "";
  const body = typeof bodyRaw === "string" ? bodyRaw : String(bodyRaw ?? "");
  return {
    id: String(o.id),
    title: String(o.name || o.title || "Untitled article"),
    body,
    updatedMs: asMs(o.updated_at || o.updatedAt || o.last_modified_date),
  };
}

export interface ProjectView {
  id: string;
  name: string;
  icon: string;
  notes: string;
  updatedMs: number;
}

export function toProjectView(o: any): ProjectView {
  const icon = o.icon;
  return {
    id: String(o.id),
    name: String(o.name || o.title || "Untitled project"),
    icon: typeof icon === "string" ? icon : icon?.emoji || "📁",
    notes: String(o.snippet || o.description || ""),
    updatedMs: asMs(o.updated_at || o.updatedAt || o.last_modified_date),
  };
}
