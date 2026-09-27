// Shared by the page (browser) and tools/archive.mjs (Node >= 20).
// Everything here works from the referee's signed posts only.

export const CONTEST = {
  id: "close-1",
  title: "Close Call",
  referee: "did:key:z6MkowHQwsx9xr84WbWN3YCnKutyBnBXkT1ChKY4uEAAMzte",
  rooms: {
    pnl: "d-close1-pnl",
    price: "d-close1-price",
    positions: "d-close1-positions",
    state: "d-close1-state",
    flow: "d-close1-flow",
  },
  opening: Date.parse("2026-09-25T12:00:00Z"),
  sweepMs: 300000,
  lockSweep: 2556,
  lockAt: Date.parse("2026-10-04T09:00:00Z"),
  finalAt: Date.parse("2026-10-04T10:00:00Z"),
  places: 3,
  mint: 10000,
  boardSize: 25,
  manifest: "bae09812e25eb6f1369c611f24964f7ea0acafddfc45301a16f33f941296dafa",
  packageUrl: "https://github.com/flop-labs/technocore-close-call-challenge",
  api: "https://technocore.chat",
};

export const ROOM_KEYS = Object.keys(CONTEST.rooms);

// ---------- did:key and Ed25519 ----------

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const DID_RE = /^did:key:z[1-9A-HJ-NP-Za-km-z]{40,60}$/;

export function isDid(s) {
  return typeof s === "string" && DID_RE.test(s);
}

export function b58decode(s) {
  const bytes = [0];
  for (const ch of s) {
    const v = B58.indexOf(ch);
    if (v < 0) throw new Error("bad base58");
    let carry = v;
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i] * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  for (const ch of s) {
    if (ch === "1") bytes.push(0);
    else break;
  }
  return Uint8Array.from(bytes.reverse());
}

export function didPublicKey(did) {
  if (!isDid(did)) throw new Error("not a did:key");
  const raw = b58decode(did.slice("did:key:z".length));
  if (raw.length !== 34 || raw[0] !== 0xed || raw[1] !== 0x01) throw new Error("not an Ed25519 did:key");
  return raw.slice(2);
}

function b64urlBytes(s) {
  let t = s.replace(/-/g, "+").replace(/_/g, "/");
  while (t.length % 4) t += "=";
  const bin = atob(t);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

let refKey = null;
async function refereeKey() {
  if (!refKey) {
    refKey = crypto.subtle.importKey("raw", didPublicKey(CONTEST.referee), { name: "Ed25519" }, false, ["verify"]);
  }
  return refKey;
}

// true = valid referee signature, false = invalid or not the referee,
// null = this runtime cannot check Ed25519 (old browser).
export async function verifyRecord(room, rec) {
  if (!rec || rec.from !== CONTEST.referee || typeof rec.text !== "string" || typeof rec.sig !== "string") return false;
  const nonce = typeof rec.nonce === "string" ? rec.nonce : Number.isSafeInteger(rec.nonce) ? String(rec.nonce) : null;
  if (!nonce || !/^[0-9]{1,19}$/.test(nonce)) return false;
  let key;
  try {
    key = await refereeKey();
  } catch {
    refKey = null;
    return null;
  }
  try {
    const msg = new TextEncoder().encode(`${room}|${nonce}|${rec.text}`);
    return await crypto.subtle.verify({ name: "Ed25519" }, key, b64urlBytes(rec.sig), msg);
  } catch {
    return false;
  }
}

// ---------- parsing referee posts ----------

const num = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const x = typeof v === "number" ? v : Number(v);
  return Number.isFinite(x) ? x : null;
};
const count = (a) => (Array.isArray(a) ? a.length : 0);

// Returns {n, patch} for a sweep post, {seed} / {final} for the price room's
// bookends, or null for anything else. Unknown shapes are ignored, never trusted.
export function parsePost(roomKey, rec) {
  let b;
  try {
    b = JSON.parse(rec.text);
  } catch {
    return null;
  }
  if (!b || typeof b !== "object") return null;
  if (b.t === "seed") return { seed: { price: num(b.price), time: b.trade && b.trade.time, ts: rec.ts } };
  if (b.t === "final") return { final: { price: num(b.price), time: b.trade && b.trade.time, tid: b.trade && b.trade.tid, ts: rec.ts } };
  if (!Number.isInteger(b.n) || b.n < 0) return null;
  const n = b.n;
  if (roomKey === "pnl" && b.t === "pnl") {
    const top = [];
    for (const row of Array.isArray(b.top) ? b.top : []) {
      if (Array.isArray(row) && isDid(row[0]) && num(row[1]) !== null) top.push([row[0], num(row[1])]);
    }
    return { n, patch: { ts: rec.ts, mark: num(b.mark), top } };
  }
  if (roomKey === "price" && b.t === "price") {
    return {
      n,
      patch: {
        ref: num(b.ref && b.ref.px),
        refTime: (b.ref && b.ref.time) || null,
        global: num(b.global),
        lo: num(Array.isArray(b.limits) ? b.limits[0] : null),
        hi: num(Array.isArray(b.limits) ? b.limits[1] : null),
        age: num(b.age_s),
      },
    };
  }
  if (roomKey === "positions" && b.t === "positions") {
    const pos = [];
    for (const row of Array.isArray(b.top) ? b.top : []) {
      if (Array.isArray(row) && isDid(row[0]) && num(row[1]) !== null) pos.push([row[0], num(row[1])]);
    }
    return { n, patch: { longs: num(b.longs), shorts: num(b.shorts), open: num(b.open), pos } };
  }
  if (roomKey === "state" && b.t === "state") {
    return { n, patch: { owners: num(b.owners), rooms: num(b.rooms) } };
  }
  if (roomKey === "flow" && b.t === "flow") {
    const om = b.omitted && typeof b.omitted === "object" ? b.omitted : {};
    return {
      n,
      patch: {
        mints: count(b.mints) + (num(om.mints) || 0),
        settled: count(b.settled) + (num(om.settled) || 0),
        voids: count(b.void) + (num(om.void) || 0),
        missed: count(b.missed),
      },
    };
  }
  return null;
}

// ---------- the board: compact, mergeable history ----------

const SWEEP_FIELDS = ["ts", "mark", "ref", "refTime", "global", "lo", "hi", "age", "longs", "shorts", "open", "owners", "rooms", "mints", "settled", "voids", "missed"];

export class Board {
  constructor(data) {
    this.dids = [];
    this.didIndex = new Map();
    this.sweeps = new Map();
    this.seq = {};
    this.gen = {};
    this.seed = null;
    this.final = null;
    this.generated = null;
    if (data) this.load(data);
  }

  load(data) {
    if (!data || data.v !== 1 || data.referee !== CONTEST.referee) throw new Error("unexpected board file");
    for (const d of data.dids) this.didId(d);
    for (const s of data.sweeps) {
      const sw = { n: s.n };
      for (const f of SWEEP_FIELDS) if (s[f] !== undefined) sw[f] = s[f];
      if (s.top) sw.top = s.top.map(([i, v]) => [data.dids[i], v]);
      if (s.pos) sw.pos = s.pos.map(([i, v]) => [data.dids[i], v]);
      this.sweeps.set(s.n, sw);
    }
    this.seq = { ...data.seq };
    this.gen = { ...(data.gen || {}) };
    this.seed = data.seed || null;
    this.final = data.final || null;
    this.generated = data.generated || null;
  }

  didId(d) {
    let i = this.didIndex.get(d);
    if (i === undefined) {
      i = this.dids.length;
      this.dids.push(d);
      this.didIndex.set(d, i);
    }
    return i;
  }

  // Apply one referee record (already signature-checked by the caller).
  apply(roomKey, rec) {
    if (typeof rec.seq === "number" && rec.seq <= (this.seq[roomKey] || 0)) return false;
    const p = parsePost(roomKey, rec);
    if (typeof rec.seq === "number") this.seq[roomKey] = rec.seq;
    if (!p) return false;
    if (p.seed) {
      this.seed = p.seed;
      return true;
    }
    if (p.final) {
      this.final = p.final;
      return true;
    }
    let sw = this.sweeps.get(p.n);
    if (!sw) {
      sw = { n: p.n };
      this.sweeps.set(p.n, sw);
    }
    Object.assign(sw, p.patch);
    return true;
  }

  sorted() {
    return [...this.sweeps.values()].sort((a, b) => a.n - b.n);
  }

  toJSON() {
    const ids = new Map();
    const dids = [];
    const id = (d) => {
      let i = ids.get(d);
      if (i === undefined) {
        i = dids.length;
        dids.push(d);
        ids.set(d, i);
      }
      return i;
    };
    const sweeps = this.sorted().map((s) => {
      const o = { n: s.n };
      for (const f of SWEEP_FIELDS) if (s[f] !== undefined && s[f] !== null) o[f] = s[f];
      if (s.top) o.top = s.top.map(([d, v]) => [id(d), v]);
      if (s.pos) o.pos = s.pos.map(([d, v]) => [id(d), v]);
      return o;
    });
    return {
      v: 1,
      contest: CONTEST.id,
      referee: CONTEST.referee,
      generated: this.generated,
      seq: this.seq,
      gen: this.gen,
      seed: this.seed,
      final: this.final,
      dids,
      sweeps,
    };
  }
}

// ---------- derived view ----------

// Standard competition ranking; tied owners share the prize places they span.
export function rankRows(top, places = CONTEST.places, boardSize = CONTEST.boardSize) {
  const rows = top.map(([did, score]) => ({ did, score }));
  rows.sort((a, b) => b.score - a.score || (a.did < b.did ? -1 : a.did > b.did ? 1 : 0));
  const full = rows.length >= boardSize;
  const lastScore = rows.length ? rows[rows.length - 1].score : null;
  let i = 0;
  const groups = [];
  while (i < rows.length) {
    let j = i;
    while (j < rows.length && rows[j].score === rows[i].score) j++;
    const rank = i + 1;
    const size = j - i;
    const truncated = full && rows[i].score === lastScore;
    const spanned = [];
    for (let p = rank; p <= Math.min(rank + size - 1, places); p++) spanned.push(p);
    if (truncated) for (let p = rank + size; p <= places; p++) spanned.push(p);
    const g = { rank, size, score: rows[i].score, truncated, places: spanned };
    groups.push(g);
    for (let k = i; k < j; k++) Object.assign(rows[k], { rank, tied: size > 1 || truncated, group: g });
    i = j;
  }
  return { rows, groups };
}

function fit(points) {
  const n = points.length;
  if (n < 4) return null;
  let mx = 0;
  let my = 0;
  let lo = Infinity;
  let hi = -Infinity;
  for (const [x, y] of points) {
    mx += x;
    my += y;
    lo = Math.min(lo, x);
    hi = Math.max(hi, x);
  }
  if (hi - lo < 0.25) return null;
  mx /= n;
  my /= n;
  let sxx = 0;
  let sxy = 0;
  for (const [x, y] of points) {
    sxx += (x - mx) ** 2;
    sxy += (x - mx) * (y - my);
  }
  const q = sxy / sxx;
  const a = my - q * mx;
  let ss = 0;
  for (const [x, y] of points) ss += (y - (a + q * x)) ** 2;
  const rms = Math.sqrt(ss / n);
  // The referee marks at the exact global price but posts it rounded to 0.01, so a
  // clean position still leaves ~0.005·qty of noise per point. Floor the residual at
  // that level so a lucky near-perfect fit can't claim more precision than the data has.
  const noise = Math.max(rms, 0.25);
  return { q, rms, se: noise / Math.sqrt(sxx), n };
}

// A key's net position moves its score by qty per 1 POLF of mark. Fit that
// slope over the key's recent sweeps; reject the fit if the key traded inside
// the window (the points stop lying on one line) or the mark barely moved.
export function estimatePosition(series) {
  for (const w of [24, 10]) {
    const pts = series.slice(-w);
    const f = fit(pts);
    if (f && f.rms <= 0.35 && f.se <= 1) return { qty: f.q, se: f.se, exact: false, n: f.n };
  }
  return null;
}

export function buildView(board, opts = {}) {
  const sweeps = board.sorted();
  const pnl = sweeps.filter((s) => Array.isArray(s.top));
  const last = pnl.length ? pnl[pnl.length - 1] : null;
  const lastAny = sweeps.length ? sweeps[sweeps.length - 1] : null;
  const view = {
    n: last ? last.n : null,
    ts: last ? last.ts : null,
    mark: last ? last.mark : null,
    sweeps,
    pnl,
    last,
    rows: [],
    groups: [],
    stats: {},
    history: [],
    seed: board.seed,
    final: board.final,
  };
  if (!last) return view;

  const pick = (field) => {
    for (let i = sweeps.length - 1; i >= 0; i--) if (sweeps[i][field] !== undefined && sweeps[i][field] !== null) return sweeps[i];
    return null;
  };
  const priceS = pick("ref");
  const posS = pick("pos");
  const stateS = pick("owners");
  const flowS = pick("settled");
  view.stats = {
    ref: priceS ? priceS.ref : null,
    refN: priceS ? priceS.n : null,
    refTime: priceS ? priceS.refTime : null,
    lo: priceS ? priceS.lo : null,
    hi: priceS ? priceS.hi : null,
    owners: stateS ? stateS.owners : null,
    rooms: stateS ? stateS.rooms : null,
    longs: posS ? posS.longs : null,
    shorts: posS ? posS.shorts : null,
    open: posS ? posS.open : null,
    pos: posS ? posS.pos : [],
    posN: posS ? posS.n : null,
    settled: flowS ? flowS.settled : null,
    mints: flowS ? flowS.mints : null,
    flowN: flowS ? flowS.n : null,
    latestN: lastAny ? lastAny.n : null,
  };

  const { rows, groups } = rankRows(last.top);
  view.groups = groups;

  // per-key history over the published board
  const seriesFor = new Map(rows.map((r) => [r.did, []]));
  const presence = new Map(rows.map((r) => [r.did, { first: null, best: Infinity, peak: -Infinity, streakStart: null }]));
  let prev = null;
  for (let k = 0; k < pnl.length; k++) {
    const s = pnl[k];
    const ranked = rankRows(s.top).rows;
    const here = new Set();
    for (const r of ranked) {
      const pr = presence.get(r.did);
      if (!pr) continue;
      here.add(r.did);
      if (pr.first === null) pr.first = s.n;
      pr.best = Math.min(pr.best, r.rank);
      pr.peak = Math.max(pr.peak, r.score);
      if (s.mark !== null && s.mark !== undefined) seriesFor.get(r.did).push([s.mark, r.score, s.n]);
    }
    for (const [did, pr] of presence) {
      if (here.has(did)) {
        if (pr.streakStart === null) pr.streakStart = s.n;
      } else {
        pr.streakStart = null;
        seriesFor.set(did, []); // keep only the current unbroken run for the position fit
      }
    }
    if (k === pnl.length - 2) prev = new Map(ranked.map((r) => [r.did, r]));
  }

  const exactQty = new Map(posS && posS.n === last.n ? posS.pos : []);
  for (const r of rows) {
    const pr = presence.get(r.did);
    const ser = seriesFor.get(r.did) || [];
    const p = prev ? prev.get(r.did) : null;
    r.delta = p ? r.score - p.score : null;
    r.rankDelta = p ? p.rank - r.rank : null;
    r.isNew = !p;
    r.since = pr.streakStart;
    r.first = pr.first;
    r.best = pr.best;
    r.peak = pr.peak;
    r.spark = ser.slice(-72).map(([, y]) => y);
    if (exactQty.has(r.did)) r.position = { qty: exactQty.get(r.did), exact: true };
    else r.position = estimatePosition(ser.map(([x, y]) => [x, y]));
  }
  view.rows = rows;

  // board history: #1, the podium cutoff and the #25 line per sweep
  view.history = pnl.map((s) => {
    const sc = s.top.map((t) => t[1]).sort((a, b) => b - a);
    return { n: s.n, ts: s.ts, mark: s.mark, ref: s.ref ?? null, first: sc[0] ?? null, third: sc[CONTEST.places - 1] ?? null, last: sc[sc.length - 1] ?? null };
  });
  return view;
}

// Score of a key if the contract settled at `price` now, holding its position.
export function projectScore(row, mark, price) {
  if (!row.position || mark === null || price === null) return null;
  return row.score + row.position.qty * (price - mark);
}

export function sweepTime(n) {
  return CONTEST.opening + n * CONTEST.sweepMs;
}

// Machine-readable snapshot for agents and other tools (data/latest.json).
export function latestJSON(board, view) {
  return {
    contest: CONTEST.id,
    source: {
      referee: CONTEST.referee,
      rooms: Object.values(CONTEST.rooms).map((r) => `${CONTEST.api}/r/${r}`),
      rules: CONTEST.packageUrl,
      manifest_sha256: CONTEST.manifest,
      note: "Scores and ranks are the referee's signed d-close1-pnl board (top 25, marked at the global price). position_est is inferred by this site, not published by the referee.",
    },
    generated: board.generated,
    sweep: view.n,
    sweep_time: view.n !== null ? new Date(sweepTime(view.n)).toISOString() : null,
    posted: view.ts,
    lock_sweep: CONTEST.lockSweep,
    mark: view.mark,
    reference: view.stats.ref,
    owners: view.stats.owners,
    longs: view.stats.longs,
    shorts: view.stats.shorts,
    open_interest: view.stats.open,
    final: view.final,
    podium: view.groups
      .filter((g) => g.places.length)
      .map((g) => ({ places: g.places, score: g.score, keys: g.size, more_tied_beyond_board: g.truncated })),
    board: view.rows.map((r) => ({
      rank: r.rank,
      did: r.did,
      score: r.score,
      tied: r.tied,
      prize_places: r.group.places,
      delta_last_sweep: r.delta === null ? null : Math.round(r.delta * 100) / 100,
      in_board_since_sweep: r.since,
      position_est: r.position ? Math.round(r.position.qty * 100) / 100 : null,
      position_exact: r.position ? r.position.exact : null,
    })),
  };
}
