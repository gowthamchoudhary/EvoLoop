import { HashRouter, Link, Route, Routes, NavLink, useLocation } from "react-router-dom";
import { fetchSystem, usePoll } from "./api.js";

const isProduction = import.meta.env?.BASE_URL?.startsWith("http");
import { Sidebar, Footer } from "./components.jsx";
import Overview from "./pages/Overview.jsx";
import Agent from "./pages/Agent.jsx";
import Tatum from "./pages/Tatum.jsx";
import HowItWorks from "./pages/HowItWorks.jsx";
import Landing from "./pages/Landing.jsx";

function NotFound() {
  return (
    <div className="state-box">
      <p>That page does not exist here.</p>
      <Link to="/dashboard" className="btn ghost">Back to Overview</Link>
    </div>
  );
}

/** App pages share the sidebar shell; the landing page is full-bleed on its own. */
function Shell({ system, children }) {
  return (
    <div className="shell">
      <Sidebar system={system} />
      <main className="content">
        {children}
        <Footer />
      </main>
    </div>
  );
}

export default function App() {
  const system = usePoll(fetchSystem);
  return (
    <HashRouter>
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/dashboard" element={<Shell system={system}><Overview system={system} /></Shell>} />
        <Route path="/agent/:id" element={<Shell system={system}><Agent system={system} /></Shell>} />
        <Route path="/tatum" element={<Shell system={system}><Tatum /></Shell>} />
        <Route path="/how-it-works" element={<Shell system={system}><HowItWorks /></Shell>} />
        <Route path="*" element={<Shell system={system}><NotFound /></Shell>} />
      </Routes>
    </HashRouter>
  );
}
export function useAppBase() {
  return baseUrl;
}

const baseUrl = typeof window !== "undefined" ? environment.base : "./";
