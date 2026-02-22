"""
RAG — Document management router
All /api/documents/* endpoints:
  POST   /api/documents/          — upload one or more files
  GET    /api/documents/          — list user's documents
  DELETE /api/documents/{doc_id}  — delete document + chunks + storage file
  PATCH  /api/documents/{doc_id}/toggle — toggle is_active
"""

import os
import uuid

import httpx
from fastapi import APIRouter, BackgroundTasks, Depends, File, HTTPException, UploadFile
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from auth import get_current_user
from database import get_db
from models import Document, DocumentChunk

from . import ingestion as rag_ingestion
from . import storage as rag_storage

router = APIRouter(prefix="/api/documents", tags=["documents"])

ALLOWED_EXTENSIONS = {".pdf", ".docx", ".doc", ".txt", ".md"}


@router.get("/debug-embed")
async def debug_embed(user: str = Depends(get_current_user)):
    """
    Diagnostic: test whether the GOOGLE_API_KEY can reach the Gemini embedding API.
    Returns a list of accessible embedding models and any error details.
    """
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


@router.post("/")
async def upload_documents(
    background_tasks: BackgroundTasks,
    files: list[UploadFile] = File(...),
    user: str = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Upload one or more files; triggers async ingestion for each."""
    if not os.getenv("SUPABASE_URL") or not os.getenv("SUPABASE_SERVICE_KEY"):
        raise HTTPException(
            status_code=503,
            detail="SUPABASE_URL and SUPABASE_SERVICE_KEY are not configured in .env",
        )

    created = []
    for file in files:
        filename = file.filename or "unnamed"
        ext = os.path.splitext(filename)[1].lower()
        if ext not in ALLOWED_EXTENSIONS:
            continue  # Skip unsupported types silently

        file_bytes = await file.read()
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
            file_size=len(file_bytes),
            mime_type=mime,
        )
        db.add(doc)
        await db.flush()   # populate doc.id
        await db.commit()

        created.append({
            "id": doc.id,
            "filename": filename,
            "status": "processing",
        })

        # Kick off chunking + embedding in the background
        background_tasks.add_task(
            rag_ingestion.ingest_document, doc.id, storage_path, mime
        )

    return created


@router.get("/")
async def list_documents(
    user: str = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """List all documents for the current user, including embedded chunk count."""
    result = await db.execute(
        select(
            Document,
            func.count(DocumentChunk.id).filter(DocumentChunk.embedding.isnot(None)).label("embedded_count"),
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
        }
        for d, embedded_count in rows
    ]


@router.delete("/{doc_id}")
async def delete_document(
    doc_id: int,
    user: str = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Delete a document, its chunks (cascade), and the raw file in storage."""
    result = await db.execute(
        select(Document).where(Document.id == doc_id, Document.user_email == user)
    )
    doc = result.scalar_one_or_none()
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")

    try:
        rag_storage.delete_file(doc.storage_path)
    except Exception:
        pass  # Don't fail if storage delete errors

    await db.delete(doc)   # DocumentChunk rows cascade via FK ondelete="CASCADE"
    await db.commit()
    return {"message": "Document deleted"}


@router.post("/{doc_id}/reprocess", status_code=202)
async def reprocess_document(
    doc_id: int,
    background_tasks: BackgroundTasks,
    user: str = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Delete existing chunks and re-run embedding in the background."""
    result = await db.execute(
        select(Document).where(Document.id == doc_id, Document.user_email == user)
    )
    doc = result.scalar_one_or_none()
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")

    # Clear out stale (un-embedded) chunks and reset counter
    await db.execute(delete(DocumentChunk).where(DocumentChunk.document_id == doc_id))
    doc.chunk_count = 0
    await db.commit()

    background_tasks.add_task(rag_ingestion.ingest_document, doc.id, doc.storage_path, doc.mime_type)
    return {"message": "Reprocessing started"}


@router.patch("/{doc_id}/toggle")
async def toggle_document(
    doc_id: int,
    user: str = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Toggle a document's active status (active ↔ paused)."""
    result = await db.execute(
        select(Document).where(Document.id == doc_id, Document.user_email == user)
    )
    doc = result.scalar_one_or_none()
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")

    doc.is_active = not doc.is_active
    await db.commit()
    return {"id": doc.id, "is_active": doc.is_active}
