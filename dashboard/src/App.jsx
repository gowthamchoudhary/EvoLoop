import { HashRouter, Link, Route, Routes } from "react-router-dom";
import { fetchSystem, usePoll } from "./api.js";
import { Footer, TopBar } from "./components.jsx";
import Overview from "./pages/Overview.jsx";
import Agent from "./pages/Agent.jsx";

function NotFound() {
  return (
    <div className="state-box">
      <p>That page does not exist here.</p>
      <Link to="/" className="btn ghost">Back to Overview</Link>
    </div>
  );
}

export default function App() {
  const system = usePoll(fetchSystem);
  return (
    <HashRouter>
      <div className="app">
        <TopBar system={system} />
        <main className="page">
          <Routes>
            <Route path="/" element={<Overview system={system} />} />
            <Route path="/agent/:id" element={<Agent system={system} />} />
            <Route path="*" element={<NotFound />} />
          </Routes>
        </main>
        <Footer />
      </div>
    </HashRouter>
  );
}
