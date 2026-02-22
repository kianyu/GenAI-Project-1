import { useState, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import "./dashboard.css";

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: Date;
}

interface Session {
  id: number;
  title: string;
  updated_at: string;
}

interface BugReport {
  id: number;
  user_email: string;
  description: string;
  image_filename: string | null;
  status: string;
  created_at: string;
}

const MODULES = [
  {
    id: "data-query",
    icon: "📊",
    label: "Data Query & Dashboard",
    desc: "Query your database with natural language and visualise results",
  },
  {
    id: "doc-qa",
    icon: "📚",
    label: "Internal Document Q&A",
    desc: "Upload documents and ask questions — AI answers from your content",
  },
  {
    id: "resume",
    icon: "💼",
    label: "Resume Screening",
    desc: "Screen candidates and rank resumes against job requirements",
  },
];

// Labels shown to users — no model names, just plain descriptions
const MODELS = [
  { value: "claude-haiku-4-5-20251001", label: "⚡ Fast", desc: "Quick everyday questions" },
  { value: "claude-sonnet-4-6",          label: "✦ Smart", desc: "Best for most tasks"       },
  { value: "claude-opus-4-6",            label: "🎯 Expert", desc: "Deep analysis & reasoning" },
];

const API = "http://localhost:8000";

export default function Dashboard() {
  const navigate = useNavigate();

  // Chat
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [activeModule, setActiveModule] = useState<string | null>(null);

  // Sessions
  const [sessions, setSessions] = useState<Session[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<number | null>(null);

  // User + settings
  const [currentUser, setCurrentUser] = useState("");
  const [isAdmin, setIsAdmin] = useState(false);
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [selectedModel, setSelectedModel] = useState(
    localStorage.getItem("selectedModel") || "claude-haiku-4-5-20251001"
  );

  // Modals
  const [showSettings, setShowSettings] = useState(false);
  const [showBugModal, setShowBugModal] = useState(false);
  const [bugView, setBugView] = useState<"submit" | "list">("submit");

  // Bug form
  const [bugDescription, setBugDescription] = useState("");
  const [bugImage, setBugImage] = useState<File | null>(null);
  const [bugs, setBugs] = useState<BugReport[]>([]);
  const [bugSubmitting, setBugSubmitting] = useState(false);
  const [bugSuccess, setBugSuccess] = useState(false);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const token = localStorage.getItem("access_token");
  const hasStartedChat = messages.length > 0;

  // ── Init ──────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!token) { navigate("/"); return; }
    try {
      const payload = JSON.parse(atob(token.split(".")[1]));
      setCurrentUser(payload.sub || "");
    } catch { navigate("/"); return; }

    fetchSessions();
    fetchMe();
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const authHeaders = (): Record<string, string> => ({
    Authorization: `Bearer ${token}`,
  });

  // ── User / admin ──────────────────────────────────────────────────────────
  const fetchMe = async () => {
    try {
      const res = await fetch(`${API}/api/me`, { headers: authHeaders() });
      const data = await res.json();
      setIsAdmin(data.is_admin || false);
    } catch { /* silent */ }
  };

  // ── Sessions ──────────────────────────────────────────────────────────────
  const fetchSessions = async () => {
    try {
      const res = await fetch(`${API}/api/sessions`, { headers: authHeaders() });
      const data = await res.json();
      setSessions(Array.isArray(data) ? data : []);
    } catch { /* silent */ }
  };

  const loadSession = async (sessionId: number) => {
    try {
      const res = await fetch(`${API}/api/sessions/${sessionId}/messages`, {
        headers: authHeaders(),
      });
      const data = await res.json();
      setMessages(
        data.map((m: { id: number; role: string; content: string; created_at: string }) => ({
          id: `db-${m.id}`,
          role: m.role as "user" | "assistant",
          content: m.content,
          timestamp: new Date(m.created_at),
        }))
      );
      setCurrentSessionId(sessionId);
      setActiveModule(null);
    } catch { /* silent */ }
  };

  const startNewChat = () => {
    setMessages([]);
    setCurrentSessionId(null);
    setActiveModule(null);
  };

  // ── Streaming chat ────────────────────────────────────────────────────────
  const sendMessage = async (content?: string, moduleOverride?: string | null) => {
    const text = (content ?? input).trim();
    if (!text || isLoading) return;

    const effectiveModule = moduleOverride !== undefined ? moduleOverride : activeModule;
    const assistantMsgId = `a-${Date.now()}`;

    setMessages(prev => [
      ...prev,
      { id: `u-${Date.now() - 1}`, role: "user", content: text, timestamp: new Date() },
      { id: assistantMsgId, role: "assistant", content: "", timestamp: new Date() },
    ]);
    setInput("");
    if (textareaRef.current) textareaRef.current.style.height = "auto";
    setIsLoading(true);

    try {
      const res = await fetch(`${API}/api/chat/stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({
          message: text,
          history: messages.slice(-10).map(m => ({ role: m.role, content: m.content })),
          module: effectiveModule,
          session_id: currentSessionId,
          model: selectedModel,
        }),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.detail || "Chat error");
      }

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const raw = line.slice(6).trim();
          if (raw === "[DONE]") continue;
          try {
            const event = JSON.parse(raw);
            if (event.type === "session") {
              setCurrentSessionId(event.session_id);
              setSessions(prev => {
                if (prev.some(s => s.id === event.session_id)) return prev;
                return [{ id: event.session_id, title: event.title, updated_at: new Date().toISOString() }, ...prev];
              });
            } else if (event.type === "text") {
              setMessages(prev =>
                prev.map(m => m.id === assistantMsgId ? { ...m, content: m.content + event.text } : m)
              );
            } else if (event.type === "error") {
              setMessages(prev =>
                prev.map(m => m.id === assistantMsgId ? { ...m, content: `⚠ ${event.message}` } : m)
              );
            }
          } catch { /* ignore malformed SSE */ }
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      setMessages(prev =>
        prev.map(m => m.id === assistantMsgId ? { ...m, content: `⚠ ${msg}` } : m)
      );
    } finally {
      setIsLoading(false);
    }
  };

  // Welcome quick card — auto-send an intro message
  const handleQuickAction = (moduleId: string) => {
    setActiveModule(moduleId);
    const mod = MODULES.find(m => m.id === moduleId)!;
    sendMessage(`I'd like to use the ${mod.label} feature. What can I do with it?`, moduleId);
  };

  // Sidebar module click — just toggle the context chip
  const handleSidebarModule = (moduleId: string) => {
    setActiveModule(prev => (prev === moduleId ? null : moduleId));
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
    e.target.style.height = "auto";
    e.target.style.height = Math.min(e.target.scrollHeight, 160) + "px";
  };

  // ── Bug reports ───────────────────────────────────────────────────────────
  const fetchBugs = async () => {
    try {
      const res = await fetch(`${API}/api/bugs`, { headers: authHeaders() });
      const data = await res.json();
      setBugs(Array.isArray(data) ? data : []);
    } catch { /* silent */ }
  };

  const submitBug = async () => {
    if (!bugDescription.trim()) return;
    setBugSubmitting(true);
    try {
      const form = new FormData();
      form.append("description", bugDescription);
      if (bugImage) form.append("image", bugImage);
      const res = await fetch(`${API}/api/bugs`, {
        method: "POST",
        headers: authHeaders(),
        body: form,
      });
      if (res.ok) {
        setBugSuccess(true);
        setBugDescription("");
        setBugImage(null);
        setTimeout(() => setBugSuccess(false), 3000);
      }
    } finally {
      setBugSubmitting(false);
    }
  };

  const updateBugStatus = async (bugId: number, status: string) => {
    await fetch(`${API}/api/admin/bugs/${bugId}/status`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ status }),
    });
    fetchBugs();
  };

  const deleteBug = async (bugId: number) => {
    if (!window.confirm("Delete this bug report? This cannot be undone.")) return;
    await fetch(`${API}/api/admin/bugs/${bugId}`, {
      method: "DELETE",
      headers: authHeaders(),
    });
    fetchBugs();
  };

  const openBugModal = (view: "submit" | "list") => {
    setBugView(view);
    setShowBugModal(true);
    if (view === "list") fetchBugs();
  };

  const logout = () => {
    localStorage.removeItem("access_token");
    navigate("/");
  };

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="dashboard">

      {/* ─── Sidebar ─── */}
      <aside className="sidebar">
        <div className="sb-top">
          <div className="sb-logo">
            <span className="sb-logo-icon">✦</span>
            <span className="sb-logo-text">Enterprise AI</span>
          </div>
          <button className="sb-new-chat" onClick={startNewChat} title="New chat">✏</button>
        </div>

        <div className="sb-user">
          <div className="sb-avatar">{currentUser.charAt(0).toUpperCase()}</div>
          <div className="sb-user-info">
            <div className="sb-user-email" title={currentUser}>{currentUser}</div>
            <div className="sb-user-meta">
              {isAdmin && <span className="sb-admin-badge">Admin</span>}
              <button className="sb-signout" onClick={logout}>Sign out</button>
            </div>
          </div>
        </div>

        <div className="sb-divider" />

        <div className="sb-section-title">Modules</div>
        <nav className="sb-nav">
          {MODULES.map(m => (
            <button
              key={m.id}
              className={`sb-nav-item ${activeModule === m.id ? "sb-nav-item--active" : ""}`}
              onClick={() => handleSidebarModule(m.id)}
              title={m.desc}
            >
              <span className="sb-nav-icon">{m.icon}</span>
              <span className="sb-nav-label">{m.label}</span>
            </button>
          ))}
        </nav>

        {sessions.length > 0 && (
          <>
            <div className="sb-divider" />
            <div className="sb-section-title">History</div>
            <nav className="sb-nav sb-nav--scroll">
              {sessions.slice(0, 20).map(s => (
                <button
                  key={s.id}
                  className={`sb-nav-item ${currentSessionId === s.id ? "sb-nav-item--active" : ""}`}
                  onClick={() => loadSession(s.id)}
                  title={s.title}
                >
                  <span className="sb-nav-icon">💬</span>
                  <span className="sb-nav-label sb-nav-label--truncate">{s.title}</span>
                </button>
              ))}
            </nav>
          </>
        )}

        <div className="sb-spacer" />

        <div className="sb-footer">
          <button className="sb-footer-btn" onClick={() => setShowSettings(true)}>
            <span>⚙️</span> Settings
          </button>
          <button className="sb-footer-btn">
            <span>❓</span> Help
          </button>
          <button className="sb-footer-btn" onClick={() => openBugModal("submit")}>
            <span>🐛</span> Report Bug
          </button>
        </div>
      </aside>

      {/* ─── Main ─── */}
      <main className="chat-main">
        <div className="chat-scroll">
          {!hasStartedChat ? (
            <div className="welcome">
              <p className="welcome-eyebrow">Enterprise AI Suite</p>
              <h1 className="welcome-title">What can I help you with?</h1>
              <p className="welcome-sub">Ask anything, or choose a module below to get started.</p>
              <div className="quick-grid">
                {MODULES.map(m => (
                  <button key={m.id} className="quick-card" onClick={() => handleQuickAction(m.id)}>
                    <span className="quick-card-icon">{m.icon}</span>
                    <span className="quick-card-label">{m.label}</span>
                    <span className="quick-card-desc">{m.desc}</span>
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="messages">
              {messages.map(msg => (
                <div key={msg.id} className={`msg msg--${msg.role}`}>
                  <div className="msg-avatar">
                    {msg.role === "user" ? currentUser.charAt(0).toUpperCase() : "✦"}
                  </div>
                  <div className="msg-body">
                    {msg.role === "assistant" && msg.content === "" ? (
                      <div className="msg-bubble msg-bubble--typing">
                        <span className="dot" /><span className="dot" /><span className="dot" />
                      </div>
                    ) : (
                      <div className="msg-bubble">{msg.content}</div>
                    )}
                    {msg.content !== "" && (
                      <div className="msg-time">
                        {msg.timestamp.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                      </div>
                    )}
                  </div>
                </div>
              ))}
              <div ref={messagesEndRef} />
            </div>
          )}
        </div>

        {activeModule && (
          <div className="module-bar">
            <span className="module-chip">
              {MODULES.find(m => m.id === activeModule)?.icon}{" "}
              {MODULES.find(m => m.id === activeModule)?.label}
              <button className="module-chip-clear" onClick={() => setActiveModule(null)}>✕</button>
            </span>
          </div>
        )}

        <div className="chat-input-wrap">
          <div className="chat-input-box">
            <button className="input-btn input-btn--attach" title="Attach file (coming soon)" disabled>
              📎
            </button>
            <textarea
              ref={textareaRef}
              className="chat-textarea"
              placeholder="Ask anything…"
              value={input}
              onChange={handleInputChange}
              onKeyDown={handleKeyDown}
              rows={1}
            />
            <button
              className="input-btn input-btn--send"
              onClick={() => sendMessage()}
              disabled={!input.trim() || isLoading}
            >
              ↑
            </button>
          </div>
          <p className="input-hint">Enter to send · Shift+Enter for new line</p>
        </div>
      </main>

      {/* ─── Settings modal ─── */}
      {showSettings && (
        <div className="overlay" onClick={() => setShowSettings(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-hdr">
              <span className="modal-title">Settings</span>
              <button className="modal-close" onClick={() => setShowSettings(false)}>✕</button>
            </div>
            <div className="modal-body">

              {/* Theme */}
              <div className="setting-row">
                <div>
                  <div className="setting-label">Appearance</div>
                  <div className="setting-desc">{theme === "dark" ? "🌙 Dark Mode" : "☀️ Light Mode"}</div>
                </div>
                <button
                  className={`toggle ${theme === "light" ? "toggle--on" : ""}`}
                  onClick={() => setTheme(t => (t === "dark" ? "light" : "dark"))}
                  aria-label="Toggle theme"
                >
                  <span className="toggle-thumb" />
                </button>
              </div>

              <div className="setting-divider" />

              {/* Model selector */}
              <div className="setting-label" style={{ marginBottom: 10 }}>AI Response Quality</div>
              <div className="model-picker">
                {MODELS.map(m => (
                  <button
                    key={m.value}
                    className={`model-option ${selectedModel === m.value ? "model-option--active" : ""}`}
                    onClick={() => {
                      setSelectedModel(m.value);
                      localStorage.setItem("selectedModel", m.value);
                    }}
                  >
                    <span className="model-option-label">{m.label}</span>
                    <span className="model-option-desc">{m.desc}</span>
                  </button>
                ))}
              </div>

            </div>
          </div>
        </div>
      )}

      {/* ─── Bug report modal ─── */}
      {showBugModal && (
        <div className="overlay" onClick={() => setShowBugModal(false)}>
          <div className="modal modal--wide" onClick={e => e.stopPropagation()}>
            <div className="modal-hdr">
              <span className="modal-title">Bug Reports</span>
              <button className="modal-close" onClick={() => setShowBugModal(false)}>✕</button>
            </div>

            <div className="modal-tabs">
              <button
                className={`modal-tab ${bugView === "submit" ? "modal-tab--active" : ""}`}
                onClick={() => setBugView("submit")}
              >Submit a Bug</button>
              <button
                className={`modal-tab ${bugView === "list" ? "modal-tab--active" : ""}`}
                onClick={() => { setBugView("list"); fetchBugs(); }}
              >All Reports</button>
            </div>

            <div className="modal-body">
              {bugView === "submit" ? (
                <div className="bug-form">
                  {bugSuccess && <div className="bug-success">✓ Report submitted — thank you!</div>}
                  <label className="bug-label">Describe the issue</label>
                  <textarea
                    className="bug-textarea"
                    placeholder="What happened? What did you expect to happen?"
                    value={bugDescription}
                    onChange={e => setBugDescription(e.target.value)}
                    rows={4}
                  />
                  <label className="bug-label">Screenshot (optional)</label>
                  <div className="bug-upload" onClick={() => fileInputRef.current?.click()}>
                    {bugImage ? <span>📎 {bugImage.name}</span> : <span>Click to upload image</span>}
                  </div>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*"
                    hidden
                    onChange={e => setBugImage(e.target.files?.[0] ?? null)}
                  />
                  <button
                    className="bug-submit"
                    onClick={submitBug}
                    disabled={bugSubmitting || !bugDescription.trim()}
                  >
                    {bugSubmitting ? "Submitting…" : "Submit Report"}
                  </button>
                </div>
              ) : (
                <div className="bug-list">
                  {bugs.length === 0 ? (
                    <div className="bug-empty">No reports yet.</div>
                  ) : (
                    bugs.map(b => (
                      <div key={b.id} className="bug-item">
                        <div className="bug-item-hdr">
                          <span className="bug-item-user">{b.user_email}</span>
                          <span className={`bug-badge bug-badge--${b.status}`}>{b.status}</span>
                          <span className="bug-item-date">
                            {new Date(b.created_at).toLocaleDateString()}
                          </span>
                        </div>
                        <div className="bug-item-desc">{b.description}</div>
                        {b.image_filename && (
                          <div className="bug-item-img-wrap">
                            <img
                              className="bug-item-img"
                              src={`${API}/uploads/${b.image_filename}`}
                              alt="Bug screenshot"
                              onClick={() => window.open(`${API}/uploads/${b.image_filename}`, "_blank")}
                              title="Click to open full size"
                            />
                          </div>
                        )}
                        {isAdmin && (
                          <div className="bug-admin-row">
                            <span className="bug-admin-label">Status</span>
                            <div className="bug-status-btns">
                              <button
                                className={`bug-status-btn bug-status-btn--open ${b.status === "open" ? "bug-status-btn--active" : ""}`}
                                onClick={() => b.status !== "open" && updateBugStatus(b.id, "open")}
                              >
                                ● Open
                              </button>
                              <button
                                className={`bug-status-btn bug-status-btn--resolved ${b.status === "resolved" ? "bug-status-btn--active" : ""}`}
                                onClick={() => b.status !== "resolved" && updateBugStatus(b.id, "resolved")}
                              >
                                ✓ Resolved
                              </button>
                            </div>
                            <button
                              className="bug-delete-btn"
                              onClick={() => deleteBug(b.id)}
                              title="Delete this report"
                            >
                              🗑 Delete
                            </button>
                          </div>
                        )}
                      </div>
                    ))
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
