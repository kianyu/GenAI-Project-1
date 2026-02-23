"""
RAG — Retrieval pipeline
Embeds the user's query via the Gemini REST API (v1), performs a cosine-similarity
search against the user's active personal document chunks AND any active shared
document chunks from the user's department, then returns a formatted context
string plus source citations.
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
    is_admin: bool = False,
    top_k: int = 5,
) -> tuple[str, list[dict]]:
    """
    RAG retrieval combining personal and shared documents:
      1. Embed the query
      2. UNION cosine-similarity search over personal + shared chunks
      3. Return (context_str, sources_list)

    Admin users search ALL visible shared docs (regardless of department).
    Regular users search only shared docs whose folder department matches their own.
    Users without a department get no shared-doc results.
    Returns ("", []) if GOOGLE_API_KEY is not configured or no chunks found.
    """
    if not os.getenv("GOOGLE_API_KEY"):
        return "", []

    try:
        query_embedding = _embed_query(query)
    except Exception:
        return "", []

    embedding_str = "[" + ",".join(str(x) for x in query_embedding) + "]"

    # Admin: search all visible shared docs (no dept restriction).
    # User: search only docs whose folder dept matches the user's dept.
    if is_admin:
        shared_subquery = """
            SELECT
                sdc.content,
                sdc.chunk_index,
                sdc.document_id,
                sd.original_filename AS filename,
                'shared' AS source_type,
                sdc.embedding <=> CAST(:embedding AS vector) AS distance
            FROM shared_document_chunks sdc
            JOIN shared_documents sd ON sdc.document_id = sd.id
            WHERE sd.is_visible = true
              AND sdc.embedding IS NOT NULL
              AND NOT EXISTS (
                  SELECT 1 FROM user_shared_doc_prefs p
                  WHERE p.user_email = :user_email
                    AND p.doc_id = sdc.document_id
                    AND p.is_rag_active = false
              )
        """
    else:
        shared_subquery = """
            SELECT
                sdc.content,
                sdc.chunk_index,
                sdc.document_id,
                sd.original_filename AS filename,
                'shared' AS source_type,
                sdc.embedding <=> CAST(:embedding AS vector) AS distance
            FROM shared_document_chunks sdc
            JOIN shared_documents sd ON sdc.document_id = sd.id
            JOIN shared_folders sf ON sd.folder_id = sf.id
            JOIN users u ON u.email = :user_email
            WHERE sf.department = u.department
              AND sd.is_visible = true
              AND sdc.embedding IS NOT NULL
              AND NOT EXISTS (
                  SELECT 1 FROM user_shared_doc_prefs p
                  WHERE p.user_email = :user_email
                    AND p.doc_id = sdc.document_id
                    AND p.is_rag_active = false
              )
        """

    sql = text(f"""
        SELECT content, chunk_index, document_id, filename, source_type
        FROM (
            -- Personal docs (user-owned, active, embedded)
            SELECT
                dc.content,
                dc.chunk_index,
                dc.document_id,
                d.original_filename AS filename,
                'personal' AS source_type,
                dc.embedding <=> CAST(:embedding AS vector) AS distance
            FROM document_chunks dc
            JOIN documents d ON dc.document_id = d.id
            WHERE d.user_email = :user_email
              AND d.is_active = true
              AND dc.embedding IS NOT NULL

            UNION ALL

            -- Shared docs (visible, user hasn't detached)
            {shared_subquery}
        ) combined
        ORDER BY distance
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
            "excerpt": row.content,
            "source_type": row.source_type,  # "personal" | "shared"
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
