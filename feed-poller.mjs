#!/usr/bin/env node
// ==============================================================
// OP-ZiSK Prover dashboard — feed poller (runs ON the prover box).
//
// Pulls the zisk-coordinator REST API and writes a status.json in the
// dashboard snapshot shape. Push that file to a public bucket (R2/S3) or
// Worker-KV; the static dashboard fetches it. The box makes only outbound
// calls — no inbound port exposed.
//
// Source of truth (read from coordinator source, not guessed):
//   GET /api/v1/jobs/recent?limit=N  -> { data: [JobHistoryJob], pagination }
//   GET /api/v1/jobs/stats/recent    -> { data: [JobHistoryStatsSummary], ... }
//   GET /api/v1/workers              -> { data: [...] }
//   GET /metrics                     -> prometheus text (fallback if JSON 503)
//
// JobHistoryJob fields used: job_id, job_label, program, proof_type, state,
//   workers[], agg_worker_id, coordinator_id, received_at, completed_at,
//   duration_ms, age_seconds, current_phase, current_phase_age_seconds,
//   contributions_duration_ms, prove_duration_ms, aggregate_duration_ms,
//   execution_duration_ms, executed_steps, failure_reason.
//
// Env:
//   COORD_URL    coordinator REST base   (default http://localhost:9190)
//   OUT          output file             (default ./status.json)
//   CHAIN        chain label             (default "OP Mainnet")
//   INTERVAL_MS  poll period             (default 3000)
//   LIMIT        recent jobs to pull     (default 100)
//   AUTH_TOKEN   bearer token if the coordinator requires one (optional)
//   PUSH_CMD     shell run after each write, e.g. an rclone/aws push (optional)
//
//   node feed-poller.mjs            # loop
//   node feed-poller.mjs --once     # single write (cron-friendly)
//   node feed-poller.mjs --selftest # map a synthetic job, print snapshot, exit
// ==============================================================

import { writeFile } from "node:fs/promises";
import { exec } from "node:child_process";

const COORD_URL = (process.env.COORD_URL || "http://localhost:9190").replace(/\/$/, "");
const OUT = process.env.OUT || "./status.json";
const CHAIN = process.env.CHAIN || "OP Mainnet";
const INTERVAL_MS = Number(process.env.INTERVAL_MS || 3000);
const LIMIT = Number(process.env.LIMIT || 100);
const AUTH = process.env.AUTH_TOKEN ? { Authorization: `Bearer ${process.env.AUTH_TOKEN}` } : {};
const PUSH_CMD = process.env.PUSH_CMD || "";

// ---- coordinator state string -> dashboard status -----------------------
function mapStatus(state) {
  const s = String(state || "").toUpperCase();
  if (s.includes("QUEUE")) return "queued";
  if (s.includes("WAIT")) return "proving";
  if (s.includes("RUN")) return "proving";
  if (s.includes("COMPLETE") || s.includes("SUCCEED") || s === "DONE") return "proven";
  if (s.includes("FAIL") || s.includes("CANCEL") || s.includes("ERROR")) return "failed";
  return "queued";
}

// real coordinator phase -> existing dashboard stage key (labels already exist)
const PHASES = [
  { key: "execute", field: "execution_duration_ms", coord: "execution" },
  { key: "contrib", field: "contributions_duration_ms", coord: "contributions" },
  { key: "inner", field: "prove_duration_ms", coord: "prove" },
  { key: "agg", field: "aggregate_duration_ms", coord: "aggregate" },
];

// "44467000-44467010" / "44467000 to 44467010" / "44467000..44467010" -> [start,end]
function parseRange(label) {
  if (!label) return null;
  const m = String(label).replace(/[_,]/g, "").match(/(\d{3,})\s*(?:-|–|\.\.+|to|→|>)\s*(\d{3,})/i);
  if (!m) return null;
  const a = Number(m[1]), b = Number(m[2]);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return null;
  return [a, b];
}

const toMs = (iso) => (iso ? Date.parse(iso) : null);

// Nominal per-phase totals (ms) for phases not yet run — so the live timeline
// can show proportions + ETA before a real duration exists. Drawn from typical
// ZisK range-proving stage times; replaced by the real duration once recorded.
const NOMINAL = { execute: 8000, contrib: 58000, inner: 145000, agg: 11000 };

function buildStages(job, status) {
  const current = String(job.current_phase || "").toLowerCase();
  return PHASES.map((p) => {
    const dur = Number(job[p.field] || 0);
    const isCurrent = current === p.coord;
    if (dur > 0) {
      // a recorded duration means this phase ran to completion
      return { key: p.key, name: p.key, status: "done", durationMs: dur, elapsedMs: dur };
    }
    if (status === "proving" && isCurrent) {
      const elapsedMs = Number(job.current_phase_age_seconds || 0) * 1000;
      return { key: p.key, name: p.key, status: "active", durationMs: Math.max(NOMINAL[p.key], elapsedMs), elapsedMs };
    }
    return { key: p.key, name: p.key, status: "pending", durationMs: NOMINAL[p.key], elapsedMs: 0 };
  });
}

function mapJob(job) {
  const status = mapStatus(job.state);
  const range = parseRange(job.job_label);
  const elapsedMs =
    job.duration_ms != null ? Number(job.duration_ms)
    : job.age_seconds != null ? Number(job.age_seconds) * 1000
    : 0;
  const queuedAt = toMs(job.received_at);
  const finishedAt = toMs(job.completed_at);
  const stages = buildStages(job, status);
  const activeIdx = stages.findIndex((s) => s.status === "active");
  const doneCount = stages.filter((s) => s.status === "done").length;
  const stageIndex = status === "proven" || status === "failed" ? stages.length
    : activeIdx >= 0 ? activeIdx : doneCount;
  const totalStageMs = stages.reduce((a, s) => a + s.durationMs, 0);
  const etaMs = status === "proving" ? Math.max(0, totalStageMs - elapsedMs) : 0;
  return {
    id: (job.job_label && /[a-z]/i.test(job.job_label)) ? job.job_label : String(job.job_id).slice(0, 8),
    rangeStart: range ? range[0] : 0,
    rangeEnd: range ? range[1] : 0,
    blocks: range ? (range[1] - range[0]) : (Number(job.instances) || 0),
    host: job.agg_worker_id || (Array.isArray(job.workers) && job.workers[0]) || job.coordinator_id || "—",
    chain: CHAIN,
    program: job.program || "",
    proofType: job.proof_type || "",
    status,
    stageIndex,
    stages,
    gas: Number(job.executed_steps || 0), // zkVM steps (cycle-equivalent); UI label reads "gas"
    proofBytes: 0, // not exposed by coordinator
    txHash: null, // settlement is the proposer's job, external
    queuedAt: queuedAt || Date.now(),
    startedAt: queuedAt || null,
    finishedAt: finishedAt || null,
    elapsedMs,
    etaMs,
    note: job.failure_reason || null,
  };
}

function snapshotFrom(jobs) {
  const mapped = jobs.map(mapJob);
  // newest-first by finish/queue time
  const active = mapped.filter((j) => j.status === "proving");
  const queue = mapped.filter((j) => j.status === "queued");
  const history = mapped
    .filter((j) => j.status === "proven" || j.status === "failed")
    .sort((a, b) => (b.finishedAt || 0) - (a.finishedAt || 0));
  const recentDurations = history.filter((j) => j.status === "proven").map((j) => j.elapsedMs).slice(0, 44);
  const heads = mapped.map((j) => j.rangeEnd).filter((n) => n > 0);
  const l2Head = heads.length ? Math.max(...heads) : 0;
  return {
    connected: true,
    chain: CHAIN,
    l1Head: 0, // not exposed by coordinator
    l2Head,
    active: active[0] || null,
    queue,
    history,
    recentDurations,
    failedCount: history.filter((j) => j.status === "failed").length,
  };
}

async function getJson(path) {
  const res = await fetch(`${COORD_URL}${path}`, { headers: AUTH, cache: "no-store" });
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`);
  return res.json();
}

// Minimal snapshot from prometheus /metrics when the JSON job endpoints are
// 503 (no Postgres history / live_state wired). Shows connection + counts only.
async function snapshotFromMetrics() {
  const res = await fetch(`${COORD_URL}/metrics`, { headers: AUTH, cache: "no-store" });
  if (!res.ok) throw new Error(`/metrics -> HTTP ${res.status}`);
  const text = await res.text();
  const sum = (name) => text.split("\n").filter((l) => l.startsWith(name) && !l.startsWith("#"))
    .reduce((a, l) => a + (Number(l.trim().split(/\s+/).pop()) || 0), 0);
  const activeJobs = sum("coordinator_active_jobs");
  const workers = sum("coordinator_workers_connected");
  return {
    connected: true, chain: CHAIN, l1Head: 0, l2Head: 0,
    active: null, queue: [], history: [], recentDurations: [], failedCount: 0,
    _degraded: { reason: "json-endpoints-503", activeJobs, workers },
  };
}

async function buildSnapshot() {
  try {
    const recent = await getJson(`/api/v1/jobs/recent?limit=${LIMIT}`);
    const jobs = Array.isArray(recent?.data) ? recent.data : [];
    return snapshotFrom(jobs);
  } catch (e) {
    // JSON jobs path unavailable -> degrade to prometheus
    return snapshotFromMetrics();
  }
}

async function tick() {
  let snap;
  try {
    snap = await buildSnapshot();
  } catch (e) {
    snap = { connected: false, chain: CHAIN, l1Head: 0, l2Head: 0, active: null, queue: [], history: [], recentDurations: [], failedCount: 0, _error: String(e.message || e) };
  }
  await writeFile(OUT, JSON.stringify(snap));
  const tag = snap.connected ? (snap._degraded ? "degraded(/metrics)" : "ok") : "offline";
  console.log(`[${new Date().toISOString()}] ${tag} active=${snap.active ? 1 : 0} queue=${snap.queue.length} history=${snap.history.length} -> ${OUT}`);
  if (PUSH_CMD) exec(PUSH_CMD, (err) => { if (err) console.error("push failed:", err.message); });
}

// ---- selftest: prove the mapper produces a valid snapshot (no box needed) --
function selftest() {
  const sample = [
    {
      job_id: "8f1c2d3e-aaaa-bbbb-cccc-000000000001", job_label: "44467000-44467010",
      hash_id: "abc", program: "op-range", proof_type: "STARK", state: "RUNNING",
      coordinator_id: "girona", workers: ["w1", "w2"], agg_worker_id: "w1",
      received_at: new Date(Date.now() - 90_000).toISOString(), completed_at: null,
      duration_ms: null, age_seconds: 90, current_phase: "prove", current_phase_age_seconds: 20,
      contributions_duration_ms: 58000, prove_duration_ms: null, aggregate_duration_ms: null,
      execution_duration_ms: 7600, executed_steps: 1_900_000, failure_reason: null,
    },
    {
      job_id: "8f1c2d3e-aaaa-bbbb-cccc-000000000002", job_label: "44466990-44467000",
      program: "op-range", proof_type: "STARK", state: "COMPLETED",
      coordinator_id: "girona", workers: ["w3"], agg_worker_id: "w3",
      received_at: new Date(Date.now() - 400_000).toISOString(), completed_at: new Date(Date.now() - 100_000).toISOString(),
      duration_ms: 300000, age_seconds: null, current_phase: null,
      contributions_duration_ms: 58000, prove_duration_ms: 210000, aggregate_duration_ms: 11000,
      execution_duration_ms: 7600, executed_steps: 1_850_000, failure_reason: null,
    },
  ];
  console.log(JSON.stringify(snapshotFrom(sample), null, 2));
}

// ==============================================================
// METRICS MODE — for coordinator builds that only expose /metrics (no
// /api/v1 JSON, e.g. 1.0.0-beta). Parses prometheus text into a snapshot
// with REAL aggregate stats + duration distribution + worker roster.
// Per-job tables stay empty (this build has no per-job rows to give).
//   ssh box 'curl -s localhost:9090/metrics' | node feed-poller.mjs --metrics-stdin
//   node feed-poller.mjs --metrics            # fetch COORD_URL/metrics itself
// ==============================================================
function parsePromLines(text) {
  const out = [];
  for (const line of text.split("\n")) {
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^([a-zA-Z_:][\w:]*)(\{([^}]*)\})?\s+([-\d.eE+]+)$/);
    if (!m) continue;
    const labels = {};
    if (m[3]) for (const kv of m[3].split(",")) {
      const i = kv.indexOf("=");
      if (i > 0) labels[kv.slice(0, i).trim()] = kv.slice(i + 1).trim().replace(/^"|"$/g, "");
    }
    out.push({ name: m[1], labels, value: Number(m[4]) });
  }
  return out;
}

function snapshotFromPrometheus(text) {
  const rows = parsePromLines(text);
  const sel = (name, lf) => rows.filter((r) => r.name === name && (!lf || Object.entries(lf).every(([k, v]) => r.labels[k] === v)));
  const val = (name, lf) => { const r = sel(name, lf)[0]; return r ? r.value : 0; };

  const proven = val("coordinator_jobs_total", { outcome: "success" });
  const failed = val("coordinator_jobs_total", { outcome: "failure" });
  const workersConnected = val("coordinator_workers_connected");
  const activeJobs = val("coordinator_active_jobs");

  const durSum = val("coordinator_job_duration_seconds_sum", { outcome: "success" });
  const durCount = val("coordinator_job_duration_seconds_count", { outcome: "success" });
  const avgMs = durCount > 0 ? (durSum / durCount) * 1000 : 0;

  // cumulative histogram buckets -> per-bucket counts (success durations)
  const buckets = sel("coordinator_job_duration_seconds_bucket", { outcome: "success" })
    .map((r) => ({ le: r.labels.le === "+Inf" ? Infinity : Number(r.labels.le), c: r.value }))
    .sort((a, b) => a.le - b.le);
  const hist = [];
  let prevLe = 0, prevC = 0;
  for (const b of buckets) {
    const count = b.c - prevC;
    if (b.le !== Infinity) hist.push({ lo: prevLe, hi: b.le, count, band: "green" });
    prevLe = b.le === Infinity ? prevLe : b.le; prevC = b.c;
  }
  // approximate per-job durations from non-empty buckets (midpoint), for sparkline
  const recentDurations = [];
  for (const b of hist) for (let i = 0; i < b.count; i++) recentDurations.push(((b.lo + b.hi) / 2) * 1000);

  const total = proven; // distribution is over successful proofs
  const target = avgMs ? Math.round(avgMs / 1000) : 300;
  for (const b of hist) b.band = (b.lo + b.hi) / 2 <= target ? "green" : "red";
  const green = hist.filter((b) => (b.lo + b.hi) / 2 <= target).reduce((a, b) => a + b.count, 0);
  const dist = { target, total, green, yellow: total - green, failed, greenPct: total ? Math.round((green / total) * 100) : 0, hist };

  // worker roster (real, per-worker outcomes)
  const wmap = {};
  for (const r of sel("coordinator_worker_jobs_total")) {
    const id = r.labels.worker_id || "?";
    wmap[id] = wmap[id] || { id, success: 0, failure: 0 };
    wmap[id][r.labels.outcome] = (wmap[id][r.labels.outcome] || 0) + r.value;
  }
  const workers = Object.values(wmap).sort((a, b) => Number(a.id) - Number(b.id));

  const stats = {
    provenToday: proven,
    avgProveMs: avgMs,
    successRate: proven + failed ? Math.round((proven / (proven + failed)) * 100) : 0,
    throughputKgs: 0,
    p50Ms: avgMs, p95Ms: hist.length ? hist[hist.length - 1].hi * 1000 : avgMs,
    dist,
  };

  return {
    connected: true, chain: CHAIN, l1Head: 0, l2Head: 0,
    active: null, queue: [], history: [], recentDurations,
    failedCount: failed,
    stats, // supplied directly -> client skips recompute
    cluster: { workersConnected, activeJobs, workers },
    source: "coordinator/metrics (1.0.0-beta — aggregate only)",
  };
}

async function tickMetrics(text) {
  const snap = snapshotFromPrometheus(text);
  await writeFile(OUT, JSON.stringify(snap));
  console.log(`[${new Date().toISOString()}] metrics ok proven=${snap.stats.provenToday} failed=${snap.failedCount} workers=${snap.cluster.workersConnected} avg=${Math.round(snap.stats.avgProveMs)}ms -> ${OUT}`);
  if (PUSH_CMD) exec(PUSH_CMD, (err) => { if (err) console.error("push failed:", err.message); });
}

const arg = process.argv[2];
if (arg === "--selftest") { selftest(); }
else if (arg === "--metrics-stdin") {
  let s = ""; process.stdin.on("data", (d) => s += d).on("end", () => tickMetrics(s));
}
else if (arg === "--metrics") {
  const run = async () => {
    const res = await fetch(`${COORD_URL}/metrics`, { headers: AUTH, cache: "no-store" });
    await tickMetrics(await res.text());
  };
  run(); if (!process.argv.includes("--once")) setInterval(run, INTERVAL_MS);
}
else if (arg === "--once") { tick(); }
else {
  console.log(`feed-poller -> ${COORD_URL}  out=${OUT}  every ${INTERVAL_MS}ms`);
  tick();
  setInterval(tick, INTERVAL_MS);
}
