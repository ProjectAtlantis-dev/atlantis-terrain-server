#!/usr/bin/env python3
"""List tables in the Flask terrain SQLite database.

Usage:
    python list_tables.py
    python list_tables.py --db /path/to/terrain.db
"""

import argparse
import os
import sqlite3
from pathlib import Path


DB_PATH = Path(__file__).resolve().parent / "terrain.db"


def _resolve_default_db_path() -> Path:
    explicit = os.environ.get("TERRAIN_DB_PATH", "").strip()
    if explicit:
        return Path(explicit).expanduser().resolve()
    return DB_PATH


def _quote_identifier(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


def _row_count(db: sqlite3.Connection, table_name: str) -> int | None:
    try:
        row = db.execute(f"SELECT COUNT(*) FROM {_quote_identifier(table_name)}").fetchone()
    except sqlite3.DatabaseError:
        return None
    return int(row[0]) if row else None


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--db",
        type=Path,
        default=_resolve_default_db_path(),
        help="Path to terrain.db (default: TERRAIN_DB_PATH or flaskserver/terrain.db)",
    )
    parser.add_argument(
        "--all",
        action="store_true",
        help="Include SQLite internal tables such as sqlite_sequence",
    )
    parser.add_argument(
        "--no-counts",
        action="store_true",
        help="Only print table names; skip row counts",
    )
    args = parser.parse_args()

    db_path = args.db.expanduser().resolve()
    if not db_path.exists():
        raise SystemExit(f"DB not found: {db_path}")

    db = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    db.execute("PRAGMA query_only = ON")

    where = "type = 'table'"
    params: tuple[str, ...] = ()
    if not args.all:
        where += " AND name NOT LIKE ?"
        params = ("sqlite_%",)

    rows = db.execute(
        f"SELECT name FROM sqlite_schema WHERE {where} ORDER BY name",
        params,
    ).fetchall()

    print(f"DB: {db_path}")
    if not rows:
        print("No tables found.")
        db.close()
        return

    print(f"Tables ({len(rows)}):")
    for (name,) in rows:
        if args.no_counts:
            print(f"  {name}")
            continue
        count = _row_count(db, name)
        suffix = "unknown rows" if count is None else f"{count:,} rows"
        print(f"  {name} ({suffix})")

    db.close()


if __name__ == "__main__":
    main()
