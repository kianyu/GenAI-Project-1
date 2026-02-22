import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import "./login.css";

export default function Login() {
  const navigate = useNavigate();

  const rememberedEmail    = localStorage.getItem("remembered_email") || "";
  const rememberedPassword = localStorage.getItem("remembered_password") || "";
  const [email, setEmail]       = useState(rememberedEmail);
  const [password, setPassword] = useState(rememberedPassword);
  const [rememberMe, setRememberMe] = useState(!!rememberedPassword);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.SyntheticEvent) => {
    e.preventDefault();
    setError(null);

    if (!email || !password) {
      setError("Email and password are required");
      return;
    }

    setLoading(true);
    try {
      const res = await fetch("http://localhost:8000/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password, remember_me: rememberMe }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.detail || "Login failed");
        return;
      }
      // Always remember the email; remember password only when checked
      localStorage.setItem("remembered_email", email);
      if (rememberMe) {
        localStorage.setItem("access_token", data.access_token);
        localStorage.setItem("remembered_password", password);
        sessionStorage.removeItem("access_token");
      } else {
        sessionStorage.setItem("access_token", data.access_token);
        localStorage.removeItem("access_token");
        localStorage.removeItem("remembered_password");
      }
      navigate("/dashboard");
    } catch {
      setError("Unable to reach server. Is the backend running?");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-page">
      {/* Navbar */}
      <header className="navbar">
        <div className="logo">Enterprise AI Suite</div>
      </header>

      {/* Main */}
      <main className="main">
        {/* Left Hero */}
        <section className="hero">
          <div className="hero-eyebrow">Enterprise AI Platform</div>
          <h1>Your Internal AI Workspace</h1>
          <p>
            A unified platform that brings AI capabilities to your organisation.
          </p>

          <div className="use-cases">
            <div className="use-case-card">
              <div className="use-case-icon">📊</div>
              <div>
                <div className="use-case-title">Data Query & Dashboard</div>
                <div className="use-case-desc">
                  Ask your internal database questions in plain English. Get instant
                  answers visualised as charts and dashboards — no SQL required.
                </div>
              </div>
            </div>
            <div className="use-case-card">
              <div className="use-case-icon">📚</div>
              <div>
                <div className="use-case-title">Internal Document Q&A</div>
                <div className="use-case-desc">
                  Upload policies, reports, or manuals and ask questions. The AI
                  answers based strictly on your own documents.
                </div>
              </div>
            </div>
            <div className="use-case-card">
              <div className="use-case-icon">💼</div>
              <div>
                <div className="use-case-title">Resume Screening</div>
                <div className="use-case-desc">
                  HR teams bulk-upload resumes and let AI rank, filter, and summarise
                  candidates against job requirements in seconds.
                </div>
              </div>
            </div>
            <div className="use-case-card use-case-card--muted">
              <div className="use-case-icon">✦</div>
              <div>
                <div className="use-case-title">More coming soon</div>
                <div className="use-case-desc">
                  Additional AI modules are on the roadmap and will be rolled out
                  progressively.
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Right Login Card */}
        <section className="login-card">
          <h2>Sign In</h2>

          <form onSubmit={handleSubmit}>
            <label>Email Address</label>
            <input
              type="email"
              placeholder="name@company.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />

            <label className="password-label">
              <span>Password</span>
              <span className="forgot">Forgot password?</span>
            </label>
            <input
              type="password"
              placeholder="Enter your password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />

            <div className="checkbox">
              <input
                type="checkbox"
                id="remember-me"
                checked={rememberMe}
                onChange={e => setRememberMe(e.target.checked)}
              />
              <label htmlFor="remember-me">Remember me for 30 days</label>
            </div>

            {error && <div className="error">{error}</div>}

            <button disabled={loading} className="primary-btn full">
              {loading ? "Signing in..." : "Sign In to Dashboard"}
            </button>
          </form>

          <p className="register">
            Don’t have an account? <Link to="/register">Register your organization</Link>
          </p>
        </section>
      </main>

      {/* Footer */}
      <footer className="footer">
        Privacy Policy · Terms of Service · Compliance
      </footer>

      {/* Contributor badge */}
      <div className="contributor-badge">Built by Charles &amp; Kian Yu</div>
    </div>
  );
}
