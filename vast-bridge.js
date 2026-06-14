#!/usr/bin/env node
/* HONEST Vast proving monitor -> feed.json. Everything from real sources:
   - chain/heads from RPC; host from nvidia-smi
   - history: real proof files; per-phase stages+durations parsed from the run log
   - active: live block, phases parsed from the running tmux pane (no log file yet)
   The pipeline shown = the REAL cargo-zisk range-proof phases:
     Witness gen → Prover setup → Execute → Contributions → Inner proofs
   No agg/snark/settle — they don't run here. Nothing fabricated; unknowns = 0/"—". */
"use strict";
const fs = require("fs"), path = require("path"), cp = require("child_process");
const ROOT = "/root/op-zisk";
const PROOF_DIRS = ["data/10/proofs/range", "data/10/proofs/range-0.19-backup"].map(d => path.join(ROOT, d));
const LOGS = path.join(ROOT, "logs"), OUT = path.join(__dirname, "feed.json"), POLL = 1000;
const PHASEDIR = path.join(__dirname, "phases"); try { fs.mkdirSync(PHASEDIR); } catch {}
// persist real per-phase durations as we observe the live run, so finished blocks
// keep honest timing even when the run wrote no log file and its pane scrolls away.
const scPath = (s, e) => path.join(PHASEDIR, `${s}-${e}.json`);
function mergeSidecar(s, e, stages) {
  let prev = {}; try { prev = JSON.parse(fs.readFileSync(scPath(s, e), "utf8")); } catch {}
  const out = { ...prev };
  stages.forEach(st => { if (st.durationMs > 0) out[st.key] = Math.max(out[st.key] || 0, st.durationMs); });
  try { fs.writeFileSync(scPath(s, e), JSON.stringify(out)); } catch {}
}
function readSidecar(s, e) { try { return JSON.parse(fs.readFileSync(scPath(s, e), "utf8")); } catch { return null; } }

// Append-only durable ledger: one frozen record per completed block, written once.
// This is the source of truth for history — survives proof-file cleanup, pane scroll,
// and missing logs. Records are never rewritten. (Node 18: no sqlite, JSONL is the fit.)
const LEDGER = path.join(__dirname, "ledger.jsonl");
function loadLedger() {
  const m = new Map();
  try { for (const ln of fs.readFileSync(LEDGER, "utf8").split("\n")) { if (!ln.trim()) continue;
    const r = JSON.parse(ln); m.set(r.s + "-" + r.e, r); } } catch {}
  return m;
}
function appendLedger(rec) { try { fs.appendFileSync(LEDGER, JSON.stringify(rec) + "\n"); } catch {} }

function env(k){try{const s=fs.readFileSync(path.join(ROOT,".env.vast-mainnet"),"utf8");const m=s.split("\n").find(l=>l.startsWith(k+"="));return m?m.slice(k.length+1).trim():null}catch{return null}}
const L1=env("L1_RPC"), L2=env("L2_RPC");
async function rpc(u,m){try{const r=await fetch(u,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",method:m,id:1}),signal:AbortSignal.timeout(6000)});return (await r.json()).result}catch{return null}}
const CHAINS={"0xa":"OP Mainnet","0xaa37dc":"OP Sepolia","0x1":"Ethereum"};
const sh=(c)=>{try{return cp.execSync(c,{maxBuffer:8<<20}).toString()}catch{return ""}};

let HOST="unknown";
{const g=sh("nvidia-smi --query-gpu=name --format=csv,noheader").trim().split("\n").filter(Boolean); if(g.length) HOST=`${g.length}x ${g[0].replace(/NVIDIA GeForce /,"")}`;}

// The real range-proof pipeline. [key, label, reached-regex, done-regex(captures ms)]
const PIPE = [
  ["witness","Witness gen", /Starting witness preimage server|Generated witness|INITIALIZING_PROOFMAN/, /Generated witness.*?elapsed_ms[=\s]+(\d+)/],
  ["setup","Prover setup", />>> INITIALIZING_PROOFMAN/, /<<< INITIALIZING_PROOFMAN \((\d+)ms\)/],
  ["execute","Execute", />>> (EXECUTE|STARTING_ASM_MICROSERVICES)/, /<<< EXECUTE \((\d+)ms\)/],
  ["contrib","Contributions", />>> CALCULATING_CONTRIBUTIONS/, /<<< CALCULATING_CONTRIBUTIONS \((\d+)ms\)/],
  ["inner","Inner proofs", />>> GENERATING_(INNER_)?PROOFS/, /<<< GENERATING_PROOFS \((\d+)ms\)|Saved range proof|RANGE_STATUS=0/],
];

// parse the real phases from a chunk of run output (log file or captured pane)
function parsePhases(txt, forceAllDone) {
  txt = txt.replace(/\x1b\[[0-9;]*m/g, "");
  const allDone = forceAllDone || /Saved range proof|RANGE_STATUS=0/.test(txt);
  let reached = -1;
  PIPE.forEach((p, i) => { if (p[2].test(txt)) reached = Math.max(reached, i); });
  return PIPE.map((p, i) => {
    const [key, name, , doneRe] = p;
    const dm = txt.match(doneRe);
    let status;
    if (allDone) status = "done";
    else if (i < reached) status = "done";
    else if (i === reached) status = dm ? "done" : "active";
    else status = "pending";
    const dur = dm && dm[1] ? +dm[1] : 0;
    return { key, name, status, durationMs: dur, elapsedMs: dur };
  });
}
const stageIndexOf = (stages) => stages.filter(s => s.status === "done").length;

function provingStatus() {
  const ps = sh("ps -eo args");
  if (/release\/multi --start/.test(ps)) return "proving";
  if (/cargo build.*--bin (multi|agg|proposer)/.test(ps)) return "building";
  if (/release\/proposer/.test(ps)) return "proposer-running";
  return "idle";
}

// capture the tmux pane that's running the smoke/multi job
function smokePane() {
  for (const s of sh("tmux ls -F '#{session_name}'").split("\n").filter(Boolean)) {
    if (s === "dash" || s === "dashsrv") continue;
    const pane = sh(`tmux capture-pane -t ${s} -p -S -500`);
    if (/multi --start \d+ --end \d+|>>> (EXECUTE|CALCULATING_CONTRIBUTIONS|GENERATING)/.test(pane)) return pane;
  }
  return "";
}

function proven() {
  const ledger = loadLedger();
  // finalize any proof file not yet in the ledger: freeze its record once.
  const seen = new Set();
  for (const dir of PROOF_DIRS) { let fl=[]; try{fl=fs.readdirSync(dir)}catch{continue}
    for (const f of fl) { const m=f.match(/^(\d+)-(\d+)\.bin$/); if(!m) continue;
      const k=m[1]+"-"+m[2]; if(seen.has(k))continue; seen.add(k);
      if (ledger.has(k)) continue;                       // already frozen — never rewrite
      const st=fs.statSync(path.join(dir,f)), s=+m[1], e=+m[2];
      let log=""; for(const suf of["execute","prove"]){try{log+=fs.readFileSync(path.join(LOGS,`multi-${s}-${e}-${suf}.log`),"utf8")}catch{}}
      const stages = parsePhases(log, true);             // durations from log if present
      const sc = readSidecar(s, e);                       // else from live-captured sidecar
      if (sc) stages.forEach(x => { if (!x.durationMs && sc[x.key]) x.durationMs = sc[x.key]; });
      const phases = {}; stages.forEach(x => phases[x.key] = x.durationMs);
      const rec = { s, e, blocks: e-s, host: HOST, proofBytes: st.size, phases,
        totalMs: stages.reduce((a,x)=>a+x.durationMs,0), finishedAt: st.mtimeMs };
      appendLedger(rec); ledger.set(k, rec);
    } }
  // history = ledger (durable), newest first
  return [...ledger.values()].sort((a,b)=>b.finishedAt-a.finishedAt).slice(0,60).map(r => {
    const stages = PIPE.map(p => ({ key:p[0], name:p[1], status:"done",
      durationMs:(r.phases&&r.phases[p[0]])||0, elapsedMs:(r.phases&&r.phases[p[0]])||0 }));
    return { id:"B-"+r.s, rangeStart:r.s, rangeEnd:r.e, blocks:r.blocks, host:r.host||HOST, status:"proven",
      stageIndex:stages.length, stages, gas:0, proofBytes:r.proofBytes, txHash:null,
      startedAt:r.finishedAt-(r.totalMs||0), finishedAt:r.finishedAt, elapsedMs:r.totalMs||0,
      etaMs:0, note:"range-proof-only", _mt:r.finishedAt, _dur:r.totalMs||0 };
  });
}

function activeJob() {
  const m = sh("ps -eo args").match(/release\/multi --start (\d+) --end (\d+)/); if (!m) return null;
  const s=+m[1], e=+m[2];
  const stages = parsePhases(smokePane(), false);
  mergeSidecar(s, e, stages);                            // snapshot live durations so they survive to history
  return { id:"B-"+s, rangeStart:s, rangeEnd:e, blocks:e-s, host:HOST, status:"proving",
    stageIndex: stageIndexOf(stages), stages, gas:0, proofBytes:0, txHash:null,
    startedAt:null, finishedAt:null, elapsedMs: stages.reduce((a,x)=>a+x.durationMs,0), etaMs:0 };
}

async function cycle() {
  const status = provingStatus();
  const history = proven();
  const active = status === "proving" ? activeJob() : null;
  const [cid,l1,l2] = await Promise.all([rpc(L2,"eth_chainId"), rpc(L1,"eth_blockNumber"), rpc(L2,"eth_blockNumber")]);
  const recentDurations = history.filter(j=>j._dur>0).map(j=>j._dur);
  const frontier = history.length ? Math.max(...history.map(j=>j.rangeEnd)) : null;
  history.forEach(j=>{delete j._mt;delete j._dur});
  const snap = { connected: status==="proving", chain: CHAINS[cid]||(cid?"chain "+cid:"unknown"),
    l1Head: l1?parseInt(l1,16):0, l2Head: l2?parseInt(l2,16):0, l2ProvenFrontier: frontier,
    provingStatus: status, active, queue: [], history, recentDurations, failedCount: 0,
    source: `${HOST} — ${status}; ${history.length} range proof(s) (no agg/settle). frontier ${frontier??"none"}, chain head ${l2?parseInt(l2,16):"?"}` };
  fs.writeFileSync(OUT, JSON.stringify(snap));
  const a = active ? `${active.id}@${active.stages[active.stageIndex]?active.stages[active.stageIndex].key:"done"}` : "idle";
  process.stdout.write(`\r[vast] ${status} active=${a} proven=${history.length} head=${l2?parseInt(l2,16):"?"}   `);
}
console.log("[vast-bridge] host", HOST);
cycle(); setInterval(cycle, POLL);
