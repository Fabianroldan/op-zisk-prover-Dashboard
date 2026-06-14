// ==============================================================
// OP-ZiSK Prover — shared formatters + helpers (window.PU).
// Plain JS so every Babel script can read it off window.
// ==============================================================
(function () {
  const pad = (n) => String(n).padStart(2, "0");
  function fmtClock(ms) {
    if (!ms || ms <= 0) return "—";
    const s = Math.round(ms / 1000);
    return `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
  }
  function fmtSecs(ms) {
    if (!ms || ms <= 0) return "—";
    const s = ms / 1000;
    return s >= 100 ? `${Math.round(s)}s` : `${s.toFixed(1)}s`;
  }
  const fmtNum = (n) => Math.round(n).toLocaleString("en-US");
  function fmtCompact(n) {
    if (!n) return "—";
    const a = Math.abs(n);
    if (a >= 1e9) return (n / 1e9).toFixed(2) + "B";
    if (a >= 1e6) return (n / 1e6).toFixed(2) + "M";
    if (a >= 1e3) return (n / 1e3).toFixed(1) + "K";
    return String(Math.round(n));
  }
  const fmtBlock = (n) => n.toLocaleString("en-US");
  function fmtBytes(b) {
    if (b >= 1e6) return (b / 1e6).toFixed(2) + " MB";
    if (b >= 1e3) return Math.round(b / 1e3) + " KB";
    return b + " B";
  }
  function fmtUSD(n) {
    if (n >= 1) return "$" + n.toFixed(2);
    return "$" + n.toFixed(4);
  }
  const shortHash = (h) => (h ? h.slice(0, 12) + "…" + h.slice(-8) : "—");
  function timeAgo(ts) {
    if (!ts) return "—";
    const s = Math.max(0, (Date.now() - ts) / 1000);
    if (s < 60) return Math.floor(s) + "s ago";
    if (s < 3600) return Math.floor(s / 60) + "m ago";
    if (s < 86400) return Math.floor(s / 3600) + "h ago";
    return Math.floor(s / 86400) + "d ago";
  }
  // cost estimate for a job (USD) — proven uses real elapsed, else total est
  function jobCost(job) {
    const total = job.stages.reduce((s, x) => s + x.durationMs, 0);
    const ms = (job.status === "proven" || job.status === "failed") ? job.elapsedMs : total;
    return (ms / 1000) * (job.costRate || 0.0001);
  }
  function jobTotalMs(job) { return job.stages.reduce((s, x) => s + x.durationMs, 0); }

  const SHORT = { witness: "Witness", setup: "Setup", execute: "Execute", contrib: "Contributions", inner: "Inner proofs", prove: "Range STARK" };
  const FULL = { witness: "Witness gen", setup: "Prover setup", execute: "Execute", contrib: "Contributions", inner: "Inner proofs", prove: "Range STARK proof" };
  const SUBS = {
    witness: "kona host · preimage gen",
    setup: "proofman · const pols/trees + ROM",
    execute: "cargo-zisk · ASM execute",
    contrib: "cargo-zisk · calculating contributions",
    inner: "cargo-zisk · inner STARK proofs",
    prove: "cargo-zisk · range STARK (VadcopFinalMinimal)",
  };

  function stageStatus(job, st) {
    return { sub: SUBS[st.key] || "", right: st.durationMs ? fmtClock(st.durationMs) : "" };
  }

  window.PU = { pad, fmtClock, fmtSecs, fmtNum, fmtCompact, fmtBlock, fmtBytes, fmtUSD, shortHash, timeAgo, jobCost, jobTotalMs, SHORT, FULL, stageStatus };
})();
