// Ascent — pure shared logic for the My Day / quick-add / dependencies /
// recurrence / sprint / subtask batch. Zero side effects: safe to import
// from src/server.ts and to unit-test directly with `bun test`.
//
// Date convention: calendar days are LOCAL-midnight epoch-ms (matching
// anytype.ts asMs), so "tomorrow" is always the user's tomorrow.

export interface Recurrence {
  kind: "daily" | "weekly" | "monthly";
  weekdays?: number[]; // 0=Sun..6=Sat, weekly only
}

export interface Subtask {
  id: string;
  title: string;
  done: boolean;
}

export const DAY = 86400000;

export function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function isoDay(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/* ---------- quick-add natural-language parsing ---------- */

const WEEKDAYS: Record<string, number> = {
  sunday: 0, sun: 0,
  monday: 1, mon: 1,
  tuesday: 2, tue: 2, tues: 2,
  wednesday: 3, wed: 3,
  thursday: 4, thu: 4, thur: 4, thurs: 4,
  friday: 5, fri: 5,
  saturday: 6, sat: 6,
};

export interface QuickAddParsed {
  title: string;
  dueISO: string; // "" when no due date was parsed
  estimateMin: number | null;
}

/**
 * Parse quick-add input like "Call dentist tomorrow 30m" or
 * "Write report next friday 2h". Returns the cleaned title, a local
 * YYYY-MM-DD due date (or ""), and an explicit estimate in minutes (or null).
 * `nowMs` is injectable so tests can pin "today".
 */
export function parseQuickAdd(input: string, nowMs: number = Date.now()): QuickAddParsed {
  let text = ` ${String(input || "")} `;
  let estimateMin: number | null = null;

  // Estimate first ("30m", "45 min", "2h", "1.5 hours") — strip it so a
  // weekday like "thu" can't collide with the "h" unit.
  const em = text.match(/\s(\d+(?:\.\d+)?)\s*(hours?|hrs?|h|minutes?|mins?|m)\b/i);
  if (em) {
    const n = parseFloat(em[1]);
    const unit = em[2].toLowerCase();
    estimateMin = Math.round(n * (unit.startsWith("h") ? 60 : 1));
    text = text.replace(em[0], " ");
  }

  const today = startOfDay(nowMs);
  const dow = new Date(today).getDay();
  let dueMs: number | null = null;
  const eat = (re: RegExp): RegExpMatchArray | null => {
    const m = text.match(re);
    if (m) text = text.replace(m[0], " ");
    return m;
  };

  if (eat(/\sday\s+after\s+tomorrow\b/i)) dueMs = today + 2 * DAY;
  else if (eat(/\stomorrow\b/i)) dueMs = today + DAY;
  else if (eat(/\stonight\b/i) || eat(/\stoday\b/i)) dueMs = today;
  else if (eat(/\snext\s+week\b/i)) dueMs = today + 7 * DAY;
  else {
    let m = eat(/\snext\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)\b/i);
    if (m) {
      const target = WEEKDAYS[m[1].toLowerCase()];
      dueMs = today + (7 + ((target - dow + 7) % 7)) * DAY;
    } else if ((m = eat(/\bin\s+(\d+)\s+days?\b/i))) {
      dueMs = today + Number(m[1]) * DAY;
    } else if ((m = eat(/\bin\s+(\d+)\s+weeks?\b/i))) {
      dueMs = today + Number(m[1]) * 7 * DAY;
    } else if ((m = eat(/\s(sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)\b/i))) {
      const target = WEEKDAYS[m[1].toLowerCase()];
      const delta = ((target - dow + 7) % 7) || 7; // strictly in the future
      dueMs = today + delta * DAY;
    }
  }

  const title = text.replace(/\s+/g, " ").trim();
  return { title, dueISO: dueMs === null ? "" : isoDay(dueMs), estimateMin };
}

/* ---------- recurrence date math ---------- */

/**
 * Next due date for a recurring task, computed from the COMPLETION date so
 * past-due recurrences never pile up (a task due last week completed today
 * recurs from today, not from its stale due date). Returns local-midnight ms.
 */
export function nextRecurrenceDate(rec: Recurrence, fromMs: number): number {
  const base = startOfDay(fromMs);
  if (rec.kind === "daily") return base + DAY;
  if (rec.kind === "weekly") {
    const days = Array.isArray(rec.weekdays) ? rec.weekdays.filter((d) => d >= 0 && d <= 6) : [];
    if (!days.length) return base + 7 * DAY;
    const set = new Set(days);
    const dow = new Date(base).getDay();
    for (let d = 1; d <= 7; d++) {
      if (set.has((dow + d) % 7)) return base + d * DAY;
    }
    return base + 7 * DAY; // unreachable, but safe
  }
  // monthly: same day-of-month next month, clamped to the month's length
  // (Jan 31 -> Feb 28).
  const d = new Date(base);
  const day = d.getDate();
  const next = new Date(d.getFullYear(), d.getMonth() + 1, 1);
  const lastDay = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate();
  next.setDate(Math.min(day, lastDay));
  return next.getTime();
}

/* ---------- My Day grouping ---------- */

export interface DayTask {
  id: string;
  dueMs: number;
  status: string;
}

export interface MyDayGroups<T extends DayTask> {
  overdue: T[];
  today: T[];
  in_progress: T[];
}

/** Partition tasks into Overdue / Due today / In progress. Done tasks are
 *  excluded; a task appears in at most one section (due-date wins). */
export function groupMyDay<T extends DayTask>(tasks: T[], nowMs: number = Date.now()): MyDayGroups<T> {
  const start = startOfDay(nowMs);
  const end = start + DAY;
  const overdue: T[] = [];
  const today: T[] = [];
  const inProgress: T[] = [];
  for (const t of tasks || []) {
    if (!t || t.status === "done") continue;
    if (t.dueMs && t.dueMs < start) overdue.push(t);
    else if (t.dueMs && t.dueMs < end) today.push(t);
    else if (t.status === "in_progress") inProgress.push(t);
  }
  const byDue = (a: T, b: T) => (a.dueMs || Infinity) - (b.dueMs || Infinity);
  overdue.sort(byDue);
  today.sort(byDue);
  return { overdue, today, in_progress: inProgress };
}

/* ---------- subtasks ---------- */

export function subtaskProgress(subs: Subtask[] | undefined | null): { done: number; total: number } {
  const list = Array.isArray(subs) ? subs : [];
  return { done: list.filter((s) => s && s.done).length, total: list.length };
}

/* ---------- dependencies ---------- */

export interface BlockerRef {
  id: string;
  title: string;
  status: string;
}

/** Incomplete blockers for a task: ids in `blockedBy` whose task isn't done. */
export function incompleteBlockers(
  blockedBy: string[] | undefined | null,
  byId: Map<string, BlockerRef> | Record<string, BlockerRef>,
): BlockerRef[] {
  const ids = Array.isArray(blockedBy) ? blockedBy : [];
  const get = (id: string): BlockerRef | undefined =>
    byId instanceof Map ? byId.get(id) : (byId as Record<string, BlockerRef>)[id];
  const out: BlockerRef[] = [];
  for (const id of ids) {
    const t = get(id);
    if (t && t.status !== "done") out.push(t);
  }
  return out;
}

/** True if making `tid` blocked-by `newBlockerId` would create a dependency
 *  cycle (tid reachable from newBlockerId through blocked_by edges). */
export function wouldBlockCycle(
  tid: string,
  newBlockerId: string,
  blockedByOf: (id: string) => string[] | undefined | null,
): boolean {
  if (tid === newBlockerId) return true;
  const seen = new Set<string>([newBlockerId]);
  const stack = [newBlockerId];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const next of blockedByOf(cur) || []) {
      if (next === tid) return true;
      if (!seen.has(next)) { seen.add(next); stack.push(next); }
    }
  }
  return false;
}

/* ---------- sprint defaults ---------- */

/** This week Monday..Sunday as local YYYY-MM-DD strings (Mon default start). */
export function thisWeekRange(nowMs: number = Date.now()): { start: string; end: string } {
  const today = startOfDay(nowMs);
  const dow = new Date(today).getDay(); // 0=Sun
  const monday = today - ((dow + 6) % 7) * DAY;
  return { start: isoDay(monday), end: isoDay(monday + 6 * DAY) };
}
