// Ascent — unit tests for the side-effect-free batch logic in src/lib.ts.
import { describe, test, expect } from "bun:test";
import {
  parseQuickAdd, nextRecurrenceDate, groupMyDay, subtaskProgress,
  incompleteBlockers, wouldBlockCycle, thisWeekRange, isoDay, startOfDay,
} from "../src/lib";

const DAY = 86400000;
// Fixed reference: Sunday 2026-09-20 12:00 local (so weekday math is stable).
const NOW = new Date(2026, 8, 20, 12, 0, 0).getTime();

describe("parseQuickAdd", () => {
  test("tomorrow / today / tonight", () => {
    expect(parseQuickAdd("call mom tomorrow", NOW).dueISO).toBe(isoDay(NOW + DAY));
    expect(parseQuickAdd("buy milk today", NOW).dueISO).toBe(isoDay(NOW));
    expect(parseQuickAdd("fix leak tonight", NOW).dueISO).toBe(isoDay(NOW));
  });
  test("titles are cleaned of the date words", () => {
    expect(parseQuickAdd("call mom tomorrow", NOW).title).toBe("call mom");
    expect(parseQuickAdd("  buy   milk   today  ", NOW).title).toBe("buy milk");
  });
  test("bare weekday resolves to the next occurrence (strictly future)", () => {
    // Sunday 2026-09-20 → "friday" is 5 days out (Sep 25)
    expect(parseQuickAdd("ship it friday", NOW).dueISO).toBe("2026-09-25");
    // "sunday" from Sunday is 7 days out, not today
    expect(parseQuickAdd("rest sunday", NOW).dueISO).toBe("2026-09-27");
  });
  test("next <weekday> skips the current week", () => {
    // Sunday → "next friday" is 12 days out (Oct 2)
    expect(parseQuickAdd("plan next friday", NOW).dueISO).toBe("2026-10-02");
    // "next sunday" from Sunday is 7 days out
    expect(parseQuickAdd("rest next sunday", NOW).dueISO).toBe("2026-09-27");
  });
  test("in N days / weeks", () => {
    expect(parseQuickAdd("deploy in 3 days", NOW).dueISO).toBe(isoDay(NOW + 3 * DAY));
    expect(parseQuickAdd("review in 2 weeks", NOW).dueISO).toBe(isoDay(NOW + 14 * DAY));
  });
  test("explicit estimates are parsed and stripped", () => {
    expect(parseQuickAdd("write report 30m", NOW)).toMatchObject({ title: "write report", estimateMin: 30 });
    expect(parseQuickAdd("plan sprint 2h", NOW)).toMatchObject({ title: "plan sprint", estimateMin: 120 });
    expect(parseQuickAdd("document api 1.5 hours", NOW)).toMatchObject({ title: "document api", estimateMin: 90 });
    expect(parseQuickAdd("just a title", NOW)).toMatchObject({ title: "just a title", estimateMin: null });
  });
  test("date + estimate combine", () => {
    const p = parseQuickAdd("call dentist tomorrow 30m", NOW);
    expect(p.dueISO).toBe(isoDay(NOW + DAY));
    expect(p.estimateMin).toBe(30);
    expect(p.title).toBe("call dentist");
  });
});

describe("nextRecurrenceDate", () => {
  test("daily advances one day from completion", () => {
    expect(isoDay(nextRecurrenceDate({ kind: "daily" }, NOW))).toBe(isoDay(NOW + DAY));
  });
  test("weekly without weekdays advances 7 days", () => {
    expect(isoDay(nextRecurrenceDate({ kind: "weekly" }, NOW))).toBe(isoDay(NOW + 7 * DAY));
  });
  test("weekly with selected weekdays hits the next selected day", () => {
    const rec = { kind: "weekly" as const, weekdays: [1, 3] }; // Mon, Wed
    // Sunday Sep 20 → Monday Sep 21
    expect(isoDay(nextRecurrenceDate(rec, NOW))).toBe("2026-09-21");
    // Monday Sep 21 → Wednesday Sep 23
    expect(isoDay(nextRecurrenceDate(rec, new Date(2026, 8, 21, 12).getTime()))).toBe("2026-09-23");
    // Wednesday Sep 23 → Monday Sep 28
    expect(isoDay(nextRecurrenceDate(rec, new Date(2026, 8, 23, 12).getTime()))).toBe("2026-09-28");
  });
  test("monthly clamps to end of month (Jan 31 -> Feb 28)", () => {
    const jan31 = new Date(2026, 0, 31, 12).getTime();
    expect(isoDay(nextRecurrenceDate({ kind: "monthly" }, jan31))).toBe("2026-02-28");
    const mar15 = new Date(2026, 2, 15, 12).getTime();
    expect(isoDay(nextRecurrenceDate({ kind: "monthly" }, mar15))).toBe("2026-04-15");
  });
  test("recurrence is computed from completion, not the stale due date", () => {
    // A task due last week but completed today recurs from today.
    const completedToday = new Date(2026, 8, 20, 18).getTime();
    expect(isoDay(nextRecurrenceDate({ kind: "daily" }, completedToday))).toBe("2026-09-21");
  });
});

describe("groupMyDay", () => {
  const mk = (id: string, dueMs: number, status: string) => ({ id, dueMs, status });
  test("overdue / today / in-progress partition with no duplicates", () => {
    const tasks = [
      mk("a", startOfDay(NOW) - DAY, "backlog"),      // overdue
      mk("b", startOfDay(NOW), "in_progress"),        // due today (due wins over in-progress)
      mk("c", 0, "in_progress"),                      // no due date → in progress
      mk("d", startOfDay(NOW) + 3 * DAY, "backlog"),  // future — not in My Day
      mk("e", startOfDay(NOW) - 2 * DAY, "done"),     // done — excluded
      mk("f", 0, "done"),                             // done — excluded
    ];
    const g = groupMyDay(tasks, NOW);
    expect(g.overdue.map((t) => t.id)).toEqual(["a"]);
    expect(g.today.map((t) => t.id)).toEqual(["b"]);
    expect(g.in_progress.map((t) => t.id)).toEqual(["c"]);
    const all = [...g.overdue, ...g.today, ...g.in_progress].map((t) => t.id);
    expect(new Set(all).size).toBe(all.length);
  });
  test("overdue sorted oldest-first", () => {
    const tasks = [
      mk("x", startOfDay(NOW) - DAY, "backlog"),
      mk("y", startOfDay(NOW) - 3 * DAY, "backlog"),
    ];
    expect(groupMyDay(tasks, NOW).overdue.map((t) => t.id)).toEqual(["y", "x"]);
  });
});

describe("subtaskProgress", () => {
  test("counts done/total", () => {
    expect(subtaskProgress([{ id: "1", title: "a", done: true }, { id: "2", title: "b", done: false }]))
      .toEqual({ done: 1, total: 2 });
  });
  test("null/undefined safe", () => {
    expect(subtaskProgress(null)).toEqual({ done: 0, total: 0 });
    expect(subtaskProgress(undefined)).toEqual({ done: 0, total: 0 });
  });
});

describe("dependencies", () => {
  const byId = new Map([
    ["b", { id: "b", title: "Blocker", status: "in_progress" }],
    ["c", { id: "c", title: "Finished blocker", status: "done" }],
  ]);
  test("incompleteBlockers returns only non-done blockers", () => {
    expect(incompleteBlockers(["b", "c"], byId).map((b) => b.id)).toEqual(["b"]);
  });
  test("wouldBlockCycle detects direct and transitive cycles", () => {
    // a blocked by b, b blocked by c
    const edges: Record<string, string[]> = { a: ["b"], b: ["c"], c: [] };
    const of = (id: string) => edges[id];
    expect(wouldBlockCycle("c", "a", of)).toBe(true);  // c→…→a would close the loop
    expect(wouldBlockCycle("a", "a", of)).toBe(true);  // self-block
    expect(wouldBlockCycle("a", "c", of)).toBe(false); // c doesn't lead back to a
  });
});

describe("thisWeekRange", () => {
  test("returns Monday–Sunday bracketing the reference day", () => {
    // Sunday 2026-09-20 → week Mon Sep 14 … Sun Sep 20
    const r = thisWeekRange(NOW);
    expect(r).toEqual({ start: "2026-09-14", end: "2026-09-20" });
    // A mid-week Wednesday
    const wed = new Date(2026, 8, 23, 12).getTime();
    expect(thisWeekRange(wed)).toEqual({ start: "2026-09-21", end: "2026-09-27" });
  });
});
