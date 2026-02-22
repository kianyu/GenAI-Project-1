"""
RAG — Retrieval pipeline
Embeds the user's query via the Gemini REST API (v1), performs a cosine-similarity
search against the user's active document chunks in pgvector, and returns
a formatted context string plus a list of source citations.
"""

import os

import httpx
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession


def _embed_query(query: str) -> list[float]:
    """
    Embed a query string via Gemini REST API v1beta.
    Model: gemini-embedding-001, 3072-dim.
    """
    api_key = os.getenv("GOOGLE_API_KEY", "")
    url = (
        "https://generativelanguage.googleapis.com/v1beta/models/"
        f"gemini-embedding-001:embedContent?key={api_key}"
    )
    payload = {
        "model": "models/gemini-embedding-001",
        "content": {"parts": [{"text": query}]},
        "taskType": "RETRIEVAL_QUERY",
    }
    with httpx.Client(timeout=30.0) as client:
        response = client.post(url, json=payload)
        response.raise_for_status()
    return response.json()["embedding"]["values"]


async def retrieve_context(
    query: str,
    user_email: str,
    db: AsyncSession,
    top_k: int = 5,
) -> tuple[str, list[dict]]:
    """
    RAG retrieval:
      1. Embed the query
      2. Cosine-similarity search over the user's active document chunks
      3. Return (context_str, sources_list)

    Returns ("", []) if GOOGLE_API_KEY is not configured or no chunks found.
    """
    if not os.getenv("GOOGLE_API_KEY"):
        return "", []

    try:
        query_embedding = _embed_query(query)
    except Exception:
        return "", []

    # Format vector as PostgreSQL literal: '[0.1,0.2,...]'
    embedding_str = "[" + ",".join(str(x) for x in query_embedding) + "]"

    sql = text("""
        SELECT
            dc.content,
            dc.chunk_index,
            dc.document_id,
            d.original_filename AS filename
        FROM document_chunks dc
        JOIN documents d ON dc.document_id = d.id
        WHERE d.user_email = :user_email
          AND d.is_active = true
          AND dc.embedding IS NOT NULL
        ORDER BY dc.embedding <=> CAST(:embedding AS vector)
        LIMIT :top_k
    """)

    try:
        result = await db.execute(sql, {
            "embedding": embedding_str,
            "user_email": user_email,
            "top_k": top_k,
        })
        rows = result.fetchall()
    except Exception:
        return "", []

    if not rows:
        return "", []

    sources: list[dict] = []
    context_parts: list[str] = []

    for row in rows:
        sources.append({
            "doc_id": row.document_id,
            "filename": row.filename,
            "chunk_index": row.chunk_index,
            "excerpt": row.content,  # full chunk text shown in source card
        })
        context_parts.append(
            f"[Source: {row.filename}]\n{row.content}"
        )

    context_str = "\n\n---\n\n".join(context_parts)
    return context_str, sources


def build_rag_system_prompt(base_prompt: str, context_str: str) -> str:
    """Prepend retrieved document context to the module system prompt."""
    if not context_str:
        return base_prompt
    return (
        f"{base_prompt}\n\n"
        "Use the following document excerpts to answer the user's question. "
        "When referencing specific information, cite its source using [Source: filename].\n\n"
        f"CONTEXT:\n{context_str}"
    )
