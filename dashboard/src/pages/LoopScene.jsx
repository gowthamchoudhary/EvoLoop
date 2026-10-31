import { useEffect, useMemo, useRef, useState } from "react";
import { fetchAgents, fetchSystem, fetchTransactions, fetchVerdicts, usePoll } from "../api.js";

/*
 * The How-it-works scroll scene: a sticky isometric wireframe city (30°/150°
 * grid, white 1px line-art buildings) on the right, step cards on the left.
 * The current building gets the red outline + glow, numbered tags ride a dashed
 * path, and small movers (agent cubes, result packets, coins) travel between
 * buildings. No libraries; SVG + CSS; SMIL animateMotion for the movers.
 * Numbers shown are LIVE when the caller passes `site`, otherwise generic.
 */

const T = 30; // iso half tile width
const ORIGIN = { x: 320, y: 292 };
const GRID = 7;

const iso = (gx, gy) => ({ x: ORIGIN.x + (gx - gy) * T, y: ORIGIN.y + (gx + gy) * (T / 2) });

function cubeFaces({ gx, gy, w = 1, d = 1, z = 0, h = 30 }) {
  const c1 = iso(gx, gy);
  const c2 = iso(gx + w, gy);
  const c3 = iso(gx + w, gy + d);
  const c4 = iso(gx, gy + d);
  const pt = (p, height) => ({ x: p.x, y: p.y - height });
  const top = [pt(c1, z + h), pt(c2, z + h), pt(c3, z + h), pt(c4, z + h)];
  const left = [pt(c4, z + h), pt(c3, z + h), pt(c3, z), pt(c4, z)];
  const right = [pt(c2, z + h), pt(c3, z + h), pt(c3, z), pt(c2, z)];
  const asPoints = (poly) => poly.map((p) => `${p.x},${p.y}`).join(" ");
  return [
    { pts: asPoints(left), cls: "iso-face" },
    { pts: asPoints(right), cls: "iso-face" },
    { pts: asPoints(top), cls: "iso-face iso-top" },
  ];
}

function Cube({ at, active, dim }) {
  const faces = cubeFaces(at);
  return (
    <g className={`iso-cube ${active ? "active" : ""} ${dim ? "dim" : ""}`}>
      {faces.map((face, index) => (
        <polygon key={index} points={face.pts} className={face.cls} />
      ))}
    </g>
  );
}

const BUILDINGS = [
  { key: "work", label: "Work", tag: 1, at: { gx: -4.6, gy: 2.6, w: 2, d: 1.6, h: 30 } },
  { key: "vault", label: "Memory vault", tag: 2, at: { gx: -4.6, gy: -2.4, w: 1.6, d: 1.6, h: 30 } },
  { key: "review", label: "Review", tag: 3, at: { gx: 0.6, gy: 3.8, w: 2, d: 1.4, h: 24 } },
  { key: "manager", label: "Manager desk", tag: 4, at: { gx: 3.6, gy: 3.6, w: 1.4, d: 1.4, h: 17 } },
  { key: "treasury", label: "Treasury · Sui", tag: 5, at: { gx: 3.8, gy: -1.4, w: 1.8, d: 1.8, h: 34 } },
  { key: "lab", label: "Upgrade lab", tag: 6, at: { gx: 1.0, gy: -4.4, w: 1.6, d: 1.6, h: 22 } },
  { key: "agent", label: "Agent", tag: 7, at: { gx: -1.4, gy: -0.6, w: 1.6, d: 1.6, h: 44 } },
];

const TAGS = [
  { n: 1, gx: -3.0, gy: 3.6 },
  { n: 2, gx: -3.0, gy: -1.2 },
  { n: 3, gx: 2.2, gy: 3.4 },
  { n: 4, gx: 4.8, gy: 4.2 },
  { n: 5, gx: 5.2, gy: -3.4 },
  { n: 6, gx: 2.4, gy: -3.2 },
  { n: 7, gx: -0.2, gy: 1.4 },
];

/** step -> building whose outline goes red. */
const STEP_BUILDING = { 1: "work", 2: "vault", 3: "review", 4: "manager", 5: "treasury", 6: "agent", 7: "review" };

function TagBox({ n, gx, gy, active }) {
  const at = iso(gx, gy);
  return (
    <g className={`iso-tagrect ${active ? "on" : ""}`}>
      <rect x={at.x - 10} y={at.y - 10} width="20" height="20" rx="6" className="iso-tag" />
      <text x={at.x} y={at.y + 3.6} textAnchor="middle" className="iso-tag-text">
        {n}
      </text>
    </g>
  );
}

function Mover({ path, dur, kind, delay = 0 }) {
  return (
    <g className={kind}>
      {kind === "coin" ? (
        <circle r="4" className="iso-mover-coin">
          <animateMotion dur={`${dur}s`} repeatCount="indefinite" begin={`${delay}s`}>
            <mpath href={`#${path}`} />
          </animateMotion>
        </circle>
      ) : (
        <rect x="-3" y="-3" width="6" height="6" rx="1.5" className={kind === "packet" ? "iso-mover-packet" : "iso-mover-agent"}>
          <animateMotion dur={`${dur}s`} repeatCount="indefinite" begin={`${delay}s`}>
            <mpath href={`#${path}`} />
          </animateMotion>
        </rect>
      )}
    </g>
  );
}

/** Counter for "memories stored" — ticks from 0 to the REAL value once mounted. */
function LiveCounter({ end }) {
  const [value, setValue] = useState(0);
  useEffect(() => {
    if (!Number.isFinite(end)) return undefined;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      setValue(end);
      return undefined;
    }
    let raf = null;
    const startedAt = performance.now();
    const tick = (now) => {
      const progress = Math.min(1, (now - startedAt) / 1600);
      setValue(Math.round(end * (1 - Math.pow(1 - progress, 2))));
      if (progress < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [end]);
  return <span className="scene-live-num">{Number.isFinite(end) ? value : 0}</span>;
}

/* ------------------------------------------------------------------ */
/* scene data (live where available)                                   */
/* ------------------------------------------------------------------ */

export function useSceneData() {
  const agents = usePoll(fetchAgents);
  const firstId = (agents.data ?? [])[0]?.id ?? null;
  const system = usePoll(fetchSystem);
  const extra = usePoll(
    async () => {
      const [verdicts, transactions] = await Promise.all([fetchVerdicts(firstId), fetchTransactions(firstId)]);
      return { ok: true, data: { verdicts: verdicts.ok ? verdicts.data : null, transactions: transactions.ok ? transactions.data : null } };
    },
    { enabled: Boolean(firstId) },
    [firstId]
  );
  const memoriesStored = system.data?.walrus?.total?.memories_stored ?? null;
  const verdict = (extra.data?.verdicts ?? [])[0] ?? null;
  const spend = (extra.data?.transactions ?? []).find((row) => row.status === "executed" && row.digest && row.kind === "spend") ?? (extra.data?.transactions ?? []).find((row) => row.status === "executed" && row.digest) ?? null;
  return {
    ready: agents.ready,
    memoriesStored,
    verdict,
    digest: spend?.digest ?? null,
    network: system.data?.network ?? null,
  };
}

/* ------------------------------------------------------------------ */
/* the scene component                                                 */
/* ------------------------------------------------------------------ */

export default function LoopScene({ site = null }) {
  const reduced = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  const [active, setActive] = useState(1);
  const [hidden, setHidden] = useState(false);
  const stepRefs = useRef([]);

  const siteData = site && typeof site === "object" && "memoriesStored" in site ? site : site?.data ?? null;
  const memoriesStored = siteData?.memoriesStored ?? null;
  const digest = siteData?.digest ?? null;
  const verdict = siteData?.verdict ?? null;
  const beforePct = verdict ? Math.round(Number(verdict.baseline_rate ?? 0) * 1000) / 10 : null;
  const afterPct = verdict ? Math.round(Number(verdict.after_rate ?? 0) * 1000) / 10 : null;

  useEffect(() => {
    const onVisibility = () => setHidden(document.visibilityState !== "visible");
    document.addEventListener("visibilitychange", onVisibility);
    onVisibility();
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  useEffect(() => {
    const nodes = stepRefs.current.filter(Boolean);
    if (!nodes.length) return undefined;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            const index = Number(entry.target.dataset.stepN ?? "1");
            setActive(index);
          }
        }
      },
      { rootMargin: "-42% 0px -42% 0px", threshold: 0 }
    );
    nodes.forEach((node) => observer.observe(node));
    return () => observer.disconnect();
  }, []);

  const grid = useMemo(() => {
    const lines = [];
    for (let k = -GRID; k <= GRID; k += 1) {
      lines.push([iso(k, -GRID), iso(k, GRID), 0, 420]);
      lines.push([iso(-GRID, k), iso(GRID, k), 0, 420]);
    }
    return lines.filter((line) => {
      const [a, b] = line;
      return !(a.x < -40 && b.x < -40) && !(a.x > 700 && b.x > 700);
    });
  }, []);

  const activeBuilding = STEP_BUILDING[String(active)];
  const moveOn = !reduced && !hidden; // movers mount only when allowed
  const digits = (n) => <span className={n === active ? "accent-digit" : ""}>{n}</span>;
  const POINTS = useMemo(() => {
    const map = {};
    for (const tag of TAGS) map[String(tag.n)] = iso(tag.gx, tag.gy);
    return map;
  }, []);

  const pathOf = (...ns) => `M${POINTS[ns[0]].x} ${POINTS[ns[0]].y} ${ns.slice(1).map((n) => `L${POINTS[n].x} ${POINTS[n].y}`).join(" ")}`;

  return (
    <div className="how-scene" role="region" aria-label="Isometric diagram of the EvoLoop loop, scroll-driven">
      <div className="how-steps">
        <div className="step-card" data-step-n="1" ref={(n) => (stepRefs.current[0] = n)}>
          <span className="step-label">Stage 01 / 07 · work</span>
          <h3>
            {digits(1)} · Work happens first
          </h3>
          <p>The agent gets a wallet with a salary and does the work, posting events with its own key. Completed, corrected, failed — everything is recorded, nothing is self-reported glory.</p>
        </div>
        <div className="step-card" data-step-n="2" ref={(n) => (stepRefs.current[1] = n)}>
          <span className="step-label">Stage 02 / 07 · remember</span>
          <h3>{digits(2)} · Everything lands in the vault</h3>
          <p>Important events are written into Walrus Memory as blobs. Next decisions read this before they spend anything.</p>
          {memoriesStored !== null && (
            <p className="small-text">
              <LiveCounter end={memoriesStored} /> memories stored <span className="muted">· live{siteData?.network ? ` · ${siteData.network}` : ""}</span>
            </p>
          )}
        </div>
        <div className="step-card" data-step-n="3" ref={(n) => (stepRefs.current[2] = n)}>
          <span className="step-label">Stage 03 / 07 · review</span>
          <h3>{digits(3)} · The evidence gate</h3>
          <p>A review scores every task category from real events. Categories that fail the evidence gate are rejected with plain-language reasons — in red on the building.</p>
        </div>
        <div className="step-card" data-step-n="4" ref={(n) => (stepRefs.current[3] = n)}>
          <span className="step-label">Stage 04 / 07 · ask</span>
          <h3>{digits(4)} · Ask before paying</h3>
          <p>A fundable gap becomes a priced request sized against the allowance and improvement reserve, then travels to the manager desk with its evidence attached.</p>
        </div>
        <div className="step-card" data-step-n="5" ref={(n) => (stepRefs.current[4] = n)}>
          <span className="step-label">Stage 05 / 07 · pay</span>
          <h3>{digits(5)} · Pay on Sui, confirm via Tatum</h3>
          <p>Approval moves real testnet SUI to the vendor. The payment is confirmed through the Tatum Sui gateway and the digest becomes part of the record.</p>
          {digest ? (
            <p className="small-text num muted">recent digest {`${digest.slice(0, 10)}…${digest.slice(-6)}`}</p>
          ) : null}
        </div>
        <div className="step-card" data-step-n="6" ref={(n) => (stepRefs.current[5] = n)}>
          <span className="step-label">Stage 06 / 07 · upgrade</span>
          <h3>{digits(6)} · The agent grows</h3>
          <p>The purchased capability unlocks and the agent's tower gains floors — outline switching from white wireframe to the accent. Its shape changed; now it has to prove it.</p>
          <p className="small-text muted">capability unlocked</p>
        </div>
        <div className="step-card" data-step-n="7" ref={(n) => (stepRefs.current[6] = n)}>
          <span className="step-label">Stage 07 / 07 · prove</span>
          <h3>{digits(7)} · Prove it worked, then remember</h3>
          <p>The same category is measured again. Issue rate before vs after decides the verdict, and the verdict is written back to Walrus so the next decision starts smarter.</p>
          {beforePct !== null && afterPct !== null ? (
            <div className="before-after">
              <div className="ba-row before">
                <span className="ba-key">before</span>
                <span className="ba-track"><span className="ba-fill" style={{ width: `${Math.min(100, beforePct)}%` }} /></span>
                <span className="ba-val">{beforePct}%</span>
              </div>
              <div className="ba-row after">
                <span className="ba-key">after</span>
                <span className="ba-track"><span className="ba-fill" style={{ width: `${Math.min(100, afterPct)}%` }} /></span>
                <span className="ba-val">{afterPct}%</span>
              </div>
            </div>
          ) : (
            <p className="small-text muted">No verdict measured yet — the meter shows when the first upgrade finishes proving itself.</p>
          )}
        </div>
      </div>

      <div className="how-visual" aria-hidden="true">
        <div className="scene-card">
          <div className="scene-head">
            <div>
              <span className="scene-banner">
                <span className="accent-digit">{active}</span>
              </span>
              <div className="scene-meta">STAGE 0{active} / 07 · {reduced ? "static" : moveOn ? "live" : "paused"}</div>
            </div>
            <div className="scene-caption">
              <strong>EvoLoop, the loop itself</strong>
              <p>Wireframe buildings = parts of the system. Red = what today's stage touches. Tags 1–7 sit on the path work takes through it.</p>
              {active === 2 && memoriesStored !== null && (
                <p className="small-text">Walrus Memory counter ticking to <span className="scene-live-num">{memoriesStored}</span> — live{siteData?.network ? ` (${siteData.network})` : ""}, mainnet storage.</p>
              )}
              {active === 5 && (
                <p className="small-text">Sui payment, confirmed via Tatum{digest ? ` · digest ${digest.slice(0, 10)}…${digest.slice(-6)}` : " · shown when the first real payment lands"}</p>
              )}
              {active === 6 && <p className="small-text muted">capability unlocked</p>}
              {active === 7 && <p className="small-text muted">next decision uses recalled lessons</p>}
            </div>
          </div>

          <svg viewBox="0 0 700 470" className="iso-svg">
            <defs>
              <path id="p-work" d={`M${iso(-8.5, 6).x} ${iso(-8.5, 6).y} L${POINTS["1"].x} ${POINTS["1"].y}`} />
              <path id="p-note" d={pathOf(1, 2)} />
              <path id="p-ask" d={pathOf(3, 3, 4)} />
              <path id="p-pay" d={pathOf(5, 5, 6)} />
              <path id="p-recall" d={`M${POINTS["2"].x} ${POINTS["2"].y} L${POINTS["7"].x} ${POINTS["7"].y}`} />
            </defs>
            <g className="iso-grid">
              {grid.map((line, index) => (
                <line key={index} x1={line[0].x} y1={line[0].y} x2={line[1].x} y2={line[1].y} />
              ))}
            </g>

            <path className="iso-path" d={pathOf(1, 2, 7, 3, 4, 5, 6)} />

            {BUILDINGS.map((b) => (
              <g key={b.key}>
                <text x={iso(b.at.gx + b.at.w / 2, b.at.gy + b.at.d / 2).x} y={iso(b.at.gx + b.at.w / 2, b.at.gy + b.at.d / 2).y + 34} textAnchor="middle" className="iso-fig-label">
                  {b.label}
                </text>
              </g>
            ))}

            {BUILDINGS.map((b) => (
              <Cube key={b.key} at={b.at} active={activeBuilding === b.key} dim={Boolean(activeBuilding) && activeBuilding !== b.key && b.key !== "agent"} />
            ))}

            {/* step 6: the agent tower grows floors (accent fill) */}
            {active >= 6 &&
              !reduced &&
              [0, 1, 2].map((floor) => (
                <g key={floor} className={`iso-tower-floor ${moveOn ? "on" : ""}`} style={{ animationDelay: `${floor * 0.35}s` }}>
                  <Cube at={{ gx: -1.4, gy: -0.6, w: 1.6, d: 1.6, z: 44 + floor * 12, h: 10 }} active />
                </g>
              ))}
            {reduced && active >= 6 && [0, 1, 2].map((floor) => <Cube key={`r${floor}`} at={{ gx: -1.4, gy: -0.6, w: 1.6, d: 1.6, z: 44 + floor * 12, h: 10 }} active />)}

            {/* step 2: memory vault gains stored slabs */}
            {siteData?.memoriesStored !== null && memoriesStored > 0 && [0, 1].map((slab) => (
              <Cube key={`slab${slab}`} at={{ gx: -4.6, gy: -2.4, w: 1.6, d: 1.6, z: 30 + slab * 9, h: 7 }} dim={active !== 2} active={active === 2} />
            ))}

            {/* numbered tags on the path */}
            {TAGS.map((tag) => (
              <TagBox key={tag.n} n={tag.n} gx={tag.gx} gy={tag.gy} active={active === tag.n} />
            ))}

            {moveOn && active === 1 && (
              <Mover path="p-work" dur={2.6} kind="agent" />
            )}
            {moveOn && active === 2 && (
              <>
                <Mover path="p-note" dur={1.8} kind="packet" delay={0} />
                <Mover path="p-note" dur={1.8} kind="packet" delay={0.9} />
              </>
            )}
            {moveOn && active === 4 && <Mover path="p-ask" dur={2.4} kind="packet" />}
            {moveOn && active === 5 && <Mover path="p-pay" dur={2.6} kind="coin" />}
            {moveOn && active === 7 && <Mover path="p-recall" dur={3.0} kind="packet" />}

            {/* compass */}
            <g>
              <circle cx="668" cy="440" r="11" className="iso-tag" />
              <path d="M668 445 L668 435 M665 438 L668 435 L671 438" stroke="var(--muted)" fill="none" />
              <text x="668" y="462" textAnchor="middle" className="iso-fig-label" style={{ fontSize: "7px", letterSpacing: "0.1em" }}>
                N
              </text>
            </g>
          </svg>

          <div className="scene-foot">
            <span className="scene-filter-label">
              <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M1 4h14M4 8h8M6 12h4" stroke="currentColor" fill="none" strokeWidth="1.4" /></svg>
              Scene 13.1
            </span>
            <span className="scene-foot-caption">
              Illustrative scene. Numbers are live where shown.
              <br />
              WORK · MEMORY VAULT · REVIEW · MANAGER DESK · TREASURY · UPGRADE LAB · AGENT
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
