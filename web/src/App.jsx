import { useEffect, useState } from "react";
import { initSupabase } from "./lib/api.js";
import Login from "./components/Login.jsx";
import Dashboard from "./components/Dashboard.jsx";

export default function App() {
  const [phase, setPhase] = useState("loading"); // loading | error | ready
  const [error, setError] = useState("");
  const [session, setSession] = useState(null);

  useEffect(() => {
    let unsubscribe = () => {};
    (async () => {
      try {
        const supabase = await initSupabase();
        const { data } = await supabase.auth.getSession();
        setSession(data?.session ?? null);
        const { data: sub } = supabase.auth.onAuthStateChange((_event, newSession) => {
          setSession(newSession);
        });
        unsubscribe = () => sub.subscription.unsubscribe();
        setPhase("ready");
      } catch (err) {
        setError(String(err.message || err));
        setPhase("error");
      }
    })();
    return () => unsubscribe();
  }, []);

  if (phase === "loading") {
    return <div className="center-screen mono muted">Connecting…</div>;
  }
  if (phase === "error") {
    return (
      <div className="center-screen">
        <div className="empty">
          Could not start the dashboard.
          <div className="hint">{error}</div>
        </div>
      </div>
    );
  }
  return session ? <Dashboard session={session} /> : <Login />;
}
