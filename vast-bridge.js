#!/usr/bin/env node
/* HONEST Vast proving monitor -> feed.json. Everything derived from real sources:
   - chain  : from eth_chainId
   - l1Head/l2Head : real chain heads from the configured RPCs
   - l2ProvenFrontier : max end of an actual proof file (NOT the chain head)
   - connected/provingStatus : from real processes (proving? building? idle?)
   - history : real .bin proof files; durations parsed from the run logs (0 if no log)
   - host : from nvidia-smi
   Range proofs only — agg/snark/settle are marked NOT done because they don't run here. */
"use strict";
const fs = require("fs"), path = require("path"), cp = require("child_process");
const ROOT = "/root/op-zisk";
const PROOF_DIRS = ["data/10/proofs/range", "data/10/proofs/range-0.19-backup"].map(d => path.join(ROOT, d));
const LOGS = path.join(ROOT, "logs"), OUT = path.join(__dirname, "feed.json"), POLL = 3000;

function env(k){try{const s=fs.readFileSync(path.join(ROOT,".env.vast-mainnet"),"utf8");const m=s.split("\n").find(l=>l.startsWith(k+"="));return m?m.slice(k.length+1).trim():null}catch{return null}}
const L1=env("L1_RPC"), L2=env("L2_RPC");
async function rpc(u,m){try{const r=await fetch(u,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",method:m,id:1}),signal:AbortSignal.timeout(6000)});return (await r.json()).result}catch{return null}}
const CHAINS = {"0xa":"OP Mainnet","0xaa37dc":"OP Sepolia","0x1":"Ethereum"};

let HOST = "unknown";
try { const g = cp.execSync("nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null").toString().trim().split("\n").filter(Boolean);
  if (g.length) HOST = `${g.length}x ${g[0].replace(/NVIDIA GeForce /,"")}`; } catch {}

function realDur(s, e) {
  let w = 0, p = 0;
  try { const t = fs.readFileSync(path.join(LOGS, `multi-${s}-${e}-execute.log`),"utf8").replace(/\x1b\[[0-9;]*m/g,"");
    const m = t.match(/Generated witness.*elapsed_ms[=\s]+(\d+)/); if (m) w = +m[1]; } catch {}
  try { const t = fs.readFileSync(path.join(LOGS, `multi-${s}-${e}-prove.log`),"utf8").replace(/\x1b\[[0-9;]*m/g,"");
    const m = t.match(/Elapsed \(wall clock\) time.*?(\d+):(\d+(?:\.\d+)?)/); if (m) p = Math.round((+m[1]*60+parseFloat(m[2]))*1000); } catch {}
  return { w, p };
}
// The REAL range-proof pipeline = exactly the two phases multi --prove runs.
// Witness gen (kona host) then the range STARK proof (cargo-zisk prove). No agg/
// snark/settle exist in this flow, so they are NOT shown as stages.
const DONE = (k, n, d) => ({ key: k, name: n, status: "done", durationMs: d, elapsedMs: d });
const provenStages = (w, p) => [DONE("witness", "Witness gen", w), DONE("prove", "Range STARK proof", p)];
// active job: idx 0 = witness running, idx 1 = STARK running
const activeStages = (idx) => [
  { key: "witness", name: "Witness gen", status: idx > 0 ? "done" : "active", durationMs: 0, elapsedMs: 0 },
  { key: "prove", name: "Range STARK proof", status: idx >= 1 ? "active" : "pending", durationMs: 0, elapsedMs: 0 },
];

function proven() {
  const seen = new Set(), out = [];
  for (const dir of PROOF_DIRS) { let fs2=[]; try{fs2=fs.readdirSync(dir)}catch{continue}
    for (const f of fs2) { const m=f.match(/^(\d+)-(\d+)\.bin$/); if(!m) continue;
      const key=m[1]+"-"+m[2]; if(seen.has(key))continue; seen.add(key);
      const st=fs.statSync(path.join(dir,f)), s=+m[1], e=+m[2], {w,p}=realDur(s,e);
      out.push({id:"B-"+s,rangeStart:s,rangeEnd:e,blocks:e-s,host:HOST,status:"proven",
        stageIndex:2,stages:provenStages(w,p),gas:0,proofBytes:st.size,txHash:null,
        startedAt:st.mtimeMs-w-p,finishedAt:st.mtimeMs,elapsedMs:w+p,etaMs:0,
        note:"range-proof-only",_mt:st.mtimeMs,_dur:w+p}); } }
  return out.sort((a,b)=>b._mt-a._mt).slice(0,60);
}

function provingStatus() {
  const ps = cp.execSync("ps -eo args 2>/dev/null").toString();
  if (/release\/multi --start/.test(ps)) return "proving";
  if (/cargo build.*--bin (multi|agg|proposer)/.test(ps)) return "building";
  if (/release\/proposer/.test(ps)) return "proposer-running";
  return "idle";
}

// the currently-proving block, derived from the running multi process + its log
function activeJob() {
  let args = "";
  try { args = cp.execSync("ps -eo args 2>/dev/null | grep 'release/multi --start' | grep -v grep | head -1").toString(); } catch {}
  const m = args.match(/--start\s+(\d+)\s+--end\s+(\d+)/); if (!m) return null;
  const s = +m[1], e = +m[2];
  let txt = "";
  for (const suf of ["prove", "execute"]) { try { txt += fs.readFileSync(path.join(LOGS, `multi-${s}-${e}-${suf}.log`), "utf8"); } catch {} }
  const idx = /GENERATING_INNER_PROOFS|GENERATING_PROOFS|ROM SETUP|INITIALIZING_PROOFMAN/.test(txt) ? 1 : 0;
  return { id: "B-" + s, rangeStart: s, rangeEnd: e, blocks: e - s, host: HOST, status: "proving",
    stageIndex: idx, stages: activeStages(idx), gas: 0, proofBytes: 0, txHash: null,
    startedAt: null, finishedAt: null, elapsedMs: 0, etaMs: 0 };
}

async function cycle() {
  const history = proven();
  const status = provingStatus();
  const active = status === "proving" ? activeJob() : null;
  const [cid, l1, l2] = await Promise.all([rpc(L2,"eth_chainId"), rpc(L1,"eth_blockNumber"), rpc(L2,"eth_blockNumber")]);
  const chain = CHAINS[cid] || (cid ? "chain " + cid : "unknown");
  const recentDurations = history.filter(j=>j._dur>0).map(j=>j._dur);
  const frontier = history.length ? Math.max(...history.map(j=>j.rangeEnd)) : null;
  history.forEach(j=>{delete j._mt;delete j._dur});
  const snap = {
    connected: status === "proving",            // "Live" only when actually proving
    chain,
    l1Head: l1 ? parseInt(l1,16) : 0,
    l2Head: l2 ? parseInt(l2,16) : 0,            // REAL chain head
    l2ProvenFrontier: frontier,                  // last proven block (≠ head)
    provingStatus: status,                       // proving | building | idle | proposer-running
    active,
    queue: [],
    history,
    recentDurations,
    failedCount: 0,
    source: `${HOST} — ${status}; ${history.length} range proof(s) (no agg/settle). proven frontier ${frontier ?? "none"}, chain head ${l2?parseInt(l2,16):"?"}`,
  };
  fs.writeFileSync(OUT, JSON.stringify(snap));
  process.stdout.write(`\r[vast] status=${status} proven=${history.length} frontier=${frontier} head=${l2?parseInt(l2,16):"?"}   `);
}
console.log("[vast-bridge HONEST] host:", HOST, "L1:", L1, "L2:", L2);
cycle(); setInterval(cycle, POLL);
