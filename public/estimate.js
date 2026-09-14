/* Ascent — tiny word-bag task-time estimator.
   Dependency-free: a seed lexicon of common task words, each mapped to a
   typical duration range in minutes. estimateTask() pools the ranges of the
   words in a title, applies effort modifiers, and returns a point estimate
   (median of typicals) plus a lo–hi range. Deterministic, no network. */
const Estimate = (() => {
  // word -> [loMin, hiMin] typical duration range, or single minutes (range derived)
  const LEX = {
    // --- communication ---
    email: [10, 10], mail: [10, 15], send: [10, 15], forward: [5, 10], reply: [10, 15],
    respond: [10, 20], message: [10, 20], text: [10, 15], dm: [10, 15], ping: [5, 15],
    call: [25, 40], phone: [25, 40], ring: [20, 30], dial: [15, 25],
    contact: [20, 40], reach: [15, 30], followup: [15, 25], "follow-up": [15, 25],
    meet: [30, 60], meeting: [30, 60], huddle: [15, 25], sync: [20, 35], standup: [10, 15],
    chat: [20, 30], discuss: [30, 45], interview: [45, 75], negotiate: [45, 75],
    present: [30, 60], demo: [20, 40], pitch: [30, 60],
    // --- reading / writing ---
    read: [15, 30], skim: [5, 15], review: [20, 40], proofread: [20, 40],
    audit: [60, 120], check: [10, 20], verify: [15, 30],
    write: [35, 60], draft: [30, 50], compose: [30, 50], author: [45, 75],
    document: [25, 45], note: [10, 20], notes: [10, 20], summarize: [20, 40],
    outline: [20, 40], blog: [35, 60], newsletter: [30, 50],
    // --- research / analysis ---
    research: [60, 80], investigate: [45, 75], explore: [30, 60], analyze: [45, 75],
    study: [40, 60], survey: [30, 60], benchmark: [45, 75], compare: [20, 40],
    // --- design / build ---
    design: [60, 120], prototype: [90, 150], mockup: [45, 75], sketch: [20, 40],
    wireframe: [60, 90], brand: [60, 120], logo: [45, 75],
    build: [45, 90], implement: [60, 120], code: [45, 90], develop: [60, 120],
    integrate: [45, 75], script: [30, 60], automation: [60, 120], plugin: [45, 75],
    refactor: [45, 75], tweak: [10, 20], polish: [20, 40], fix: [40, 60],
    debug: [45, 75], patch: [30, 50], troubleshoot: [45, 75],
    test: [20, 40], qa: [30, 60], deploy: [20, 40], ship: [20, 40],
    release: [30, 60], launch: [45, 75], publish: [20, 40], migrate: [45, 75],
    // --- planning / organizing ---
    plan: [20, 40], roadmap: [45, 75], strategize: [45, 75], brainstorm: [20, 40],
    prepare: [30, 60], prep: [20, 40], organize: [20, 40], arrange: [15, 30],
    coordinate: [20, 40], schedule: [5, 15], book: [5, 15], reserve: [5, 15],
    calendar: [5, 15], update: [15, 30], edit: [15, 35], revise: [20, 40],
    file: [10, 20], submit: [10, 20], upload: [5, 15], download: [5, 15],
    backup: [15, 30], archive: [10, 20],
    // --- scope nouns ---
    report: [30, 50], proposal: [45, 75], contract: [30, 60], agreement: [30, 45],
    quote: [15, 30], estimate: [15, 30], invoice: [15, 25], expense: [10, 20],
    budget: [30, 60], forecast: [30, 60], tax: [45, 75], taxes: [45, 75],
    bug: [30, 60], issue: [20, 40], ticket: [15, 30], feature: [90, 150],
    epic: [180, 300], story: [30, 60], doc: [25, 45], docs: [25, 45],
    wiki: [20, 40], readme: [15, 30], changelog: [10, 20],
    slides: [40, 60], deck: [40, 60], presentation: [45, 75],
    spreadsheet: [20, 40], dashboard: [60, 120], database: [45, 75], schema: [30, 60],
    api: [45, 75], website: [90, 150], landing: [45, 75], page: [20, 40],
    video: [60, 120], podcast: [90, 150], photo: [20, 40],
    // --- buying / money ---
    buy: [15, 30], purchase: [15, 30], order: [10, 20], pay: [5, 15],
    // --- people ---
    hire: [60, 120], onboard: [90, 150], train: [45, 75], mentor: [30, 60],
    resume: [30, 60], cv: [30, 60], application: [30, 50],
    // --- life admin ---
    visa: [30, 60], passport: [20, 40], travel: [45, 75], trip: [45, 75],
    flight: [20, 40], hotel: [15, 30], doctor: [45, 75], dentist: [30, 60],
    appointment: [20, 40], car: [45, 75], house: [90, 150], apartment: [45, 75],
    lease: [30, 60], move: [120, 240],
  };

  // effort modifiers multiply every matched word's range
  const MOD = {
    quick: 0.5, fast: 0.6, brief: 0.6, short: 0.7, simple: 0.7, easy: 0.7,
    light: 0.8, minor: 0.7,
    deep: 1.5, thorough: 1.4, detailed: 1.4, comprehensive: 1.6,
    long: 1.5, major: 1.5, complex: 1.5, full: 1.3, big: 1.4,
  };

  const STOP = new Set([
    "a", "an", "the", "to", "for", "of", "on", "in", "at", "by", "with", "and",
    "or", "about", "re", "fwd", "my", "your", "our", "me", "it", "this", "that",
    "these", "those", "as", "is", "are", "be", "do", "does", "into", "over",
    "from", "up", "out", "new", "please", "pls", "asap", "vs", "per",
  ]);

  const round5 = (n) => Math.max(5, Math.round(n / 5) * 5);
  const median = (a) => {
    const s = [...a].sort((x, y) => x - y);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };

  // size buckets for chip color-coding
  function classifyTask(title) {
    const e = estimateTask(title);
    if (!e) return null;
    const p = e.point;
    if (p < 15) return "xs";
    if (p < 30) return "s";
    if (p < 60) return "m";
    if (p < 120) return "l";
    return "xl";
  }

  function estimateTask(title) {
    const tokens = String(title || "")
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, " ")
      .split(/[\s-]+/)
      .filter((t) => t && !STOP.has(t));
    if (!tokens.length) return null;
    const seen = new Set();
    const ranges = [];
    let mult = 1;
    for (const t of tokens) {
      if (seen.has(t)) continue;
      seen.add(t);
      const r = LEX[t];
      if (r) ranges.push(r);
      else if (MOD[t]) mult *= MOD[t];
    }
    if (!ranges.length) return null;
    mult = Math.min(2, Math.max(0.25, mult));
    const los = ranges.map(([lo]) => round5(lo * mult));
    const his = ranges.map(([, hi]) => round5(hi * mult));
    const typicals = ranges.map(([lo, hi]) => round5(((lo + hi) / 2) * mult));
    const lo = Math.min(...los), hi = Math.max(...his);
    const point = Math.round(median(typicals));
    return { point, lo, hi: Math.max(hi, lo), mult };
  }

  function fmtMins(mins) {
    const m = Math.round(mins);
    if (m < 120) return `${m}m`;
    const h = m / 60;
    const s = (Math.round(h * 10) / 10).toString().replace(/\.0$/, "");
    return `${s}h`;
  }

  // chip for a task title; "" when the estimator has nothing to say
  function estChip(title) {
    const e = estimateTask(title);
    if (!e) return "";
    const size = classifyTask(title);
    const label = e.lo === e.hi ? `≈${fmtMins(e.point)}` : `≈${fmtMins(e.lo)}–${fmtMins(e.hi)}`;
    return `<span class="est-chip est-${size}" title="Time estimate: ${label.replace("≈", "")} (typical ${fmtMins(e.point)})">⏱ ${label}</span>`;
  }

  // "≈3.5h" total for a kanban column; "" when nothing is estimable
  function colTotal(tasks) {
    let sum = 0, n = 0;
    for (const t of tasks || []) {
      const e = estimateTask(t && t.title);
      if (e) { sum += e.point; n++; }
    }
    return n ? `≈${fmtMins(sum)}` : "";
  }

  return { estimateTask, classifyTask, estChip, colTotal, fmtMins, LEX, MOD };
})();

if (typeof globalThis !== "undefined") globalThis.Estimate = Estimate;
