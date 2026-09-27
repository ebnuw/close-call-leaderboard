#!/usr/bin/env node
// Copy the referee's rooms into data/ before technocore.chat's ring forgets them.
// Every record is checked against the referee's Ed25519 key; anything else is dropped.
//
//   node tools/archive.mjs            read what's new, verify, merge, write data/
//   node tools/archive.mjs --offline  rebuild data/board.json and data/latest.json from data/raw only
//
// A normal run asks each room only for records after the last one held
// (?since=&limit=200, which returns the newest records after `since`). If that
// read doesn't join up with the archive, the run takes the room's whole export.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CONTEST, Board, verifyRecord, buildView, latestJSON } from "../core.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA = path.join(ROOT, "data");
const RAW = path.join(DATA, "raw");
const KEPT = ["pnl", "price", "positions", "state"]; // raw JSONL kept in full
const OFFLINE = process.argv.includes("--offline");
const UA = "close-call-leaderboard/1 (read-only archive of the close-1 referee rooms)";
const READ_LIMIT = 200;

const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

async function readJSON(file) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}

async function readLines(file) {
  try {
    return (await fs.readFile(file, "utf8")).split("\n").filter(Boolean);
  } catch (e) {
    if (e.code === "ENOENT") return [];
    throw e;
  }
}

async function get(url) {
  for (let attempt = 1; ; attempt++) {
    try {
      const r = await fetch(url, { headers: { "user-agent": UA } });
      if (r.status === 429 && attempt < 4) {
        await sleep(15000);
        continue;
      }
      if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
      return r;
    } catch (e) {
      if (attempt >= 4) throw e;
      await sleep(5000 * attempt);
    }
  }
}

// Parse a JSONL line, keeping the nonce's exact digits (it can exceed 2^53).
function parseLine(line) {
  const m = line.match(/"nonce":([0-9]{1,19})[,}]/);
  const rec = JSON.parse(line);
  if (m) rec.nonce = m[1];
  return rec;
}

// The export's line for a record, rebuilt from a ?format=json message.
// Same fields, same order, same serializer as the stored file.
function toLine(m) {
  return `{"seq":${m.seq},"ts":${JSON.stringify(m.ts)},"from":${JSON.stringify(m.from)},"text":${JSON.stringify(m.text)},"nonce":${m.nonce},"sig":${JSON.stringify(m.sig)}}`;
}

const MSG_KEYS = "seq,ts,from,text,nonce,sig";

async function exportRoom(room) {
  const r = await get(`${CONTEST.api}/r/${room}/export`);
  const gen = r.headers.get("x-room-generation");
  const lines = (await r.text()).split("\n").filter(Boolean);
  return { gen: gen === null ? null : Number(gen), lines, how: "export" };
}

// Records after `since`, or null when they don't join up with it.
async function readSince(room, since) {
  const r = await get(`${CONTEST.api}/r/${room}?format=json&limit=${READ_LIMIT}` + (since ? `&since=${since}` : ""));
  const raw = await r.text();
  // Quote each message's nonce before parsing so no digit is lost. Inside a
  // message's text the key reads \"nonce\": and doesn't match.
  const d = JSON.parse(raw.replace(/"nonce":([0-9]{1,19})([,}])/g, '"nonce":"$1"$2'));
  if (!d || !Array.isArray(d.messages)) return null;
  const msgs = d.messages.filter((m) => m.seq > since).sort((a, b) => a.seq - b.seq);
  if (msgs.length && msgs[0].seq !== since + 1) return null;
  const lines = [];
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (i && m.seq !== msgs[i - 1].seq + 1) return null;
    if (Object.keys(m).join(",") !== MSG_KEYS || typeof m.nonce !== "string") return null;
    lines.push(toLine(m));
  }
  return { gen: typeof d.generation === "number" ? d.generation : null, lines, how: "read" };
}

async function fetchNew(room, since) {
  if (since) {
    const d = await readSince(room, since);
    if (d) return d;
  }
  return exportRoom(room);
}

async function verifiedLines(room, lines) {
  const out = [];
  let bad = 0;
  for (const line of lines) {
    let rec;
    try {
      rec = parseLine(line);
    } catch {
      bad++;
      continue;
    }
    const ok = await verifyRecord(room, rec);
    if (ok === null) throw new Error("this Node has no Ed25519 in WebCrypto; refusing to touch the archive (use Node >= 20)");
    if (ok) out.push({ line, rec });
    else bad++;
  }
  return { out, bad };
}

function checkGen(gen, key, room, got) {
  if (gen[key] !== undefined && got !== null && got !== gen[key]) {
    throw new Error(`${room}: room generation changed ${gen[key]} -> ${got}; refusing to merge`);
  }
  if (got !== null) gen[key] = got;
}

async function main() {
  await fs.mkdir(RAW, { recursive: true });
  const prevData = await readJSON(path.join(DATA, "board.json"));
  const prev = prevData ? new Board(prevData) : null;
  const gen = { ...(prev ? prev.gen : {}) };
  const board = new Board();
  let problems = 0;

  // raw rooms: merge what we hold with what the room has now
  for (const key of KEPT) {
    const room = CONTEST.rooms[key];
    const file = path.join(RAW, `${room}.jsonl`);
    const heldLines = await readLines(file);
    const held = await verifiedLines(room, heldLines);
    if (held.bad) {
      log(`${room}: ${held.bad} archived lines failed verification and were dropped`);
      problems++;
    }
    if (heldLines.length && held.bad > heldLines.length / 2) {
      throw new Error(`${room}: most archived lines failed verification; refusing to rewrite the archive`);
    }
    let merged = held.out;
    if (!OFFLINE) {
      const top = held.out.length ? held.out[held.out.length - 1].rec.seq : 0;
      const got = await fetchNew(room, top);
      checkGen(gen, key, room, got.gen);
      const fresh = await verifiedLines(room, got.lines);
      if (fresh.bad) log(`${room}: ${fresh.bad} fetched lines failed verification and were dropped`);
      const add = fresh.out.filter((x) => x.rec.seq > top);
      const firstNew = add.length ? add[0].rec.seq : null;
      if (top && firstNew !== null && firstNew > top + 1) {
        log(`${room}: gap, seq ${top + 1}..${firstNew - 1} left the ring before this archive saw them`);
        problems++;
      }
      merged = held.out.concat(add);
      log(`${room}: held ${held.out.length}, ${got.how} ${got.lines.length}, added ${add.length}`);
    }
    merged.sort((a, b) => a.rec.seq - b.rec.seq);
    await fs.writeFile(file, merged.map((x) => x.line).join("\n") + (merged.length ? "\n" : ""));
    for (const { rec } of merged) board.apply(key, rec);
  }

  // flow: ~5 KB a post, so keep only its per-sweep counts, carried over between runs
  if (prev) {
    for (const s of prev.sweeps.values()) {
      if (s.settled === undefined) continue;
      const sw = board.sweeps.get(s.n) || { n: s.n };
      Object.assign(sw, { mints: s.mints, settled: s.settled, voids: s.voids, missed: s.missed });
      board.sweeps.set(s.n, sw);
    }
    board.seq.flow = prev.seq.flow || 0;
  }
  if (!OFFLINE) {
    const room = CONTEST.rooms.flow;
    const got = await fetchNew(room, board.seq.flow || 0);
    checkGen(gen, "flow", room, got.gen);
    const fresh = await verifiedLines(room, got.lines);
    let added = 0;
    for (const { rec } of fresh.out.sort((a, b) => a.rec.seq - b.rec.seq)) if (board.apply("flow", rec)) added++;
    log(`${room}: ${got.how} ${got.lines.length}, counts added for ${added} sweeps`);
  }

  // positions: keep only the latest board of the top 10 to keep board.json small
  const withPos = board.sorted().filter((s) => s.pos);
  for (const s of withPos.slice(0, -1)) delete s.pos;

  board.gen = gen;
  board.generated = new Date().toISOString();
  const view = buildView(board);
  const json = board.toJSON();
  await fs.writeFile(path.join(DATA, "board.json"), JSON.stringify(json));
  await fs.writeFile(path.join(DATA, "latest.json"), JSON.stringify(latestJSON(board, view), null, 1) + "\n");
  log(`board.json: ${json.sweeps.length} sweeps, ${json.dids.length} keys, latest sweep ${view.n}, final ${board.final ? board.final.price : "not yet"}`);
  if (problems) log(`${problems} problem(s) noted above`);
}

main().catch((e) => {
  console.error(e.stack || String(e));
  process.exit(1);
});
