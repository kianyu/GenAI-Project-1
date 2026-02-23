"""
Shared Documents router — department-based document sharing.

Endpoints (static paths before parameterised):
  GET    /api/shared-documents/storage              — total shared storage used (admin)
  POST   /api/shared-documents/folders              — create shared folder (admin)
  GET    /api/shared-documents/folders              — list folders (admin: all; user: dept-filtered)
  PATCH  /api/shared-documents/folders/{id}/rename  — rename folder (admin)
  DELETE /api/shared-documents/folders/{id}         — delete folder + docs (admin)
  POST   /api/shared-documents/                     — upload files (admin)
  GET    /api/shared-documents/                     — list docs (admin: all; user: dept-visible)
  GET    /api/shared-documents/{id}/content         — parse & return text
  DELETE /api/shared-documents/{id}                 — delete doc (admin)
  POST   /api/shared-documents/{id}/reprocess       — re-embed (admin)
  PATCH  /api/shared-documents/{id}/toggle-visibility — admin visibility toggle
  PATCH  /api/shared-documents/{id}/toggle-rag      — admin RAG toggle
  PATCH  /api/shared-documents/{id}/toggle-user     — user personal RAG toggle
"""

import os
import uuid

from fastapi import APIRouter, BackgroundTasks, Body, Depends, File, Form, HTTPException, UploadFile
from sqlalchemy import delete, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from auth import get_current_user
from database import get_db
from models import SharedDocument, SharedDocumentChunk, SharedFolder, User, UserSharedDocPref

from . import ingestion as rag_ingestion
from . import storage as rag_storage

router = APIRouter(prefix="/api/shared-documents", tags=["shared-documents"])

ALLOWED_EXTENSIONS = {".pdf", ".docx", ".doc", ".txt", ".md"}
STORAGE_LIMIT_BYTES = 512 * 1024 * 1024  # 0.5 GB shared storage


def _get_admin_emails() -> set[str]:
    return {e.strip() for e in os.getenv("ADMIN_EMAIL", "").split(",") if e.strip()}


def _require_admin(user: str) -> None:
    if user not in _get_admin_emails():
        raise HTTPException(status_code=403, detail="Admin access required")


# ── Storage quota (admin) ─────────────────────────────────────────────────────

@router.get("/storage")
async def get_shared_storage(
    user: str = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    _require_admin(user)
    result = await db.execute(
        select(func.coalesce(func.sum(SharedDocument.file_size), 0))
    )
    used = int(result.scalar() or 0)
    return {"used_bytes": used, "limit_bytes": STORAGE_LIMIT_BYTES}


# ── Folders ───────────────────────────────────────────────────────────────────

@router.post("/folders")
async def create_shared_folder(
    name: str = Body(..., embed=False),
    department: str = Body(..., embed=False),
    user: str = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Admin: create a shared folder visible to a specific department."""
    _require_admin(user)
    folder = SharedFolder(name=name.strip(), department=department.strip())
    db.add(folder)
    await db.commit()
    await db.refresh(folder)
    return {
        "id": folder.id,
        "name": folder.name,
        "department": folder.department,
        "created_at": folder.created_at.isoformat(),
        "doc_count": 0,
        "total_size": 0,
    }


@router.get("/folders")
async def list_shared_folders(
    user: str = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Admin: all folders. User: only folders matching their department."""
    is_admin = user in _get_admin_emails()

    if is_admin:
        result = await db.execute(
            select(SharedFolder).order_by(SharedFolder.created_at.asc())
        )
    else:
        user_result = await db.execute(select(User).where(User.email == user))
        user_row = user_result.scalar_one_or_none()
        dept = user_row.department if user_row else None
        if not dept:
            return []
        result = await db.execute(
            select(SharedFolder)
            .where(SharedFolder.department == dept)
            .order_by(SharedFolder.created_at.asc())
        )

    folders = result.scalars().all()
    out = []
    for f in folders:
        agg = await db.execute(
            select(
                func.count(SharedDocument.id),
                func.coalesce(func.sum(SharedDocument.file_size), 0),
            ).where(SharedDocument.folder_id == f.id)
        )
        doc_count, total_size = agg.one()
        out.append({
            "id": f.id,
            "name": f.name,
            "department": f.department,
            "created_at": f.created_at.isoformat(),
            "doc_count": doc_count,
            "total_size": int(total_size),
        })
    return out


@router.patch("/folders/{folder_id}/rename")
async def rename_shared_folder(
    folder_id: int,
    name: str = Body(..., embed=True),
    user: str = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    _require_admin(user)
    result = await db.execute(select(SharedFolder).where(SharedFolder.id == folder_id))
    folder = result.scalar_one_or_none()
    if not folder:
        raise HTTPException(status_code=404, detail="Folder not found")
    folder.name = name.strip()
    await db.commit()
    return {"id": folder.id, "name": folder.name, "department": folder.department}


@router.delete("/folders/{folder_id}")
async def delete_shared_folder(
    folder_id: int,
    user: str = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    _require_admin(user)
    result = await db.execute(select(SharedFolder).where(SharedFolder.id == folder_id))
    folder = result.scalar_one_or_none()
    if not folder:
        raise HTTPException(status_code=404, detail="Folder not found")

    docs_result = await db.execute(
        select(SharedDocument).where(SharedDocument.folder_id == folder_id)
    )
    for doc in docs_result.scalars().all():
        try:
            rag_storage.delete_file(doc.storage_path)
        except Exception:
            pass

    await db.delete(folder)
    await db.commit()
    return {"message": "Folder deleted"}


# ── Upload ────────────────────────────────────────────────────────────────────

@router.post("/")
async def upload_shared_documents(
    background_tasks: BackgroundTasks,
    files: list[UploadFile] = File(...),
    folder_id: int = Form(...),
    user: str = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Admin: upload files into a shared folder."""
    _require_admin(user)

    if not os.getenv("SUPABASE_URL") or not os.getenv("SUPABASE_SERVICE_KEY"):
        raise HTTPException(
            status_code=503,
            detail="SUPABASE_URL and SUPABASE_SERVICE_KEY are not configured in .env",
        )

    folder_result = await db.execute(select(SharedFolder).where(SharedFolder.id == folder_id))
    if not folder_result.scalar_one_or_none():
        raise HTTPException(status_code=400, detail="Invalid folder")

    usage_result = await db.execute(
        select(func.coalesce(func.sum(SharedDocument.file_size), 0))
    )
    current_usage = int(usage_result.scalar() or 0)

    created = []
    for file in files:
        filename = file.filename or "unnamed"
        ext = os.path.splitext(filename)[1].lower()
        if ext not in ALLOWED_EXTENSIONS:
            continue

        file_bytes = await file.read()
        file_size = len(file_bytes)

        if current_usage + file_size > STORAGE_LIMIT_BYTES:
            raise HTTPException(
                status_code=413,
                detail="Shared storage limit exceeded (max 0.5 GB)",
            )

        mime = file.content_type or "text/plain"
        storage_path = f"shared/{uuid.uuid4().hex}_{filename}"

        try:
            rag_storage.upload_file(storage_path, file_bytes, mime)
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Storage upload failed: {e}")

        doc = SharedDocument(
            folder_id=folder_id,
            original_filename=filename,
            storage_path=storage_path,
            file_size=file_size,
            mime_type=mime,
        )
        db.add(doc)
        await db.flush()
        await db.commit()

        current_usage += file_size
        created.append({"id": doc.id, "filename": filename, "status": "processing"})

        background_tasks.add_task(
            rag_ingestion.ingest_shared_document, doc.id, storage_path, mime
        )

    return created


# ── List documents ────────────────────────────────────────────────────────────

@router.get("/")
async def list_shared_documents(
    user: str = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Admin: all docs. User: visible docs in their dept folders, with user_rag_active."""
    is_admin = user in _get_admin_emails()

    if is_admin:
        result = await db.execute(
            select(
                SharedDocument,
                func.count(SharedDocumentChunk.id)
                .filter(SharedDocumentChunk.embedding.isnot(None))
                .label("embedded_count"),
            )
            .outerjoin(SharedDocumentChunk, SharedDocumentChunk.document_id == SharedDocument.id)
            .group_by(SharedDocument.id)
            .order_by(SharedDocument.created_at.desc())
        )
        rows = result.all()

        # Look up admin's own personal RAG preferences (same as regular users)
        doc_ids = [d.id for d, _ in rows]
        admin_prefs: dict[int, bool] = {}
        if doc_ids:
            pref_result = await db.execute(
                select(UserSharedDocPref).where(
                    UserSharedDocPref.user_email == user,
                    UserSharedDocPref.doc_id.in_(doc_ids),
                )
            )
            for p in pref_result.scalars().all():
                admin_prefs[p.doc_id] = p.is_rag_active

        return [
            {
                "id": d.id,
                "filename": d.original_filename,
                "folder_id": d.folder_id,
                "chunk_count": d.chunk_count,
                "embedded_count": embedded_count,
                "file_size": d.file_size,
                "is_visible": d.is_visible,
                "is_rag_active": d.is_rag_active,
                "user_rag_active": admin_prefs.get(d.id, True),
                "created_at": d.created_at.isoformat(),
            }
            for d, embedded_count in rows
        ]

    # Regular user — dept-filtered + visibility check + user pref
    user_result = await db.execute(select(User).where(User.email == user))
    user_row = user_result.scalar_one_or_none()
    dept = user_row.department if user_row else None
    if not dept:
        return []

    result = await db.execute(
        select(
            SharedDocument,
            func.count(SharedDocumentChunk.id)
            .filter(SharedDocumentChunk.embedding.isnot(None))
            .label("embedded_count"),
        )
        .outerjoin(SharedDocumentChunk, SharedDocumentChunk.document_id == SharedDocument.id)
        .join(SharedFolder, SharedFolder.id == SharedDocument.folder_id)
        .where(SharedFolder.department == dept, SharedDocument.is_visible == True)  # noqa: E712
        .group_by(SharedDocument.id)
        .order_by(SharedDocument.created_at.desc())
    )
    rows = result.all()

    # Fetch user's preferences in bulk
    doc_ids = [d.id for d, _ in rows]
    prefs: dict[int, bool] = {}
    if doc_ids:
        pref_result = await db.execute(
            select(UserSharedDocPref).where(
                UserSharedDocPref.user_email == user,
                UserSharedDocPref.doc_id.in_(doc_ids),
            )
        )
        for p in pref_result.scalars().all():
            prefs[p.doc_id] = p.is_rag_active

    return [
        {
            "id": d.id,
            "filename": d.original_filename,
            "folder_id": d.folder_id,
            "chunk_count": d.chunk_count,
            "embedded_count": embedded_count,
            "file_size": d.file_size,
            "is_visible": d.is_visible,
            "is_rag_active": d.is_rag_active,
            "user_rag_active": prefs.get(d.id, True),
            "created_at": d.created_at.isoformat(),
        }
        for d, embedded_count in rows
    ]


# ── Document content preview ──────────────────────────────────────────────────

@router.get("/{doc_id}/content")
async def get_shared_document_content(
    doc_id: int,
    user: str = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    is_admin = user in _get_admin_emails()

    result = await db.execute(select(SharedDocument).where(SharedDocument.id == doc_id))
    doc = result.scalar_one_or_none()
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")

    if not is_admin:
        # Verify user's dept matches the folder's dept and doc is visible
        user_result = await db.execute(select(User).where(User.email == user))
        user_row = user_result.scalar_one_or_none()
        dept = user_row.department if user_row else None

        folder_result = await db.execute(
            select(SharedFolder).where(SharedFolder.id == doc.folder_id)
        )
        folder = folder_result.scalar_one_or_none()
        if not folder or folder.department != dept or not doc.is_visible:
            raise HTTPException(status_code=403, detail="Access denied")

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


# ── Admin: delete / reprocess ─────────────────────────────────────────────────

@router.delete("/{doc_id}")
async def delete_shared_document(
    doc_id: int,
    user: str = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    _require_admin(user)
    result = await db.execute(select(SharedDocument).where(SharedDocument.id == doc_id))
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
async def reprocess_shared_document(
    doc_id: int,
    background_tasks: BackgroundTasks,
    user: str = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    _require_admin(user)
    result = await db.execute(select(SharedDocument).where(SharedDocument.id == doc_id))
    doc = result.scalar_one_or_none()
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")

    await db.execute(delete(SharedDocumentChunk).where(SharedDocumentChunk.document_id == doc_id))
    doc.chunk_count = 0
    await db.commit()

    background_tasks.add_task(
        rag_ingestion.ingest_shared_document, doc.id, doc.storage_path, doc.mime_type
    )
    return {"message": "Reprocessing started"}


# ── Admin toggles ─────────────────────────────────────────────────────────────

@router.patch("/{doc_id}/toggle-visibility")
async def toggle_shared_visibility(
    doc_id: int,
    user: str = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    _require_admin(user)
    result = await db.execute(select(SharedDocument).where(SharedDocument.id == doc_id))
    doc = result.scalar_one_or_none()
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")
    doc.is_visible = not doc.is_visible
    await db.commit()
    return {"id": doc.id, "is_visible": doc.is_visible}


@router.patch("/{doc_id}/toggle-rag")
async def toggle_shared_rag(
    doc_id: int,
    user: str = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    _require_admin(user)
    result = await db.execute(select(SharedDocument).where(SharedDocument.id == doc_id))
    doc = result.scalar_one_or_none()
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")
    doc.is_rag_active = not doc.is_rag_active
    await db.commit()
    return {"id": doc.id, "is_rag_active": doc.is_rag_active}


# ── User personal RAG toggle ──────────────────────────────────────────────────

@router.patch("/{doc_id}/toggle-user")
async def toggle_user_shared_pref(
    doc_id: int,
    user: str = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Create or flip the user's personal RAG preference for this shared doc."""
    # Verify doc exists and user's dept can see it
    result = await db.execute(select(SharedDocument).where(SharedDocument.id == doc_id))
    doc = result.scalar_one_or_none()
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")

    pref_result = await db.execute(
        select(UserSharedDocPref).where(
            UserSharedDocPref.user_email == user,
            UserSharedDocPref.doc_id == doc_id,
        )
    )
    pref = pref_result.scalar_one_or_none()

    if pref is None:
        # First toggle: default was True, so set to False
        pref = UserSharedDocPref(user_email=user, doc_id=doc_id, is_rag_active=False)
        db.add(pref)
    else:
        pref.is_rag_active = not pref.is_rag_active

    await db.commit()
    return {"doc_id": doc_id, "user_rag_active": pref.is_rag_active}
