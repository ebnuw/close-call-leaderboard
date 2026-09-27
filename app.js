import { CONTEST, ROOM_KEYS, Board, verifyRecord, buildView, projectScore, sweepTime, isDid } from "./core.js";

const HL_URL = "https://api.hyperliquid.xyz/info";
const POLL_MS = 30000;
const HL_MS = 30000;
const COLLAPSE_AT = 4; // tie groups this large fold into one row

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const S = {
  board: new Board(),
  view: null,
  source: "loading",
  sig: { ok: 0, bad: 0, unsupported: false },
  hl: null,
  hlAt: 0,
  hlErr: false,
  pulledAt: 0,
  pullErr: null,
  genChanged: null,
  expanded: new Set(),
  openGroups: new Set(),
  query: "",
  pulling: false,
};

// ---------- formatting ----------

const F = {
  n2: (v) => (v === null || v === undefined ? "—" : (v < 0 ? "−" : "") + Math.abs(v).toFixed(2)),
  d2: (v) => (v === null || v === undefined ? "—" : Math.abs(v) < 0.005 ? "0.00" : (v > 0 ? "+" : "−") + Math.abs(v).toFixed(2)),
  int: (v) => (v === null || v === undefined ? "—" : Math.round(v).toLocaleString("en-US")),
  big: (v) => (v === null || v === undefined ? "—" : v >= 1e6 ? (v / 1e6).toFixed(2) + "M" : v >= 1e4 ? (v / 1e3).toFixed(1) + "k" : F.int(v)),
  did: (d) => d.slice(8, 14) + "…" + d.slice(-5),
  pad: (x) => String(x).padStart(2, "0"),
  dur(ms) {
    if (ms <= 0) return "0m";
    const m = Math.floor(ms / 60000);
    const d = Math.floor(m / 1440);
    const h = Math.floor((m % 1440) / 60);
    const mm = m % 60;
    if (d) return `${d}d ${F.pad(h)}h ${F.pad(mm)}m`;
    if (h) return `${h}h ${F.pad(mm)}m`;
    return `${mm}m`;
  },
  clock(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    return `${Math.floor(s / 60)}:${F.pad(s % 60)}`;
  },
  ago(ms) {
    if (ms < 60000) return `${Math.max(0, Math.round(ms / 1000))}s ago`;
    return `${F.dur(ms)} ago`;
  },
  utc: (t) => new Date(t).toISOString().slice(11, 16) + " UTC",
  day: (t) => new Date(t).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }),
  local: (t) => new Date(t).toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit", timeZoneName: "short" }),
  ord(n) {
    const s = ["th", "st", "nd", "rd"];
    const v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  },
  places(p) {
    if (!p.length) return "";
    return p.length === 1 ? F.ord(p[0]) : `${F.ord(p[0])}–${F.ord(p[p.length - 1])}`;
  },
};
const tone = (v) => (v === null || v === undefined || Math.abs(v) < 0.005 ? "flat" : v > 0 ? "up" : "down");

// ---------- data ----------

async function loadArchive() {
  // ?live skips this site's copy and rebuilds everything from technocore.chat
  if (new URLSearchParams(location.search).has("live")) {
    S.source = "live";
    return;
  }
  try {
    const r = await fetch("data/board.json", { cache: "no-cache" });
    if (!r.ok) throw new Error(String(r.status));
    S.board = new Board(await r.json());
    S.source = "archive";
  } catch {
    S.board = new Board();
    S.source = "live";
  }
}

async function readRoom(key, since, limit) {
  const room = CONTEST.rooms[key];
  const url = `${CONTEST.api}/r/${room}?format=json&limit=${limit}` + (since ? `&since=${since}` : "");
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${room}: HTTP ${r.status}`);
  return r.json();
}

// Whole retained ring as {generation, messages}. Nonces keep their exact digits.
async function exportRoom(key) {
  const room = CONTEST.rooms[key];
  const r = await fetch(`${CONTEST.api}/r/${room}/export`);
  if (!r.ok) throw new Error(`${room}: HTTP ${r.status}`);
  const gen = r.headers.get("x-room-generation");
  const messages = [];
  for (const line of (await r.text()).split("\n")) {
    if (!line) continue;
    try {
      const m = line.match(/"nonce":([0-9]{1,19})[,}]/);
      const rec = JSON.parse(line);
      if (m) rec.nonce = m[1];
      messages.push(rec);
    } catch {}
  }
  return { generation: gen === null ? undefined : Number(gen), messages };
}

async function applyMessages(key, d) {
  if (!d || !Array.isArray(d.messages)) return false;
  if (S.board.gen[key] && d.generation !== undefined && d.generation !== S.board.gen[key]) {
    S.genChanged = CONTEST.rooms[key];
    return false;
  }
  if (d.generation !== undefined) S.board.gen[key] = d.generation;
  const room = CONTEST.rooms[key];
  // >= keeps the record the page already holds, so it gets verified again
  const msgs = d.messages.filter((m) => m.seq >= (S.board.seq[key] || 0)).sort((a, b) => a.seq - b.seq);
  let changed = false;
  for (const m of msgs) {
    const ok = await verifyRecord(room, m);
    if (ok === false) {
      S.sig.bad++;
      continue;
    }
    if (ok === null) S.sig.unsupported = true;
    else S.sig.ok++;
    if (S.board.apply(key, m)) changed = true;
  }
  return changed;
}

// Catch one room up. A short read covers the usual case; if the page is further
// behind than one read can reach (no archive, or an old one), take the room's
// whole ring instead, because `since` + `limit` returns the NEWEST records.
// The read starts one record back, so the post the page already shows is
// checked against the referee's key in this browser too, even if it came
// from the archive.
async function catchUp(key, limit) {
  const held = S.board.seq[key] || 0;
  const d = await readRoom(key, Math.max(0, held - 1), limit);
  const gap = held ? d.first_seq > held : d.first_seq > 1;
  if (gap && key !== "flow") {
    try {
      return await applyMessages(key, await exportRoom(key));
    } catch {
      // fall through to the short read
    }
  }
  return applyMessages(key, d);
}

// pnl drives the board; the other rooms are read when it moves.
async function pull(force = false) {
  if (S.pulling) return;
  S.pulling = true;
  try {
    const moved = await catchUp("pnl", 50);
    // after the lock the board stops moving, but the price room still gets the final S
    if (moved || force || Date.now() >= CONTEST.lockAt) {
      const rest = ROOM_KEYS.filter((k) => k !== "pnl");
      const res = await Promise.allSettled(
        rest.map(async (k) => {
          if (k === "flow") {
            // flow posts are 4 KB each and only feed the latest counts: read the newest one
            const d = await readRoom(k, 0, 1);
            d.messages = (d.messages || []).filter((m) => m.seq > (S.board.seq.flow || 0));
            return applyMessages(k, d);
          }
          return catchUp(k, 50);
        }),
      );
      let err = null;
      for (const r of res) if (r.status === "rejected") err = String(r.reason && r.reason.message ? r.reason.message : r.reason);
      S.pullErr = err;
    } else {
      S.pullErr = null;
    }
    S.pulledAt = Date.now();
    if (moved || force || !S.view) refresh();
  } catch (e) {
    S.pullErr = e && e.message ? e.message : String(e);
    renderStatus();
  } finally {
    S.pulling = false;
  }
}

async function pullHL() {
  if (document.hidden && S.hl !== null) return;
  try {
    const r = await fetch(HL_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "allMids", dex: "xyz" }) });
    const j = await r.json();
    const px = Number(j["xyz:NVDA"]);
    if (Number.isFinite(px) && px > 0) {
      S.hl = px;
      S.hlAt = Date.now();
      S.hlErr = false;
    }
  } catch {
    S.hlErr = true;
  }
  if (S.view) {
    renderFacts();
    renderBoard();
  }
}

// ---------- render ----------

// Price the projection column uses: the final S once posted, else the HL mid.
const projPx = () => (S.view && S.view.final ? S.view.final.price : S.hl);

function refresh() {
  S.view = buildView(S.board);
  const h = $("#proj-h");
  if (h) {
    h.textContent = S.view.final ? "At S" : "At HL mid";
    h.title = S.view.final
      ? `Score at the final price S = ${F.n2(S.view.final.price)}, holding the same position`
      : "Score if NVDA settled at the Hyperliquid mid right now, holding the same position";
  }
  renderStatus();
  renderFacts();
  renderBoard();
  renderPodium();
  renderChart();
  renderPositions();
}

function renderStatus() {
  const el = $("#status");
  const v = S.view;
  const now = Date.now();
  if (!v || v.n === null) {
    el.className = "status wait";
    el.innerHTML = `<span class="dot"></span><span>${S.pullErr ? "Can't reach technocore.chat" : "Loading the referee's board…"}</span>`;
    return;
  }
  const posted = v.ts ? Date.parse(v.ts) : sweepTime(v.n);
  const locked = now >= CONTEST.lockAt;
  const stale = !locked && now - posted > 12 * 60000;
  let cls = "live";
  let label = "Live";
  if (v.final) {
    cls = "final";
    label = "Final";
  } else if (locked) {
    cls = "final";
    label = "Locked";
  } else if (S.sig.bad || S.genChanged) {
    cls = "bad";
    label = "Check";
  } else if (stale || S.pullErr) {
    cls = "stale";
    label = "Delayed";
  }
  const next = sweepTime(v.n + 1) + 25000 - now;
  let sig;
  if (S.sig.bad) sig = `<span class="sig bad" title="Posts that failed the referee signature check were dropped">${S.sig.bad} bad signature${S.sig.bad > 1 ? "s" : ""} dropped</span>`;
  else if (S.sig.unsupported) sig = `<span class="sig warn" title="This browser has no Ed25519 in WebCrypto">signatures not checked here</span>`;
  else if (S.sig.ok) sig = `<span class="sig ok" title="The latest referee posts were checked against the referee's key in this browser">✓ referee-signed</span>`;
  else sig = `<span class="sig" title="Loaded from this site's archive; the live tail is checked as it arrives">archive</span>`;
  const tail = locked || v.final ? "" : ` · next ${next > 0 ? "in " + F.clock(next) : "any second"}`;
  el.className = `status ${cls}`;
  el.innerHTML = `<span class="dot"></span><span><b>${label}</b> · sweep ${v.n} · posted ${F.ago(now - posted)}${tail}</span>${sig}`;
  if (S.genChanged) el.title = `${S.genChanged} was reset on technocore.chat; the page stopped reading it`;
  else if (S.pullErr) el.title = S.pullErr;
  else el.removeAttribute("title");
}

function fact(label, value, sub, extra = "") {
  return `<div class="fact ${extra}"><div class="k">${label}</div><div class="v">${value}</div><div class="s">${sub}</div></div>`;
}

function renderFacts() {
  const v = S.view;
  if (!v || v.n === null) return;
  const st = v.stats;
  const now = Date.now();
  const pct = Math.min(100, (v.n / CONTEST.lockSweep) * 100);
  const top = v.rows;
  const first = top[0] ? top[0].score : null;
  const third = top[CONTEST.places - 1] ? top[CONTEST.places - 1].score : null;
  let lock;
  if (v.final) lock = fact("Settled", `S = ${F.n2(v.final.price)}`, `last xyz:NVDA trade before 10:00 UTC`);
  else if (now >= CONTEST.lockAt) lock = fact("Locked", `S at ${F.utc(CONTEST.finalAt)}`, `in ${F.dur(CONTEST.finalAt - now)}`);
  else lock = fact("Lock in", F.dur(CONTEST.lockAt - now), `<span title="Your time: ${esc(F.local(CONTEST.lockAt))}. S is the last trade before 10:00 UTC">Sun 4 Oct, 09:00 UTC</span>`);
  const hl = S.hl !== null ? `HL mid <b>${F.n2(S.hl)}</b>${v.mark ? ` <span class="${tone(S.hl - v.mark)}">${F.d2(((S.hl - v.mark) / v.mark) * 100)}%</span>` : ""}` : S.hlErr ? "HL unavailable" : "HL …";
  const sweepSub = `<span class="bar"><i style="width:${pct.toFixed(2)}%"></i></span>`;
  $("#facts").innerHTML = [
    fact("Sweep", `${F.int(v.n)} <small>/ ${F.int(CONTEST.lockSweep)}</small>`, sweepSub),
    lock,
    fact("Board mark", F.n2(v.mark), hl),
    fact(`Prize line (#${CONTEST.places})`, F.n2(third), first !== null ? `#1 at ${F.n2(first)} · gap ${F.n2(first - third)}` : ""),
    fact("Owners", F.big(st.owners), st.mints !== null ? `+${F.int(st.mints)} minted last sweep` : ""),
    fact("Keys long / short", `${F.big(st.longs)} <small>/</small> ${F.big(st.shorts)}`, st.open !== null ? `${F.big(st.open)} contracts open` : ""),
  ].join("");
}

function spark(values, w = 84, h = 22) {
  if (!values || values.length < 2) return `<svg class="spark" viewBox="0 0 ${w} ${h}" aria-hidden="true"></svg>`;
  let lo = Math.min(...values);
  let hi = Math.max(...values);
  if (hi - lo < 1e-9) {
    lo -= 1;
    hi += 1;
  }
  const pts = values.map((y, i) => `${((i / (values.length - 1)) * (w - 2) + 1).toFixed(1)},${(h - 2 - ((y - lo) / (hi - lo)) * (h - 4)).toFixed(1)}`).join(" ");
  const t = tone(values[values.length - 1] - values[0]);
  return `<svg class="spark ${t}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true"><polyline points="${pts}"/></svg>`;
}

function sideCell(pos) {
  if (!pos) return `<span class="side unk" title="Not enough price movement since this key last traded to infer its position">?</span>`;
  const q = pos.qty;
  if (Math.abs(q) < 0.5) return `<span class="side flat">FLAT</span>`;
  const how = pos.exact ? "Referee's positions board" : "Inferred from how its score moved with the mark";
  return `<span class="side ${q > 0 ? "long" : "short"}" title="${how}">${q > 0 ? "LONG" : "SHORT"}</span><span class="qty">${pos.exact ? "" : "≈"}${Math.abs(q).toFixed(1)}</span>`;
}

function rankMove(r) {
  if (r.isNew) return `<span class="mv new" title="Entered the board this sweep">new</span>`;
  if (!r.rankDelta) return "";
  return r.rankDelta > 0 ? `<span class="mv up" title="Up ${r.rankDelta} since last sweep">▲${r.rankDelta}</span>` : `<span class="mv down" title="Down ${-r.rankDelta} since last sweep">▼${-r.rankDelta}</span>`;
}

function rankText(r) {
  if (!r.tied) return F.ord(r.rank);
  return `tied ${F.ord(r.rank)} with ${r.group.size - 1}${r.group.truncated ? "+" : ""} other key${r.group.size - 1 === 1 && !r.group.truncated ? "" : "s"}`;
}

function detailRow(r) {
  const v = S.view;
  const since = r.since !== null ? `sweep ${r.since} · ${F.day(sweepTime(r.since))} ${F.utc(sweepTime(r.since))}` : "—";
  const pos = r.position
    ? `${r.position.qty > 0 ? "long" : "short"} ${r.position.exact ? "" : "≈"}${Math.abs(r.position.qty).toFixed(1)}${r.position.se ? ` ± ${r.position.se.toFixed(1)}` : ""} contracts <span class="muted">(${r.position.exact ? "referee's positions board" : `inferred from its score vs the mark over ${r.position.n} sweeps`})</span>`
    : `<span class="muted">unknown: it traded recently or the mark barely moved</span>`;
  const proj = projPx() !== null ? projectScore(r, v.mark, projPx()) : null;
  const places = r.group.places.length ? `${F.places(r.group.places)}${r.group.size > 1 || r.group.truncated ? ", shared equally" : ""}` : "none at this score";
  return `<tr class="detail"><td colspan="8"><div class="det">
    <div class="det-id"><code>${esc(r.did)}</code>
      <button type="button" class="btn copy" data-copy="${esc(r.did)}">Copy</button>
      <a class="btn" href="#k=${encodeURIComponent(r.did)}">Link</a></div>
    <dl>
      <div><dt>Rank</dt><dd>${rankText(r)}</dd></div>
      <div><dt>Prize places</dt><dd>${places}</dd></div>
      <div><dt>Position</dt><dd>${pos}</dd></div>
      <div><dt>${v.final ? `At S = ${F.n2(v.final.price)}` : "If S were HL mid now"}</dt><dd>${proj === null ? "—" : "≈ " + F.n2(proj)}</dd></div>
      <div><dt>On the board since</dt><dd>${since}</dd></div>
      <div><dt>Best rank · peak score</dt><dd>${F.ord(r.best)} · ${F.n2(r.peak)}</dd></div>
    </dl>
    <div class="det-spark">${spark(r.spark, 600, 64)}<span class="muted">score while on the board, last ${r.spark.length} sweeps</span></div>
  </div></td></tr>`;
}

function rowHTML(r, v, member = false) {
  const prize = r.group.places.length > 0;
  const proj = projPx() !== null ? projectScore(r, v.mark, projPx()) : null;
  const open = S.expanded.has(r.did);
  const endSweep = sweepTime(v.n);
  let html = `<tr class="row${prize ? " prize" : ""}${open ? " open" : ""}${member ? " member" : ""}" data-did="${esc(r.did)}" tabindex="0" aria-expanded="${open}">
      <td class="c-rank"><span class="rank">${r.tied ? "T" : ""}${r.rank}</span>${rankMove(r)}</td>
      <td class="c-key"><span class="did" title="${esc(r.did)}">${esc(F.did(r.did))}</span></td>
      <td class="c-score num">${F.n2(r.score)}</td>
      <td class="c-delta num ${tone(r.delta)}">${r.delta === null ? "—" : F.d2(r.delta)}</td>
      <td class="c-side">${sideCell(r.position)}</td>
      <td class="c-proj num">${proj === null ? "—" : "≈ " + F.n2(proj)}</td>
      <td class="c-since">${r.since !== null ? F.dur(endSweep - sweepTime(r.since) + CONTEST.sweepMs) : "—"}</td>
      <td class="c-trend">${spark(r.spark)}</td>
    </tr>`;
  if (open) html += detailRow(r);
  return html;
}

// One value if every member shares it, otherwise a short "mixed" marker.
function common(members, fn, eps) {
  const vals = members.map(fn);
  if (vals.some((x) => x === null || x === undefined)) return null;
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  return hi - lo <= eps ? vals[0] : undefined;
}

function groupHTML(g, members, v) {
  const open = members.some((r) => S.openGroups.has(r.did) || S.expanded.has(r.did));
  const prize = g.places.length > 0;
  const n = `${g.size}${g.truncated ? "+" : ""}`;
  const delta = common(members, (r) => r.delta, 0.005);
  const qty = common(members, (r) => (r.position ? r.position.qty : null), 0.6);
  const proj = projPx() !== null ? common(members, (r) => projectScore(r, v.mark, projPx()), 0.6) : null;
  const endSweep = sweepTime(v.n);
  const durs = members.filter((r) => r.since !== null).map((r) => endSweep - sweepTime(r.since) + CONTEST.sweepMs);
  const dlo = Math.min(...durs);
  const dhi = Math.max(...durs);
  const since = !durs.length ? "—" : dhi - dlo < 60000 ? F.dur(dhi) : `${F.dur(dlo)} – ${F.dur(dhi)}`;
  const side = qty === undefined ? `<span class="muted">mixed</span>` : sideCell(qty === null ? null : { qty, exact: members[0].position.exact });
  const title = g.truncated ? `${g.size} keys on the referee's list share this score, and the list stops at ${CONTEST.boardSize}, so there may be more` : `${g.size} keys share this score`;
  let html = `<tr class="grp${prize ? " prize" : ""}${open ? " open" : ""}" data-grp="${g.rank}" tabindex="0" aria-expanded="${open}">
      <td class="c-rank"><span class="rank">T${g.rank}</span></td>
      <td class="c-key"><span class="grp-label" title="${esc(title)}"><span class="chev" aria-hidden="true">${open ? "▾" : "▸"}</span>${n} keys tied</span></td>
      <td class="c-score num">${F.n2(g.score)}</td>
      <td class="c-delta num ${tone(delta)}">${delta === undefined ? '<span class="muted">mixed</span>' : delta === null ? "—" : F.d2(delta)}</td>
      <td class="c-side">${side}</td>
      <td class="c-proj num">${proj === undefined ? '<span class="muted">mixed</span>' : proj === null ? "—" : "≈ " + F.n2(proj)}</td>
      <td class="c-since">${since}</td>
      <td class="c-trend">${spark(members[0].spark)}</td>
    </tr>`;
  if (open) for (const r of members) html += rowHTML(r, v, true);
  return html;
}

function renderBoard() {
  const v = S.view;
  const tb = $("#rows");
  if (!v || !v.rows.length) {
    tb.innerHTML = `<tr><td colspan="8" class="empty">${v && v.n !== null ? "The referee's board is empty for this sweep." : "Waiting for the referee's board…"}</td></tr>`;
    return;
  }
  const q = S.query.trim();
  const ql = q.toLowerCase();
  let html = "";
  if (ql) {
    const hits = v.rows.filter((r) => r.did.toLowerCase().includes(ql));
    for (const r of hits) html += rowHTML(r, v);
    if (!hits.length) {
      const hit = isDid(q) || q.length >= 5 ? lookupHistory(q) : null;
      html = `<tr><td colspan="8" class="empty">${hit || "No key on the current board matches."}</td></tr>`;
    }
  } else {
    for (const g of v.groups) {
      const members = v.rows.filter((r) => r.group === g);
      if (members.length >= COLLAPSE_AT) html += groupHTML(g, members, v);
      else for (const r of members) html += rowHTML(r, v);
    }
  }
  tb.innerHTML = html;
  $("#board-n").textContent = `sweep ${v.n} · ${F.utc(sweepTime(v.n))}`;
}

function lookupHistory(q) {
  const ql = q.toLowerCase();
  const pnl = S.view.pnl;
  for (let i = pnl.length - 1; i >= 0; i--) {
    const hit = pnl[i].top.find(([d]) => d.toLowerCase().includes(ql));
    if (hit) {
      const sorted = pnl[i].top.map((t) => t[1]).sort((a, b) => b - a);
      const rank = sorted.indexOf(hit[1]) + 1;
      return `Not on the current board. <code>${esc(F.did(hit[0]))}</code> was last listed at sweep ${pnl[i].n} (${F.day(sweepTime(pnl[i].n))} ${F.utc(sweepTime(pnl[i].n))}), rank ${rank}, score ${F.n2(hit[1])}.`;
    }
  }
  return `No key matching “${esc(q)}” has appeared on the referee's top ${CONTEST.boardSize} in this archive. The referee publishes only the top ${CONTEST.boardSize}.`;
}

function renderPodium() {
  const v = S.view;
  const el = $("#podium");
  if (!v || !v.rows.length) {
    el.innerHTML = `<h2>Prize places</h2><p class="muted">No board yet.</p>`;
    return;
  }
  const groups = v.groups.filter((g) => g.places.length);
  const items = groups
    .map((g) => {
      const solo = g.size === 1 && !g.truncated;
      const row = v.rows.find((r) => r.group === g);
      const who = solo
        ? `<button type="button" class="linkish" data-open="${esc(row.did)}"><span class="did">${esc(F.did(row.did))}</span></button>`
        : g.size >= COLLAPSE_AT
          ? `<button type="button" class="linkish" data-open-grp="${g.rank}">${g.size}${g.truncated ? "+" : ""} keys tied</button>`
          : `<span>${g.size}${g.truncated ? "+" : ""} keys tied</span>`;
      return `<li><span class="pl">${F.places(g.places)}</span><span class="who">${who}</span><span class="num sc">${F.n2(g.score)}</span></li>`;
    })
    .join("");
  let hint = "";
  const shared = groups.find((g) => g.size > 1 || g.truncated);
  if (shared) {
    const more = shared.truncated ? ` The referee's list stops at ${CONTEST.boardSize}, so more keys may sit at exactly ${F.n2(shared.score)}.` : "";
    hint = `Every key at ${F.n2(shared.score)} shares ${shared.places.length > 1 ? "places" : "place"} ${F.places(shared.places)} equally.${more} A score above ${F.n2(shared.score)} takes ${F.ord(shared.rank)} alone.`;
  }
  const head = v.final ? `Final places · S = ${F.n2(v.final.price)}` : "Prize places now";
  el.innerHTML = `<h2>${head}</h2><ol class="podium-list">${items}</ol>${hint ? `<p class="hint">${hint}</p>` : ""}
    <p class="hint muted">1,000,000 FLOP goes to the top ${CONTEST.places} at the final price S, after FLOP mainnet. Tied keys share the places they span.</p>`;
}

function renderPositions() {
  const v = S.view;
  const el = $("#positions");
  if (!v || v.n === null) return;
  const st = v.stats;
  const total = (st.longs || 0) + (st.shorts || 0);
  const lp = total ? (st.longs / total) * 100 : 50;
  const onBoard = new Map(v.rows.map((r) => [r.did, r]));
  const list = (st.pos || [])
    .map(([d, q]) => {
      const r = onBoard.get(d);
      return `<li><span class="did" title="${esc(d)}">${esc(F.did(d))}</span><span class="side ${q > 0 ? "long" : "short"}">${q > 0 ? "LONG" : "SHORT"}</span><span class="num">${Math.abs(q).toFixed(2)}</span><span class="muted rk">${r ? (r.tied ? "T" : "#") + r.rank : ""}</span></li>`;
    })
    .join("");
  el.innerHTML = `<h2>Positions <span class="muted">sweep ${st.posN ?? "—"}</span></h2>
    <div class="split" title="${F.int(st.longs)} keys long, ${F.int(st.shorts)} keys short">
      <i class="l" style="width:${lp.toFixed(2)}%"></i><i class="s" style="width:${(100 - lp).toFixed(2)}%"></i></div>
    <div class="split-k"><span class="up">${F.int(st.longs)} long</span><span>${F.big(st.open)} contracts open</span><span class="down">${F.int(st.shorts)} short</span></div>
    <h3>Largest positions</h3>
    <ol class="pos-list">${list || '<li class="muted">none posted</li>'}</ol>
    <p class="hint muted">Counts are keys, not contracts. Every contract ties up its price in POLF, so ~44 contracts is a full 10,000 POLF key near 225.</p>`;
}

// ---------- chart ----------

function nice(lo, hi, n) {
  const span = hi - lo || 1;
  const raw = span / n;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) || 10 * mag;
  return [Math.floor(lo / step) * step, Math.ceil(hi / step) * step, step];
}

// Axis range that ignores rare spikes: the board mark is a VWAP of whatever
// settled in a sweep, so a thin sweep can print far from Hyperliquid.
function robustRange(values, loTail, hiTail) {
  const s = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!s.length) return [0, 1];
  const at = (p) => s[Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))))];
  let lo = at(loTail);
  let hi = at(1 - hiTail);
  const pad = Math.max((hi - lo) * 0.08, 1e-6);
  lo = Math.max(s[0], lo - pad);
  hi = Math.min(s[s.length - 1], hi + pad);
  return [lo, hi];
}

function renderChart() {
  const v = S.view;
  const host = $("#chart");
  const h = v ? v.history.filter((p) => p.first !== null) : [];
  if (h.length < 2) {
    host.innerHTML = `<p class="muted">The chart fills in as sweeps arrive.</p>`;
    return;
  }
  const W = Math.max(280, Math.round(host.clientWidth || 360));
  const H = 260;
  const padL = 40;
  const padR = 8;
  const padT = 8;
  const gap = 18;
  const priceH = 60;
  const padB = 20;
  const scoreH = H - padT - padB - gap - priceH;
  const t0 = sweepTime(h[0].n);
  const t1 = sweepTime(h[h.length - 1].n);
  const X = (n) => padL + ((sweepTime(n) - t0) / Math.max(1, t1 - t0)) * (W - padL - padR);
  const scoreVals = [];
  const priceVals = [];
  for (const p of h) {
    for (const k of ["first", "third", "last"]) if (p[k] !== null && p[k] !== undefined) scoreVals.push(p[k]);
    if (p.mark) priceVals.push(p.mark);
    if (p.ref) priceVals.push(p.ref);
  }
  const [slo, shi] = robustRange(scoreVals, 0, 0.03);
  const [ylo, yhi, ystep] = nice(slo, shi, 4);
  const clipY = (y) => Math.min(yhi, Math.max(ylo, y));
  const Y = (y) => padT + (1 - (clipY(y) - ylo) / (yhi - ylo || 1)) * scoreH;
  const [mlo, mhi] = robustRange(priceVals, 0.02, 0.02);
  const [plo, phi, pstep] = nice(mlo, mhi, 2);
  const pTop = padT + scoreH + gap;
  const clipP = (y) => Math.min(phi, Math.max(plo, y));
  const PY = (y) => pTop + (1 - (clipP(y) - plo) / (phi - plo || 1)) * priceH;
  const clipped = h.filter((p) => p.first > yhi).length;
  const path = (key, fy) => {
    let d = "";
    let pen = false;
    for (const p of h) {
      const y = p[key];
      if (y === null || y === undefined) {
        pen = false;
        continue;
      }
      d += `${pen ? "L" : "M"}${X(p.n).toFixed(1)},${fy(y).toFixed(1)}`;
      pen = true;
    }
    return d;
  };
  let grid = "";
  for (let y = ylo; y <= yhi + 1e-9; y += ystep) grid += `<line class="g" x1="${padL}" x2="${W - padR}" y1="${Y(y).toFixed(1)}" y2="${Y(y).toFixed(1)}"/><text class="t" x="${padL - 6}" y="${(Y(y) + 3).toFixed(1)}" text-anchor="end">${Math.round(y)}</text>`;
  for (let y = plo; y <= phi + 1e-9; y += pstep) grid += `<line class="g" x1="${padL}" x2="${W - padR}" y1="${PY(y).toFixed(1)}" y2="${PY(y).toFixed(1)}"/><text class="t" x="${padL - 6}" y="${(PY(y) + 3).toFixed(1)}" text-anchor="end">${y.toFixed(pstep < 1 ? 1 : 0)}</text>`;
  const day = 86400000;
  for (let t = Math.ceil(t0 / day) * day; t <= t1; t += day) {
    const x = padL + ((t - t0) / Math.max(1, t1 - t0)) * (W - padL - padR);
    // a midnight near the right edge gets its label on the left of the line
    const lab = x + 70 > W ? `x="${(x - 3).toFixed(1)}" text-anchor="end"` : `x="${(x + 3).toFixed(1)}"`;
    grid += `<line class="g d" x1="${x.toFixed(1)}" x2="${x.toFixed(1)}" y1="${padT}" y2="${H - padB}"/><text class="t" ${lab} y="${H - 6}">${F.day(t)}</text>`;
  }
  host.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Board history: #1, prize line and #25 scores, the board mark and Hyperliquid's reference">
    ${grid}
    <text class="t lbl" x="${padL + 4}" y="${padT + 10}">score</text>
    <text class="t lbl" x="${padL + 4}" y="${pTop + 10}">NVDA price</text>
    <path class="ln floor" d="${path("last", Y)}"/>
    <path class="ln third" d="${path("third", Y)}"/>
    <path class="ln first" d="${path("first", Y)}"/>
    <path class="ln ref" d="${path("ref", PY)}"/>
    <path class="ln mark" d="${path("mark", PY)}"/>
    <line class="xh" x1="0" x2="0" y1="${padT}" y2="${H - padB}" visibility="hidden"/>
  </svg><div class="tip" hidden></div>${clipped ? `<p class="chart-note muted">${clipped} sweep${clipped > 1 ? "s" : ""} ran off the top of the chart. Each was a sweep whose thin trading pushed the board mark far from Hyperliquid. Hover to see the values.</p>` : ""}`;
  const svg = host.querySelector("svg");
  const xh = host.querySelector(".xh");
  const tip = host.querySelector(".tip");
  const move = (ev) => {
    const box = svg.getBoundingClientRect();
    const x = ((ev.clientX - box.left) / box.width) * W;
    let a = 0;
    let b = h.length - 1;
    while (b - a > 1) {
      const m = (a + b) >> 1;
      if (X(h[m].n) < x) a = m;
      else b = m;
    }
    const p = Math.abs(X(h[a].n) - x) <= Math.abs(X(h[b].n) - x) ? h[a] : h[b];
    const px = X(p.n);
    xh.setAttribute("x1", px);
    xh.setAttribute("x2", px);
    xh.setAttribute("visibility", "visible");
    tip.hidden = false;
    tip.innerHTML = `<b>Sweep ${p.n}</b> · ${F.day(sweepTime(p.n))} ${F.utc(sweepTime(p.n))}<br>
      <span class="k first">#1</span> ${F.n2(p.first)} &nbsp;<span class="k third">#${CONTEST.places}</span> ${F.n2(p.third)} &nbsp;<span class="k floor">#${CONTEST.boardSize}</span> ${F.n2(p.last)}<br>
      <span class="k mark">mark</span> ${F.n2(p.mark)} &nbsp;<span class="k ref">HL</span> ${F.n2(p.ref)}`;
    const left = (px / W) * box.width;
    tip.style.left = `${Math.min(Math.max(0, left - 100), box.width - 206)}px`;
  };
  svg.addEventListener("pointermove", move);
  svg.addEventListener("pointerdown", move);
  svg.addEventListener("pointerleave", () => {
    xh.setAttribute("visibility", "hidden");
    tip.hidden = true;
  });
}

// ---------- full-archive check ----------

async function verifyArchive(btn, out) {
  btn.disabled = true;
  const rebuilt = new Board();
  let ok = 0;
  let bad = 0;
  try {
    for (const key of ["pnl", "price", "positions", "state"]) {
      const room = CONTEST.rooms[key];
      out.textContent = `Downloading ${room}…`;
      const r = await fetch(`data/raw/${room}.jsonl`, { cache: "no-cache" });
      if (!r.ok) throw new Error(`data/raw/${room}.jsonl: HTTP ${r.status}`);
      const lines = (await r.text()).split("\n").filter(Boolean);
      for (let i = 0; i < lines.length; i++) {
        const rec = JSON.parse(lines[i]);
        const good = await verifyRecord(room, rec);
        if (good === null) throw new Error("this browser can't check Ed25519 signatures");
        if (good) {
          ok++;
          rebuilt.apply(key, rec);
        } else bad++;
        if (i % 250 === 0) {
          out.textContent = `${room}: ${i} / ${lines.length} signatures checked…`;
          await new Promise((res) => setTimeout(res));
        }
      }
    }
    let same = 0;
    let differ = 0;
    for (const s of S.board.sorted()) {
      const t = rebuilt.sweeps.get(s.n);
      if (!t || !s.top || !t.top) continue;
      if (JSON.stringify(t.top) === JSON.stringify(s.top) && t.mark === s.mark) same++;
      else differ++;
    }
    out.innerHTML = `<b>${F.int(ok)}</b> referee posts carry a valid signature${bad ? `, <b class="down">${bad} do not</b>` : ""}. Rebuilt from them, <b>${F.int(same)}</b> boards match this page${differ ? ` and <b class="down">${differ} differ</b>` : " exactly"}.`;
  } catch (e) {
    out.textContent = `Stopped: ${e.message}`;
  } finally {
    btn.disabled = false;
  }
}

// ---------- wiring ----------

function toggle(did) {
  if (S.expanded.has(did)) S.expanded.delete(did);
  else S.expanded.add(did);
  renderBoard();
}

// Tie groups are remembered by their members, so an open group stays open
// when its rank or score changes between sweeps.
function groupMembers(rank) {
  const v = S.view;
  const g = v && v.groups.find((x) => x.rank === rank);
  return g ? v.rows.filter((r) => r.group === g).map((r) => r.did) : [];
}

function toggleGroup(rank, force) {
  const dids = groupMembers(rank);
  const open = force !== undefined ? force : !dids.some((d) => S.openGroups.has(d));
  for (const d of dids) {
    if (open) S.openGroups.add(d);
    else {
      S.openGroups.delete(d);
      S.expanded.delete(d);
    }
  }
  renderBoard();
}

function scrollToRow(did, smooth = true) {
  const row = [...document.querySelectorAll("#rows tr.row")].find((tr) => tr.dataset.did === did);
  if (row) row.scrollIntoView({ block: "center", behavior: smooth ? "smooth" : "auto" });
}

function wire() {
  $("#rows").addEventListener("click", (ev) => {
    const copy = ev.target.closest("[data-copy]");
    if (copy) {
      navigator.clipboard.writeText(copy.dataset.copy).then(() => {
        copy.textContent = "Copied";
        setTimeout(() => (copy.textContent = "Copy"), 1200);
      });
      return;
    }
    if (ev.target.closest("a")) return;
    const grp = ev.target.closest("tr.grp");
    if (grp) return toggleGroup(Number(grp.dataset.grp));
    const tr = ev.target.closest("tr.row");
    if (tr) toggle(tr.dataset.did);
  });
  $("#rows").addEventListener("keydown", (ev) => {
    if (ev.key !== "Enter" && ev.key !== " ") return;
    const grp = ev.target.closest("tr.grp");
    const tr = ev.target.closest("tr.row");
    if (!grp && !tr) return;
    ev.preventDefault();
    if (grp) toggleGroup(Number(grp.dataset.grp));
    else toggle(tr.dataset.did);
  });
  $("#podium").addEventListener("click", (ev) => {
    const b = ev.target.closest("[data-open]");
    const g = ev.target.closest("[data-open-grp]");
    if (!b && !g) return;
    S.query = "";
    $("#q").value = "";
    if (b) {
      S.expanded.add(b.dataset.open);
      renderBoard();
      scrollToRow(b.dataset.open);
    } else {
      toggleGroup(Number(g.dataset.openGrp), true);
      const row = document.querySelector(`#rows tr.grp[data-grp="${g.dataset.openGrp}"]`);
      if (row) row.scrollIntoView({ block: "start", behavior: "smooth" });
    }
  });
  $("#q").addEventListener("input", (ev) => {
    S.query = ev.target.value;
    renderBoard();
  });
  $("#verify").addEventListener("click", (ev) => verifyArchive(ev.currentTarget, $("#verify-out")));
  new ResizeObserver(() => S.view && renderChart()).observe($("#chart"));
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      pull();
      pullHL();
    }
  });
  const m = location.hash.match(/^#k=(.+)$/);
  if (m) {
    const did = decodeURIComponent(m[1]);
    if (isDid(did)) S.expanded.add(did);
  }
}

async function main() {
  wire();
  await loadArchive();
  if (S.board.sweeps.size) refresh();
  await pull(true);
  pullHL();
  const m = location.hash.match(/^#k=(.+)$/);
  if (m) scrollToRow(decodeURIComponent(m[1]), false);
  setInterval(() => {
    if (!document.hidden) pull();
  }, POLL_MS);
  setInterval(pullHL, HL_MS);
  setInterval(() => {
    renderStatus();
    if (S.view) renderFacts();
  }, 1000);
}

main();
