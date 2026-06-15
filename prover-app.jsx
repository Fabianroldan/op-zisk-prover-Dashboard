// ==============================================================
// OP-ZiSK Prover — app shell + hash router + views.
// Views: dashboard (live) · blocks (list) · block (detail).
// Depends on window.PU (util), window.{Sparkline,Timeline,Histogram},
// and window.proverFeed (data).
// ==============================================================
const { useState, useEffect } = React;
const { pad, fmtClock, fmtSecs, fmtDur, fmtNum, fmtCompact, fmtBlock, fmtBytes, fmtUSD, shortHash, timeAgo, jobCost, jobTotalMs, FULL, stageStatus } = window.PU;
const { Sparkline, Timeline, Histogram } = window;

const nav = (hash) => { window.location.hash = hash; };
function parseHash() {
  const h = window.location.hash.replace(/^#\/?/, "");
  if (h.startsWith("block/")) return { name: "block", id: decodeURIComponent(h.slice(6)) };
  if (h.startsWith("blocks")) return { name: "blocks" };
  return { name: "dashboard" };
}

// ======================= THEME TOGGLE =======================
function ThemeToggle() {
  const [dark, setDark] = useState(() => document.documentElement.getAttribute("data-theme") === "dark");
  const flip = () => {
    const next = dark ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    try { localStorage.setItem("opzisk-theme", next); } catch (e) {}
    setDark(!dark);
  };
  return (
    <button className="icon-btn" type="button" title={dark ? "Light mode" : "Dark mode"} onClick={flip}>
      {dark ? (
        <svg width="19" height="19" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M15 10.2A6.2 6.2 0 1 1 7.8 3a4.8 4.8 0 0 0 7.2 7.2Z" />
        </svg>
      ) : (
        <svg width="19" height="19" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
          <circle cx="9" cy="9" r="3.2" /><path d="M9 1.5v1.8M9 14.7v1.8M1.5 9h1.8M14.7 9h1.8M3.7 3.7l1.3 1.3M13 13l1.3 1.3M3.7 14.3l1.3-1.3M13 5l1.3-1.3" />
        </svg>
      )}
    </button>
  );
}

// ======================= SIDEBAR =======================
function Sidebar({ route, snap, onNav }) {
  const items = [
    { key: "dashboard", label: "Live", hash: "#/", icon: <path d="M2 9h3l2-5 3 11 2-6h4" /> },
    { key: "blocks", label: "Blocks", hash: "#/blocks", icon: <g><rect x="2.5" y="2.5" width="13" height="4" rx="1.4" /><rect x="2.5" y="7.5" width="13" height="4" rx="1.4" /><rect x="2.5" y="12.5" width="13" height="2.8" rx="1.4" /></g> },
  ];
  return (
    <aside className="sidebar">
      <div className="sb-rail">
        {items.map((it) => (
          <a key={it.key} className={"sb-item" + (route.name === it.key ? " on" : "")} title={it.label} href={it.hash} onClick={(e) => { e.preventDefault(); onNav(it.hash); }}>
            <svg width="19" height="19" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">{it.icon}</svg>
          </a>
        ))}
        <div className="sb-spacer"></div>
        <ThemeToggle />
        <button className="sb-item" type="button" title="Sign out" onClick={() => { if (window.confirm("Reset the dashboard view?")) window.location.reload(); }}>
          <svg width="19" height="19" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M7 15.5H3.5a1 1 0 0 1-1-1v-11a1 1 0 0 1 1-1H7M11.5 12l3-3-3-3M14.5 9H7" /></svg>
        </button>
      </div>
    </aside>
  );
}

// ======================= SEARCH (job id · block · host) =======================
function Search({ snap }) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(0);

  const all = [];
  if (snap.active) all.push(snap.active);
  snap.queue.forEach((j) => all.push(j));
  snap.history.forEach((j) => all.push(j));

  const query = q.trim().toLowerCase();
  const num = parseInt(query.replace(/[^0-9]/g, ""), 10);
  const results = !query ? [] : all.filter((j) => {
    if (j.id.toLowerCase().includes(query)) return true;
    if (j.host.toLowerCase().includes(query)) return true;
    if (!isNaN(num) && num >= j.rangeStart && num <= j.rangeEnd) return true;
    if (String(j.rangeStart).includes(query) || String(j.rangeEnd).includes(query)) return true;
    return false;
  }).slice(0, 7);

  const go = (job) => { if (!job) return; setQ(""); setOpen(false); nav(`#/block/${job.id}`); };
  const onKey = (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setHi((h) => Math.min(h + 1, results.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setHi((h) => Math.max(h - 1, 0)); }
    else if (e.key === "Enter") { go(results[hi]); }
    else if (e.key === "Escape") { setOpen(false); }
  };

  return (
    <div className="search-wrap">
      <div className="search">
        <span className="s-ico"><svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6"><circle cx="7" cy="7" r="4.5" /><path d="M11 11l3 3" strokeLinecap="round" /></svg></span>
        <input
          placeholder="Search ranges, JOB id…"
          value={q}
          onChange={(e) => { setQ(e.target.value); setOpen(true); setHi(0); }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 140)}
          onKeyDown={onKey}
        />
      </div>
      {open && query && (
        <div className="search-pop">
          {results.length === 0 && <div className="sp-empty">No match for “{q}”</div>}
          {results.map((j, i) => (
            <div key={j.id} className={"sp-row" + (i === hi ? " on" : "")} onMouseDown={() => go(j)} onMouseEnter={() => setHi(i)}>
              <span className={"sp-dot " + j.status}></span>
              <div className="sp-main">
                <div className="sp-range">{fmtBlock(j.rangeStart)}<span className="arw">→</span>{fmtBlock(j.rangeEnd)}</div>
                <div className="sp-sub">{j.id} · {j.blocks} blk · {j.host}</div>
              </div>
              <span className="sp-tag">{j.status}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ======================= TOP BAR (greeting + search) =======================
function MainBar({ title, sub, snap, now, back }) {
  const t = new Date(now);
  const r = parseHash();
  const tabs = [{ k: "dashboard", label: "Live", hash: "#/" }, { k: "blocks", label: "Blocks", hash: "#/blocks" }];
  return (
    <div className="apphead">
      <div className="ah-left">
        {back && <button className="ah-back" onClick={() => nav(back)}>←</button>}
        <div>
          <div className="ah-brand" onClick={() => nav("#/")} title="OP × ZisK">
            <span className="wm-op">OP</span><span className="wm-x">×</span><span className="wm-zisk">ZisK</span>
          </div>
          <h1 className="ah-title">{title}</h1>
          {sub && <div className="ah-sub">{sub}</div>}
        </div>
      </div>
      <div className="ah-right">
        <nav className="ah-nav">
          {tabs.map((tb) => (
            <a key={tb.k} className={"ah-tab" + (r.name === tb.k ? " on" : "")} href={tb.hash} onClick={(e) => { e.preventDefault(); nav(tb.hash); }}>{tb.label}</a>
          ))}
        </nav>
        <Search snap={snap} />
        <span className="clock">{pad(t.getUTCHours())}<span className="sep">:</span>{pad(t.getUTCMinutes())}<span className="sep">:</span>{pad(t.getUTCSeconds())} UTC</span>
        <ThemeToggle />
        <button className="icon-btn" title="Notifications"><svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M9 2a4 4 0 0 0-4 4c0 4-1.5 5-1.5 5h11S13 10 13 6a4 4 0 0 0-4-4ZM7.5 14.5a1.5 1.5 0 0 0 3 0" /></svg><span className="dotred"></span></button>
      </div>
    </div>
  );
}

// ======================= METRIC RAIL =======================
function Rail({ snap }) {
  const s = snap.stats, m = snap.metrics;
  const behind = (snap.l2Head && snap.l2ProvenFrontier) ? snap.l2Head - snap.l2ProvenFrontier : 0;
  return (
    <div className="rail">
      <div className="m"><span className="m-l">Proven</span><span className="m-v green">{m ? m.rangesProven : s.provenToday}<span className="u">ranges · {m ? m.blocksProven : 0} blk</span></span></div>
      <div className="m"><span className="m-l">Throughput</span><span className="m-v">{m && m.blocksPerHour ? m.blocksPerHour.toFixed(1) : "—"}<span className="u">blk/hr</span></span></div>
      <div className="m"><span className="m-l">Avg / range</span><span className="m-v">{fmtDur(s.avgProveMs)}<span className="u">p95 {fmtDur(s.p95Ms)}</span></span></div>
      <div className="m"><span className="m-l">Proven frontier</span><span className="m-v">{snap.l2ProvenFrontier ? fmtBlock(snap.l2ProvenFrontier) : "—"}</span></div>
      <div className="m"><span className="m-l">Behind tip</span><span className="m-v">{behind ? fmtNum(behind) : "—"}<span className="u">blocks</span></span></div>
      <div className="m grow spark"><span className="m-l">Range time · last {snap.recentDurations.length}</span><Sparkline data={snap.recentDurations} /></div>
    </div>
  );
}

// ======================= CURRENT JOB (hero) =======================
function CurrentJob({ job }) {
  if (!job) {
    return (
      <div className="hero">
        <div className="sec"><span className="sec-t">Currently proving</span><span className="rule"></span></div>
        <div className="hero-card" style={{ cursor: "default" }}><div className="empty">Idle — awaiting next range…</div></div>
      </div>
    );
  }
  // progress + ETA come from the bridge (historical-avg based) — never the 100% done-only bug
  const pct = job.progress != null ? job.progress : Math.min(100, (job.elapsedMs / (jobTotalMs(job) || 1)) * 100);
  const ai = Math.min(job.stageIndex, job.stages.length - 1);
  const active = job.stages[ai];
  const ss = stageStatus(job, active);
  return (
    <div className="hero">
      <div className="sec"><span className="sec-t">Currently proving</span><span className="sec-c">{job.id}</span><span className="rule"></span><span className="sec-c">stage {Math.min(job.stageIndex + 1, job.stages.length)} / {job.stages.length}</span></div>
      <div className="hero-card" onClick={() => nav(`#/block/${job.id}`)}>
        <div className="hero-top">
          <div>
            <div className="hero-id">
              {job.stalled
                ? <span className="live-tag stalled"><span className="ld"></span>Stalled</span>
                : <span className="live-tag"><span className="ld"></span>Proving</span>}
              <span className="jid">{job.host}</span>
              {job.stalled && <span className="flag">⚠ no GPU progress · {fmtDur(active.elapsedMs)} in {FULL[active.key]}</span>}
            </div>
            <h1 className="hero-range">{fmtBlock(job.rangeStart)}<span className="arw">→</span>{fmtBlock(job.rangeEnd)}</h1>
            <div className="hero-meta">
              <span className="mi"><b>{job.blocks}</b> block{job.blocks > 1 ? "s" : ""}</span>
              {job.proofBytes > 0 && <span className="mi"><b>{fmtBytes(job.proofBytes)}</b> proof</span>}
              <span className="mi">range proof</span>
            </div>
          </div>
          <div className="hero-timers">
            <div className="tmr big"><span className="tl">Elapsed</span><span className="tv">{fmtDur(job.elapsedMs)}</span></div>
            <div className="tmr"><span className="tl">ETA</span><span className="tv eta">{job.stalled ? "—" : fmtDur(job.etaMs)}</span></div>
            <div className="tmr"><span className="tl">Progress</span><span className={"tv pct" + (job.stalled ? " stall" : "")}>{job.stalled ? "STALL" : Math.round(pct) + "%"}</span></div>
          </div>
        </div>
        <Timeline job={job} />
        <div className="callout">
          <span className="play">▶</span>
          <span className="cstage">{FULL[active.key]}</span>
          <span className="cstatus"><b>{ss.sub}</b></span>
          <span className="cright">{fmtSecs(active.elapsedMs)}{active.expectedMs > 0 ? ` / ~${fmtSecs(active.expectedMs)} exp` : ""}</span>
        </div>
      </div>
    </div>
  );
}

// ======================= shared bits =======================
function StatusTag({ status }) {
  const label = { proven: "Proven", failed: "Failed", proving: "Proving", queued: "Queued", agg: "Aggregated" }[status] || status;
  return <span className={"tag " + status}><span className="td"></span>{label}</span>;
}
function MiniStrip({ job }) {
  return <span className="strip">{job.stages.map((st, i) => <i key={i} className={st.status === "done" ? "done" : st.status === "active" ? "active" : ""}></i>)}</span>;
}

// ======================= QUEUE =======================
function Queue({ queue, perAgg }) {
  const N = perAgg || 2;
  return (
    <div className="panel-b">
      <div className="sec"><span className="sec-t">Queue</span><span className="sec-c">{queue.length}</span><span className="rule"></span><span className="sec-c">witness-cached · range proofs</span></div>
      {queue.length === 0 && <div className="empty">Queue empty</div>}
      <div className="q-scroll">
        {queue.map((job, i) => {
          // after every N range proofs an aggregation fires — show the divider + which ranges it spans
          const aggBoundary = (i + 1) % N === 0;
          const grp = queue.slice(i - N + 1, i + 1);
          return (
            <React.Fragment key={job.id + "-" + i}>
              <div className="qrow" onClick={() => nav(`#/block/${job.id}`)}>
                <span className="qpos">{pad(i + 1)}</span>
                <div>
                  <div className="q-range">{fmtBlock(job.rangeStart)}<span className="arw">→</span>{fmtBlock(job.rangeEnd)}</div>
                  <div className="q-sub">range proof · {job.blocks} blk</div>
                </div>
                <div className="q-right"><span className="qtag range">range</span></div>
              </div>
              {aggBoundary && grp.length === N && (
                <div className="qagg">
                  <span className="qagg-i">⊕</span>
                  <span className="qagg-t">PLONK agg · {N} ranges · {grp.reduce((s, g) => s + g.blocks, 0)} blocks</span>
                  <span className="qagg-r">{fmtBlock(grp[0].rangeStart)} → {fmtBlock(grp[grp.length - 1].rangeEnd)}</span>
                </div>
              )}
            </React.Fragment>
          );
        })}
      </div>
      <div className="qdepth"><span className="ql">Backlog depth</span><span className="qv">{queue.length} ranges · {queue.reduce((s, j) => s + j.blocks, 0)} blocks witness-cached</span></div>
    </div>
  );
}

// ======================= DASHBOARD =======================
const STREAM_COLS = "1.5fr 0.55fr 1fr 0.8fr 0.85fr";
function StreamTable({ history }) {
  const rows = history.slice(0, 8);
  return (
    <div className="panel-b">
      <div className="sec"><span className="sec-t">Proving stream</span><span className="sec-c">live</span><span className="rule"></span><a className="sec-link" href="#/blocks" onClick={(e) => { e.preventDefault(); nav("#/blocks"); }}>all blocks →</a></div>
      <div className="tbl-h" style={{ gridTemplateColumns: STREAM_COLS }}>
        <span>Range</span><span className="r">Blocks</span><span>Pipeline</span><span className="r">Proof time</span><span className="r">Status</span>
      </div>
      {rows.map((job) => (
        <div key={job.id} className="row" style={{ gridTemplateColumns: STREAM_COLS }} onClick={() => nav(`#/block/${job.id}`)}>
          <div>
            <div className="c-range">{fmtBlock(job.rangeStart)}<span className="arw">→</span>{fmtBlock(job.rangeEnd)}</div>
            <div className="c-id">{job.id} · {timeAgo(job.finishedAt)}</div>
          </div>
          <div className="c-blk">{job.blocks}</div>
          <MiniStrip job={job} />
          <div className="c-time">{fmtClock(job.elapsedMs)}</div>
          <div style={{ textAlign: "right" }}><StatusTag status={job.status} /></div>
        </div>
      ))}
    </div>
  );
}

// ======================= CLUSTER (live worker roster) =======================
function Cluster({ cluster }) {
  const ws = cluster.workers || [];
  return (
    <div className="panel-b">
      <div className="sec"><span className="sec-t">Cluster</span><span className="sec-c">{cluster.workersConnected}</span><span className="rule"></span><span className="sec-c">workers · {cluster.activeJobs} active</span></div>
      {ws.length === 0 && <div className="empty">No worker job records</div>}
      {ws.map((w) => {
        const total = (w.success || 0) + (w.failure || 0);
        const pct = total ? Math.round((w.success / total) * 100) : 0;
        return (
          <div key={w.id} className="qrow" style={{ cursor: "default" }}>
            <span className="qpos">W{w.id}</span>
            <div>
              <div className="q-range">worker {w.id}</div>
              <div className="q-sub">{w.success} ok · {w.failure} fail</div>
            </div>
            <div className="q-right"><span className="q-eta">{pct}% ok</span></div>
          </div>
        );
      })}
    </div>
  );
}

// ======================= NETWORK METRICS (real ledger aggregates) =======================
function NetMetrics({ m }) {
  if (!m) return null;
  const cell = (l, v, s) => (
    <div className="mcell"><div className="ml">{l}</div><div className="mv">{v}</div>{s && <div className="ms">{s}</div>}</div>
  );
  return (
    <div className="panel-b">
      <div className="sec"><span className="sec-t">Network metrics</span><span className="rule"></span><span className="sec-c">{m.rangesProven} ranges · {m.blocksProven} blocks · from ledger</span></div>
      <div className="mgrid det-grid">
        {cell("Throughput", m.blocksPerHour ? m.blocksPerHour.toFixed(1) : "—", "blocks / hour")}
        {cell("Sec / block", m.secPerBlock ? m.secPerBlock.toFixed(0) + "s" : "—", "proving rate")}
        {cell("Avg range size", m.avgRangeBlocks ? m.avgRangeBlocks.toFixed(1) : "—", "blocks / range")}
        {cell("Avg gas / block", m.avgGasPerBlock ? fmtCompact(m.avgGasPerBlock) : "—", m.gasCount + " measured")}
        {cell("Avg witness gen", fmtDur(m.avgWitnessMs), "kona host")}
        {cell("Avg prove", fmtDur(m.avgProveMs), "after witness")}
        {cell("Avg total / range", fmtDur(m.avgTotalMs), m.measuredCount + " measured")}
        {cell("Avg agg (PLONK)", m.aggCount ? fmtDur(m.avgAggMs) : "—", (m.aggCount || 0) + " batch" + (m.aggCount === 1 ? "" : "es"))}
        {cell("Proof instances / range", m.instancesAvailable ? fmtNum(m.avgInstances) : "—", m.avgMain ? "Main " + fmtNum(m.avgMain) : "ZisK segments")}
        {cell("Avg proof size", m.avgProofBytes ? fmtBytes(m.avgProofBytes) : "—", "range STARK")}
        {cell("Backlog", (m.backlogRanges || 0) + " ranges", (m.backlogBlocks || 0) + " blocks witness-cached")}
        {cell("Total gas proven", m.totalGas ? fmtCompact(m.totalGas) : "—", null)}
      </div>
    </div>
  );
}

function Dashboard({ snap, now }) {
  const live = !!snap.cluster;
  return (
    <div className="view">
      <MainBar title="Live" sub={snap.source || "real-time OP range proving"} snap={snap} now={now} />
      <Rail snap={snap} />
      <CurrentJob job={snap.active} />
      <NetMetrics m={snap.metrics} />
      <div className="dash-grid">
        <div className="panel-b">
          <div className="sec"><span className="sec-t">Proof-time distribution</span><span className="rule"></span><span className="sec-c">{snap.stats.dist ? snap.stats.dist.total : 0} proven</span></div>
          <Histogram dist={snap.stats.dist} />
        </div>
        {live ? <Cluster cluster={snap.cluster} /> : <Queue queue={snap.queue} perAgg={snap.metrics && snap.metrics.rangesPerAgg} />}
      </div>
      <AggList aggs={snap.aggregations} />
      {live && snap.history.length === 0
        ? <div className="panel-b"><div className="sec"><span className="sec-t">Proving stream</span><span className="rule"></span></div><div className="empty">Coordinator 1.0.0-beta exposes aggregate metrics only — no per-range rows. Per-job stream needs the /api/v1 build or Postgres history.</div></div>
        : <StreamTable history={snap.history} />}
    </div>
  );
}

// ======================= AGGREGATIONS =======================
function AggList({ aggs }) {
  if (!aggs || !aggs.length) return null;
  return (
    <div className="panel-b" style={{ marginTop: 24 }}>
      <div className="sec"><span className="sec-t">Aggregations</span><span className="sec-c">{aggs.length}</span><span className="rule"></span><span className="sec-c">PLONK · batches of range proofs</span></div>
      <div className="q-scroll">
        {aggs.map((a, i) => (
          <div key={a.id + "-" + i} className="qrow" onClick={() => nav(`#/block/${a.id}`)}>
            <span className="qpos agg">⊕</span>
            <div>
              <div className="q-range">{fmtBlock(a.rangeStart)}<span className="arw">→</span>{fmtBlock(a.rangeEnd)}</div>
              <div className="q-sub">{a.ranges} ranges · {a.blocks} blocks{a.snarkMs ? ` · SNARK ${fmtSecs(a.snarkMs)}` : ""}</div>
            </div>
            <div className="q-right"><span className="qtag agg">agg</span><span className="q-eta">{fmtDur(a.elapsedMs)}</span></div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ======================= BLOCKS PAGE =======================
const BLOCKS_COLS = "1.4fr 0.5fr 1fr 0.8fr 0.7fr 0.8fr 0.7fr";
function BlocksPage({ snap, now }) {
  const [filter, setFilter] = useState("all");
  const all = snap.history;
  const list = all.filter((j) => filter === "all" ? true : j.status === filter);
  const s = snap.stats;
  return (
    <div className="view">
      <MainBar title="Blocks" sub="every proven & failed OP range" snap={snap} now={now} />
      <div className="rail">
        <div className="m"><span className="m-l">Total ranges</span><span className="m-v">{all.length}</span></div>
        <div className="m"><span className="m-l">Eligible rate</span><span className="m-v green">{s.dist ? s.dist.greenPct : 0}<span className="u">%</span></span></div>
        <div className="m"><span className="m-l">Avg prove</span><span className="m-v">{fmtClock(s.avgProveMs)}</span></div>
        <div className="m"><span className="m-l">p95</span><span className="m-v">{fmtClock(s.p95Ms)}</span></div>
        <div className="m"><span className="m-l">Failed</span><span className="m-v red">{s.dist ? s.dist.failed : 0}</span></div>
        <div className="m grow"><span className="m-l">Proven frontier</span><span className="m-v">{snap.l2ProvenFrontier ? fmtBlock(snap.l2ProvenFrontier) : "—"}</span></div>
      </div>

      <div className="filters">
        {["all", "proven", "failed"].map((f) => (
          <button key={f} className={"chip" + (filter === f ? " on" : "")} onClick={() => setFilter(f)}>
            {f === "all" ? "All" : f === "proven" ? "Proven" : "Failed"}
            <span className="chip-n">{f === "all" ? all.length : all.filter((j) => j.status === f).length}</span>
          </button>
        ))}
      </div>

      <div className="panel-b">
        <div className="tbl-h" style={{ gridTemplateColumns: BLOCKS_COLS }}>
          <span>Range</span><span className="r">Blocks</span><span>Prover</span><span className="r">Proof time</span><span className="r">Size</span><span className="r">Status</span><span className="r">When</span>
        </div>
        <div className="tbl-scroll">
          {list.map((job) => (
            <div key={job.id} className="row" style={{ gridTemplateColumns: BLOCKS_COLS }} onClick={() => nav(`#/block/${job.id}`)}>
              <div>
                <div className="c-range">{fmtBlock(job.rangeStart)}<span className="arw">→</span>{fmtBlock(job.rangeEnd)}</div>
                <div className="c-id">{job.id}</div>
              </div>
              <div className="c-blk">{job.blocks}</div>
              <div className="c-cluster">{job.host}</div>
              <div className="c-time">{fmtClock(job.elapsedMs)}</div>
              <div className="c-size">{job.proofBytes > 0 ? fmtBytes(job.proofBytes) : "—"}</div>
              <div style={{ textAlign: "right" }}><StatusTag status={job.status} /></div>
              <div className="c-when">{timeAgo(job.finishedAt)}</div>
            </div>
          ))}
          {list.length === 0 && <div className="empty">No {filter} ranges</div>}
        </div>
      </div>
    </div>
  );
}

// ======================= BLOCK DETAIL =======================
// explains what the proof actually proves — range semantics vs aggregation semantics
function ProofExplainer({ job }) {
  const isAgg = job.kind === "agg";
  const s = job.rangeStart, e = job.rangeEnd, n = job.blocks;
  return (
    <div className="panel-b explainer" style={{ marginTop: 22 }}>
      <div className="sec"><span className="sec-t">What this proves</span><span className="rule"></span>
        <span className="sec-c">{isAgg ? "PLONK aggregation" : "OP validity proof · derivation + execution"}</span></div>
      {isAgg ? (
        <div className="xp">
          <p>Proves a batch of range proofs composes into one PLONK proof: every range proof verifies, consecutive roots chain (<code>range[i].l2PostRoot == range[i+1].l2PreRoot</code>), the rollup config is consistent, the range VK is correct, and each <code>l1Head</code> is included in the supplied L1 header chain up to the checkpoint.</p>
          <div className="xfields"><span>aggregates</span><b>{n} blocks · {fmtBlock(s)} → {fmtBlock(e)}</b></div>
        </div>
      ) : (
        <div className="xp">
          <p>OP validity proof for the contiguous interval <code>({fmtBlock(s)}, {fmtBlock(e)}]</code> — proves blocks <b>{fmtBlock(s + 1)}–{fmtBlock(e)}</b> ({n} block{n > 1 ? "s" : ""}). Block <b>{fmtBlock(s)}</b> is the pre-state anchor (<code>l2PreRoot</code>), not itself proved.</p>
          <p>Inside ZisK, Kona runs the OP derivation pipeline (L1 data · batches · blobs · preimages) → canonical L2 payloads, then executes them under OP-EVM rules with ZisK precompile routing. The output root computed at block {fmtBlock(e)} must equal the claimed <code>l2PostRoot</code>.</p>
          <div className="xfields"><span>publicly commits</span><b>l1Head · l2PreRoot · l2PostRoot · l2BlockNumber · rollupConfigHash</b></div>
        </div>
      )}
    </div>
  );
}

function BlockDetail({ job, snap, now }) {
  if (!job) {
    return (
      <div className="view">
        <MainBar title="Block not found" snap={snap} now={now} back="#/blocks" />
        <div className="panel-b"><div className="empty">This range is no longer in the live window.</div></div>
      </div>
    );
  }
  const isAgg = job.kind === "agg";
  const done = job.status === "proven" || job.status === "failed";
  const proving = job.status === "proving";
  const witnessMs = job.stages.find((s) => s.key === "witness")?.durationMs || 0;
  const snarkMs = job.stages.find((s) => s.key === "snark")?.durationMs || job.snarkMs || 0;
  const totalMs = jobTotalMs(job);
  const proveMs = Math.max(0, totalMs - witnessMs);   // all cargo-zisk phases combined
  // all phases done but proof not yet written -> final save/verify
  const finalizing = proving && job.stageIndex >= job.stages.length;
  // unavailable-until-proven fields read "pending" while proving, not a bare dash
  const pend = (v, fmt) => v > 0 ? fmt(v) : (proving ? <span className="mv-pending">pending</span> : "—");
  return (
    <div className="view">
      <MainBar title={`${fmtBlock(job.rangeStart)} → ${fmtBlock(job.rangeEnd)}`} sub={isAgg ? `PLONK agg · ${job.ranges} ranges · ${snap.chain}` : `proves ${fmtBlock(job.rangeStart + 1)}–${fmtBlock(job.rangeEnd)} · ${snap.chain}`} snap={snap} now={now} back={isAgg ? "#/" : "#/blocks"} />

      <div className="det-head">
        <StatusTag status={isAgg ? "agg" : job.status} />
        <span className="det-meta"><b>{job.blocks}</b> blocks</span>
        {isAgg && <span className="det-meta"><b>{job.ranges}</b> ranges</span>}
        <span className="det-meta">prover <b>{job.host}</b></span>
        <span className="det-meta">{done ? `finished ${timeAgo(job.finishedAt)}` : finalizing ? "finalizing — writing proof" : proving ? "in progress" : "queued"}</span>
      </div>

      {isAgg ? (
        <div className="mgrid det-grid">
          <div className="mcell"><div className="ml">Total agg time</div><div className="mv">{fmtDur(job.elapsedMs)}</div></div>
          <div className="mcell"><div className="ml">SNARK wrap</div><div className="mv">{snarkMs > 0 ? fmtSecs(snarkMs) : "—"}</div></div>
          <div className="mcell"><div className="ml">Ranges</div><div className="mv">{job.ranges}</div></div>
          <div className="mcell"><div className="ml">Blocks</div><div className="mv">{job.blocks}</div></div>
          <div className="mcell"><div className="ml">Type</div><div className="mv" style={{ fontSize: 13 }}>PLONK aggregation</div></div>
        </div>
      ) : (
        <div className="mgrid det-grid">
          <div className="mcell"><div className="ml">Total proof time</div><div className="mv">{fmtDur(job.elapsedMs)}</div></div>
          <div className="mcell"><div className="ml">Witness gen</div><div className="mv">{fmtDur(witnessMs)}</div></div>
          <div className="mcell"><div className="ml">Range prove</div><div className="mv">{fmtDur(proveMs)}</div></div>
          <div className="mcell"><div className="ml">Proof size</div><div className="mv">{pend(job.proofBytes, fmtBytes)}</div></div>
          <div className="mcell"><div className="ml">Gas proven</div><div className="mv">{pend(job.gas, fmtCompact)}</div></div>
          <div className="mcell"><div className="ml">Proof instances</div><div className="mv">{pend(job.instances, fmtNum)}</div></div>
          <div className="mcell"><div className="ml">Transactions</div><div className="mv">{pend(job.txs, fmtNum)}</div></div>
          <div className="mcell"><div className="ml">Blocks</div><div className="mv">{job.blocks}</div></div>
        </div>
      )}

      <div className="panel-b" style={{ marginTop: 22 }}>
        <div className="sec"><span className="sec-t">Pipeline timeline</span><span className="rule"></span><span className="sec-c">{job.stageIndex} / {job.stages.length} stages</span></div>
        <Timeline job={job} />
      </div>

      <div className="panel-b" style={{ marginTop: 22 }}>
        <div className="mst">
          <div className="mst-h"><span></span><span>Stage</span><span>Detail</span><span className="r">Duration</span><span className="r">State</span></div>
          {job.stages.map((st) => {
            const cls = st.status === "done" ? "done" : st.status === "active" ? "active" : "pending";
            const denom = st.durationMs || st.expectedMs || 0;            // expected width when not yet timed
            const pct = cls === "done" ? 100 : denom ? Math.min(98, (st.elapsedMs / denom) * 100) : 0;
            const ss = stageStatus(job, st);
            const stateTxt = cls === "done" ? "Done" : cls === "active" ? "● live" : "Pending";
            return (
              <div key={st.key} className={"mstr " + cls}>
                <span className="si"></span>
                <span className="sn">{FULL[st.key]}</span>
                {cls === "pending"
                  ? <span style={{ fontSize: 11.5, color: "var(--t3)", fontFamily: "var(--mono)" }}>{ss.sub}</span>
                  : <div className="sbar"><i style={{ width: pct + "%" }}></i></div>}
                <span className="sd">{cls === "done" ? fmtSecs(st.durationMs) : cls === "active" ? (st.elapsedMs > 0 ? fmtSecs(st.elapsedMs) + (st.expectedMs ? ` / ~${fmtSecs(st.expectedMs)}` : "") : "…") : `~${fmtSecs(st.expectedMs)}`}</span>
                <span className="ss">{stateTxt}</span>
              </div>
            );
          })}
        </div>
      </div>

      <ProofExplainer job={job} />

      <div className="txrow" style={{ marginTop: 22 }}>
        <span className="txl">Settlement</span>
        <span className="txh">{job.txHash ? shortHash(job.txHash) : (job.status === "failed" ? "— failed before settlement" : "— pending")}</span>
        {job.txHash && <span className="txb">View on explorer ↗</span>}
      </div>
    </div>
  );
}

// ======================= APP =======================
function App() {
  const [snap, setSnap] = useState(() => window.proverFeed.snapshot());
  const [now, setNow] = useState(Date.now());
  const [route, setRoute] = useState(parseHash());

  // live blocks-proven counter in the browser tab title
  useEffect(() => {
    const n = snap.metrics ? snap.metrics.blocksProven : 0;
    document.title = n ? `${fmtNum(n)} blocks · OP-ZisK Prover` : "OP-ZisK Prover — Live";
  }, [snap.metrics && snap.metrics.blocksProven]);

  useEffect(() => {
    const unsub = window.proverFeed.subscribe(setSnap);
    // Live feed if window.OPZISK_FEED_URL is set (see index.html); else the mock.
    const FEED_URL = window.OPZISK_FEED_URL || "";
    let stop = false, timer = null;
    if (FEED_URL) {
      const poll = async () => {
        try {
          const data = await (await fetch(FEED_URL, { cache: "no-store" })).json();
          window.proverFeed.setConnected(data.connected !== false);
          window.proverFeed.ingest(data);
        } catch (e) {
          window.proverFeed.setConnected(false);
        }
        if (!stop) timer = setTimeout(poll, 1000);
      };
      poll();
    } else {
      window.proverFeed.startSimulation();
    }
    const clk = setInterval(() => setNow(Date.now()), 1000);
    const onHash = () => setRoute(parseHash());
    window.addEventListener("hashchange", onHash);
    return () => { stop = true; if (timer) clearTimeout(timer); unsub(); clearInterval(clk); window.removeEventListener("hashchange", onHash); };
  }, []);

  const findJob = (id) => {
    if (snap.active && snap.active.id === id) return snap.active;
    return snap.queue.find((j) => j.id === id) || snap.history.find((j) => j.id === id)
      || (snap.aggregations || []).find((j) => j.id === id) || null;
  };

  let content;
  if (route.name === "blocks") content = <BlocksPage snap={snap} now={now} />;
  else if (route.name === "block") content = <BlockDetail job={findJob(route.id)} snap={snap} now={now} />;
  else content = <Dashboard snap={snap} now={now} />;

  return (
    <div className="shell">
      <main className="main">{content}</main>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
