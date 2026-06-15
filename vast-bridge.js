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
// the proof loop tees everything durably here: witness-S-E.log / range-S-E.log / agg-*.log
const LOGS = path.join(ROOT, "logs/proof-loop-mainnet"), OUT = path.join(__dirname, "feed.json"), POLL = 1000;
function rangeLog(s, e) { let t = ""; for (const p of [`witness-${s}-${e}.log`, `range-${s}-${e}.log`]) { try { t += fs.readFileSync(path.join(LOGS, p), "utf8"); } catch {} } return t; }
const PHASEDIR = path.join(__dirname, "phases"); try { fs.mkdirSync(PHASEDIR); } catch {}
// persist real per-phase durations as we observe the live run, so finished blocks
// keep honest timing even when the run wrote no log file and its pane scrolls away.
const scPath = (s, e) => path.join(PHASEDIR, `${s}-${e}.json`);
function readSidecar(s, e) {
  try { const r = JSON.parse(fs.readFileSync(scPath(s, e), "utf8"));
    return (r.phases || r.stats) ? { phases: r.phases || {}, stats: r.stats || {} } : { phases: r, stats: {} };
  } catch { return null; }
}
function mergeSidecar(s, e, stages, stats) {
  const prev = readSidecar(s, e) || { phases: {}, stats: {} };
  stages.forEach(st => { if (st.durationMs > 0) prev.phases[st.key] = Math.max(prev.phases[st.key] || 0, st.durationMs); });
  if (stats) Object.assign(prev.stats, stats);
  try { fs.writeFileSync(scPath(s, e), JSON.stringify(prev)); } catch {}
}

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
async function rpc(u,m,params){try{const r=await fetch(u,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",method:m,params:params||[],id:1}),signal:AbortSignal.timeout(6000)});return (await r.json()).result}catch{return null}}
// gas/txs come from the chain (loop logs don't carry kona ExecutionStats), summed over [s,e)
async function rangeGasTxs(s, e) {
  let gas = 0, txs = 0, ok = false;
  for (let b = s; b < e; b++) {
    const blk = await rpc(L2, "eth_getBlockByNumber", ["0x" + b.toString(16), false]);
    if (blk && blk.gasUsed) { gas += parseInt(blk.gasUsed, 16) || 0; txs += (blk.transactions ? blk.transactions.length : 0); ok = true; }
  }
  return ok ? { gas, txs } : null;
}
const CHAINS={"0xa":"OP Mainnet","0xaa37dc":"OP Sepolia","0x1":"Ethereum"};
const sh=(c)=>{try{return cp.execSync(c,{maxBuffer:8<<20}).toString()}catch{return ""}};

let HOST="unknown";
{const g=sh("nvidia-smi --query-gpu=name --format=csv,noheader").trim().split("\n").filter(Boolean); if(g.length) HOST=`${g.length}x ${g[0].replace(/NVIDIA GeForce /,"")}`;}

// The real range-proof pipeline. [key, label, reached-regex, done-regex(captures ms)]
// markers verified against real logs/proof-loop-mainnet/{witness,range}-*.log
const PIPE = [
  ["witness","Witness gen", /Starting witness preimage server|Generated witness|INITIALIZING_PROOFMAN/, /Generated witness.*?elapsed_ms[=\s]+(\d+)/],
  ["setup","Prover setup", />>> INITIALIZING_PROOFMAN/, /<<< INITIALIZING_PROOFMAN \((\d+)ms\)/],
  ["execute","Execute", />>> (EXECUTE|STARTING_ASM_MICROSERVICES|COMPUTE_MINIMAL_TRACE)/, /<<< EXECUTE \((\d+)ms\)/],
  ["contrib","Contributions", />>> CALCULATING_CONTRIBUTIONS/, /<<< CALCULATING_CONTRIBUTIONS \((\d+)ms\)/],
  ["inner","Inner proofs", />>> GENERATING_(INNER_)?PROOFS/, /<<< GENERATING_INNER_PROOFS \((\d+)ms\)|Range proof saved to/],
];
const DONE_RE = /Range proof saved to|RANGE_STATUS=0/;

// parse the real phases from a chunk of run output (log file or captured pane)
function parsePhases(txt, forceAllDone) {
  txt = txt.replace(/\x1b\[[0-9;]*m/g, "");
  const allDone = forceAllDone || DONE_RE.test(txt);
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

// The prover emits an ExecutionStats { ... } struct (in the execute log / live pane) with
// the authoritative gas/steps/tx accounting for exactly what it proved. Parse it verbatim.
// ZisK logs proof-instance counts (durable, in range log): "Total global instances: N" + "Main: N".
// This is the available execution-size metric — raw instruction steps aren't logged in loop mode.
function parseInstances(txt) {
  txt = txt.replace(/\x1b\[[0-9;]*m/g, "");
  const t = txt.match(/Total global instances:\s*(\d+)/);
  const mn = txt.match(/\bMain:\s*(\d+)/);
  return { instances: t ? +t[1] : 0, main: mn ? +mn[1] : 0 };
}

function parseStats(txt) {
  const m = txt.replace(/\x1b\[[0-9;]*m/g, "").match(/ExecutionStats \{([^}]*)\}/);
  if (!m) return null;
  const o = {};
  for (const mm of m[1].matchAll(/(\w+):\s*(\d+)/g)) o[mm[1]] = +mm[2];
  return Object.keys(o).length ? o : null;
}

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
    const pane = sh(`tmux capture-pane -t ${s} -p -S -3000`);  // deep scrollback: keep early ExecutionStats line
    if (/multi --start \d+ --end \d+|>>> (EXECUTE|CALCULATING_CONTRIBUTIONS|GENERATING)/.test(pane)) return pane;
  }
  return "";
}

async function proven() {
  const ledger = loadLedger();
  // finalize any proof file not yet in the ledger: freeze its record once.
  const seen = new Set();
  for (const dir of PROOF_DIRS) { let fl=[]; try{fl=fs.readdirSync(dir)}catch{continue}
    for (const f of fl) { const m=f.match(/^(\d+)-(\d+)\.bin$/); if(!m) continue;
      const k=m[1]+"-"+m[2]; if(seen.has(k))continue; seen.add(k);
      if (ledger.has(k)) continue;                       // already frozen — never rewrite
      const st=fs.statSync(path.join(dir,f)), s=+m[1], e=+m[2];
      const log = rangeLog(s, e);                         // durable witness+range loop logs
      const stages = parsePhases(log, true);
      const sc = readSidecar(s, e);                       // sidecar fallback for any phase not in log
      const scP = sc ? sc.phases : {};
      stages.forEach(x => { if (!x.durationMs && scP[x.key]) x.durationMs = scP[x.key]; });
      const phases = {}; stages.forEach(x => phases[x.key] = x.durationMs);
      const gt = await rangeGasTxs(s, e);                 // gas/txs from chain (not in logs)
      const inst = parseInstances(log);                   // real proof-instance counts
      const rec = { s, e, blocks: e-s, host: HOST, proofBytes: st.size, phases,
        totalMs: stages.reduce((a,x)=>a+x.durationMs,0),
        gas: gt ? gt.gas : 0, txs: gt ? gt.txs : 0,
        instances: inst.instances, main: inst.main, steps: 0,  // raw steps not logged in loop mode
        finishedAt: st.mtimeMs };
      appendLedger(rec); ledger.set(k, rec);
    } }
  const recs = [...ledger.values()];
  const history = recs.sort((a,b)=>b.finishedAt-a.finishedAt).slice(0,60).map(r => {
    const stages = PIPE.map(p => ({ key:p[0], name:p[1], status:"done",
      durationMs:(r.phases&&r.phases[p[0]])||0, elapsedMs:(r.phases&&r.phases[p[0]])||0 }));
    return { id:"B-"+r.s, rangeStart:r.s, rangeEnd:r.e, blocks:r.blocks, host:r.host||HOST, status:"proven",
      stageIndex:stages.length, stages, gas:r.gas||0, txs:r.txs||0,
      instances:r.instances||0, main:r.main||0,
      proofBytes:r.proofBytes, txHash:null, startedAt:r.finishedAt-(r.totalMs||0), finishedAt:r.finishedAt,
      elapsedMs:r.totalMs||0, etaMs:0, note:"range-proof-only", _mt:r.finishedAt, _dur:r.totalMs||0 };
  });
  return { history, metrics: computeMetrics(recs, aggRecords()) };
}

// aggregation runs every RANGES_PER_AGG ranges -> agg-<first>-to-<last>.log.
// <<< NAME (Xms) phase markers are universal here, so summing them = real agg compute time.
function aggRecords() {
  let fl = []; try { fl = fs.readdirSync(LOGS); } catch {}
  const out = [];
  for (const f of fl) {
    // real name: agg-<firstStart>-<firstEnd>-to-<lastStart>-<lastEnd>.log
    const m = f.match(/^agg-(\d+)-\d+-to-\d+-(\d+)\.log$/); if (!m) continue;
    let txt = ""; try { txt = fs.readFileSync(path.join(LOGS, f), "utf8").replace(/\x1b\[[0-9;]*m/g, ""); } catch { continue; }
    let totalMs = 0; for (const mm of txt.matchAll(/<<< [A-Z_]+ \((\d+)ms\)/g)) totalMs += +mm[1];
    const snarkM = txt.match(/<<< GENERATING_WRAPPER_SNARK_PROOF \((\d+)ms\)/);
    const done = /Aggregation proof generated|Proof artifacts saved/i.test(txt);
    const st = fs.statSync(path.join(LOGS, f));
    out.push({ first: +m[1], last: +m[2], blocks: (+m[2]) - (+m[1]), totalMs, snarkMs: snarkM ? +snarkM[1] : 0, done, finishedAt: st.mtimeMs });
  }
  return out.sort((a, b) => b.finishedAt - a.finishedAt);
}

// aggregates over the durable ledger — averaged ONLY over records that actually carry the
// datum (so missing-data blocks don't drag an average to zero). agg = n/a (not run here).
const avg = (a) => a.length ? a.reduce((x,y)=>x+y,0)/a.length : 0;
const sum = (a) => a.reduce((x,y)=>x+y,0);
function avgPhaseDurations(recs) {
  const out = {};
  for (const p of PIPE) { const k = p[0]; const v = recs.map(r => (r.phases && r.phases[k]) || 0).filter(x => x > 0); out[k] = Math.round(avg(v)); }
  return out;
}
// epoch ms of the most-recent ">>> PHASE" line that maps to the active stage (live phase timer)
function activePhaseStart(txt, activeKey) {
  const reach = (PIPE.find(p => p[0] === activeKey) || [])[2];
  let ts = 0;
  for (const ln of txt.split("\n")) {
    if (reach && reach.test(ln)) { const m = ln.match(/^(\d{4}-\d\d-\d\dT[\d:.]+Z)/); if (m) ts = Date.parse(m[1]); }
  }
  return ts;
}
function firstLogStart(txt) {
  const m = txt.match(/^(\d{4}-\d\d-\d\dT[\d:.]+Z)/m);
  return m ? Date.parse(m[1]) : 0;
}
function computeMetrics(recs, aggs) {
  aggs = aggs || [];
  const aggDone = aggs.filter(a => a.totalMs > 0);
  // throughput from timed ranges only: real proving rate (no zeros, no NaN)
  const timed = recs.filter(r => r.totalMs > 0);
  const timedBlocks = sum(timed.map(r => r.blocks));
  const timedMs = sum(timed.map(r => r.totalMs));
  const secPerBlock = timedBlocks ? (timedMs / 1000) / timedBlocks : 0;
  const blocksPerHour = timedMs ? timedBlocks / (timedMs / 3.6e6) : 0;
  const inst = recs.filter(r => r.instances > 0);
  const mainI = recs.filter(r => r.main > 0);
  const gas = recs.filter(r=>r.gas>0), steps = recs.filter(r=>r.steps>0);
  const wit = recs.map(r=>r.phases&&r.phases.witness||0).filter(x=>x>0);
  const prov = recs.filter(r=>r.totalMs>0).map(r=>r.totalMs-((r.phases&&r.phases.witness)||0)).filter(x=>x>0);
  const tot = recs.map(r=>r.totalMs||0).filter(x=>x>0);
  const sz = recs.map(r=>r.proofBytes||0).filter(x=>x>0);
  const tb = sum(gas.map(r=>r.blocks)), tbS = sum(steps.map(r=>r.blocks));
  return {
    blocksProven: sum(recs.map(r=>r.blocks)), rangesProven: recs.length,
    avgRangeBlocks: avg(recs.map(r=>r.blocks)),
    totalGas: sum(recs.map(r=>r.gas||0)), avgGasPerBlock: tb ? sum(gas.map(r=>r.gas))/tb : 0,
    totalSteps: sum(recs.map(r=>r.steps||0)), avgStepsPerBlock: tbS ? sum(steps.map(r=>r.steps))/tbS : 0,
    avgWitnessMs: avg(wit), avgProveMs: avg(prov), avgTotalMs: avg(tot), avgProofBytes: avg(sz),
    measuredCount: tot.length, gasCount: gas.length,
    avgPhases: avgPhaseDurations(recs),                          // per-phase historical avg (for live ETA/gantt)
    secPerBlock, blocksPerHour,                                  // real throughput (timed ranges)
    avgInstances: avg(inst.map(r=>r.instances)), avgMain: avg(mainI.map(r=>r.main)),
    instancesAvailable: inst.length > 0, stepsAvailable: false,
    aggCount: aggs.length, avgAggMs: avg(aggDone.map(a=>a.totalMs)), aggNote: "PLONK agg every 2 ranges",
  };
}

// the loop prefetches witnesses ahead of proving -> data/10/witness-cache/<S>-<E>-stdin.bin.
// cached-but-not-yet-proven ranges ARE the real backlog/queue.
const WCACHE = path.join(ROOT, "data/10/witness-cache");
function witnessQueue(provenKeys, activeKey) {
  let fl = []; try { fl = fs.readdirSync(WCACHE); } catch {}
  const q = [];
  for (const f of fl) {
    const m = f.match(/^(\d+)-(\d+)-stdin\.bin$/); if (!m) continue;
    const s = +m[1], e = +m[2], k = s + "-" + e;
    if (provenKeys.has(k) || k === activeKey) continue;
    q.push({ id: "B-" + s, rangeStart: s, rangeEnd: e, blocks: e - s, status: "queued", host: HOST,
      stageIndex: 0, stages: PIPE.map(p => ({ key: p[0], name: p[1], status: "pending", durationMs: 0, elapsedMs: 0 })),
      gas: 0, proofBytes: 0, note: "witness cached" });
  }
  return q.sort((a, b) => a.rangeStart - b.rangeStart);
}

function activeJob(avgPh) {
  const m = sh("ps -eo args").match(/release\/multi --start (\d+) --end (\d+)/); if (!m) return null;
  const s=+m[1], e=+m[2];
  const log = rangeLog(s, e);                             // live tee'd log; durable + complete
  const txt = (log || smokePane()).replace(/\x1b\[[0-9;]*m/g, "");
  const stages = parsePhases(txt, false);
  mergeSidecar(s, e, stages, null);                      // persist live durations so they survive to history
  avgPh = avgPh || {};
  const ai = stages.findIndex(x => x.status === "active");
  const activeKey = ai >= 0 ? stages[ai].key : null;
  const now = Date.now();
  const startTs = activeKey ? activePhaseStart(txt, activeKey) : 0;
  const activeElapsed = startTs ? Math.max(0, now - startTs) : 0;
  const doneMs = stages.filter(x => x.status === "done").reduce((a, x) => a + x.durationMs, 0);
  // attach expected (historical) widths + live elapsed per stage
  stages.forEach((x, i) => {
    x.expectedMs = avgPh[x.key] || 0;
    x.elapsedMs = x.status === "done" ? x.durationMs : (i === ai ? activeElapsed : 0);
  });
  // elapsed = sum of completed phases + the active phase's live elapsed.
  // (NOT wall-clock: witness is prefetched ahead, so its log timestamps are stale.)
  const elapsedMs = doneMs + activeElapsed;
  const estTotal = doneMs + stages.filter(x => x.status !== "done").reduce((a, x) => a + Math.max(x.elapsedMs || 0, x.expectedMs || 0), 0);
  const etaMs = Math.max(0, estTotal - elapsedMs);
  const progress = estTotal ? Math.min(99, Math.round((elapsedMs / estTotal) * 100)) : 0;
  // STALL: active phase running far past its historical average (GPU likely hung).
  const activeExp = ai >= 0 ? (stages[ai].expectedMs || 0) : 0;
  const stalled = activeElapsed > Math.max(activeExp * 4, 900000);  // >4x expected or >15min
  return { id:"B-"+s, rangeStart:s, rangeEnd:e, blocks:e-s, host:HOST, status:"proving",
    stageIndex: stageIndexOf(stages), stages, gas:0, txs:0, instances:0, main:0, proofBytes:0, txHash:null,
    startedAt:null, finishedAt:null, elapsedMs, estimatedTotalMs: estTotal, etaMs, progress,
    stalled, stallPhase: stalled && ai >= 0 ? stages[ai].key : null };
}

async function cycle() {
  const status = provingStatus();
  const { history, metrics } = await proven();
  const active = status === "proving" ? activeJob(metrics.avgPhases) : null;
  const [cid,l1,l2] = await Promise.all([rpc(L2,"eth_chainId"), rpc(L1,"eth_blockNumber"), rpc(L2,"eth_blockNumber")]);
  const recentDurations = history.filter(j=>j._dur>0).map(j=>j._dur);
  const frontier = history.length ? Math.max(...history.map(j=>j.rangeEnd)) : null;
  const provenKeys = new Set(history.map(j=>j.rangeStart+"-"+j.rangeEnd));
  const queue = witnessQueue(provenKeys, active ? active.rangeStart+"-"+active.rangeEnd : null);
  metrics.backlogRanges = queue.length;
  metrics.backlogBlocks = queue.reduce((a,j)=>a+j.blocks,0);
  history.forEach(j=>{delete j._mt;delete j._dur});
  // GPU utilization (stall corroboration + display)
  const gpu = sh("nvidia-smi --query-gpu=utilization.gpu --format=csv,noheader,nounits").split("\n").map(x=>parseInt(x)).filter(x=>!isNaN(x));
  const gpuUtil = gpu.length ? Math.round(gpu.reduce((a,b)=>a+b,0)/gpu.length) : null;
  const snap = { connected: status==="proving", chain: CHAINS[cid]||(cid?"chain "+cid:"unknown"),
    l1Head: l1?parseInt(l1,16):0, l2Head: l2?parseInt(l2,16):0, l2ProvenFrontier: frontier,
    provingStatus: status, active, queue, history, metrics, recentDurations, failedCount: 0, gpuUtil,
    source: `${history.length} ranges proven · frontier ${frontier??"—"} · chain head ${l2?parseInt(l2,16):"?"}` };
  fs.writeFileSync(OUT, JSON.stringify(snap));
  const a = active ? `${active.id}@${active.stages[active.stageIndex]?active.stages[active.stageIndex].key:"done"}` : "idle";
  process.stdout.write(`\r[vast] ${status} active=${a} proven=${history.length} head=${l2?parseInt(l2,16):"?"}   `);
}
console.log("[vast-bridge] host", HOST);
cycle(); setInterval(cycle, POLL);
