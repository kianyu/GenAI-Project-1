import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import "./login.css";

export default function Register() {
  const navigate = useNavigate();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.SyntheticEvent) => {
    e.preventDefault();
    setError(null);

    if (!email || !password || !confirm) {
      setError("All fields are required");
      return;
    }

    if (password !== confirm) {
      setError("Passwords do not match");
      return;
    }

    setLoading(true);
    try {
      const res = await fetch("http://localhost:8000/api/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.detail || "Registration failed");
        return;
      }
      localStorage.setItem("access_token", data.access_token);
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
        <nav>
          <a>Platform</a>
          <a>Solutions</a>
          <a>Resources</a>
          <a>Pricing</a>
          <Link to="/" className="primary-btn">Sign In</Link>
        </nav>
      </header>

      {/* Main */}
      <main className="main">
        {/* Left Hero */}
        <section className="hero">
          <h1>Join the AI Operations Hub</h1>
          <p>
            Create your account and get access to your HR and internal data
            workspace powered by enterprise-grade artificial intelligence.
          </p>
          <div className="features">
            <span>🔒 SSO Secure</span>
            <span>📊 Real-time insights</span>
          </div>
        </section>

        {/* Right Register Card */}
        <section className="login-card">
          <h2>Create Account</h2>

          <form onSubmit={handleSubmit}>
            <label>Email Address</label>
            <input
              type="email"
              placeholder="name@company.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />

            <label>Password</label>
            <input
              type="password"
              placeholder="Create a password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />

            <label>Confirm Password</label>
            <input
              type="password"
              placeholder="Repeat your password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
            />

            {error && <div className="error">{error}</div>}

            <button disabled={loading} className="primary-btn full">
              {loading ? "Creating account..." : "Create Account"}
            </button>
          </form>

          <p className="register">
            Already have an account? <Link to="/">Sign in</Link>
          </p>
        </section>
      </main>

      {/* Footer */}
      <footer className="footer">
        Privacy Policy · Terms of Service · Compliance
      </footer>
    </div>
  );
}
