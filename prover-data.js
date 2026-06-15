/* ============================================================
   OP-ZisK Prover — live feed data layer (MOCK).

   This module emits immutable SNAPSHOTS of prover state. The UI
   depends only on the snapshot shape below — so to go live you
   replace the simulator with a real source WITHOUT touching the UI:

     const feed = new ProverFeed();
     // --- real backend ---
     const ws = new WebSocket('wss://prover.example/stream');
     ws.onopen    = () => feed.setConnected(true);
     ws.onclose   = () => feed.setConnected(false);
     ws.onmessage = (e) => feed.ingest(JSON.parse(e.data)); // see ingest()
     // and DON'T call feed.startSimulation()

   For this design we call feed.startSimulation() to animate mock jobs.

   ---- Snapshot ----------------------------------------------------
   {
     connected: bool,
     chain: string, l1Head: number, l2Head: number,
     active:  Job | null,     // job currently proving (hero)
     queue:   Job[],          // upcoming, in order
     history: Job[],          // newest-first, proven/failed
     stats:   { provenToday, avgProveMs, successRate, throughputKgs }
   }
   ---- Job ---------------------------------------------------------
   {
     id, rangeStart, rangeEnd, blocks, host, chain,
     status: 'queued'|'proving'|'proven'|'failed',
     stageIndex, stages: Stage[],
     gas, proofBytes, txHash,
     queuedAt, startedAt, finishedAt, elapsedMs, etaMs,
     note            // optional flag, e.g. 'rpc-throttled'
   }
   ---- Stage -------------------------------------------------------
   { key, name, status:'pending'|'active'|'done', durationMs, elapsedMs }
   ================================================================ */

(function () {
  "use strict";

  // Canonical pipeline. Base durations (seconds) are drawn from the
  // measured GPU session; jitter makes the feed feel alive.
  const STAGE_DEFS = [
    { key: "witness", name: "Witness gen",   base: 95,  jitter: 70, net: true },
    { key: "execute", name: "Execute",       base: 7.6, jitter: 1.6 },
    { key: "contrib", name: "Contributions", base: 58,  jitter: 9 },
    { key: "inner",   name: "Inner proofs",  base: 145, jitter: 22 },
    { key: "agg",     name: "Aggregation",   base: 11,  jitter: 3 },
    { key: "snark",   name: "Final SNARK",   base: 7,   jitter: 1.6 },
    { key: "settle",  name: "On-chain settle", base: 18, jitter: 10 },
  ];

  // Simulated time runs faster than wall time so a full ~6-min job is
  // watchable on a review screen. Displayed timers still count real
  // proving seconds (we advance simulated ms, not fake the labels).
  const TIME_SCALE = 7;
  const HISTORY_MAX = 80;

  const HOSTS = ["gpu-uk-5090", "gpu-us-4090", "gpu-eu-a100"];
  const CHAIN = "OP Sepolia";

  const rnd = (a, b) => a + Math.random() * (b - a);
  const pick = (arr) => arr[(Math.random() * arr.length) | 0];
  const hex = (n) =>
    "0x" + Array.from({ length: n }, () => "0123456789abcdef"[(Math.random() * 16) | 0]).join("");

  function makeStages() {
    return STAGE_DEFS.map((d) => {
      // witness gen is network-bound: occasionally throttled (the Alchemy-429 story)
      let secs = Math.max(1, d.base + rnd(-d.jitter, d.jitter) * 0.5 + (d.net ? rnd(0, d.jitter) : 0));
      return { key: d.key, name: d.name, status: "pending", durationMs: secs * 1000, elapsedMs: 0, net: !!d.net };
    });
  }

  let _seq = 1;
  function makeJob(rangeStart, blocks) {
    const stages = makeStages();
    const gas = Math.round(blocks * rnd(170000, 195000));
    const witness = stages[0];
    const note = witness.durationMs > 175000 ? "rpc-throttled" : null;
    return {
      id: "JOB-" + String(_seq++).padStart(4, "0"),
      rangeStart,
      rangeEnd: rangeStart + blocks,
      blocks,
      host: pick(HOSTS),
      chain: CHAIN,
      status: "queued",
      stageIndex: 0,
      stages,
      gas,
      proofBytes: Math.round(blocks * rnd(48000, 56000)),
      txHash: null,
      queuedAt: Date.now(),
      startedAt: null,
      finishedAt: null,
      elapsedMs: 0,
      etaMs: stages.reduce((s, x) => s + x.durationMs, 0),
      costRate: rnd(0.00009, 0.00014),
      note,
    };
  }

  function jobTotalDuration(job) {
    return job.stages.reduce((s, x) => s + x.durationMs, 0);
  }

  class ProverFeed {
    constructor() {
      this._subs = new Set();
      this._nextBlock = 44467010;
      this.connected = false;
      this.chain = CHAIN;
      this.l1Head = 6_842_119;
      this.l2Head = this._nextBlock;
      this.active = null;
      this.queue = [];
      this.history = [];
      this.stats = { provenToday: 0, avgProveMs: 0, successRate: 100, throughputKgs: 0, p50Ms: 0, p95Ms: 0 };
      this.recentDurations = [];
      this.failedCount = 0;
      this._timer = null;
      this._lastTick = 0;
      this._seed();
    }

    // ---- pub/sub ----
    subscribe(cb) {
      this._subs.add(cb);
      cb(this.snapshot());
      return () => this._subs.delete(cb);
    }
    _emit() {
      const snap = this.snapshot();
      this._subs.forEach((cb) => cb(snap));
    }
    snapshot() {
      return {
        connected: this.connected,
        chain: this.chain,
        l1Head: this.l1Head,
        l2Head: this.l2Head,
        active: this.active,
        queue: this.queue.slice(),
        history: this.history.slice(),
        aggregations: this.aggregations || [],
        recentDurations: this.recentDurations.slice(-44),
        stats: this.stats,
        metrics: this.metrics || null,            // rich ledger aggregates (live feed only)
        l2ProvenFrontier: this.l2ProvenFrontier ?? null,
        provingStatus: this.provingStatus || null,
        failedCount: this.failedCount || 0,
        cluster: this.cluster || null,   // worker roster (live feed only)
        source: this.source || null,     // data-source label (live feed only)
      };
    }

    // ---- real-backend entry point (unused in the mock) ----
    setConnected(v) { this.connected = v; this._emit(); }
    ingest(snapshotPatch) {
      Object.assign(this, snapshotPatch);
      // A feed that supplies its own `stats` (e.g. aggregate /metrics) keeps them;
      // otherwise derive stats from history + recentDurations.
      if (!snapshotPatch.stats) this._recomputeStats();
      this._emit();
    }

    // ---- seed initial state ----
    _seed() {
      // seed a deep, realistic history for the blocks list + distribution
      const COUNT = 34;
      let block = this._nextBlock;
      const seeds = [];
      for (let i = 0; i < COUNT; i++) {
        const blocks = pick([10, 10, 10, 10, 5, 1]);
        block -= blocks;
        seeds.push({ start: block, blocks });
      }
      seeds.reverse(); // oldest first
      const nowT = Date.now();
      seeds.forEach((s, i) => {
        const job = makeJob(s.start, s.blocks);
        job.stages.forEach((st) => { st.status = "done"; st.elapsedMs = st.durationMs; });
        job.stageIndex = job.stages.length;
        const failed = Math.random() < 0.06;
        if (failed) {
          const failAt = 3 + ((Math.random() * 3) | 0); // fail during inner/agg/snark
          job.stages.forEach((st, k) => {
            if (k < failAt) { st.status = "done"; st.elapsedMs = st.durationMs; }
            else { st.status = "pending"; st.elapsedMs = 0; }
          });
          job.stageIndex = failAt;
          job.status = "failed";
          job.txHash = null;
          this.failedCount++;
        } else {
          job.status = "proven";
          job.txHash = hex(64);
        }
        job.elapsedMs = job.stages.reduce((a, x) => a + x.elapsedMs, 0);
        job.startedAt = nowT - (COUNT - i) * 352000 - rnd(0, 90000);
        job.finishedAt = job.startedAt + job.elapsedMs;
        job.etaMs = 0;
        if (job.status === "proven") this.recentDurations.push(job.elapsedMs);
        this.history.unshift(job);
      });

      // active job, partway through
      const active = makeJob(this._nextBlock, 10);
      this._nextBlock = active.rangeEnd;
      active.status = "proving";
      active.startedAt = Date.now();
      // pre-advance to ~ start of inner proofs for an immediately interesting hero
      this._advanceJobBy(active, active.stages[0].durationMs + active.stages[1].durationMs + active.stages[2].durationMs + active.stages[3].durationMs * 0.35);
      this.active = active;

      // queue
      for (let i = 0; i < 5; i++) {
        const blocks = pick([10, 10, 10, 5, 1]);
        const job = makeJob(this._nextBlock, blocks);
        this._nextBlock = job.rangeEnd;
        this.queue.push(job);
      }
      // recent proving times are seeded from history above
      this.l2Head = this._nextBlock;
      this._recomputeStats();
    }

    _advanceJobBy(job, ms) {
      let remaining = ms;
      while (remaining > 0 && job.stageIndex < job.stages.length) {
        const st = job.stages[job.stageIndex];
        st.status = "active";
        const room = st.durationMs - st.elapsedMs;
        if (remaining >= room) {
          st.elapsedMs = st.durationMs;
          st.status = "done";
          remaining -= room;
          job.stageIndex++;
        } else {
          st.elapsedMs += remaining;
          remaining = 0;
        }
      }
      // recompute elapsed / eta
      job.elapsedMs = job.stages.reduce((s, x) => s + x.elapsedMs, 0);
      job.etaMs = jobTotalDuration(job) - job.elapsedMs;
    }

    // ---- simulation loop ----
    startSimulation() {
      if (this._timer) return;
      this.connected = true;
      this._lastTick = performance.now();
      this._timer = setInterval(() => this._tick(), 100);
      this._emit();
    }
    stopSimulation() {
      clearInterval(this._timer);
      this._timer = null;
    }

    _tick() {
      const now = performance.now();
      const dt = (now - this._lastTick) * TIME_SCALE;
      this._lastTick = now;

      if (!this.active) {
        this._pullNext();
        this._emit();
        return;
      }

      const job = this.active;
      this._advanceJobBy(job, dt);

      if (job.stageIndex >= job.stages.length) {
        // completed
        job.status = Math.random() < 0.04 ? "failed" : "proven";
        job.finishedAt = Date.now();
        job.txHash = job.status === "proven" ? hex(64) : null;
        job.etaMs = 0;
        if (job.status === "proven") {
          this.recentDurations.push(job.elapsedMs);
          if (this.recentDurations.length > 60) this.recentDurations.shift();
        } else {
          this.failedCount++;
        }
        this.history.unshift(job);
        if (this.history.length > HISTORY_MAX) this.history.pop();
        this.active = null;
        this._pullNext();
        this._recomputeStats();
      }
      this._emit();
    }

    _pullNext() {
      if (this.queue.length === 0) this._replenish();
      const next = this.queue.shift();
      if (next) {
        next.status = "proving";
        next.startedAt = Date.now();
        next.stages[0].status = "active";
        this.active = next;
      }
      this._replenish();
    }

    _replenish() {
      while (this.queue.length < 5) {
        const blocks = pick([10, 10, 10, 5, 1]);
        const job = makeJob(this._nextBlock, blocks);
        this._nextBlock = job.rangeEnd;
        this.queue.push(job);
        this.l2Head = this._nextBlock;
      }
    }

    _recomputeStats() {
      const m = this.metrics;  // authoritative ledger aggregates (live feed) — prefer these
      const proven = this.history.filter((j) => j.status === "proven");
      // ONLY timed ranges feed averages/percentiles — never the 0ms RPC-only blocks
      const timed = proven.filter((j) => j.elapsedMs > 0).map((j) => j.elapsedMs);
      const pctile = (arr, p) => {
        if (!arr.length) return 0;
        const s = arr.slice().sort((a, b) => a - b);
        return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
      };
      const times = timed.map((ms) => ms / 1000);
      // honest distribution: just the spread of range proof times + median/p95 markers
      let dist = { total: 0, p50: 0, p95: 0, fastest: 0, slowest: 0, hist: [] };
      if (times.length) {
        const lo = Math.floor(Math.min(...times) / 60) * 60;
        const hi = Math.max(lo + 60, Math.ceil(Math.max(...times) / 60) * 60);
        const step = Math.max(30, Math.round((hi - lo) / 12 / 30) * 30);
        const hist = [];
        for (let l = lo; l < hi; l += step) {
          const h = l + step;
          hist.push({ lo: l, hi: h, count: times.filter((t) => t >= l && t < h).length });
        }
        dist = { total: times.length, p50: pctile(timed, 50) / 1000, p95: pctile(timed, 95) / 1000,
          fastest: Math.min(...times), slowest: Math.max(...times), hist };
      }
      this.stats = {
        provenToday: m ? m.rangesProven : proven.length,
        avgProveMs: m ? m.avgTotalMs : (timed.length ? timed.reduce((a, b) => a + b, 0) / timed.length : 0),
        successRate: 100,
        p50Ms: pctile(timed, 50),
        p95Ms: pctile(timed, 95),
        dist,
      };
    }
  }

  window.ProverFeed = ProverFeed;
  window.PROVER_STAGE_DEFS = STAGE_DEFS;
})();
