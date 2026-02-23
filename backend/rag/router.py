"""
RAG — Document management router
Endpoints (in match-order — static paths before parameterised):
  GET    /api/documents/debug-embed              — Gemini API diagnostic
  GET    /api/documents/storage                  — storage quota usage
  POST   /api/documents/folders                  — create folder
  GET    /api/documents/folders                  — list folders
  PATCH  /api/documents/folders/{id}/rename      — rename folder
  PATCH  /api/documents/folders/{id}/toggle      — bulk activate/deactivate
  DELETE /api/documents/folders/{id}             — delete folder + all docs
  POST   /api/documents/                         — upload files (requires folder_id)
  GET    /api/documents/                         — list docs (flat, includes folder_id)
  GET    /api/documents/{doc_id}/content         — get parsed text of a doc
  DELETE /api/documents/{doc_id}                 — delete doc + chunks + storage
  POST   /api/documents/{doc_id}/reprocess       — retry failed embedding
  PATCH  /api/documents/{doc_id}/toggle          — toggle is_active
"""

import os
import uuid

import httpx
from fastapi import APIRouter, BackgroundTasks, Body, Depends, File, Form, HTTPException, UploadFile
from sqlalchemy import delete, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from auth import get_current_user
from database import get_db
from models import Document, DocumentChunk, DocumentFolder

from . import ingestion as rag_ingestion
from . import storage as rag_storage

router = APIRouter(prefix="/api/documents", tags=["documents"])

ALLOWED_EXTENSIONS = {".pdf", ".docx", ".doc", ".txt", ".md"}
STORAGE_LIMIT_BYTES = 512 * 1024 * 1024  # 0.5 GB


# ── Diagnostic ────────────────────────────────────────────────────────────────

@router.get("/debug-embed")
async def debug_embed(user: str = Depends(get_current_user)):
    """Test whether the GOOGLE_API_KEY can reach the Gemini embedding API."""
    api_key = os.getenv("GOOGLE_API_KEY", "")
    if not api_key:
        return {"error": "GOOGLE_API_KEY is not set in .env"}

    try:
        with httpx.Client(timeout=10.0) as client:
            r = client.get(
                f"https://generativelanguage.googleapis.com/v1beta/models?key={api_key}"
            )
            data = r.json()
    except Exception as e:
        return {"error": f"Network error: {e}"}

    if "error" in data:
        return {"api_error": data["error"]}

    all_models = data.get("models", [])
    embed_models = [
        {"name": m["name"], "displayName": m.get("displayName", "")}
        for m in all_models
        if "embedContent" in m.get("supportedGenerationMethods", [])
    ]
    return {
        "total_models_visible": len(all_models),
        "embedding_models": embed_models,
    }


# ── Storage quota ─────────────────────────────────────────────────────────────

@router.get("/storage")
async def get_storage(
    user: str = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Return how many bytes the user has used out of the 0.5 GB limit."""
    result = await db.execute(
        select(func.coalesce(func.sum(Document.file_size), 0))
        .where(Document.user_email == user)
    )
    used = int(result.scalar() or 0)
    return {"used_bytes": used, "limit_bytes": STORAGE_LIMIT_BYTES}


# ── Folders ───────────────────────────────────────────────────────────────────

@router.post("/folders")
async def create_folder(
    name: str = Body(..., embed=True),
    user: str = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Create a new empty folder."""
    folder = DocumentFolder(user_email=user, name=name.strip())
    db.add(folder)
    await db.commit()
    await db.refresh(folder)
    return {
        "id": folder.id,
        "name": folder.name,
        "created_at": folder.created_at.isoformat(),
        "doc_count": 0,
        "total_size": 0,
    }


@router.get("/folders")
async def list_folders(
    user: str = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """List all folders with doc count and total size."""
    result = await db.execute(
        select(DocumentFolder)
        .where(DocumentFolder.user_email == user)
        .order_by(DocumentFolder.created_at.asc())
    )
    folders = result.scalars().all()

    out = []
    for f in folders:
        agg = await db.execute(
            select(
                func.count(Document.id),
                func.coalesce(func.sum(Document.file_size), 0),
            ).where(Document.folder_id == f.id)
        )
        doc_count, total_size = agg.one()
        out.append({
            "id": f.id,
            "name": f.name,
            "created_at": f.created_at.isoformat(),
            "doc_count": doc_count,
            "total_size": int(total_size),
        })
    return out


@router.patch("/folders/{folder_id}/rename")
async def rename_folder(
    folder_id: int,
    name: str = Body(..., embed=True),
    user: str = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(DocumentFolder).where(
            DocumentFolder.id == folder_id,
            DocumentFolder.user_email == user,
        )
    )
    folder = result.scalar_one_or_none()
    if not folder:
        raise HTTPException(status_code=404, detail="Folder not found")
    folder.name = name.strip()
    await db.commit()
    return {"id": folder.id, "name": folder.name}


@router.patch("/folders/{folder_id}/toggle")
async def toggle_folder_docs(
    folder_id: int,
    active: bool = Body(..., embed=True),
    user: str = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Activate or deactivate all documents inside a folder at once."""
    result = await db.execute(
        select(DocumentFolder).where(
            DocumentFolder.id == folder_id,
            DocumentFolder.user_email == user,
        )
    )
    if not result.scalar_one_or_none():
        raise HTTPException(status_code=404, detail="Folder not found")

    await db.execute(
        update(Document)
        .where(Document.folder_id == folder_id)
        .values(is_active=active)
    )
    await db.commit()
    return {"message": "Updated"}


@router.delete("/folders/{folder_id}")
async def delete_folder(
    folder_id: int,
    user: str = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Delete a folder and all its documents (storage + DB cascade)."""
    result = await db.execute(
        select(DocumentFolder).where(
            DocumentFolder.id == folder_id,
            DocumentFolder.user_email == user,
        )
    )
    folder = result.scalar_one_or_none()
    if not folder:
        raise HTTPException(status_code=404, detail="Folder not found")

    # Delete raw storage files before removing DB rows
    docs_result = await db.execute(
        select(Document).where(Document.folder_id == folder_id)
    )
    for doc in docs_result.scalars().all():
        try:
            rag_storage.delete_file(doc.storage_path)
        except Exception:
            pass  # Don't fail if storage delete errors

    # Delete folder — ON DELETE CASCADE removes documents → chunks
    await db.delete(folder)
    await db.commit()
    return {"message": "Folder deleted"}


# ── Upload ────────────────────────────────────────────────────────────────────

@router.post("/")
async def upload_documents(
    background_tasks: BackgroundTasks,
    files: list[UploadFile] = File(...),
    folder_id: int = Form(...),
    user: str = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Upload one or more files into a folder; triggers async ingestion."""
    if not os.getenv("SUPABASE_URL") or not os.getenv("SUPABASE_SERVICE_KEY"):
        raise HTTPException(
            status_code=503,
            detail="SUPABASE_URL and SUPABASE_SERVICE_KEY are not configured in .env",
        )

    # Verify the folder belongs to this user
    folder_result = await db.execute(
        select(DocumentFolder).where(
            DocumentFolder.id == folder_id,
            DocumentFolder.user_email == user,
        )
    )
    if not folder_result.scalar_one_or_none():
        raise HTTPException(status_code=400, detail="Invalid folder")

    # Current storage usage
    usage_result = await db.execute(
        select(func.coalesce(func.sum(Document.file_size), 0))
        .where(Document.user_email == user)
    )
    current_usage = int(usage_result.scalar() or 0)

    created = []
    for file in files:
        filename = file.filename or "unnamed"
        ext = os.path.splitext(filename)[1].lower()
        if ext not in ALLOWED_EXTENSIONS:
            continue  # Skip unsupported types silently

        file_bytes = await file.read()
        file_size = len(file_bytes)

        if current_usage + file_size > STORAGE_LIMIT_BYTES:
            raise HTTPException(
                status_code=413,
                detail="Storage limit exceeded (max 0.5 GB per user)",
            )

        mime = file.content_type or "text/plain"
        storage_path = f"{user}/{uuid.uuid4().hex}_{filename}"

        try:
            rag_storage.upload_file(storage_path, file_bytes, mime)
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Storage upload failed: {e}")

        doc = Document(
            user_email=user,
            original_filename=filename,
            storage_path=storage_path,
            file_size=file_size,
            mime_type=mime,
            folder_id=folder_id,
        )
        db.add(doc)
        await db.flush()
        await db.commit()

        current_usage += file_size
        created.append({"id": doc.id, "filename": filename, "status": "processing"})

        background_tasks.add_task(
            rag_ingestion.ingest_document, doc.id, storage_path, mime
        )

    return created


# ── List documents (flat) ─────────────────────────────────────────────────────

@router.get("/")
async def list_documents(
    user: str = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """List all documents for the current user, including embedded chunk count and folder_id."""
    result = await db.execute(
        select(
            Document,
            func.count(DocumentChunk.id)
            .filter(DocumentChunk.embedding.isnot(None))
            .label("embedded_count"),
        )
        .outerjoin(DocumentChunk, DocumentChunk.document_id == Document.id)
        .where(Document.user_email == user)
        .group_by(Document.id)
        .order_by(Document.created_at.desc())
    )
    rows = result.all()
    return [
        {
            "id": d.id,
            "filename": d.original_filename,
            "is_active": d.is_active,
            "chunk_count": d.chunk_count,
            "embedded_count": embedded_count,
            "file_size": d.file_size,
            "created_at": d.created_at.isoformat(),
            "folder_id": d.folder_id,
        }
        for d, embedded_count in rows
    ]


# ── Document content preview ──────────────────────────────────────────────────

@router.get("/{doc_id}/content")
async def get_document_content(
    doc_id: int,
    user: str = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Download and parse a document, returning its text (up to 50 000 chars)."""
    result = await db.execute(
        select(Document).where(Document.id == doc_id, Document.user_email == user)
    )
    doc = result.scalar_one_or_none()
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")

    try:
        file_bytes = rag_storage.download_file(doc.storage_path)
        text = rag_ingestion._parse_text(file_bytes, doc.mime_type or "text/plain")
        truncated = len(text) > 50_000
        return {
            "content": text[:50_000],
            "truncated": truncated,
            "filename": doc.original_filename,
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ── Delete / reprocess / toggle individual doc ────────────────────────────────

@router.delete("/{doc_id}")
async def delete_document(
    doc_id: int,
    user: str = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(Document).where(Document.id == doc_id, Document.user_email == user)
    )
    doc = result.scalar_one_or_none()
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")

    try:
        rag_storage.delete_file(doc.storage_path)
    except Exception:
        pass

    await db.delete(doc)
    await db.commit()
    return {"message": "Document deleted"}


@router.post("/{doc_id}/reprocess", status_code=202)
async def reprocess_document(
    doc_id: int,
    background_tasks: BackgroundTasks,
    user: str = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(Document).where(Document.id == doc_id, Document.user_email == user)
    )
    doc = result.scalar_one_or_none()
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")

    await db.execute(delete(DocumentChunk).where(DocumentChunk.document_id == doc_id))
    doc.chunk_count = 0
    await db.commit()

    background_tasks.add_task(
        rag_ingestion.ingest_document, doc.id, doc.storage_path, doc.mime_type
    )
    return {"message": "Reprocessing started"}


@router.patch("/{doc_id}/toggle")
async def toggle_document(
    doc_id: int,
    user: str = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(Document).where(Document.id == doc_id, Document.user_email == user)
    )
    doc = result.scalar_one_or_none()
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")

    doc.is_active = not doc.is_active
    await db.commit()
    return {"id": doc.id, "is_active": doc.is_active}
