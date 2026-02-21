import { useState } from "react";
import { useNavigate } from "react-router-dom";
import "./login.css";

const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function Login() {
  const navigate = useNavigate();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!email || !password) {
      setError("Email and password are required");
      return;
    }

    if (!emailRegex.test(email)) {
      setError("Please enter a valid email address");
      return;
    }

    setLoading(true);
    setTimeout(() => {
      setLoading(false);
      navigate("/dashboard");
    }, 1200);
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
          <button className="primary-btn">Get Started</button>
        </nav>
      </header>

      {/* Main */}
      <main className="main">
        {/* Left Hero */}
        <section className="hero">
          <h1>Welcome to your AI Operations Hub</h1>
          <p>
            Securely access your HR and internal data workspace powered by
            enterprise-grade artificial intelligence.
          </p>

          <div className="features">
            <span>🔒 SSO Secure</span>
            <span>📊 Real-time insights</span>
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
              <input type="checkbox" />
              <span>Remember me for 30 days</span>
            </div>

            {error && <div className="error">{error}</div>}

            <button disabled={loading} className="primary-btn full">
              {loading ? "Signing in..." : "Sign In to Dashboard"}
            </button>
          </form>

          <div className="divider">OR CONTINUE WITH</div>

          <div className="oauth">
            <button>Google</button>
            <button>GitHub</button>
          </div>

          <p className="register">
            Don’t have an account? <span>Register your organization</span>
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
