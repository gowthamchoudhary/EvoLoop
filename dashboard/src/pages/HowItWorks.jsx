import { Link } from "react-router-dom";
import LoopScene, { useSceneData } from "./LoopScene.jsx";

const HONEST = [
  "The grader is automated feedback standing in for a user: it checks answers against real Tatum rates and balances and posts task_completed / user_corrected events.",
  "The live-data questions are designed so a model without live data fails — they ask for current prices and balances no offline model can know.",
  "Price data is served through Tatum's Data API, which sources it from CoinGecko.",
  "Demo periods are compressed: a \"period\" can be minutes instead of a month, so upgrades and verdicts finish in one run.",
  "This demo runs on Sui testnet. Walrus Memory writes go to mainnet storage; for test runs a dev namespace prefix is used.",
];

export default function HowItWorks() {
  const scene = useSceneData();
  return (
    <div className="how-page" style={{ padding: "0 20px" }}>
      <header style={{ maxWidth: 560, padding: "56px 0 8px" }}>
        <Link to="/app" className="sb-link" style={{ display: "inline-flex", paddingLeft: 0 }}>← Open the demo workspace</Link>
        <h1 style={{ fontSize: "2.2rem", letterSpacing: "-0.03em", margin: "18px 0 8px" }}>How EvoLoop works</h1>
        <p className="muted small-text">
          Scroll: the city on the right is the loop itself. The building with the red outline is the part of the system doing its job at this stage — WORK, MEMORY VAULT,
          REVIEW, MANAGER DESK, TREASURY, UPGRADE LAB — with the agent tower in the middle.{typeof scene.memoriesStored === "number" ? ` Live right now: ${scene.memoriesStored} memories stored on Walrus.` : ""}
        </p>
      </header>

      <LoopScene site={scene} />

      <section className="card honest-notes" style={{ margin: "24px 0 60px" }} id="honest">
        <h3 style={{ fontSize: "1rem" }}>Honest notes</h3>
        <ul>
          {HONEST.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </section>
    </div>
  );
}
