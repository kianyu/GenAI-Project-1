"""
RAG — Supabase Storage helpers
Handles uploading and deleting raw document files from Supabase Storage.
"""

import os

from supabase import create_client, Client

BUCKET = "documents"
_bucket_ensured = False  # module-level flag so we only create once per process


def _get_client() -> Client:
    url = os.getenv("SUPABASE_URL", "")
    key = os.getenv("SUPABASE_SERVICE_KEY", "")
    if not url or not key:
        raise RuntimeError("SUPABASE_URL and SUPABASE_SERVICE_KEY must be set in .env")
    return create_client(url, key)


def _ensure_bucket(client: Client) -> None:
    """Create the documents bucket if it doesn't exist (runs once per process)."""
    global _bucket_ensured
    if _bucket_ensured:
        return
    existing = [b.name for b in client.storage.list_buckets()]
    if BUCKET not in existing:
        client.storage.create_bucket(BUCKET, options={"public": False})
    _bucket_ensured = True


def upload_file(storage_path: str, file_bytes: bytes, mime_type: str) -> None:
    """Upload file bytes to Supabase Storage at the given path."""
    client = _get_client()
    _ensure_bucket(client)
    client.storage.from_(BUCKET).upload(
        path=storage_path,
        file=file_bytes,
        file_options={"content-type": mime_type, "upsert": "true"},
    )


def download_file(storage_path: str) -> bytes:
    """Download and return raw bytes from Supabase Storage."""
    client = _get_client()
    return client.storage.from_(BUCKET).download(storage_path)


def delete_file(storage_path: str) -> None:
    """Remove a file from Supabase Storage (best-effort)."""
    client = _get_client()
    client.storage.from_(BUCKET).remove([storage_path])
