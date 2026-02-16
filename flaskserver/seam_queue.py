from __future__ import annotations

import datetime as dt
import sqlite3

_SEAM_SCHEMA = """
CREATE TABLE IF NOT EXISTS seam_jobs (
    tile_id     TEXT PRIMARY KEY,
    priority    INTEGER NOT NULL DEFAULT 0,
    status      TEXT NOT NULL DEFAULT 'pending',
    attempts    INTEGER NOT NULL DEFAULT 0,
    last_error  TEXT,
    updated_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_seam_jobs_status_priority
ON seam_jobs(status, priority DESC, updated_at ASC);
"""


def init_seam_jobs(db: sqlite3.Connection) -> None:
    db.executescript(_SEAM_SCHEMA)
    db.commit()


def parse_tile_id(tile_id: str) -> tuple[int, int, int] | None:
    parts = tile_id.split("-")
    if len(parts) != 3:
        return None
    try:
        return int(parts[0]), int(parts[1]), int(parts[2])
    except ValueError:
        return None


def neighbor_tile_ids(tile_id: str, include_diagonal: bool = True) -> list[str]:
    parsed = parse_tile_id(tile_id)
    if parsed is None:
        return []
    depth, col, row = parsed
    n = 1 << depth

    out: list[str] = []
    for dc in (-1, 0, 1):
        for dr in (-1, 0, 1):
            if dc == 0 and dr == 0:
                continue
            if not include_diagonal and abs(dc) + abs(dr) != 1:
                continue
            nc = col + dc
            nr = row + dr
            if nc < 0 or nr < 0 or nc >= n or nr >= n:
                continue
            out.append(f"{depth}-{nc}-{nr}")
    return out


def _enqueue_one(db: sqlite3.Connection, tile_id: str, priority: int) -> None:
    now = dt.datetime.now(dt.timezone.utc).isoformat()
    db.execute(
        """
        INSERT INTO seam_jobs (tile_id, priority, status, attempts, last_error, updated_at)
        VALUES (?, ?, 'pending', 0, NULL, ?)
        ON CONFLICT(tile_id) DO UPDATE SET
            priority = MAX(seam_jobs.priority, excluded.priority),
            status = CASE
                WHEN seam_jobs.status = 'running' THEN seam_jobs.status
                ELSE 'pending'
            END,
            last_error = CASE
                WHEN seam_jobs.status = 'running' THEN seam_jobs.last_error
                ELSE NULL
            END,
            updated_at = excluded.updated_at
        """,
        (tile_id, int(priority), now),
    )


def enqueue_tile_and_neighbors(
    db: sqlite3.Connection,
    tile_id: str,
    center_priority: int = 100,
    neighbor_priority: int = 60,
) -> None:
    _enqueue_one(db, tile_id, center_priority)
    for nid in neighbor_tile_ids(tile_id, include_diagonal=True):
        _enqueue_one(db, nid, neighbor_priority)
    db.commit()


def claim_next_job(db: sqlite3.Connection) -> str | None:
    now = dt.datetime.now(dt.timezone.utc).isoformat()
    db.execute("BEGIN IMMEDIATE")
    row = db.execute(
        """
        SELECT tile_id
        FROM seam_jobs
        WHERE status = 'pending'
        ORDER BY priority DESC, updated_at ASC
        LIMIT 1
        """
    ).fetchone()
    if row is None:
        db.execute("COMMIT")
        return None

    tile_id = str(row[0])
    db.execute(
        """
        UPDATE seam_jobs
        SET status = 'running',
            attempts = attempts + 1,
            updated_at = ?
        WHERE tile_id = ?
        """,
        (now, tile_id),
    )
    db.execute("COMMIT")
    return tile_id


def retry_failed(db: sqlite3.Connection) -> int:
    """Reset all failed seam jobs back to pending so they get reprocessed."""
    now = dt.datetime.now(dt.timezone.utc).isoformat()
    cur = db.execute(
        """
        UPDATE seam_jobs
        SET status = 'pending',
            last_error = NULL,
            updated_at = ?
        WHERE status = 'failed'
        """,
        (now,),
    )
    db.commit()
    return cur.rowcount


def finish_job(db: sqlite3.Connection, tile_id: str, ok: bool, error: str | None = None) -> None:
    now = dt.datetime.now(dt.timezone.utc).isoformat()
    if ok:
        db.execute(
            """
            UPDATE seam_jobs
            SET status = 'done',
                last_error = NULL,
                updated_at = ?
            WHERE tile_id = ?
            """,
            (now, tile_id),
        )
    else:
        db.execute(
            """
            UPDATE seam_jobs
            SET status = 'failed',
                last_error = ?,
                updated_at = ?
            WHERE tile_id = ?
            """,
            ((error or "")[:1000], now, tile_id),
        )
    db.commit()
