"""
RAG — Document ingestion pipeline
Downloads uploaded file from Supabase Storage, parses the text, splits into
overlapping chunks, embeds each chunk via the Gemini REST API (v1), and stores
the resulting DocumentChunk rows in the database.

Runs as a FastAPI BackgroundTask so the upload endpoint returns immediately.
"""

import asyncio
import io
import os
import sys
import time

import httpx
from sqlalchemy import update

from database import AsyncSessionLocal
from models import Document, DocumentChunk, SharedDocument, SharedDocumentChunk

from . import storage as rag_storage


# ── Helpers ───────────────────────────────────────────────────────────────────

def _parse_text(file_bytes: bytes, mime_type: str) -> str:
    """Extract plain text from PDF, DOCX, or plain-text files."""
    if "pdf" in mime_type:
        import warnings
        from pypdf import PdfReader
        # strict=False makes pypdf tolerant of malformed values (e.g. bad floats)
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            reader = PdfReader(io.BytesIO(file_bytes), strict=False)
        pages = []
        for page in reader.pages:
            try:
                text = page.extract_text()
                if text:
                    pages.append(text)
            except Exception:
                pass  # skip unreadable pages rather than aborting
        raw = "\n\n".join(pages)
    elif "wordprocessingml" in mime_type or "msword" in mime_type:
        from docx import Document as DocxDocument
        doc = DocxDocument(io.BytesIO(file_bytes))
        raw = "\n\n".join(p.text for p in doc.paragraphs if p.text.strip())
    else:
        # Plain text, markdown, etc.
        raw = file_bytes.decode("utf-8", errors="replace")

    # PostgreSQL (UTF-8) rejects null bytes — strip them regardless of file type
    return raw.replace("\x00", "")


def _chunk_text(text: str, chunk_size: int = 512, overlap: int = 50) -> list[str]:
    """Split text into overlapping word-level chunks."""
    words = text.split()
    chunks: list[str] = []
    i = 0
    while i < len(words):
        chunk = " ".join(words[i : i + chunk_size])
        if chunk.strip():
            chunks.append(chunk)
        i += chunk_size - overlap
    return chunks


def _embed_text(text: str, max_retries: int = 6) -> list[float]:
    """
    Embed text via Gemini REST API v1beta with automatic retry on 429.
    Reads the retryDelay from the response body when available, otherwise
    uses exponential backoff starting at 30 s.
    """
    api_key = os.getenv("GOOGLE_API_KEY", "")
    url = (
        "https://generativelanguage.googleapis.com/v1beta/models/"
        f"gemini-embedding-001:embedContent?key={api_key}"
    )
    payload = {
        "model": "models/gemini-embedding-001",
        "content": {"parts": [{"text": text}]},
        "taskType": "RETRIEVAL_DOCUMENT",
    }

    wait = 30  # seconds — initial backoff
    for attempt in range(max_retries):
        with httpx.Client(timeout=30.0) as client:
            response = client.post(url, json=payload)

        if response.status_code == 429:
            # Try to honour the server-suggested retry delay
            retry_delay = wait
            try:
                details = response.json().get("error", {}).get("details", [])
                for d in details:
                    if "retryDelay" in d:
                        retry_delay = max(int(float(d["retryDelay"].rstrip("s"))), wait)
                        break
            except Exception:
                pass

            if attempt < max_retries - 1:
                print(
                    f"[RAG] Rate limited (429) — waiting {retry_delay}s "
                    f"(attempt {attempt + 1}/{max_retries})",
                    file=sys.stderr, flush=True,
                )
                time.sleep(retry_delay)
                wait = min(wait * 2, 120)  # cap backoff at 2 min
                continue
            # All retries exhausted
            response.raise_for_status()

        response.raise_for_status()
        return response.json()["embedding"]["values"]

    raise RuntimeError(f"Embedding failed after {max_retries} retries (rate limit)")


# ── Main ingestion task ───────────────────────────────────────────────────────

async def ingest_document(doc_id: int, storage_path: str, mime_type: str) -> None:
    """
    RAG ingestion pipeline (runs as a background task):
      1. Download file from Supabase Storage
      2. Parse text content
      3. Split into overlapping chunks
      4. Embed each chunk with Gemini REST API
      5. Persist DocumentChunk rows and update chunk_count on Document
    """
    if not os.getenv("GOOGLE_API_KEY"):
        return  # RAG disabled — no API key configured

    try:
        file_bytes = rag_storage.download_file(storage_path)
        text = _parse_text(file_bytes, mime_type)
        chunks = _chunk_text(text)
        if not chunks:
            return

        async with AsyncSessionLocal() as db:
            for i, chunk in enumerate(chunks):
                # ~0.65 s between requests keeps throughput under 100 req/min
                # (free-tier Gemini limit) without relying solely on retry.
                if i > 0:
                    await asyncio.sleep(0.65)

                try:
                    embedding = _embed_text(chunk)
                except Exception as e:
                    print(
                        f"[RAG] Embedding error — chunk {i}, doc {doc_id}: {e}",
                        file=sys.stderr, flush=True,
                    )
                    embedding = None  # chunk stored without embedding

                db.add(DocumentChunk(
                    document_id=doc_id,
                    content=chunk,
                    embedding=embedding,
                    chunk_index=i,
                ))

            # Mark document as fully processed
            await db.execute(
                update(Document)
                .where(Document.id == doc_id)
                .values(chunk_count=len(chunks))
            )
            await db.commit()

    except Exception as e:
        print(f"[RAG] Ingestion failed for doc {doc_id}: {e}", file=sys.stderr, flush=True)


# ── Shared document ingestion task ────────────────────────────────────────────

async def ingest_shared_document(doc_id: int, storage_path: str, mime_type: str) -> None:
    """
    Same pipeline as ingest_document but writes SharedDocumentChunk rows
    and updates SharedDocument.chunk_count.
    """
    if not os.getenv("GOOGLE_API_KEY"):
        return

    try:
        file_bytes = rag_storage.download_file(storage_path)
        text = _parse_text(file_bytes, mime_type)
        chunks = _chunk_text(text)
        if not chunks:
            return

        async with AsyncSessionLocal() as db:
            for i, chunk in enumerate(chunks):
                if i > 0:
                    await asyncio.sleep(0.65)

                try:
                    embedding = _embed_text(chunk)
                except Exception as e:
                    print(
                        f"[RAG] Shared embedding error — chunk {i}, doc {doc_id}: {e}",
                        file=sys.stderr, flush=True,
                    )
                    embedding = None

                db.add(SharedDocumentChunk(
                    document_id=doc_id,
                    content=chunk,
                    embedding=embedding,
                    chunk_index=i,
                ))

            await db.execute(
                update(SharedDocument)
                .where(SharedDocument.id == doc_id)
                .values(chunk_count=len(chunks))
            )
            await db.commit()

    except Exception as e:
        print(f"[RAG] Shared ingestion failed for doc {doc_id}: {e}", file=sys.stderr, flush=True)
