// ==============================================================
// OP-ZiSK Prover — chart components → window.
// Sparkline, Timeline (stage gantt + playhead + axis), Histogram.
// ==============================================================
const { pad: _pad, fmtSecs: _fmtSecs, fmtClock: _fmtClock, SHORT: _SHORT } = window.PU;

// ---------------------- sparkline ----------------------
function Sparkline({ data, w = 150, h = 30 }) {
  if (!data || data.length < 2) return <svg className="spark-svg" viewBox={`0 0 ${w} ${h}`}></svg>;
  const min = Math.min(...data), max = Math.max(...data);
  const rng = max - min || 1;
  const n = data.length;
  const x = (i) => (i / (n - 1)) * w;
  const y = (v) => h - 3 - ((v - min) / rng) * (h - 6);
  const line = data.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const area = `0,${h} ${line} ${w},${h}`;
  return (
    <svg className="spark-svg" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
      <polygon points={area} fill="rgba(95,114,87,0.14)" />
      <polyline points={line} fill="none" stroke="var(--accent)" strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={x(n - 1)} cy={y(data[n - 1])} r="2.4" fill="var(--accent)" />
    </svg>
  );
}

// ---------------------- stage timeline ----------------------
function Timeline({ job, showAxis = true }) {
  const total = job.stages.reduce((s, x) => s + x.durationMs, 0);
  // EXACT time-proportional columns so cells, playhead, and axis share one scale.
  const cols = job.stages.map((s) => `${(s.durationMs / total) * 100}fr`).join(" ");
  const elapsedPct = Math.min(100, (job.elapsedMs / total) * 100);
  const isLive = job.status === "proving";

  const ticks = [];
  const stepS = total / 1000 > 360 ? 120 : 60;
  for (let s = 0; s <= total / 1000 + 1; s += stepS) {
    ticks.push({ pct: Math.min(100, (s / (total / 1000)) * 100), label: `${Math.floor(s / 60)}:${_pad(s % 60)}` });
  }
  const cellState = (st, i) =>
    st.status === "done" || i < job.stageIndex ? "done" : st.status === "active" || (i === job.stageIndex && isLive) ? "active" : "pending";

  return (
    <div className="tl">
      <div className="tl-labels" style={{ gridTemplateColumns: cols }}>
        {job.stages.map((st, i) => {
          const cls = cellState(st, i);
          const wide = (st.durationMs / total) > 0.055;
          return (
            <div key={st.key} className={"tl-lab " + cls}>
              <span className="ix">{_pad(i + 1)}</span>
              {wide && <span className="nm">{_SHORT[st.key]}</span>}
            </div>
          );
        })}
      </div>
      <div className="tl-body">
        <div className="tl-track" style={{ gridTemplateColumns: cols }}>
          {job.stages.map((st, i) => {
            const cls = cellState(st, i);
            const pct = st.durationMs ? Math.min(100, (st.elapsedMs / st.durationMs) * 100) : 0;
            const wide = (st.durationMs / total) > 0.07;
            return (
              <div key={st.key} className={"cell " + cls}>
                <span className="fill" style={{ width: pct + "%" }}></span>
                {cls === "done" && wide && <span className="cell-dur">{_fmtSecs(st.durationMs)}</span>}
                {cls === "pending" && wide && <span className="cell-dur">~{_fmtSecs(st.durationMs)}</span>}
              </div>
            );
          })}
        </div>
        {isLive && <div className="playhead" style={{ left: elapsedPct + "%" }}></div>}
        {showAxis && (
          <div className="tl-axis">
            <div className="base"></div>
            {ticks.map((tk, i) => (
              <div key={i} className="tick" style={{ left: tk.pct + "%" }}>
                <i></i><span>{tk.label}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------- proof-time distribution histogram ----------------------
function Histogram({ dist, height = 150 }) {
  if (!dist || !dist.hist.length) return <div className="empty">No data</div>;
  const max = Math.max(1, ...dist.hist.map((b) => b.count));
  const targetIdx = dist.hist.findIndex((b) => b.lo + 15 > dist.target);
  const targetPct = ((targetIdx >= 0 ? targetIdx : dist.hist.length) / dist.hist.length) * 100;
  return (
    <div className="hist">
      <div className="hist-plot" style={{ height: height + "px" }}>
        <div className="hist-thresh" style={{ left: targetPct + "%" }}>
          <span className="ht-label">target {_fmtClock(dist.target * 1000)}</span>
        </div>
        <div className="hist-bars">
          {dist.hist.map((b, i) => (
            <div key={i} className="hbar-col">
              <div className="hbar-track">
                <div className={"hbar " + b.band} style={{ height: (b.count / max) * 100 + "%" }}>
                  {b.count > 0 && <span className="hbar-n">{b.count}</span>}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
      <div className="hist-axis">
        {dist.hist.map((b, i) => (
          <span key={i} className="hx">{i % 2 === 0 ? `${Math.floor(b.lo / 60)}:${_pad(b.lo % 60)}` : ""}</span>
        ))}
      </div>
      <div className="hist-legend">
        <span className="hl"><i className="sw green"></i><b>{dist.green}</b><span className="hl-t">on target</span></span>
        <span className="hl"><i className="sw red"></i><b>{dist.yellow}</b><span className="hl-t">over target</span></span>
        <span className="hl grow"><span className="hl-t">eligible rate</span><b className="elig">{dist.greenPct}%</b></span>
      </div>
    </div>
  );
}

Object.assign(window, { Sparkline, Timeline, Histogram });
