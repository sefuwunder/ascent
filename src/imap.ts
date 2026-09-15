// Ascent — minimal zero-dependency IMAP client over Bun TLS sockets.
// Supports: implicit TLS connect (port 993 default), LOGIN, SELECT INBOX,
// UID SEARCH FLAGGED (starred = \Flagged), UID FETCH of UID + INTERNALDATE +
// ENVELOPE, plus a best-effort BODY.PEEK[TEXT]<0.2048> snippet. Tagged and
// untagged responses, literal strings ({N} CRLF) and nested parenthesized
// lists are parsed. A `secure: false` option exists for the local test stub
// only — real mail servers are always reached over implicit TLS.

export class ImapError extends Error {
  status: number;
  constructor(status: number, msg: string) {
    super(msg);
    this.status = status;
  }
}

export interface ImapConfig {
  host: string;
  port?: number; // default 993
  user: string;
  pass: string;
  secure?: boolean; // default true; false = plain TCP (test stub only)
}

export interface StarredMail {
  uid: string;
  from: string;
  subject: string;
  date: string; // YYYY-MM-DD (calendar day of the message)
  snippet: string;
}

const READ_TIMEOUT_MS = 30000;
const SNIPPET_BYTES = 2048;

// ---------- RFC 2047 encoded-word decoding (=?UTF-8?Q?...?= / =?UTF-8?B?...?=) ----------
function decodeQ(s: string, charset: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "_") { bytes.push(0x20); continue; }
    if (c === "=" && i + 2 < s.length) {
      const h = parseInt(s.slice(i + 1, i + 3), 16);
      if (!Number.isNaN(h)) { bytes.push(h); i += 2; continue; }
    }
    bytes.push(c.charCodeAt(0));
  }
  try {
    return new TextDecoder(charset || "utf-8").decode(new Uint8Array(bytes));
  } catch {
    return s;
  }
}
export function decodeHeader(v: string): string {
  return String(v ?? "").replace(/=\?([^?]+)\?([qQbB])\?([^?]*)\?=/g, (_, cs, enc, text) => {
    try {
      if (enc.toUpperCase() === "B") {
        const bin = Buffer.from(String(text), "base64");
        return new TextDecoder(cs || "utf-8").decode(bin);
      }
      return decodeQ(String(text), String(cs));
    } catch {
      return String(text);
    }
  });
}

// ---------- tiny IMAP list parser ----------
// Parses atoms, quoted strings ("a\"b"), NIL, parenthesized lists, and
// literals (already merged into the line as {N}CRLF<payload>). Returns the
// value plus the unconsumed remainder.
export function parseImapValue(s: string): [any, string] {
  s = s.replace(/^\s+/, "");
  if (!s) return [null, ""];
  const c = s[0];
  if (c === "(") {
    const out: any[] = [];
    let rest = s.slice(1);
    for (;;) {
      rest = rest.replace(/^\s+/, "");
      if (!rest) break; // unbalanced — best effort
      if (rest[0] === ")") return [out, rest.slice(1)];
      const [v, r] = parseImapValue(rest);
      out.push(v);
      rest = r;
    }
    return [out, rest];
  }
  if (c === '"') {
    let i = 1, acc = "";
    while (i < s.length) {
      if (s[i] === "\\" && i + 1 < s.length) { acc += s[i + 1]; i += 2; continue; }
      if (s[i] === '"') return [acc, s.slice(i + 1)];
      acc += s[i]; i++;
    }
    return [acc, ""];
  }
  const m = s.match(/^(NIL|\d+|[^\s()"\]]+)/i);
  if (m) {
    const tok = m[1];
    if (/^NIL$/i.test(tok)) return [null, s.slice(m[0].length)];
    if (/^\d+$/.test(tok)) return [Number(tok), s.slice(m[0].length)];
    return [tok, s.slice(m[0].length)];
  }
  return [null, s.slice(1)];
}

function addrText(addr: any[]): string {
  // address = (display-name route mailbox host)
  if (!Array.isArray(addr)) return "";
  const [name, , mailbox, host] = addr;
  const email = mailbox && host ? `${mailbox}@${host}` : String(mailbox || "");
  const n = decodeHeader(String(name || ""));
  return n && email && n !== email ? `${n} <${email}>` : email;
}

// INTERNALDATE "15-Sep-2026 10:23:45 +0000" → "2026-09-15"
const MONTHS: Record<string, number> = {
  Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
  Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
};
export function internalDateToIso(d: string): string {
  const m = String(d || "").match(/(\d{1,2})-([A-Za-z]{3})-(\d{4})/);
  if (!m) return "";
  const mon = MONTHS[m[2].slice(0, 1).toUpperCase() + m[2].slice(1).toLowerCase()];
  if (mon === undefined) return "";
  return `${m[3]}-${String(mon + 1).padStart(2, "0")}-${m[1].padStart(2, "0")}`;
}

// ---------- connection ----------

class Conn {
  private buf = Buffer.alloc(0);
  private lines: string[] = [];
  private wake: (() => void) | null = null;
  private closedErr: Error | null = null;
  private sock: any = null;

  async open(host: string, port: number, secure: boolean) {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) { settled = true; reject(new ImapError(0, `mail server not reachable (${host}:${port}) — timed out`)); }
      }, READ_TIMEOUT_MS);
      const self = this;
      const pending: any = Bun.connect({
        hostname: host,
        port,
        tls: secure,
        socket: {
          open(sock: any) {
            self.sock = sock;
            if (!settled) { settled = true; clearTimeout(timer); resolve(); }
          },
          data(_s: any, data: Buffer) {
            self.onData(data);
          },
          error(_s: any, err: Error) {
            if (!settled) { settled = true; clearTimeout(timer); reject(new ImapError(0, `mail server not reachable (${host}:${port}) — ${err.message}`)); }
            else self.onClose(err);
          },
          close() {
            self.onClose(new Error("connection closed by server"));
          },
        },
      });
      // Bun.connect's returned promise rejects on hard failures (e.g.
      // ECONNREFUSED) that never reach the socket error callback.
      if (pending && typeof pending.catch === "function") {
        pending.catch((err: Error) => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            reject(new ImapError(0, `mail server not reachable (${host}:${port}) — ${err.message || "connection failed"}`));
          }
        });
      }
    });
  }

  private onData(data: Buffer) {
    this.buf = Buffer.concat([this.buf, data]);
    for (;;) {
      const idx = this.buf.indexOf("\r\n");
      if (idx < 0) break;
      const line = this.buf.slice(0, idx).toString("latin1");
      let rest = this.buf.slice(idx + 2);
      const lm = line.match(/\{(\d+)\}$/);
      if (lm) {
        const n = Number(lm[1]);
        if (rest.length < n) break; // wait for the full literal
        const lit = rest.slice(0, n).toString("latin1");
        rest = rest.slice(n);
        this.buf = rest;
        this.lines.push(line + "\n" + lit);
        continue;
      }
      this.buf = rest;
      this.lines.push(line);
    }
    if (this.wake) { const w = this.wake; this.wake = null; w(); }
  }

  private onClose(err: Error) {
    if (!this.closedErr) this.closedErr = err;
    if (this.wake) { const w = this.wake; this.wake = null; w(); }
  }

  async readLine(): Promise<string> {
    for (;;) {
      if (this.lines.length) return this.lines.shift()!;
      if (this.closedErr) throw new ImapError(0, this.closedErr.message);
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.wake = null;
          reject(new ImapError(0, "mail server timed out waiting for a reply"));
        }, READ_TIMEOUT_MS);
        this.wake = () => { clearTimeout(timer); resolve(); };
      });
    }
  }

  write(s: string) {
    this.sock.write(s);
  }

  /** Send one tagged command; return the response lines through the tagged OK. */
  async cmd(tag: string, command: string): Promise<string[]> {
    this.write(`${tag} ${command}\r\n`);
    const out: string[] = [];
    for (;;) {
      const line = await this.readLine();
      if (line.startsWith(`${tag} `)) {
        const rest = line.slice(tag.length + 1);
        if (/^OK\b/i.test(rest)) return out;
        const msg = rest.replace(/^(NO|BAD)\s*/i, "").trim();
        const authish = /auth|login|credential|password|username/i.test(msg);
        throw new ImapError(authish ? 401 : 502, `mail server refused: ${msg || rest}`);
      }
      out.push(line);
    }
  }

  close() {
    try { this.write("a999 LOGOUT\r\n"); } catch { /* already gone */ }
    try { this.sock.end(); } catch { /* already gone */ }
  }
}

function cfgOk(c: ImapConfig): ImapConfig {
  const host = String(c.host || "").trim();
  const user = String(c.user || "").trim();
  if (!host) throw new ImapError(400, "mail host is required");
  if (!user) throw new ImapError(400, "mail username is required");
  if (!c.pass) throw new ImapError(400, "mail password is required");
  return {
    host,
    port: c.port && Number(c.port) > 0 ? Number(c.port) : 993,
    user,
    pass: String(c.pass),
    secure: c.secure !== false,
  };
}

/** Connect, log in, select INBOX. Returns the open connection. */
async function login(cfg0: ImapConfig): Promise<Conn> {
  const cfg = cfgOk(cfg0);
  const conn = new Conn();
  await conn.open(cfg.host, cfg.port!, cfg.secure!);
  const greet = await conn.readLine();
  if (!/^\* OK/i.test(greet)) {
    conn.close();
    throw new ImapError(502, `mail server did not greet properly: ${greet.slice(0, 80)}`);
  }
  try {
    await conn.cmd("a001", `LOGIN ${qstr(cfg.user)} ${qstr(cfg.pass)}`);
    await conn.cmd("a002", "SELECT INBOX");
  } catch (e) {
    conn.close();
    throw e;
  }
  return conn;
}

function qstr(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Validate credentials: log in and SELECT INBOX, then disconnect. */
export async function validateImap(cfg: ImapConfig): Promise<{ ok: true }> {
  const conn = await login(cfg);
  conn.close();
  return { ok: true };
}

function parseSearchUids(lines: string[]): string[] {
  const out: string[] = [];
  for (const line of lines) {
    const m = line.match(/^\* SEARCH\s*(.*)$/i);
    if (m && m[1].trim()) out.push(...m[1].trim().split(/\s+/));
  }
  return out;
}

// Fetch envelopes for a batch of UIDs; returns partial results on parse issues.
async function fetchEnvelopes(conn: Conn, tag: string, uids: string[]): Promise<Map<string, { from: string; subject: string; date: string }>> {
  const out = new Map<string, { from: string; subject: string; date: string }>();
  const lines = await conn.cmd(tag, `UID FETCH ${uids.join(",")} (UID INTERNALDATE ENVELOPE)`);
  let cur: string[] = [];
  const flush = () => {
    if (!cur.length) return;
    const joined = cur.join("\r\n");
    const m = joined.match(/\* \d+ FETCH \((.*)\)$/s);
    cur = [];
    if (!m) return;
    const body = m[1].replace(/\n[^\n]*$/s, (tail) => tail); // keep literals attached
    const parts: Record<string, string> = {};
    // Split "KEY value" pairs at top level.
    let rest = body;
    while (rest.trim()) {
      const km = rest.match(/^\s*([A-Z.\[\]<>\d]+)\s*/i);
      if (!km) break;
      const key = km[1].toUpperCase();
      rest = rest.slice(km[0].length);
      if (rest.startsWith("{")) {
        const nm = rest.match(/^\{(\d+)\}\r?\n?/);
        if (!nm) break;
        const n = Number(nm[1]);
        parts[key] = rest.slice(nm[0].length, nm[0].length + n);
        rest = rest.slice(nm[0].length + n);
      } else {
        const [v, r] = parseImapValue(rest);
        parts[key] = v as any;
        rest = r;
      }
    }
    // ENVELOPE value arrives via parseImapValue as nested array (or string when literal-merged).
    const uid = String(parts["UID"] ?? "");
    if (!uid) return;
    let env = parts["ENVELOPE"];
    if (typeof env === "string") {
      const [v] = parseImapValue(env.trim());
      env = v;
    }
    let from = "", subject = "", date = "";
    if (Array.isArray(env)) {
      subject = decodeHeader(String(env[1] ?? "")).trim();
      const fromList = env[2];
      if (Array.isArray(fromList)) from = fromList.map(addrText).filter(Boolean).join(", ");
      date = internalDateToIso(String(parts["INTERNALDATE"] ?? env[0] ?? ""));
    } else {
      date = internalDateToIso(String(parts["INTERNALDATE"] ?? ""));
    }
    out.set(uid, { from, subject, date });
  };
  for (const line of lines) {
    if (/^\* \d+ FETCH/i.test(line) && cur.length) flush();
    cur.push(line);
  }
  flush();
  return out;
}

// Best-effort text snippets; a failure here never fails the import.
async function fetchSnippets(conn: Conn, tag: string, uids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  try {
    const lines = await conn.cmd(tag, `UID FETCH ${uids.join(",")} (UID BODY.PEEK[TEXT]<0.${SNIPPET_BYTES}>)`);
    let cur: string[] = [];
    const flush = () => {
      if (!cur.length) return;
      const joined = cur.join("\r\n");
      cur = [];
      const um = joined.match(/UID (\d+)/i);
      if (!um) return;
      // The literal payload is everything after the last {N}\n marker.
      const lm = joined.match(/\{(\d+)\}\n([\s\S]*)$/);
      let text = lm ? lm[2].slice(0, Number(lm[1])) : "";
      // Strip a leading MIME header block when present.
      const hm = text.match(/\r?\n\r?\n/);
      if (hm) text = text.slice(hm.index! + hm[0].length);
      text = text.replace(/\s+/g, " ").trim().slice(0, 280);
      if (text) out.set(um[1], text);
    };
    for (const line of lines) {
      if (/^\* \d+ FETCH/i.test(line) && cur.length) flush();
      cur.push(line);
    }
    flush();
  } catch {
    /* snippet fetch is optional — envelopes already succeeded */
  }
  return out;
}

/** List starred (\\Flagged) messages in INBOX, newest first. */
export async function fetchStarred(cfg0: ImapConfig, limit = 200): Promise<StarredMail[]> {
  const conn = await login(cfg0);
  try {
    const uids = parseSearchUids(await conn.cmd("a003", "UID SEARCH FLAGGED"));
    if (!uids.length) return [];
    const picked = uids.slice(-Math.min(limit, 200));
    const envs = await fetchEnvelopes(conn, "a004", picked);
    const snips = await fetchSnippets(conn, "a005", picked);
    const mails: StarredMail[] = [];
    for (const uid of picked) {
      const e = envs.get(uid) || { from: "", subject: "", date: "" };
      mails.push({
        uid,
        from: e.from,
        subject: e.subject || "(no subject)",
        date: e.date,
        snippet: snips.get(uid) || "",
      });
    }
    return mails.reverse(); // newest first
  } finally {
    conn.close();
  }
}
