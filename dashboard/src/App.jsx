import { Suspense, lazy } from "react";
import { HashRouter, Link, Route, Routes, Navigate } from "react-router-dom";
import { fetchSystem, usePoll } from "./api.js";
import { FullShell, EmptyBox } from "./components.jsx";
import Landing from "./pages/Landing.jsx";
import HowItWorks from "./pages/HowItWorks.jsx";

/* Landing ships with the first paint (hero + scene); the workspace routes are
   lazy so the recharts-heavy agent page never sits in the initial bundle. */
const Overview = lazy(() => import("./pages/Overview.jsx"));
const Requests = lazy(() => import("./pages/Requests.jsx"));
const AgentsList = lazy(() => import("./pages/Agents.jsx"));
const Agent = lazy(() => import("./pages/Agent.jsx"));
const Payroll = lazy(() => import("./pages/Payroll.jsx"));
const Memory = lazy(() => import("./pages/Memory.jsx"));
const Activity = lazy(() => import("./pages/Activity.jsx"));

function SceneFallback() {
  return (
    <div className="state-box">
      <div className="skel skel-block" />
      <div className="skel skel-bar" style={{ width: "60%" }} />
    </div>
  );
}

function NotFound() {
  return (
    <div className="page">
      <EmptyBox title="That page does not exist here.">
        The workspace routes are /app, /app/requests, /app/agents, /app/payroll, /app/memory and /app/activity.
      </EmptyBox>
    </div>
  );
}

/** Agent page needs its own shell (breadcrumb shows the agent). */
function AgentRoute({ system }) {
  return (
    <FullShell system={system} crumb="Agent">
      <Agent system={system} />
    </FullShell>
  );
}

export default function App() {
  const system = usePoll(fetchSystem);
  return (
    <HashRouter>
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/how-it-works" element={<HowItWorks />} />
        <Route path="/app" element={<Agentless system={system} crumb="Overview"><Overview system={system} /></Agentless>} />
        <Route path="/app/requests" element={<Agentless system={system} crumb="Inbox"><Requests system={system} /></Agentless>} />
        <Route path="/app/agents" element={<Agentless system={system} crumb="Agents"><AgentsList system={system} /></Agentless>} />
        <Route path="/agent/:id" element={<AgentRoute system={system} />} />
        <Route path="/app/payroll" element={<Agentless system={system} crumb="Payroll"><Payroll system={system} /></Agentless>} />
        <Route path="/app/memory" element={<Agentless system={system} crumb="Memory"><Memory system={system} /></Agentless>} />
        <Route path="/app/activity" element={<Agentless system={system} crumb="Activity"><Activity system={system} /></Agentless>} />
        {/* legacy paths keep working */}
        <Route path="/dashboard" element={<Navigate to="/app" replace />} />
        <Route path="/tatum" element={<Navigate to="/app/activity" replace />} />
        <Route path="*" element={<NotFound />} />
      </Routes>
    </HashRouter>
  );
}

function Agentless({ system, crumb, children }) {
  return (
    <Suspense fallback={<SceneFallback />}>
      <FullShell system={system} crumb={crumb}>
        {children}
      </FullShell>
    </Suspense>
  );
}
