import { useEffect, useMemo, useState } from "react";

/*
 * Animated loop scene, in the spirit of an isometric wireframe building card:
 * near-black panel, diamond grid, wireframe cubes, one block lit in red for the
 * active stage, a big step number top-left, marker chips and a compass bottom-right.
 * Pure SVG + CSS transitions; no data is fetched or faked - this is the diagram of
 * the real loop described on /how-it-works.
 */

const T = 30; // half tile width; tile height = T
const ORIGIN = { x: 300, y: 250 };
const GRID = 6;

const iso = (gx, gy) => ({ x: ORIGIN.x + (gx - gy) * T, y: ORIGIN.y + (gx + gy) * (T / 2) });

const STAGES = [
  {
    n: 1,
    name: "Work happens",
    lines: ["The agent runs tasks and posts events with its own key.", "completed · corrected · failed · capability_missing"],
    note: "The agent's wallet was paid a salary before any of this.",
  },
  {
    n: 2,
    name: "Everything is remembered",
    lines: ["Important events are queued as memory texts.", "Walrus Memory stores them as blobs."],
    note: "Memory rows carry the blob id; the exact text stays one toggle away.",
  },
  {
    n: 3,
    name: "The evidence gate",
    lines: ["A review scores every category from real events.", "Only categories with enough evidence become gaps."],
    note: "Rejected categories stay visible with their gate reasons.",
  },
  {
    n: 4,
    name: "Budget and payment",
    lines: ["The gap becomes a priced upgrade request.", "Allowance, reserve and lessons decide; the manager approves; Sui moves."],
    note: "The payment digest is verified through Tatum.",
  },
  {
    n: 5,
    name: "Upgrade and proof",
    lines: ["The capability unlocks on-chain - the agent's shape changes.", "A verdict compares issue rates before and after, and is stored for the next decision."],
    note: "A different color for a different agent: upgraded, measured, worth it.",
  },
];

const LINE = "var(--iso-line)";
const RED = "var(--iso-red)";
const FILL = "var(--iso-fill)";
const FILL_TOP = "var(--iso-fill-top)";

function cubePoly({ gx, gy, w = 1, d = 1, z = 0, h = 40 }) {
  const c1 = iso(gx, gy);
  const c2 = iso(gx + w, gy);
  const c3 = iso(gx + w, gy + d);
  const c4 = iso(gx, gy + d);
  const pt = (p, y) => ({ x: p.x, y: p.y - y });
  const top = [pt(c1, z + h), pt(c2, z + h), pt(c3, z + h), pt(c4, z + h)];
  const left = [pt(c4, z + h), pt(c3, z + h), pt(c3, z), pt(c4, z)];
  const right = [pt(c2, z + h), pt(c3, z + h), pt(c3, z), pt(c2, z)];
  const asPoints = (poly) => poly.map((p) => `${p.x},${p.y}`).join(" ");
  return {
    topKey: `${gx},${gy},${w},${d},${z},${h}-top`,
    faces: [
      { pts: asPoints(left), cls: "iso-face iso-left" },
      { pts: asPoints(right), cls: "iso-face iso-right" },
      { pts: asPoints(top), cls: "iso-face iso-top" },
    ],
  };
}

function Cube({ gx, gy, w, d, z, h, active, muted }) {
  const { faces } = cubePoly({ gx, gy, w, d, z, h });
  return (
    <g className={`iso-cube ${active ? "active" : ""} ${muted ? "muted" : ""}`}>
      {faces.map((face, index) => (
        <polygon key={index} points={face.pts} className={face.cls} />
      ))}
    </g>
  );
}

function Marker({ gx, gy, n, active }) {
  const at = iso(gx, gy);
  return (
    <g className={`iso-marker ${active ? "active" : ""}`}>
      <rect x={at.x - 13} y={at.y - 13} width="26" height="26" rx="7" className="iso-chip" />
      <text x={at.x} y={at.y + 4.5} textAnchor="middle" className="iso-chip-text">
        {n}
      </text>
    </g>
  );
}

export default function LoopScene() {
  const reduced = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  const [stage, setStage] = useState(1);

  useEffect(() => {
    if (reduced) return undefined;
    const timer = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      setStage((s) => (s % STAGES.length) + 1);
    }, 3600);
    return () => clearInterval(timer);
  }, [reduced]);

  const gridLines = useMemo(() => {
    const lines = [];
    for (let k = -GRID; k <= GRID; k += 1) {
      lines.push([iso(k, -GRID), iso(k, GRID)]);
      lines.push([iso(-GRID, k), iso(GRID, k)]);
    }
    return lines;
  }, []);

  const current = STAGES[stage - 1];
  const agentActive = stage === 1 || stage === 5;
  const memoryCount = stage >= 2 ? Math.min(3, stage === 2 ? 2 : 3) : 0;
  const verdict = stage === 5;

  return (
    <div className="scene-card" role="img" aria-label={`Animated loop diagram, stage ${current.n} of 5: ${current.name}`}>
      <div className="scene-head">
        <div>
          <span className="dim-label">The loop</span>
          <div className="scene-big">{current.n}</div>
          <div className="scene-meta">
            5 stages
            <br />
            period compressed
          </div>
        </div>
        <div className="scene-caption">
          <strong>{current.name}</strong>
          {current.lines.map((line, index) => (
            <p key={index} className="muted small-text">{line}</p>
          ))}
          <p className="scene-note small-text">{current.note}</p>
        </div>
        <div className="scene-tools">
          <button type="button" className="icon-btn" onClick={() => setStage((s) => (s % STAGES.length) + 1)} aria-label="next stage">
            <svg viewBox="0 0 20 20" width="16" height="16"><path d="M5 5h10M12 3l3 2-3 2M15 15H5m3-2-3 2 3 2" stroke="currentColor" fill="none" strokeWidth="1.6" /></svg>
          </button>
        </div>
      </div>

      <svg viewBox="0 0 600 430" className="iso-svg">
        <g className="iso-grid">
          {gridLines.map((line, index) => (
            <line key={index} x1={line[0].x} y1={line[0].y} x2={line[1].x} y2={line[1].y} />
          ))}
        </g>

        {/* treasury block - right */}
        <Cube gx={3} gy={1} w={1} d={1} h={28} active={stage === 4} muted={stage !== 4} />
        {/* work slabs */}
        <Cube gx={-3} gy={3} w={1} d={1} z={0} h={10} active={stage === 1} muted={stage !== 1} />
        <Cube gx={-2} gy={4} w={1} d={1} z={0} h={16} active={stage === 1} muted={stage !== 1} />
        {/* agent core cube */}
        <Cube gx={-1} gy={0} w={2} d={2} h={64} active={agentActive} />
        {/* upgrade tower: grows rounded segments like a building on upgrade */}
        {stage >= 5 && (
          <g className="iso-tower">
            <Cube gx={-1} gy={0} w={2} d={2} z={64} h={34} active />
            <Cube gx={-1} gy={0} w={2} d={2} z={102} h={34} active />
            <Cube gx={-1} gy={0} w={2} d={2} z={140} h={30} active />
          </g>
        )}
        {/* memory stack - left: one cube per period of stored history */}
        {[0, 1, 2].map((index) => (
          <Cube key={index} gx={-3} gy={-2 + index * 0.0 - index} w={1} d={1} z={index * 20} h={18} active={stage > 1 && memoryCount > index} muted={!(stage > 1 && memoryCount > index)} />
        ))}
        {/* review gate slab */}
        <Cube gx={1} gy={3} w={2} d={1} z={0} h={22} active={stage === 3} muted={stage !== 3} />
        {/* salary slab travelling from treasury to agent during stage 4 */}
        <g className={`pay-slab ${stage === 4 ? "moving" : ""}`}>
          <Cube gx={2} gy={2} w={1} d={1} h={14} active />
        </g>

        <Marker gx={-2} gy={2} n={1} active={stage === 1} />
        <Marker gx={-3} gy={-3} n={2} active={stage === 2} />
        <Marker gx={1} gy={4} n={3} active={stage === 3} />
        <Marker gx={4} gy={2} n={4} active={stage === 4} />

        {stage === 3 && (
          <g className="iso-flag">
            <text x={iso(1, 4).x} y={iso(1, 4).y - 40} textAnchor="middle" className="iso-flag-text">gap → request</text>
          </g>
        )}
        {stage === 5 && (
          <g className="iso-flag red">
            <text x={iso(-1, 0).x} y={iso(-1, 0).y - 210} textAnchor="middle" className="iso-flag-text">premium_data · verdict stored</text>
          </g>
        )}

        <g className="iso-compass">
          <circle cx="560" cy="402" r="16" className="iso-chip" />
          <path d="M560 410 L560 394 M557 397 L560 394 L563 397" stroke="currentColor" fill="none" />
          <text x="560" y="424" textAnchor="middle" className="iso-compass-text">loop</text>
        </g>
      </svg>

      <div className="scene-foot">
        <button type="button" className="scene-filter" onClick={() => setStage(1)} title="back to stage 1">
          ⇢ replay the loop
        </button>
        <span className="muted small-text">
          {verdict ? "appearance changed - the upgraded agent is measured next period" : `stage ${current.n} of 5 · ${current.name.toLowerCase()}`}
        </span>
        <span className={RED} style={{ width: 10, height: 10, borderRadius: 3, display: "inline-block", background: `var(--iso-red)` }} />
      </div>
    </div>
  );
}
