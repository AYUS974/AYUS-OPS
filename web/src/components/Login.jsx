import { useState } from "react";
import { getSupabase } from "../lib/api.js";

export default function Login() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const { error: authError } = await getSupabase().auth.signInWithPassword({ email, password });
    if (authError) {
      setError(authError.message);
      setBusy(false);
    }
    // On success the onAuthStateChange listener in App swaps to the dashboard.
  }

  return (
    <div className="center-screen">
      <div className="login-backdrop-glow" aria-hidden="true" />
      <form className="login-card" onSubmit={handleSubmit}>
        <div className="wordmark">
          <h1>AYUS&nbsp;OPS</h1>
          <span>portal</span>
        </div>

        <h2 className="login-title">Security Verification Required</h2>

        <div className="login-field">
          <label className="login-label" htmlFor="email">Access Email</label>
          <input
            id="email"
            type="email"
            autoComplete="username"
            required
            placeholder="founder@ayuslabs.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>

        <div className="login-field">
          <label className="login-label" htmlFor="password">Passkey</label>
          <input
            id="password"
            type="password"
            autoComplete="current-password"
            required
            placeholder="••••••••••••"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>

        {error && <div className="login-error">✕ {error}</div>}

        <button className="login-btn" disabled={busy}>
          {busy ? "Authorizing access…" : "Authorize Command"}
        </button>

        <div className="login-hint">
          AYUS Ops mission control verification node.
        </div>
      </form>
    </div>
  );
}
