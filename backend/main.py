import json
import os
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from typing import Optional

import anthropic as anthropic_sdk
import bcrypt
import jwt
from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from database import AsyncSessionLocal, Base, engine, get_db
from models import BugReport, ChatMessage, ChatSession, User

SECRET_KEY = "dev-secret-key-change-in-production"
ALGORITHM = "HS256"
TOKEN_EXPIRE_HOURS = 24

UPLOAD_DIR = "uploads"
os.makedirs(UPLOAD_DIR, exist_ok=True)

ADMIN_EMAILS: set[str] = {"kianyugan@gmail.com"}

ALLOWED_MODELS = {
    "claude-haiku-4-5-20251001",
    "claude-sonnet-4-6",
    "claude-opus-4-6",
}


# ── Helpers ──────────────────────────────────────────────────────────────────

def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()


def verify_password(password: str, hashed: str) -> bool:
    return bcrypt.checkpw(password.encode(), hashed.encode())


# ── Startup ───────────────────────────────────────────────────────────────────

SEED_USERS = {
    "kianyugan@gmail.com": "kianyugan",
    "kianyoou@gmail.com": "kianyoou",
}


@asynccontextmanager
async def lifespan(app: FastAPI):
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    async with AsyncSessionLocal() as session:
        for email, password in SEED_USERS.items():
            result = await session.execute(select(User).where(User.email == email))
            if result.scalar_one_or_none() is None:
                session.add(User(email=email, password_hash=hash_password(password)))
        await session.commit()

    yield


app = FastAPI(lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── Auth ─────────────────────────────────────────────────────────────────────

class LoginRequest(BaseModel):
    email: str
    password: str


class RegisterRequest(BaseModel):
    email: str
    password: str


def create_token(email: str) -> str:
    payload = {
        "sub": email,
        "exp": datetime.now(timezone.utc) + timedelta(hours=TOKEN_EXPIRE_HOURS),
    }
    return jwt.encode(payload, SECRET_KEY, algorithm=ALGORITHM)


def get_current_user(authorization: Optional[str] = Header(None)) -> str:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Not authenticated")
    token = authorization.split(" ", 1)[1]
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        return payload["sub"]
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Token expired")
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=401, detail="Invalid token")


@app.post("/api/login")
async def login(data: LoginRequest, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(User).where(User.email == data.email))
    user = result.scalar_one_or_none()
    if user is None or not verify_password(data.password, user.password_hash):
        raise HTTPException(status_code=401, detail="Invalid credentials")
    return {"access_token": create_token(user.email), "token_type": "bearer"}


@app.post("/api/register")
async def register(data: RegisterRequest, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(User).where(User.email == data.email))
    if result.scalar_one_or_none() is not None:
        raise HTTPException(status_code=409, detail="Email already registered")
    user = User(email=data.email, password_hash=hash_password(data.password))
    db.add(user)
    await db.commit()
    return {"access_token": create_token(user.email), "token_type": "bearer"}


@app.get("/api/me")
async def get_me(user: str = Depends(get_current_user)):
    return {"email": user, "is_admin": user in ADMIN_EMAILS}


# ── Chat (streaming SSE) ──────────────────────────────────────────────────────

MODULE_PROMPTS: dict[str, str] = {
    "data-query": (
        "You are an AI data analyst assistant for an enterprise platform. "
        "Help the user query internal databases using natural language. "
        "Guide them in describing their data needs, suggest what queries they might run, "
        "and explain how results would be visualised. "
        "Database connections are configured by the administrator separately."
    ),
    "doc-qa": (
        "You are an AI document assistant for an enterprise platform. "
        "Help the user ask questions about their internal documents and knowledge base. "
        "Guide them in framing precise questions and assist with document analysis. "
        "Document uploads and embedding are handled through the platform."
    ),
    "resume": (
        "You are an HR AI assistant specialising in resume screening and candidate evaluation. "
        "Help the user define screening criteria, create scoring rubrics, evaluate candidate qualifications, "
        "and provide structured evaluation frameworks. "
        "Resume uploads and parsing are processed through the platform."
    ),
}

BASE_SYSTEM_PROMPT = (
    "You are a helpful enterprise AI assistant. You assist users with data analysis, "
    "internal document question-answering, and HR tasks. Be professional, concise, and accurate."
)


class MessageInput(BaseModel):
    role: str
    content: str


class ChatRequest(BaseModel):
    message: str
    history: list[MessageInput] = []
    module: Optional[str] = None
    session_id: Optional[int] = None
    model: Optional[str] = None


@app.post("/api/chat/stream")
async def chat_stream(
    data: ChatRequest,
    user: str = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    api_key = os.getenv("ANTHROPIC_API_KEY")
    if not api_key:
        raise HTTPException(
            status_code=503,
            detail="ANTHROPIC_API_KEY is not configured. Add it to backend/.env and restart.",
        )

    system = MODULE_PROMPTS.get(data.module or "", BASE_SYSTEM_PROMPT)
    model = data.model if data.model in ALLOWED_MODELS else "claude-haiku-4-5-20251001"

    api_messages = [{"role": m.role, "content": m.content} for m in data.history]
    api_messages.append({"role": "user", "content": data.message})

    # Create or retrieve session — commit before starting the stream
    if data.session_id:
        result = await db.execute(
            select(ChatSession).where(
                ChatSession.id == data.session_id,
                ChatSession.user_email == user,
            )
        )
        session = result.scalar_one_or_none()
        if not session:
            raise HTTPException(status_code=404, detail="Session not found")
    else:
        title = data.message[:60] + ("…" if len(data.message) > 60 else "")
        session = ChatSession(user_email=user, title=title)
        db.add(session)
        await db.flush()  # populate session.id

    session.updated_at = datetime.now(timezone.utc)
    db.add(ChatMessage(session_id=session.id, role="user", content=data.message))
    await db.commit()

    session_id = session.id
    session_title = session.title

    async def event_stream():
        # Send session info as first event
        yield f"data: {json.dumps({'type': 'session', 'session_id': session_id, 'title': session_title})}\n\n"

        full_response = ""
        client = anthropic_sdk.AsyncAnthropic(api_key=api_key)
        try:
            async with client.messages.stream(
                model=model,
                max_tokens=1024,
                system=system,
                messages=api_messages,
            ) as stream:
                async for text in stream.text_stream:
                    full_response += text
                    yield f"data: {json.dumps({'type': 'text', 'text': text})}\n\n"
        except Exception as e:
            yield f"data: {json.dumps({'type': 'error', 'message': str(e)})}\n\n"

        # Persist assistant response in a fresh session
        if full_response:
            async with AsyncSessionLocal() as save_db:
                save_db.add(ChatMessage(session_id=session_id, role="assistant", content=full_response))
                await save_db.commit()

        yield "data: [DONE]\n\n"

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# ── Chat Sessions ─────────────────────────────────────────────────────────────

@app.get("/api/sessions")
async def list_sessions(
    user: str = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(ChatSession)
        .where(ChatSession.user_email == user)
        .order_by(ChatSession.updated_at.desc())
    )
    sessions = result.scalars().all()
    return [
        {"id": s.id, "title": s.title, "updated_at": s.updated_at.isoformat()}
        for s in sessions
    ]


@app.get("/api/sessions/{session_id}/messages")
async def get_session_messages(
    session_id: int,
    user: str = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(ChatSession).where(ChatSession.id == session_id, ChatSession.user_email == user)
    )
    if result.scalar_one_or_none() is None:
        raise HTTPException(status_code=404, detail="Session not found")

    msgs = await db.execute(
        select(ChatMessage)
        .where(ChatMessage.session_id == session_id)
        .order_by(ChatMessage.created_at)
    )
    return [
        {"id": m.id, "role": m.role, "content": m.content, "created_at": m.created_at.isoformat()}
        for m in msgs.scalars().all()
    ]


# ── Bug Reports ───────────────────────────────────────────────────────────────

@app.post("/api/bugs")
async def submit_bug(
    description: str = Form(...),
    image: Optional[UploadFile] = File(None),
    user: str = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    image_filename = None
    if image and image.filename:
        ext = image.filename.rsplit(".", 1)[-1].lower()
        safe_name = f"{int(datetime.now().timestamp())}_{user.split('@')[0]}.{ext}"
        contents = await image.read()
        with open(os.path.join(UPLOAD_DIR, safe_name), "wb") as f:
            f.write(contents)
        image_filename = safe_name

    db.add(BugReport(user_email=user, description=description, image_filename=image_filename))
    await db.commit()
    return {"message": "Bug report submitted"}


@app.get("/api/bugs")
async def get_bugs(
    user: str = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(select(BugReport).order_by(BugReport.created_at.desc()))
    return [
        {
            "id": b.id,
            "user_email": b.user_email,
            "description": b.description,
            "image_filename": b.image_filename,
            "status": b.status,
            "created_at": b.created_at.isoformat(),
        }
        for b in result.scalars().all()
    ]


# ── Admin ─────────────────────────────────────────────────────────────────────

class BugStatusUpdate(BaseModel):
    status: str  # "open" | "resolved"


@app.put("/api/admin/bugs/{bug_id}/status")
async def update_bug_status(
    bug_id: int,
    data: BugStatusUpdate,
    user: str = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    if user not in ADMIN_EMAILS:
        raise HTTPException(status_code=403, detail="Admin access required")
    result = await db.execute(select(BugReport).where(BugReport.id == bug_id))
    bug = result.scalar_one_or_none()
    if not bug:
        raise HTTPException(status_code=404, detail="Not found")
    if data.status not in {"open", "resolved"}:
        raise HTTPException(status_code=400, detail="Invalid status")
    bug.status = data.status
    await db.commit()
    return {"message": "Status updated"}


@app.delete("/api/admin/bugs/{bug_id}")
async def delete_bug(
    bug_id: int,
    user: str = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    if user not in ADMIN_EMAILS:
        raise HTTPException(status_code=403, detail="Admin access required")
    result = await db.execute(select(BugReport).where(BugReport.id == bug_id))
    bug = result.scalar_one_or_none()
    if not bug:
        raise HTTPException(status_code=404, detail="Not found")
    # Remove uploaded image if present
    if bug.image_filename:
        image_path = os.path.join(UPLOAD_DIR, bug.image_filename)
        if os.path.exists(image_path):
            os.remove(image_path)
    await db.delete(bug)
    await db.commit()
    return {"message": "Bug report deleted"}


# ── Static files (uploaded screenshots) ──────────────────────────────────────
# Mounted last so it doesn't shadow API routes
app.mount("/uploads", StaticFiles(directory=UPLOAD_DIR), name="uploads")
