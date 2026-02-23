import { useState, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import ReactMarkdown from "react-markdown";
import "./dashboard.css";

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: Date;
  sources?: SourceItem[];
}

interface SourceItem {
  doc_id: number;
  filename: string;
  chunk_index: number;
  excerpt: string;
  source_type?: "personal" | "shared";
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

interface DocItem {
  id: number;
  filename: string;
  is_active: boolean;
  chunk_count: number;
  embedded_count: number;
  file_size: number | null;
  created_at: string;
  folder_id: number | null;
}

interface FolderItem {
  id: number;
  name: string;
  created_at: string;
  doc_count: number;
  total_size: number;
}

interface SharedDocItem {
  id: number;
  filename: string;
  folder_id: number;
  chunk_count: number;
  embedded_count: number;
  file_size: number | null;
  is_visible: boolean;
  is_rag_active: boolean;
  user_rag_active: boolean;
  created_at: string;
}

interface SharedFolderItem {
  id: number;
  name: string;
  department: string;
  created_at: string;
  doc_count: number;
  total_size: number;
}

interface UserItem {
  email: string;
  department: string | null;
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
  {
    id: "general",
    icon: "💬",
    label: "General Chat",
    desc: "Ask anything — technology trends, how things work, general knowledge",
  },
];

const MODELS = [
  { value: "claude-haiku-4-5-20251001", label: "⚡ Fast", desc: "Quick everyday questions" },
  { value: "claude-sonnet-4-6",          label: "✦ Smart", desc: "Best for most tasks"       },
  { value: "claude-opus-4-6",            label: "🎯 Expert", desc: "Deep analysis & reasoning" },
];

const API = "http://localhost:8000";
const STORAGE_LIMIT = 512 * 1024 * 1024; // 0.5 GB

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

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
  const [department, setDepartment] = useState<string | null>(null);
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [selectedModel, setSelectedModel] = useState(
    localStorage.getItem("selectedModel") || "claude-haiku-4-5-20251001"
  );

  // Modals
  const [showSettings, setShowSettings] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [showBugModal, setShowBugModal] = useState(false);
  const [showUsersModal, setShowUsersModal] = useState(false);
  const [bugView, setBugView] = useState<"submit" | "list">("submit");

  // Bug form
  const [bugDescription, setBugDescription] = useState("");
  const [bugImage, setBugImage] = useState<File | null>(null);
  const [bugs, setBugs] = useState<BugReport[]>([]);
  const [bugSubmitting, setBugSubmitting] = useState(false);
  const [bugSuccess, setBugSuccess] = useState(false);

  // RAG — personal documents
  const [documents, setDocuments] = useState<DocItem[]>([]);
  const [folders, setFolders] = useState<FolderItem[]>([]);
  const [storageUsed, setStorageUsed] = useState(0);

  // Personal folder UI state
  const [expandedFolders, setExpandedFolders] = useState<Set<number>>(new Set());
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [renamingFolderId, setRenamingFolderId] = useState<number | null>(null);
  const [renamingFolderName, setRenamingFolderName] = useState("");

  // Personal upload
  const [uploadingFolderId, setUploadingFolderId] = useState<number | null>(null);
  const uploadFolderIdRef = useRef<number | null>(null);

  // RAG — shared documents
  const [sharedDocs, setSharedDocs] = useState<SharedDocItem[]>([]);
  const [sharedFolders, setSharedFolders] = useState<SharedFolderItem[]>([]);

  // Shared folder UI state
  const [expandedSharedFolders, setExpandedSharedFolders] = useState<Set<number>>(new Set());
  const [creatingSharedFolder, setCreatingSharedFolder] = useState(false);
  const [newSharedFolderName, setNewSharedFolderName] = useState("");
  const [newSharedFolderDept, setNewSharedFolderDept] = useState("");
  const [renamingSharedFolderId, setRenamingSharedFolderId] = useState<number | null>(null);
  const [renamingSharedFolderName, setRenamingSharedFolderName] = useState("");

  // Shared upload
  const [uploadingSharedFolderId, setUploadingSharedFolderId] = useState<number | null>(null);
  const uploadSharedFolderIdRef = useRef<number | null>(null);
  const sharedDocFileInputRef = useRef<HTMLInputElement>(null);

  // Admin — user management
  const [adminUsers, setAdminUsers] = useState<UserItem[]>([]);
  const [editingUserEmail, setEditingUserEmail] = useState<string | null>(null);
  const [editingDeptValue, setEditingDeptValue] = useState("");

  // File content preview
  const [previewDoc, setPreviewDoc] = useState<{ id: number; filename: string; isShared?: boolean } | null>(null);
  const [previewContent, setPreviewContent] = useState("");
  const [previewTruncated, setPreviewTruncated] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);

  // Source cards expanded state
  const [expandedSources, setExpandedSources] = useState<Set<string>>(new Set());

  // Panel visibility
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [rightPanelOpen, setRightPanelOpen] = useState(true);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const docFileInputRef = useRef<HTMLInputElement>(null);

  const token = localStorage.getItem("access_token") || sessionStorage.getItem("access_token");
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
    fetchDocuments();
    fetchFolders();
    fetchStorage();
    fetchSharedFolders();
    fetchSharedDocs();
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Poll for document ingestion progress (personal)
  useEffect(() => {
    const hasProcessing = documents.some(
      d => d.chunk_count === 0 || (d.chunk_count > 0 && d.embedded_count === 0)
    );
    if (!hasProcessing) return;
    const timer = setInterval(() => {
      fetchDocuments();
      fetchFolders();
      fetchStorage();
    }, 5000);
    return () => clearInterval(timer);
  }, [documents]);

  // Poll for shared document ingestion progress
  useEffect(() => {
    const hasProcessing = sharedDocs.some(
      d => d.chunk_count === 0 || (d.chunk_count > 0 && d.embedded_count === 0)
    );
    if (!hasProcessing) return;
    const timer = setInterval(() => {
      fetchSharedDocs();
      fetchSharedFolders();
    }, 5000);
    return () => clearInterval(timer);
  }, [sharedDocs]);

  const authHeaders = (): Record<string, string> => ({
    Authorization: `Bearer ${token}`,
  });

  const toggleSources = (key: string) => {
    setExpandedSources(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  const toggleExpandFolder = (folderId: number) => {
    setExpandedFolders(prev => {
      const next = new Set(prev);
      if (next.has(folderId)) next.delete(folderId); else next.add(folderId);
      return next;
    });
  };

  const toggleExpandSharedFolder = (folderId: number) => {
    setExpandedSharedFolders(prev => {
      const next = new Set(prev);
      if (next.has(folderId)) next.delete(folderId); else next.add(folderId);
      return next;
    });
  };

  // ── User / admin ──────────────────────────────────────────────────────────
  const fetchMe = async () => {
    try {
      const res = await fetch(`${API}/api/me`, { headers: authHeaders() });
      const data = await res.json();
      setIsAdmin(data.is_admin || false);
      setDepartment(data.department || null);
      if (data.is_admin) fetchAdminUsers();
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
        data.map((m: { id: number; role: string; content: string; created_at: string; sources?: SourceItem[] }) => ({
          id: `db-${m.id}`,
          role: m.role as "user" | "assistant",
          content: m.content,
          timestamp: new Date(m.created_at),
          sources: m.sources?.length ? m.sources : undefined,
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

  const deleteSession = async (sessionId: number, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!window.confirm("Delete this conversation? This cannot be undone.")) return;
    await fetch(`${API}/api/sessions/${sessionId}`, {
      method: "DELETE",
      headers: authHeaders(),
    });
    setSessions(prev => prev.filter(s => s.id !== sessionId));
    if (currentSessionId === sessionId) startNewChat();
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
            } else if (event.type === "sources") {
              setMessages(prev =>
                prev.map(m => m.id === assistantMsgId ? { ...m, sources: event.sources } : m)
              );
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

  // ── RAG — Personal Documents ───────────────────────────────────────────────
  const fetchDocuments = async () => {
    try {
      const res = await fetch(`${API}/api/documents/`, { headers: authHeaders() });
      const data = await res.json();
      setDocuments(Array.isArray(data) ? data : []);
    } catch { /* silent */ }
  };

  const fetchFolders = async () => {
    try {
      const res = await fetch(`${API}/api/documents/folders`, { headers: authHeaders() });
      const data = await res.json();
      setFolders(Array.isArray(data) ? data : []);
    } catch { /* silent */ }
  };

  const fetchStorage = async () => {
    try {
      const res = await fetch(`${API}/api/documents/storage`, { headers: authHeaders() });
      const data = await res.json();
      setStorageUsed(data.used_bytes || 0);
    } catch { /* silent */ }
  };

  const refreshAll = () => {
    fetchDocuments();
    fetchFolders();
    fetchStorage();
  };

  // ── Personal Folder CRUD ──────────────────────────────────────────────────
  const createFolder = async (name: string) => {
    if (!name.trim()) return;
    await fetch(`${API}/api/documents/folders`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ name }),
    });
    setCreatingFolder(false);
    setNewFolderName("");
    fetchFolders();
  };

  const renameFolder = async (folderId: number, name: string) => {
    if (!name.trim()) { setRenamingFolderId(null); return; }
    await fetch(`${API}/api/documents/folders/${folderId}/rename`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ name }),
    });
    setRenamingFolderId(null);
    fetchFolders();
  };

  const deleteFolder = async (folderId: number) => {
    const folder = folders.find(f => f.id === folderId);
    const count = folder?.doc_count ?? 0;
    const msg = count > 0
      ? `Delete folder and all ${count} file${count > 1 ? "s" : ""} inside? This cannot be undone.`
      : "Delete this empty folder?";
    if (!window.confirm(msg)) return;
    await fetch(`${API}/api/documents/folders/${folderId}`, {
      method: "DELETE",
      headers: authHeaders(),
    });
    refreshAll();
  };

  const toggleFolder = async (folderId: number, active: boolean) => {
    await fetch(`${API}/api/documents/folders/${folderId}/toggle`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ active }),
    });
    fetchDocuments();
  };

  // ── Personal Upload ───────────────────────────────────────────────────────
  const uploadToFolder = async (files: FileList | null, folderId: number) => {
    if (!files || files.length === 0) return;
    setUploadingFolderId(folderId);
    const form = new FormData();
    for (const f of files) form.append("files", f);
    form.append("folder_id", String(folderId));
    try {
      await fetch(`${API}/api/documents/`, {
        method: "POST",
        headers: authHeaders(),
        body: form,
      });
    } catch { /* silent */ }
    await fetchDocuments();
    setUploadingFolderId(null);
    fetchFolders();
    fetchStorage();
    setExpandedFolders(prev => new Set(prev).add(folderId));
  };

  // ── Personal Document Actions ─────────────────────────────────────────────
  const toggleDocument = async (docId: number) => {
    await fetch(`${API}/api/documents/${docId}/toggle`, {
      method: "PATCH",
      headers: authHeaders(),
    });
    fetchDocuments();
  };

  const deleteDocument = async (docId: number) => {
    if (!window.confirm("Delete this document and all its data? This cannot be undone.")) return;
    await fetch(`${API}/api/documents/${docId}`, {
      method: "DELETE",
      headers: authHeaders(),
    });
    refreshAll();
  };

  const reprocessDocument = async (docId: number) => {
    await fetch(`${API}/api/documents/${docId}/reprocess`, {
      method: "POST",
      headers: authHeaders(),
    });
    fetchDocuments();
  };

  // ── RAG — Shared Documents ────────────────────────────────────────────────
  const fetchSharedFolders = async () => {
    try {
      const res = await fetch(`${API}/api/shared-documents/folders`, { headers: authHeaders() });
      const data = await res.json();
      setSharedFolders(Array.isArray(data) ? data : []);
    } catch { /* silent */ }
  };

  const fetchSharedDocs = async () => {
    try {
      const res = await fetch(`${API}/api/shared-documents/`, { headers: authHeaders() });
      const data = await res.json();
      setSharedDocs(Array.isArray(data) ? data : []);
    } catch { /* silent */ }
  };

  const refreshShared = () => {
    fetchSharedFolders();
    fetchSharedDocs();
  };

  // ── Shared Folder CRUD (admin) ────────────────────────────────────────────
  const createSharedFolder = async (name: string, dept: string) => {
    if (!name.trim() || !dept.trim()) return;
    await fetch(`${API}/api/shared-documents/folders`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ name, department: dept }),
    });
    setCreatingSharedFolder(false);
    setNewSharedFolderName("");
    setNewSharedFolderDept("");
    fetchSharedFolders();
  };

  const renameSharedFolder = async (folderId: number, name: string) => {
    if (!name.trim()) { setRenamingSharedFolderId(null); return; }
    await fetch(`${API}/api/shared-documents/folders/${folderId}/rename`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ name }),
    });
    setRenamingSharedFolderId(null);
    fetchSharedFolders();
  };

  const deleteSharedFolder = async (folderId: number) => {
    const folder = sharedFolders.find(f => f.id === folderId);
    const count = folder?.doc_count ?? 0;
    const msg = count > 0
      ? `Delete shared folder and all ${count} file${count > 1 ? "s" : ""} inside? This cannot be undone.`
      : "Delete this empty shared folder?";
    if (!window.confirm(msg)) return;
    await fetch(`${API}/api/shared-documents/folders/${folderId}`, {
      method: "DELETE",
      headers: authHeaders(),
    });
    refreshShared();
  };

  // ── Shared Upload (admin) ─────────────────────────────────────────────────
  const uploadToSharedFolder = async (files: FileList | null, folderId: number) => {
    if (!files || files.length === 0) return;
    setUploadingSharedFolderId(folderId);
    const form = new FormData();
    for (const f of files) form.append("files", f);
    form.append("folder_id", String(folderId));
    try {
      await fetch(`${API}/api/shared-documents/`, {
        method: "POST",
        headers: authHeaders(),
        body: form,
      });
    } catch { /* silent */ }
    await fetchSharedDocs();
    setUploadingSharedFolderId(null);
    fetchSharedFolders();
    setExpandedSharedFolders(prev => new Set(prev).add(folderId));
  };

  // ── Shared Document Actions ───────────────────────────────────────────────
  const deleteSharedDocument = async (docId: number) => {
    if (!window.confirm("Delete this shared document and all its data? This cannot be undone.")) return;
    await fetch(`${API}/api/shared-documents/${docId}`, {
      method: "DELETE",
      headers: authHeaders(),
    });
    refreshShared();
  };

  const toggleSharedVisibility = async (docId: number) => {
    const res = await fetch(`${API}/api/shared-documents/${docId}/toggle-visibility`, {
      method: "PATCH",
      headers: authHeaders(),
    });
    const data = await res.json();
    setSharedDocs(prev => prev.map(d => d.id === docId ? { ...d, is_visible: data.is_visible } : d));
  };

  const toggleSharedRag = async (docId: number) => {
    const res = await fetch(`${API}/api/shared-documents/${docId}/toggle-rag`, {
      method: "PATCH",
      headers: authHeaders(),
    });
    const data = await res.json();
    setSharedDocs(prev => prev.map(d => d.id === docId ? { ...d, is_rag_active: data.is_rag_active } : d));
  };

  const toggleSharedUserPref = async (docId: number) => {
    const res = await fetch(`${API}/api/shared-documents/${docId}/toggle-user`, {
      method: "PATCH",
      headers: authHeaders(),
    });
    const data = await res.json();
    setSharedDocs(prev => prev.map(d => d.id === docId ? { ...d, user_rag_active: data.user_rag_active } : d));
  };

  const reprocessSharedDocument = async (docId: number) => {
    await fetch(`${API}/api/shared-documents/${docId}/reprocess`, {
      method: "POST",
      headers: authHeaders(),
    });
    fetchSharedDocs();
  };

  // ── Content preview ───────────────────────────────────────────────────────
  const openPreview = async (doc: DocItem) => {
    setPreviewDoc({ id: doc.id, filename: doc.filename, isShared: false });
    setPreviewContent("");
    setPreviewTruncated(false);
    setPreviewLoading(true);
    try {
      const res = await fetch(`${API}/api/documents/${doc.id}/content`, {
        headers: authHeaders(),
      });
      const data = await res.json();
      setPreviewContent(data.content || "(empty file)");
      setPreviewTruncated(data.truncated || false);
    } catch {
      setPreviewContent("Failed to load content.");
    } finally {
      setPreviewLoading(false);
    }
  };

  const openSharedPreview = async (doc: SharedDocItem) => {
    setPreviewDoc({ id: doc.id, filename: doc.filename, isShared: true });
    setPreviewContent("");
    setPreviewTruncated(false);
    setPreviewLoading(true);
    try {
      const res = await fetch(`${API}/api/shared-documents/${doc.id}/content`, {
        headers: authHeaders(),
      });
      const data = await res.json();
      setPreviewContent(data.content || "(empty file)");
      setPreviewTruncated(data.truncated || false);
    } catch {
      setPreviewContent("Failed to load content.");
    } finally {
      setPreviewLoading(false);
    }
  };

  // ── Admin — User Management ───────────────────────────────────────────────
  const fetchAdminUsers = async () => {
    try {
      const res = await fetch(`${API}/api/admin/users`, { headers: authHeaders() });
      const data = await res.json();
      setAdminUsers(Array.isArray(data) ? data : []);
    } catch { /* silent */ }
  };

  const saveUserDepartment = async (email: string, dept: string) => {
    await fetch(`${API}/api/admin/users/${encodeURIComponent(email)}/department`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ department: dept.trim() || null }),
    });
    setEditingUserEmail(null);
    fetchAdminUsers();
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
    sessionStorage.removeItem("access_token");
    navigate("/");
  };

  // ── Derived data ──────────────────────────────────────────────────────────
  const storagePercent = Math.min((storageUsed / STORAGE_LIMIT) * 100, 100);
  const storageNearLimit = storagePercent >= 85;
  const uncategorizedDocs = documents.filter(d => d.folder_id === null);

  // ── Shared doc rendering helper ───────────────────────────────────────────
  const renderSharedDocItem = (doc: SharedDocItem) => {
    const needsRetry = doc.chunk_count > 0 && doc.embedded_count === 0;
    const isProcessing = doc.chunk_count === 0;
    const notReady = isProcessing || needsRetry;

    // Effective RAG state for the current viewer
    const effectiveActive = doc.user_rag_active;

    const badgeClass = notReady
      ? "doc-badge--processing"
      : !doc.is_visible
      ? "doc-badge--inactive"
      : effectiveActive
      ? "doc-badge--active"
      : "doc-badge--inactive";
    const badgeLabel = isProcessing
      ? "processing…"
      : needsRetry
      ? "retry"
      : !doc.is_visible
      ? "unshared"
      : effectiveActive
      ? "attached"
      : "detached";

    return (
      <div key={doc.id} className="doc-item">
        <div className="doc-item-info">
          <button
            className="doc-item-name-btn"
            onClick={() => openSharedPreview(doc)}
            title={`View: ${doc.filename}`}
          >
            📄 {doc.filename}
          </button>
          <span className={`doc-badge ${badgeClass}`}>{badgeLabel}</span>
        </div>
        <div className="doc-item-actions">
          {notReady ? (
            isAdmin && (
              <button
                className="doc-retry-btn"
                onClick={() => reprocessSharedDocument(doc.id)}
                title="Retry embedding"
              >
                ↻
              </button>
            )
          ) : isAdmin ? (
            <>
              {/* Admin toggle 1: visibility */}
              <button
                className={`doc-toggle-btn doc-toggle-visibility${doc.is_visible ? " doc-toggle-on" : " doc-toggle-off"}`}
                onClick={() => toggleSharedVisibility(doc.id)}
                title={doc.is_visible ? "Share to users" : "Unshare from users"}
              >
                {doc.is_visible ? "👁" : "🚫"}
              </button>
              {/* Admin toggle 2: personal attach preference (only affects admin's own chat) */}
              <button
                className="doc-toggle-btn"
                onClick={() => toggleSharedUserPref(doc.id)}
                title={doc.user_rag_active ? "Detach" : "Attach"}
              >
                {doc.user_rag_active ? "⏸" : "▶"}
              </button>
              <button
                className="doc-delete-btn-sm"
                onClick={() => deleteSharedDocument(doc.id)}
                title="Delete"
              >
                🗑
              </button>
            </>
          ) : (
            /* User toggle: personal attach preference */
            <button
              className="doc-toggle-btn"
              onClick={() => toggleSharedUserPref(doc.id)}
              title={doc.user_rag_active ? "Detach" : "Attach"}
            >
              {doc.user_rag_active ? "⏸" : "▶"}
            </button>
          )}
        </div>
      </div>
    );
  };

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="dashboard">

      {/* ─── Sidebar ─── */}
      <aside className={`sidebar${sidebarOpen ? "" : " sidebar--collapsed"}`}>
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
              {department && <span className="sb-dept-badge">{department}</span>}
              <button className="sb-signout" onClick={logout}>Sign out</button>
            </div>
          </div>
        </div>

        {sessions.length > 0 && (
          <>
            <div className="sb-divider" />
            <div className="sb-section-title">History</div>
            <nav className="sb-nav sb-nav--scroll">
              {sessions.slice(0, 20).map(s => (
                <div key={s.id} className="sb-session-item">
                  <button
                    className={`sb-nav-item ${currentSessionId === s.id ? "sb-nav-item--active" : ""}`}
                    onClick={() => loadSession(s.id)}
                    title={s.title}
                  >
                    <span className="sb-nav-icon">💬</span>
                    <span className="sb-nav-label sb-nav-label--truncate">{s.title}</span>
                  </button>
                  <button
                    className="sb-session-delete"
                    onClick={(e) => deleteSession(s.id, e)}
                    title="Delete conversation"
                  >
                    🗑
                  </button>
                </div>
              ))}
            </nav>
          </>
        )}

        <div className="sb-spacer" />

        <div className="sb-footer">
          <button className="sb-footer-btn" onClick={() => setShowSettings(true)}>
            <span>⚙️</span> Settings
          </button>
          <button className="sb-footer-btn" onClick={() => setShowHelp(true)}>
            <span>❓</span> Help
          </button>
          <button className="sb-footer-btn" onClick={() => openBugModal("submit")}>
            <span>🐛</span> Report Bug
          </button>
        </div>
      </aside>

      {/* ─── Main ─── */}
      <main className="chat-main">
        {/* Panel toggle bar */}
        <div className="panel-toggle-bar">
          <button
            className="panel-toggle-btn"
            onClick={() => setSidebarOpen(o => !o)}
            title={sidebarOpen ? "Hide sidebar" : "Show sidebar"}
          >
            {sidebarOpen ? "◀" : "▶"}
          </button>
          <div className="panel-toggle-spacer" />
          <button
            className="panel-toggle-btn"
            onClick={() => setRightPanelOpen(o => !o)}
            title={rightPanelOpen ? "Hide documents" : "Show documents"}
          >
            {rightPanelOpen ? "▶" : "◀"}
          </button>
        </div>

        <div className="chat-scroll">
          {!hasStartedChat ? (
            <div className="welcome">
              <p className="welcome-eyebrow">Enterprise AI Suite</p>
              <h1 className="welcome-title">What can I help you with?</h1>
              <p className="welcome-sub">Ask anything to get started.</p>
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
                    ) : msg.role === "assistant" ? (
                      <div className="msg-bubble msg-bubble--md">
                        <ReactMarkdown>{msg.content}</ReactMarkdown>
                      </div>
                    ) : (
                      <div className="msg-bubble">{msg.content}</div>
                    )}
                    {msg.content !== "" && (
                      <div className="msg-time">
                        {msg.timestamp.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                      </div>
                    )}
                    {/* RAG source citations */}
                    {msg.sources && msg.sources.length > 0 && (
                      <div className="source-cards">
                        <div className="source-cards-header">
                          <span className="source-cards-title">
                            📎 {msg.sources.length} source{msg.sources.length > 1 ? "s" : ""}
                          </span>
                          <button
                            className="source-toggle-btn"
                            onClick={() => toggleSources(msg.id)}
                          >
                            {expandedSources.has(msg.id) ? "▲ Hide" : "▼ Show"}
                          </button>
                        </div>
                        {expandedSources.has(msg.id) && (
                          <div className="source-list">
                            {msg.sources.map((src, i) => {
                              const cardKey = `${msg.id}-card-${i}`;
                              const cardOpen = expandedSources.has(cardKey);
                              return (
                                <div key={i} className="source-card">
                                  <div className="source-card-header">
                                    <span className="source-card-filename">
                                      {src.source_type === "shared" ? "🌐" : "📄"} {src.filename}
                                      {src.source_type === "shared" && (
                                        <span className="source-shared-badge">shared</span>
                                      )}
                                    </span>
                                    <button
                                      className="source-card-toggle"
                                      onClick={() => toggleSources(cardKey)}
                                    >
                                      {cardOpen ? "▲ Hide" : "▼ Show"}
                                    </button>
                                  </div>
                                  {cardOpen && (
                                    <blockquote className="source-card-excerpt">{src.excerpt}</blockquote>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              ))}
              <div ref={messagesEndRef} />
            </div>
          )}
        </div>

        {activeModule && activeModule !== "general" && (
          <div className="module-bar">
            <span className="module-chip">
              {MODULES.find(m => m.id === activeModule)?.icon}{" "}
              {MODULES.find(m => m.id === activeModule)?.label}
              <button className="module-chip-clear" onClick={() => setActiveModule(null)}>✕</button>
            </span>
          </div>
        )}

        {/* Active personal documents notice */}
        {documents.some(d => d.is_active && d.embedded_count > 0) && (
          <div className="doc-active-bar">
            <span className="doc-active-bar-text">
              📎 {documents.filter(d => d.is_active && d.embedded_count > 0).length} document
              {documents.filter(d => d.is_active && d.embedded_count > 0).length > 1 ? "s" : ""} attached
              — AI may use them to answer your questions
              <span
                className="doc-active-bar-hint"
                title="Attached documents may cause the AI to give irrelevant or misleading answers. For the best response, deactivate as many unrelated documents as possible."
              >?</span>
            </span>
            <button
              className="doc-active-bar-dismiss"
              onClick={() =>
                documents.filter(d => d.is_active).forEach(d => toggleDocument(d.id))
              }
            >
              Detach all documents
            </button>
          </div>
        )}

        {/* Active shared documents notice */}
        {sharedDocs.some(d => d.is_visible && d.user_rag_active && d.embedded_count > 0) && (
          <div className="doc-active-bar doc-active-bar--shared">
            <span className="doc-active-bar-text">
              🌐 {sharedDocs.filter(d => d.is_visible && d.user_rag_active && d.embedded_count > 0).length} shared document
              {sharedDocs.filter(d => d.is_visible && d.user_rag_active && d.embedded_count > 0).length > 1 ? "s" : ""} attached
              — AI may use them to answer your questions
              <span
                className="doc-active-bar-hint"
                title="Attached documents may cause the AI to give irrelevant or misleading answers. For the best response, deactivate as many unrelated documents as possible."
              >?</span>
            </span>
            <button
              className="doc-active-bar-dismiss"
              onClick={async () => {
                const active = sharedDocs.filter(
                  d => d.is_visible && d.user_rag_active && d.embedded_count > 0
                );
                await Promise.all(active.map(d => toggleSharedUserPref(d.id)));
                fetchSharedDocs();
              }}
            >
              Detach all shared documents
            </button>
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

      {/* ─── Document right panel ─── */}
      <aside className={`doc-panel-right${rightPanelOpen ? "" : " doc-panel-right--collapsed"}`}>

        {/* ── My Documents section ── */}
        <div className="doc-panel-hdr">
          <span className="doc-panel-title">📁 My Documents</span>
          <button
            className="doc-upload-btn"
            onClick={() => { setCreatingFolder(true); setNewFolderName(""); }}
          >
            + New Folder
          </button>
        </div>

        {/* Personal storage bar */}
        <div className="doc-storage-wrap">
          <div className="doc-storage-labels">
            <span>{formatBytes(storageUsed)} used</span>
            <span className={storageNearLimit ? "doc-storage-warn" : ""}>
              {formatBytes(STORAGE_LIMIT - storageUsed)} left
            </span>
          </div>
          <div className="doc-storage-track">
            <div
              className={`doc-storage-fill${storageNearLimit ? " doc-storage-fill--warn" : ""}`}
              style={{ width: `${storagePercent}%` }}
            />
          </div>
        </div>

        {/* New personal folder inline input */}
        {creatingFolder && (
          <div className="doc-folder-create">
            <input
              className="doc-folder-create-input"
              autoFocus
              placeholder="Folder name…"
              value={newFolderName}
              onChange={e => setNewFolderName(e.target.value)}
              onKeyDown={e => {
                if (e.key === "Enter" && newFolderName.trim()) createFolder(newFolderName.trim());
                if (e.key === "Escape") { setCreatingFolder(false); setNewFolderName(""); }
              }}
            />
            <button
              className="doc-folder-create-btn"
              onClick={() => createFolder(newFolderName.trim())}
              disabled={!newFolderName.trim()}
            >
              Create
            </button>
            <button
              className="doc-folder-create-cancel"
              onClick={() => { setCreatingFolder(false); setNewFolderName(""); }}
            >
              ✕
            </button>
          </div>
        )}

        {/* Personal folder list */}
        {folders.length === 0 && !creatingFolder ? (
          <div className="doc-empty">
            No folders yet.<br />Create a folder to start uploading documents.
          </div>
        ) : (
          <div className="doc-folder-list">
            {folders.map(folder => {
              const folderDocs = documents.filter(d => d.folder_id === folder.id);
              const isExpanded = expandedFolders.has(folder.id);
              const isRenaming = renamingFolderId === folder.id;
              const isUploading = uploadingFolderId === folder.id;
              const isProcessingAny = folderDocs.some(d => d.chunk_count === 0);
              const allActive = folderDocs.length > 0 && folderDocs.every(d => d.is_active);

              return (
                <div key={folder.id} className="doc-folder">
                  <div className="doc-folder-hdr">
                    <button
                      className="doc-folder-chevron"
                      onClick={() => toggleExpandFolder(folder.id)}
                      title={isExpanded ? "Collapse" : "Expand"}
                    >
                      {isExpanded ? "▼" : "▶"}
                    </button>

                    {isRenaming ? (
                      <input
                        className="doc-folder-rename-input"
                        autoFocus
                        value={renamingFolderName}
                        onChange={e => setRenamingFolderName(e.target.value)}
                        onKeyDown={e => {
                          if (e.key === "Enter") renameFolder(folder.id, renamingFolderName);
                          if (e.key === "Escape") setRenamingFolderId(null);
                        }}
                        onBlur={() => renameFolder(folder.id, renamingFolderName)}
                      />
                    ) : (
                      <span
                        className="doc-folder-name"
                        title={folder.name}
                        onDoubleClick={() => {
                          setRenamingFolderId(folder.id);
                          setRenamingFolderName(folder.name);
                        }}
                      >
                        {folder.name}
                      </span>
                    )}

                    <span className="doc-folder-count">({folderDocs.length})</span>

                    <div className="doc-folder-actions">
                      {folderDocs.length > 0 && (
                        <button
                          className="doc-folder-btn"
                          onClick={() => toggleFolder(folder.id, !allActive)}
                          title={allActive ? "Detach all" : "Attach all"}
                        >
                          {allActive ? "⏸" : "▶"}
                        </button>
                      )}
                      <button
                        className="doc-folder-btn"
                        onClick={() => {
                          setRenamingFolderId(folder.id);
                          setRenamingFolderName(folder.name);
                        }}
                        title="Rename folder"
                      >
                        ✏
                      </button>
                      <button
                        className="doc-folder-btn doc-folder-btn--danger"
                        onClick={() => deleteFolder(folder.id)}
                        title="Delete folder"
                      >
                        🗑
                      </button>
                    </div>
                  </div>

                  {isExpanded && (
                    <div className="doc-folder-body">
                      <button
                        className="doc-add-files-btn"
                        disabled={isUploading}
                        onClick={() => {
                          uploadFolderIdRef.current = folder.id;
                          if (docFileInputRef.current) {
                            docFileInputRef.current.value = "";
                            docFileInputRef.current.click();
                          }
                        }}
                      >
                        {isUploading ? "Uploading…" : "+ Add Files"}
                      </button>

                      {(isUploading || isProcessingAny) && (
                        <div className="doc-uploading-row">
                          <span className="doc-uploading-spinner" />
                          {isUploading ? "Uploading files…" : "Processing files…"}
                        </div>
                      )}

                      {folderDocs.length === 0 && !isUploading ? (
                        <div className="doc-folder-empty">No files yet.</div>
                      ) : (
                        folderDocs.map(doc => {
                          const needsRetry = doc.chunk_count > 0 && doc.embedded_count === 0;
                          const isProcessing = doc.chunk_count === 0;
                          const notReady = isProcessing || needsRetry;
                          const badgeClass = notReady
                            ? "doc-badge--processing"
                            : doc.is_active
                            ? "doc-badge--active"
                            : "doc-badge--inactive";
                          const badgeLabel = isProcessing
                            ? "processing…"
                            : needsRetry
                            ? "retry"
                            : doc.is_active
                            ? "attached"
                            : "detached";
                          return (
                            <div key={doc.id} className="doc-item">
                              <div className="doc-item-info">
                                <button
                                  className="doc-item-name-btn"
                                  onClick={() => openPreview(doc)}
                                  title={`View: ${doc.filename}`}
                                >
                                  📄 {doc.filename}
                                </button>
                                <span className={`doc-badge ${badgeClass}`}>{badgeLabel}</span>
                              </div>
                              <div className="doc-item-actions">
                                {notReady ? (
                                  <button
                                    className="doc-retry-btn"
                                    onClick={() => reprocessDocument(doc.id)}
                                    title="Retry embedding"
                                  >
                                    ↻
                                  </button>
                                ) : (
                                  <button
                                    className="doc-toggle-btn"
                                    onClick={() => toggleDocument(doc.id)}
                                    title={doc.is_active ? "Detach" : "Attach"}
                                  >
                                    {doc.is_active ? "⏸" : "▶"}
                                  </button>
                                )}
                                <button
                                  className="doc-delete-btn-sm"
                                  onClick={() => deleteDocument(doc.id)}
                                  title="Delete"
                                >
                                  🗑
                                </button>
                              </div>
                            </div>
                          );
                        })
                      )}
                    </div>
                  )}
                </div>
              );
            })}

            {/* Uncategorized docs */}
            {uncategorizedDocs.length > 0 && (
              <div className="doc-folder doc-folder--uncategorized">
                <div className="doc-folder-hdr">
                  <button
                    className="doc-folder-chevron"
                    onClick={() => toggleExpandFolder(-1)}
                  >
                    {expandedFolders.has(-1) ? "▼" : "▶"}
                  </button>
                  <span className="doc-folder-name">Uncategorized</span>
                  <span className="doc-folder-count">({uncategorizedDocs.length})</span>
                </div>
                {expandedFolders.has(-1) && (
                  <div className="doc-folder-body">
                    {uncategorizedDocs.map(doc => {
                      const needsRetry = doc.chunk_count > 0 && doc.embedded_count === 0;
                      const isProcessing = doc.chunk_count === 0;
                      const notReady = isProcessing || needsRetry;
                      const badgeClass = notReady ? "doc-badge--processing" : doc.is_active ? "doc-badge--active" : "doc-badge--inactive";
                      const badgeLabel = isProcessing ? "processing…" : needsRetry ? "retry" : doc.is_active ? "attached" : "detached";
                      return (
                        <div key={doc.id} className="doc-item">
                          <div className="doc-item-info">
                            <button className="doc-item-name-btn" onClick={() => openPreview(doc)} title={doc.filename}>
                              📄 {doc.filename}
                            </button>
                            <span className={`doc-badge ${badgeClass}`}>{badgeLabel}</span>
                          </div>
                          <div className="doc-item-actions">
                            {notReady ? (
                              <button className="doc-retry-btn" onClick={() => reprocessDocument(doc.id)}>↻</button>
                            ) : (
                              <button className="doc-toggle-btn" onClick={() => toggleDocument(doc.id)} title={doc.is_active ? "Detach" : "Attach"}>
                                {doc.is_active ? "⏸" : "▶"}
                              </button>
                            )}
                            <button className="doc-delete-btn-sm" onClick={() => deleteDocument(doc.id)}>🗑</button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Hidden personal file input */}
        <input
          ref={docFileInputRef}
          type="file"
          multiple
          accept=".pdf,.docx,.txt,.md"
          hidden
          onChange={e => {
            if (uploadFolderIdRef.current !== null) {
              uploadToFolder(e.target.files, uploadFolderIdRef.current);
            }
          }}
        />

        {/* ── Shared Documents section ── */}
        <div className="shared-section-header">
          <span className="doc-panel-title">🌐 Shared Documents</span>
          {isAdmin && (
            <button
              className="doc-upload-btn"
              onClick={() => { setCreatingSharedFolder(true); setNewSharedFolderName(""); setNewSharedFolderDept(""); }}
            >
              + New Folder
            </button>
          )}
        </div>

        {!isAdmin && !department && (
          <div className="doc-empty">No department assigned.<br />Ask your admin to assign your department.</div>
        )}

        {/* New shared folder inline form */}
        {isAdmin && creatingSharedFolder && (
          <div className="doc-folder-create doc-folder-create--shared">
            <input
              className="doc-folder-create-input"
              autoFocus
              placeholder="Folder name…"
              value={newSharedFolderName}
              onChange={e => setNewSharedFolderName(e.target.value)}
              onKeyDown={e => {
                if (e.key === "Escape") { setCreatingSharedFolder(false); }
              }}
            />
            <input
              className="doc-folder-create-input"
              placeholder="Department (e.g. Engineering)"
              value={newSharedFolderDept}
              onChange={e => setNewSharedFolderDept(e.target.value)}
              onKeyDown={e => {
                if (e.key === "Enter" && newSharedFolderName.trim() && newSharedFolderDept.trim())
                  createSharedFolder(newSharedFolderName.trim(), newSharedFolderDept.trim());
                if (e.key === "Escape") { setCreatingSharedFolder(false); }
              }}
            />
            <button
              className="doc-folder-create-btn"
              onClick={() => createSharedFolder(newSharedFolderName.trim(), newSharedFolderDept.trim())}
              disabled={!newSharedFolderName.trim() || !newSharedFolderDept.trim()}
            >
              Create
            </button>
            <button
              className="doc-folder-create-cancel"
              onClick={() => setCreatingSharedFolder(false)}
            >
              ✕
            </button>
          </div>
        )}

        {/* Shared folder list */}
        {sharedFolders.length === 0 && !creatingSharedFolder ? (
          (isAdmin || department) && (
            <div className="doc-empty">
              {isAdmin ? "No shared folders yet." : "No shared documents for your department."}
            </div>
          )
        ) : (
          <div className="doc-folder-list">
            {sharedFolders.map(folder => {
              const folderDocs = sharedDocs.filter(d => d.folder_id === folder.id);
              const isExpanded = expandedSharedFolders.has(folder.id);
              const isRenaming = renamingSharedFolderId === folder.id;
              const isUploading = uploadingSharedFolderId === folder.id;
              const isProcessingAny = folderDocs.some(d => d.chunk_count === 0);

              return (
                <div key={folder.id} className="doc-folder">
                  <div className="doc-folder-hdr">
                    <button
                      className="doc-folder-chevron"
                      onClick={() => toggleExpandSharedFolder(folder.id)}
                    >
                      {isExpanded ? "▼" : "▶"}
                    </button>

                    {isRenaming && isAdmin ? (
                      <input
                        className="doc-folder-rename-input"
                        autoFocus
                        value={renamingSharedFolderName}
                        onChange={e => setRenamingSharedFolderName(e.target.value)}
                        onKeyDown={e => {
                          if (e.key === "Enter") renameSharedFolder(folder.id, renamingSharedFolderName);
                          if (e.key === "Escape") setRenamingSharedFolderId(null);
                        }}
                        onBlur={() => renameSharedFolder(folder.id, renamingSharedFolderName)}
                      />
                    ) : (
                      <span
                        className="doc-folder-name"
                        title={folder.name}
                        onDoubleClick={() => {
                          if (isAdmin) {
                            setRenamingSharedFolderId(folder.id);
                            setRenamingSharedFolderName(folder.name);
                          }
                        }}
                      >
                        {folder.name}
                      </span>
                    )}

                    <span className="doc-badge doc-badge--dept">{folder.department}</span>
                    <span className="doc-folder-count">({folderDocs.length})</span>

                    {isAdmin && (
                      <div className="doc-folder-actions">
                        <button
                          className="doc-folder-btn"
                          onClick={() => {
                            setRenamingSharedFolderId(folder.id);
                            setRenamingSharedFolderName(folder.name);
                          }}
                          title="Rename folder"
                        >
                          ✏
                        </button>
                        <button
                          className="doc-folder-btn doc-folder-btn--danger"
                          onClick={() => deleteSharedFolder(folder.id)}
                          title="Delete folder"
                        >
                          🗑
                        </button>
                      </div>
                    )}
                  </div>

                  {isExpanded && (
                    <div className="doc-folder-body">
                      {isAdmin && (
                        <button
                          className="doc-add-files-btn"
                          disabled={isUploading}
                          onClick={() => {
                            uploadSharedFolderIdRef.current = folder.id;
                            if (sharedDocFileInputRef.current) {
                              sharedDocFileInputRef.current.value = "";
                              sharedDocFileInputRef.current.click();
                            }
                          }}
                        >
                          {isUploading ? "Uploading…" : "+ Add Files"}
                        </button>
                      )}

                      {(isUploading || isProcessingAny) && (
                        <div className="doc-uploading-row">
                          <span className="doc-uploading-spinner" />
                          {isUploading ? "Uploading files…" : "Processing files…"}
                        </div>
                      )}

                      {folderDocs.length === 0 && !isUploading ? (
                        <div className="doc-folder-empty">No files yet.</div>
                      ) : (
                        folderDocs.map(doc => renderSharedDocItem(doc))
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* Hidden shared file input */}
        <input
          ref={sharedDocFileInputRef}
          type="file"
          multiple
          accept=".pdf,.docx,.txt,.md"
          hidden
          onChange={e => {
            if (uploadSharedFolderIdRef.current !== null) {
              uploadToSharedFolder(e.target.files, uploadSharedFolderIdRef.current);
            }
          }}
        />

        {/* ── User Management button (admin only) ── */}
        {isAdmin && (
          <div className="user-mgmt-btn-wrap">
            <button
              className="user-mgmt-btn"
              onClick={() => { fetchAdminUsers(); setShowUsersModal(true); }}
            >
              👤 Manage Users
            </button>
          </div>
        )}
      </aside>

      {/* ─── File content preview modal ─── */}
      {previewDoc && (
        <div className="overlay" onClick={() => setPreviewDoc(null)}>
          <div className="modal modal--wide doc-preview-modal" onClick={e => e.stopPropagation()}>
            <div className="modal-hdr">
              <span className="modal-title">
                {previewDoc.isShared ? "🌐" : "📄"} {previewDoc.filename}
              </span>
              <button className="modal-close" onClick={() => setPreviewDoc(null)}>✕</button>
            </div>
            <div className="modal-body doc-preview-body">
              {previewLoading ? (
                <div className="doc-preview-loading">Loading content…</div>
              ) : (
                <>
                  {previewTruncated && (
                    <div className="doc-preview-truncated">
                      ⚠ Showing first 50,000 characters only.
                    </div>
                  )}
                  <pre className="doc-preview-content">{previewContent}</pre>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ─── Help modal ─── */}
      {showHelp && (
        <div className="overlay" onClick={() => setShowHelp(false)}>
          <div className="modal modal--wide" onClick={e => e.stopPropagation()}>
            <div className="modal-hdr">
              <span className="modal-title">❓ Help &amp; Guide</span>
              <button className="modal-close" onClick={() => setShowHelp(false)}>✕</button>
            </div>
            <div className="modal-body help-body">

              <section className="help-section">
                <h3 className="help-h3">💬 Chat Modes</h3>
                <p>Use the four modules to focus the AI on your task:</p>
                <ul className="help-list">
                  <li><strong>Data Query</strong> — describe what data you need; the AI guides you through querying internal databases in plain language.</li>
                  <li><strong>Document Q&amp;A</strong> — ask questions about uploaded documents. The AI searches your files and shared department documents, then answers with cited sources.</li>
                  <li><strong>Resume Screening</strong> — define criteria or upload job descriptions and let the AI evaluate candidates.</li>
                  <li><strong>General Chat</strong> — ask anything: technology trends, how things work, coding help, general knowledge.</li>
                </ul>
                <p>No module selected = General Chat by default.</p>
              </section>

              <section className="help-section">
                <h3 className="help-h3">📁 My Documents</h3>
                <p>Upload your own private files (PDF, DOCX, TXT, MD — up to 0.5 GB total).</p>
                <ul className="help-list">
                  <li><strong>Create folder</strong> — click <em>+ New Folder</em> in the right panel, type a name, press Enter.</li>
                  <li><strong>Rename folder</strong> — double-click the folder name, or hover and click the ✏ button.</li>
                  <li><strong>Upload files</strong> — expand a folder, click <em>+ Add Files</em>, pick files. The panel shows <em>Uploading files…</em> then <em>Processing files…</em> while the AI embeds the content.</li>
                  <li><strong>Preview file</strong> — click the filename to open a content preview (up to 50,000 characters).</li>
                  <li><strong>Attach / Detach</strong> — ⏸ detaches the file so it is ignored by the AI; ▶ re-attaches it. Use the folder-level buttons to toggle all files at once.</li>
                  <li><strong>Delete file / folder</strong> — click 🗑. Deleting a folder removes all files inside permanently.</li>
                </ul>
              </section>

              <section className="help-section">
                <h3 className="help-h3">🌐 Shared Documents</h3>
                <p>Admin-created folders visible to specific departments. Once your admin assigns your department, you automatically see the relevant shared folders.</p>
                <ul className="help-list">
                  <li><strong>Preview</strong> — click any filename to read the file content.</li>
                  <li><strong>Attach / Detach toggle</strong> — ⏸ detaches a shared file from <em>your own</em> AI responses without affecting other users; ▶ re-attaches it.</li>
                  <li>Shared files are automatically included in Document Q&amp;A RAG alongside your personal files.</li>
                </ul>
              </section>

              <section className="help-section">
                <h3 className="help-h3">🤖 RAG — AI Document Answering</h3>
                <p>When you ask a question, the AI searches attached documents (personal + shared) for relevant passages, then uses them to build its answer. Cited sources appear below each AI response — click <em>▼ Show</em> to expand excerpts. A 🌐 badge marks sources from shared documents.</p>
                <p>Detach a document to exclude it from all future queries (your setting only).</p>
              </section>

              <section className="help-section">
                <h3 className="help-h3">🗂 Chat Sessions</h3>
                <ul className="help-list">
                  <li><strong>New chat</strong> — click ✏ in the top-left of the sidebar.</li>
                  <li><strong>Restore session</strong> — click any session in the History list to reload the full conversation.</li>
                  <li><strong>Delete session</strong> — hover a session and click 🗑. This permanently removes the conversation.</li>
                </ul>
              </section>

              <section className="help-section">
                <h3 className="help-h3">🛠 Admin Capabilities</h3>
                <p>Admins see extra controls in the Shared Documents panel and a User Management section below it.</p>
                <ul className="help-list">
                  <li><strong>Assign departments</strong> — click the <em>👤 Manage Users</em> button at the bottom of the right panel. In the popup, click a department cell to edit, press Enter or click away to save. Users with no department see no shared documents.</li>
                  <li><strong>Create shared folder</strong> — click <em>+ New Folder</em> in the Shared Documents section, provide a folder name and the department name that should have access.</li>
                  <li><strong>Upload to shared folder</strong> — expand the folder, click <em>+ Add Files</em>.</li>
                  <li><strong>👁 Visibility toggle</strong> — hide or show a shared file from all department users.</li>
                  <li><strong>⏸ Detach / ▶ Attach</strong> — detach or re-attach a shared file for your own AI responses (does not affect other users).</li>
                  <li><strong>Manage bug reports</strong> — mark reports Open / Resolved or delete them in the All Reports tab.</li>
                </ul>
              </section>

              <section className="help-section">
                <h3 className="help-h3">⚙️ Settings</h3>
                <ul className="help-list">
                  <li><strong>Theme</strong> — toggle between dark and light mode.</li>
                  <li><strong>AI Response Quality</strong> — Fast (Haiku) for quick answers, Smart (Sonnet) for most tasks, Expert (Opus) for deep analysis.</li>
                </ul>
              </section>

              <section className="help-section">
                <h3 className="help-h3">🐛 Report a Bug</h3>
                <p>Click <em>Report Bug</em> in the sidebar footer. Describe the issue and optionally attach a screenshot. All reports are visible to admins in the All Reports tab.</p>
              </section>

            </div>
          </div>
        </div>
      )}

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

      {/* ─── Bug / Admin modal ─── */}
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
              ) : bugView === "list" ? (
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
              ) : null}
            </div>
          </div>
        </div>
      )}

      {/* ─── User Management modal (admin only) ─── */}
      {showUsersModal && (
        <div className="overlay" onClick={() => setShowUsersModal(false)}>
          <div className="modal modal--wide" onClick={e => e.stopPropagation()}>
            <div className="modal-hdr">
              <span className="modal-title">👤 User Management</span>
              <button className="modal-close" onClick={() => setShowUsersModal(false)}>✕</button>
            </div>
            <div className="modal-body">
              <div className="admin-users-tab">
                <p className="admin-users-hint">
                  Click a department cell to edit. Press Enter or click away to save.
                  Leave blank to clear the department.
                </p>
                {adminUsers.length === 0 ? (
                  <div className="bug-empty">No users found.</div>
                ) : (
                  <table className="admin-users-table">
                    <thead>
                      <tr>
                        <th>Email</th>
                        <th>Department</th>
                        <th>Joined</th>
                      </tr>
                    </thead>
                    <tbody>
                      {adminUsers.map(u => (
                        <tr key={u.email}>
                          <td className="admin-users-email">{u.email}</td>
                          <td>
                            {editingUserEmail === u.email ? (
                              <input
                                className="user-dept-input"
                                autoFocus
                                value={editingDeptValue}
                                onChange={e => setEditingDeptValue(e.target.value)}
                                onKeyDown={e => {
                                  if (e.key === "Enter") saveUserDepartment(u.email, editingDeptValue);
                                  if (e.key === "Escape") setEditingUserEmail(null);
                                }}
                                onBlur={() => saveUserDepartment(u.email, editingDeptValue)}
                              />
                            ) : (
                              <span
                                className={`user-dept-cell ${u.department ? "user-dept-cell--set" : "user-dept-cell--empty"}`}
                                onClick={() => {
                                  setEditingUserEmail(u.email);
                                  setEditingDeptValue(u.department || "");
                                }}
                                title="Click to edit"
                              >
                                {u.department || "— click to assign —"}
                              </span>
                            )}
                          </td>
                          <td className="admin-users-date">
                            {new Date(u.created_at).toLocaleDateString()}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Contributor badge */}
      <div className="contributor-badge">Built by Charles &amp; Kian Yu</div>
    </div>
  );
}
