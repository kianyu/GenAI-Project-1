"""
RAG — Document ingestion pipeline
Downloads uploaded file from Supabase Storage, parses the text, splits into
overlapping chunks, embeds each chunk via the Gemini REST API (v1), and stores
the resulting DocumentChunk rows in the database.

Runs as a FastAPI BackgroundTask so the upload endpoint returns immediately.
"""

import io
import os
import sys

import httpx
from sqlalchemy import update

from database import AsyncSessionLocal
from models import Document, DocumentChunk

from . import storage as rag_storage


# ── Helpers ───────────────────────────────────────────────────────────────────

def _parse_text(file_bytes: bytes, mime_type: str) -> str:
    """Extract plain text from PDF, DOCX, or plain-text files."""
    if "pdf" in mime_type:
        from pypdf import PdfReader
        reader = PdfReader(io.BytesIO(file_bytes))
        return "\n\n".join(page.extract_text() or "" for page in reader.pages)
    elif "wordprocessingml" in mime_type or "msword" in mime_type:
        from docx import Document as DocxDocument
        doc = DocxDocument(io.BytesIO(file_bytes))
        return "\n\n".join(p.text for p in doc.paragraphs if p.text.strip())
    else:
        # Plain text, markdown, etc.
        return file_bytes.decode("utf-8", errors="replace")


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


def _embed_text(text: str) -> list[float]:
    """
    Embed text via Gemini REST API v1beta.
    Model: gemini-embedding-001, 3072-dim.
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
    with httpx.Client(timeout=30.0) as client:
        response = client.post(url, json=payload)
        response.raise_for_status()
    return response.json()["embedding"]["values"]


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
