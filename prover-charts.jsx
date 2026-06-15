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
  // size each stage by its REAL duration if done, else its historical expected width.
  // this stops the in-progress "100% / tiny active sliver" bug.
  const sizeMs = (s) => (s.durationMs > 0 ? s.durationMs : (s.expectedMs || 0));
  const total = job.stages.reduce((a, x) => a + sizeMs(x), 0);
  const timed = total > 0;
  // ONE fr array drives BOTH the grid columns AND the playhead position — so the line
  // is always at the active bar's fill edge. true time-proportions (tiny 0.6 floor only
  // so a near-zero phase never collapses to invisible).
  const fr = job.stages.map((s) => timed ? Math.max(0.6, (sizeMs(s) / total) * 100) : 1);
  const totalFr = fr.reduce((a, b) => a + b, 0);
  const cols = fr.map((f) => f + "fr").join(" ");
  const isLive = job.status === "proving";
  let headFr = 0;
  for (let i = 0; i < job.stages.length; i++) {
    const st = job.stages[i];
    if (st.status === "done") { headFr += fr[i]; continue; }
    if (st.status === "active") {
      const denom = st.durationMs || st.expectedMs || 0;
      headFr += denom ? Math.min(1, st.elapsedMs / denom) * fr[i] : 0;
    }
    break;
  }
  const elapsedPct = totalFr ? Math.min(100, (headFr / totalFr) * 100) : 0;

  const ticks = [];
  if (timed) {
    const stepS = total / 1000 > 360 ? 120 : 60;
    for (let s = 0; s <= total / 1000 + 1; s += stepS) {
      ticks.push({ pct: Math.min(100, (s / (total / 1000)) * 100), label: `${Math.floor(s / 60)}:${_pad(s % 60)}` });
    }
  }
  const cellState = (st, i) =>
    st.status === "done" || i < job.stageIndex ? "done" : st.status === "active" || (i === job.stageIndex && isLive) ? "active" : "pending";

  return (
    <div className="tl">
      <div className="tl-labels" style={{ gridTemplateColumns: cols }}>
        {job.stages.map((st, i) => {
          const cls = cellState(st, i);
          const wide = !timed || (sizeMs(st) / total) > 0.08;  // hide cramped labels entirely (no overlap)
          return (
            <div key={st.key} className={"tl-lab " + cls}>
              {wide && <span className="ix">{_pad(i + 1)}</span>}
              {wide && <span className="nm">{_SHORT[st.key]}</span>}
            </div>
          );
        })}
      </div>
      <div className="tl-body">
        <div className="tl-track" style={{ gridTemplateColumns: cols }}>
          {job.stages.map((st, i) => {
            const cls = cellState(st, i);
            const denom = st.durationMs || st.expectedMs || 0;
            const pct = cls === "done" ? 100 : denom ? Math.min(98, (st.elapsedMs / denom) * 100) : (cls === "active" ? 40 : 0);
            const wide = !timed || (sizeMs(st) / total) > 0.07;
            return (
              <div key={st.key} className={"cell " + cls}>
                <span className="fill" style={{ width: pct + "%" }}></span>
                {cls === "done" && wide && st.durationMs > 0 && <span className="cell-dur">{_fmtSecs(st.durationMs)}</span>}
                {cls === "active" && wide && st.elapsedMs > 0 && <span className="cell-dur">{_fmtSecs(st.elapsedMs)}</span>}
                {cls === "pending" && wide && st.expectedMs > 0 && <span className="cell-dur">~{_fmtSecs(st.expectedMs)}</span>}
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

// ---------------------- proof-time distribution (density curve) ----------------------
// Catmull-Rom → sampled polyline, clamped to baseline so the area never dips < 0.
function smoothPoints(pts, baseY, perSeg = 18) {
  if (pts.length < 2) return pts.slice();
  const out = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || pts[i + 1];
    for (let s = 0; s < perSeg; s++) {
      const t = s / perSeg, t2 = t * t, t3 = t2 * t;
      const x = 0.5 * ((2 * p1.x) + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3);
      let y = 0.5 * ((2 * p1.y) + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3);
      out.push({ x, y: Math.min(baseY, y) }); // clamp overshoot below baseline
    }
  }
  out.push(pts[pts.length - 1]);
  return out;
}

function Histogram({ dist }) {
  if (!dist || !dist.hist.length) return <div className="empty">No data yet</div>;

  const W = 640, H = 200;
  const padL = 26, padR = 16, padT = 18, padB = 28;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const baseY = padT + plotH;

  const LO = dist.hist[0].lo, HI = dist.hist[dist.hist.length - 1].hi;
  const max = Math.max(1, ...dist.hist.map((b) => b.count));
  const xFor = (sec) => padL + ((sec - LO) / (HI - LO)) * plotW;
  const yFor = (count) => baseY - (count / max) * plotH;
  const fmtT = (sec) => `${Math.floor(sec / 60)}:${_pad(Math.round(sec) % 60)}`;
  const bw = (plotW / dist.hist.length) * 0.7;

  const yTicks = [0, Math.ceil(max / 2), max].filter((v, i, a) => a.indexOf(v) === i);
  const marks = [
    { x: dist.p50, label: "median", color: "var(--accent)" },
    { x: dist.p95, label: "p95", color: "var(--coral)" },
  ];

  return (
    <div className="hist">
      <svg className="hist-svg" viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "auto", display: "block" }}>
        {/* y gridlines */}
        {yTicks.map((v, i) => {
          const y = yFor(v);
          return (
            <g key={i}>
              <line x1={padL} y1={y} x2={W - padR} y2={y} stroke="var(--line)" strokeWidth="1" strokeDasharray={v === 0 ? "0" : "3 4"} />
              <text x={padL - 6} y={y + 3.5} textAnchor="end" fill="var(--t3)" style={{ font: "500 10px var(--mono)" }}>{v}</text>
            </g>
          );
        })}

        {/* single-tone bars + counts */}
        {dist.hist.map((b, i) => {
          const cx = xFor(b.lo + (b.hi - b.lo) / 2);
          return (
            <g key={i}>
              <rect x={cx - bw / 2} y={yFor(b.count)} width={bw} height={baseY - yFor(b.count)} rx="3" fill="var(--accent)" opacity={b.count ? 0.82 : 0} />
              {b.count > 0 && <text x={cx} y={yFor(b.count) - 6} textAnchor="middle" fill="var(--t2)" style={{ font: "600 10px var(--mono)" }}>{b.count}</text>}
            </g>
          );
        })}

        {/* median + p95 markers */}
        {marks.map((mk, i) => {
          const x = Math.max(padL, Math.min(W - padR, xFor(mk.x)));
          return (
            <g key={i}>
              <line x1={x} y1={padT - 2} x2={x} y2={baseY} stroke={mk.color} strokeWidth="1.4" strokeDasharray="4 3" />
              <g transform={`translate(${Math.min(x + 4, W - padR - 70)}, ${padT - 2})`}>
                <rect x="0" y="-2" width="68" height="15" rx="3.5" fill={mk.color} opacity="0.14" />
                <text x="5" y="9" fill={mk.color} style={{ font: "600 9.5px var(--mono)" }}>{mk.label} {fmtT(mk.x)}</text>
              </g>
            </g>
          );
        })}

        {/* x axis labels */}
        {dist.hist.map((b, i) => i % 2 === 0 && (
          <text key={i} x={xFor(b.lo)} y={H - 8} textAnchor="middle" fill="var(--t3)" style={{ font: "500 10px var(--mono)" }}>{fmtT(b.lo)}</text>
        ))}
        <text x={W - padR} y={H - 8} textAnchor="end" fill="var(--t3)" style={{ font: "500 10px var(--mono)" }}>{fmtT(HI)}</text>
      </svg>

      <div className="hist-legend">
        <span className="hl"><span className="hl-t">fastest</span><b>{fmtT(dist.fastest)}</b></span>
        <span className="hl"><span className="hl-t">median</span><b>{fmtT(dist.p50)}</b></span>
        <span className="hl"><span className="hl-t">p95</span><b>{fmtT(dist.p95)}</b></span>
        <span className="hl grow"><span className="hl-t">slowest</span><b>{fmtT(dist.slowest)}</b></span>
      </div>
    </div>
  );
}

Object.assign(window, { Sparkline, Timeline, Histogram });
