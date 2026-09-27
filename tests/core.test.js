import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CONTEST, Board, rankRows, parsePost, verifyRecord, buildView, estimatePosition, didPublicKey, latestJSON } from "../core.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RAW = path.join(ROOT, "data", "raw");
const D = (s) => "did:key:z6Mk" + s.padEnd(44, "x");

test("referee did decodes to a 32-byte Ed25519 key", () => {
  assert.equal(didPublicKey(CONTEST.referee).length, 32);
  assert.throws(() => didPublicKey("did:key:zQ3sh"), /did:key/);
});

test("ranks follow the fold: score desc, ties share the places they span", () => {
  const top = [[D("b"), 10], [D("a"), 12], [D("c"), 10], [D("d"), 5]];
  const { rows, groups } = rankRows(top, 3, 25);
  assert.deepEqual(rows.map((r) => [r.did, r.rank]), [[D("a"), 1], [D("b"), 2], [D("c"), 2], [D("d"), 4]]);
  assert.deepEqual(groups.map((g) => g.places), [[1], [2, 3], []]);
  assert.equal(rows[1].tied, true);
  assert.equal(rows[0].tied, false);
});

test("a tie that reaches the bottom of a full board is marked as possibly longer", () => {
  const top = [[D("top"), 100]];
  for (let i = 0; i < 24; i++) top.push([D("t" + String(i).padStart(2, "0")), 92.43]);
  const { groups } = rankRows(top, 3, 25);
  assert.equal(groups.length, 2);
  assert.equal(groups[1].truncated, true);
  assert.deepEqual(groups[1].places, [2, 3]);
  const short = rankRows(top.slice(0, 10), 3, 25);
  assert.equal(short.groups[1].truncated, false);
});

test("unknown or malformed posts are ignored", () => {
  assert.equal(parsePost("pnl", { text: "not json" }), null);
  assert.equal(parsePost("pnl", { text: JSON.stringify({ t: "pnl", n: "7" }) }), null);
  const p = parsePost("pnl", { ts: "x", text: JSON.stringify({ t: "pnl", n: 7, mark: "1.5", top: [["nope", "1"], [D("a"), "2.5"]] }) });
  assert.deepEqual(p.patch.top, [[D("a"), 2.5]]);
});

test("a forged post fails verification", async () => {
  const rec = { from: CONTEST.referee, nonce: 1, text: "{}", sig: "A".repeat(86) };
  assert.equal(await verifyRecord("d-close1-pnl", rec), false);
  assert.equal(await verifyRecord("d-close1-pnl", { ...rec, from: D("z") }), false);
});

const haveRaw = fs.existsSync(path.join(RAW, "d-close1-pnl.jsonl"));

function loadRaw(room) {
  return fs
    .readFileSync(path.join(RAW, `${room}.jsonl`), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

test("archived referee posts verify and rebuild the published board", { skip: !haveRaw }, async () => {
  const board = new Board();
  for (const key of ["pnl", "price", "positions", "state"]) {
    const room = CONTEST.rooms[key];
    for (const rec of loadRaw(room)) {
      assert.equal(await verifyRecord(room, rec), true, `${room} seq ${rec.seq}`);
      board.apply(key, rec);
    }
  }
  const pnl = board.sorted().filter((s) => s.top);
  assert.ok(pnl.length > 100);
  // the referee's mark is the global price of the same sweep
  let checked = 0;
  for (const s of pnl) {
    if (s.global !== undefined && s.mark !== null) {
      assert.equal(s.mark, s.global, `sweep ${s.n}`);
      checked++;
    }
  }
  assert.ok(checked > 100);
  // our order matches the referee's own order for every sweep
  for (const s of pnl) {
    const ours = rankRows(s.top).rows.map((r) => r.did);
    assert.deepEqual(ours, s.top.map((t) => t[0]), `sweep ${s.n}`);
  }
  // round trip through the compact file
  const again = new Board(JSON.parse(JSON.stringify(board.toJSON())));
  assert.deepEqual(again.sorted().map((s) => s.top), board.sorted().map((s) => s.top));
  const view = buildView(again);
  const latest = latestJSON(again, view);
  assert.equal(latest.board.length, view.rows.length);
});

test("the position estimate recovers a known position from rounded referee numbers", () => {
  // score = cash + q*mark, with the mark posted rounded to 0.01 and the score to 0.01
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (const q of [-44.6, -41.8, 12.3, 43.9]) {
    const pts = [];
    let px = 224;
    for (let i = 0; i < 24; i++) {
      px += (rnd() - 0.5) * 0.8;
      const exact = px + (rnd() - 0.5) * 0.01;
      pts.push([Math.round(px * 100) / 100, Math.round((150 + q * (exact - 224)) * 100) / 100]);
    }
    const est = estimatePosition(pts);
    assert.ok(est, `no estimate for ${q}`);
    assert.ok(Math.abs(est.qty - q) <= Math.max(0.6, 2 * est.se), `q ${q} est ${est.qty} se ${est.se}`);
  }
  // a key that traded mid-window: the long fit is refused, the short one only uses
  // points after the trade, so it reports the position the key holds now
  const jump = (at) => {
    const pts = [];
    for (let i = 0; i < 24; i++) {
      const m = 224 + (i % 2 ? 1 : -1) * (0.3 + i * 0.05);
      pts.push([m, (i < at ? -40 : 40) * (m - 224) + (i < at ? 0 : 30)]);
    }
    return pts;
  };
  const after = estimatePosition(jump(12));
  assert.equal(after.n, 10);
  assert.ok(Math.abs(after.qty - 40) < 0.01);
  // a trade inside the last 10 sweeps leaves no clean window: refuse rather than average
  assert.equal(estimatePosition(jump(19)), null);
});

test("inferred positions agree with the referee's positions board where both exist", { skip: !haveRaw }, (t) => {
  const board = new Board();
  for (const key of ["pnl", "price", "positions"]) for (const rec of loadRaw(CONTEST.rooms[key])) board.apply(key, rec);
  const sweeps = board.sorted();
  const byN = new Map(sweeps.map((s) => [s.n, s]));
  let cmp = 0;
  let worst = 0;
  let refused = 0;
  for (const s of sweeps) {
    if (!s.pos || !s.top) continue;
    for (const [did, qty] of s.pos) {
      if (!s.top.some((t) => t[0] === did)) continue;
      const series = [];
      for (let n = s.n; n > s.n - 30; n--) {
        const t = byN.get(n);
        const hit = t && t.top && t.top.find((x) => x[0] === did);
        if (!hit) break;
        series.unshift([t.mark, hit[1]]);
      }
      const est = estimatePosition(series);
      if (!est) {
        refused++;
        continue;
      }
      cmp++;
      worst = Math.max(worst, Math.abs(est.qty - qty));
    }
  }
  if (!cmp) {
    t.skip(`no key sat on both boards long enough to compare (${refused} refused)`);
    return;
  }
  console.log(`positions compared ${cmp}, refused ${refused}, worst error ${worst.toFixed(3)}`);
  assert.ok(worst < 1.5, `worst ${worst}`);
});
