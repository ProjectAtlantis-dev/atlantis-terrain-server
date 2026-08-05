"""Schedule Glacier bathymetry for newly explored fjord terrain.

Terrain DEMs and coastline masks already arrive through viewer demand.  This
module turns the ready, visible depth-12 tiles into coarse bathymetry jobs
without making open-ocean exploration synthesize a seabed.

The eligibility rule is deliberately coastal:

* a mixed land/water coastline mask is fjord/coast demand;
* an all-water tile is eligible only within ``OFFSHORE_LIMIT_M`` of a mixed
  mask; and
* jobs are coalesced at depth 8, the bathymetry storage contract depth.

Offshore banks need their own evidence/model and are intentionally outside
this rule.
"""

from __future__ import annotations

import json
import math
import sqlite3
import subprocess
import threading
import time
import zlib
from concurrent.futures import Future, ThreadPoolExecutor
from pathlib import Path
from typing import Callable, Iterable, Mapping

import numpy as np

from terrain_config import GREENLAND_BBOX, WMS_CONTRACT_DEPTH
from tile_address import format_tile_id, parse_tile_id


BATHYMETRY_JOB_DEPTH = 8
OFFSHORE_LIMIT_M = 2_000.0
BATHYMETRY_DEM_MAX_DEPTH = WMS_CONTRACT_DEPTH
BATHYMETRY_DEMAND_PAUSED_KEY = "bathymetry_demand_paused"
BATHYMETRY_FAILURE_KEY_PREFIX = "bathymetry_demand_failure:"
BATHYMETRY_RETRY_MAX_SECONDS = 3_600.0


def terrain_request_max_depth(
    request_args: Mapping[str, str],
    default_max_depth: int,
) -> int:
    """Keep non-viewer bathymetry acquisition at the depth-12 contract.

    ``demand=bathymetry`` is the explicit contract. ``bathymetry=0`` remains
    recognized for the existing Glacier client while it is upgraded; no
    browser request uses that scheduler-suppression parameter.
    """
    if (
        request_args.get("demand") == "bathymetry"
        or request_args.get("bathymetry") == "0"
    ):
        return min(int(default_max_depth), BATHYMETRY_DEM_MAX_DEPTH)
    return int(default_max_depth)


def terrain_request_origin(request_args: Mapping[str, str]) -> str:
    """Classify terrain demand for audit logs and scheduling provenance."""
    if (
        request_args.get("demand") == "bathymetry"
        or request_args.get("bathymetry") == "0"
    ):
        return "bathymetry"
    return "viewer"


def bathymetry_demand_paused(db) -> bool:
    """Read the durable operator pause from terrain metadata."""
    try:
        row = db.execute(
            "SELECT value FROM metadata WHERE key = ?",
            (BATHYMETRY_DEMAND_PAUSED_KEY,),
        ).fetchone()
    except sqlite3.OperationalError as exc:
        # Small unit-test/legacy databases may predate the metadata table.
        if "no such table" in str(exc).lower():
            return False
        raise
    return bool(
        row
        and str(row[0]).strip().lower() in {"1", "true", "yes", "on"}
    )


def _failure_key(job_id: str) -> str:
    return f"{BATHYMETRY_FAILURE_KEY_PREFIX}{job_id}"


def _read_failure(db, job_id: str, logger=None) -> dict | None:
    """Read one durable failed-job cooldown from existing metadata."""
    try:
        row = db.execute(
            "SELECT value FROM metadata WHERE key = ?",
            (_failure_key(job_id),),
        ).fetchone()
        value = json.loads(row[0]) if row else None
        if not isinstance(value, dict):
            return None
        return {
            "attempts": max(1, int(value["attempts"])),
            "failed_at": float(value["failed_at"]),
            "retry_at": float(value["retry_at"]),
            "error": str(value.get("error") or ""),
        }
    except sqlite3.OperationalError as exc:
        if "no such table" in str(exc).lower():
            return None
        raise
    except (KeyError, TypeError, ValueError, json.JSONDecodeError) as exc:
        if logger is not None:
            logger.warning(
                f"[bathymetry-demand] ignoring corrupt failure state for "
                f"{job_id}: {type(exc).__name__}: {exc}"
            )
        return None


def _ancestor_at_depth(tile_id: str, depth: int) -> tuple[int, int] | None:
    parsed = parse_tile_id(tile_id)
    if parsed is None:
        return None
    source_depth, column, row = parsed
    if source_depth < depth:
        return None
    shift = source_depth - depth
    return column >> shift, row >> shift


def _decode_mask(width: int, height: int, blob) -> np.ndarray | None:
    values = np.frombuffer(zlib.decompress(blob), dtype=np.uint8)
    if values.size != int(width) * int(height):
        return None
    return values.reshape((int(height), int(width))).astype(bool)


def _tile_gap_m(
    left: tuple[int, int],
    right: tuple[int, int],
    tile_size_m: float,
) -> float:
    """Shortest distance between two closed tile footprints."""
    dc = max(abs(left[0] - right[0]) - 1, 0)
    dr = max(abs(left[1] - right[1]) - 1, 0)
    return math.hypot(dc, dr) * tile_size_m


def eligible_fjord_jobs(
    db,
    visible_tile_ids: Iterable[str],
    *,
    offshore_limit_m: float = OFFSHORE_LIMIT_M,
) -> set[str]:
    """Return depth-8 job ids justified by visible coastline-mask demand."""
    candidates = {
        address
        for tile_id in visible_tile_ids
        if (address := _ancestor_at_depth(tile_id, WMS_CONTRACT_DEPTH))
        is not None
    }
    if not candidates:
        return set()

    root_width = float(GREENLAND_BBOX[2] - GREENLAND_BBOX[0])
    tile_size_m = root_width / (1 << WMS_CONTRACT_DEPTH)
    search_tiles = int(math.ceil(offshore_limit_m / tile_size_m)) + 1
    min_col = min(column for column, _ in candidates) - search_tiles
    max_col = max(column for column, _ in candidates) + search_tiles
    min_row = min(row for _, row in candidates) - search_tiles
    max_row = max(row for _, row in candidates) + search_tiles

    masks: dict[tuple[int, int], tuple[bool, bool]] = {}
    rows = db.execute(
        "SELECT t.col, t.row, m.width, m.height, m.mask "
        "FROM coastline_masks m JOIN tiles t ON t.tile_id = m.tile_id "
        "WHERE t.depth = ? AND t.col BETWEEN ? AND ? "
        "AND t.row BETWEEN ? AND ?",
        (
            WMS_CONTRACT_DEPTH,
            min_col,
            max_col,
            min_row,
            max_row,
        ),
    ).fetchall()
    for column, row, width, height, blob in rows:
        mask = _decode_mask(width, height, blob)
        if mask is None:
            continue
        masks[(int(column), int(row))] = (bool(np.any(mask)), bool(np.all(mask)))

    mixed = {
        address
        for address, (has_water, all_water) in masks.items()
        if has_water and not all_water
    }
    if not mixed:
        return set()

    eligible: set[tuple[int, int]] = set()
    for address in candidates:
        classification = masks.get(address)
        if classification is None or not classification[0]:
            continue
        if not classification[1]:
            eligible.add(address)
            continue
        if any(
            _tile_gap_m(address, coast_address, tile_size_m)
            <= offshore_limit_m
            for coast_address in mixed
        ):
            eligible.add(address)

    jobs = {
        format_tile_id(
            BATHYMETRY_JOB_DEPTH,
            column >> (WMS_CONTRACT_DEPTH - BATHYMETRY_JOB_DEPTH),
            row >> (WMS_CONTRACT_DEPTH - BATHYMETRY_JOB_DEPTH),
        )
        for column, row in eligible
    }
    if not jobs:
        return set()

    placeholders = ",".join("?" for _ in jobs)
    covered = {
        row[0]
        for row in db.execute(
            f"SELECT tile_id FROM bathymetry WHERE tile_id IN ({placeholders})",
            sorted(jobs),
        )
    }
    return jobs - covered


class BathymetryDemandScheduler:
    """Small in-process bridge to Glacier's idempotent depth-8 worker."""

    def __init__(
        self,
        db_path: str | Path,
        *,
        glacier_root: str | Path | None = None,
        workers: int = 1,
        retry_seconds: float = 60.0,
        retry_max_seconds: float = BATHYMETRY_RETRY_MAX_SECONDS,
        logger=None,
        pool=None,
        runner: Callable[..., subprocess.CompletedProcess] = subprocess.run,
    ) -> None:
        self.db_path = Path(db_path).expanduser().resolve()
        self.glacier_root = Path(
            glacier_root or Path.home() / "work" / "glacier"
        ).expanduser().resolve()
        self.command = self.glacier_root / "runOnDemand"
        self.retry_seconds = max(float(retry_seconds), 0.0)
        self.retry_max_seconds = max(
            float(retry_max_seconds), self.retry_seconds
        )
        self.log = logger
        self._runner = runner
        self._pool = pool or ThreadPoolExecutor(max_workers=max(1, workers))
        self._lock = threading.RLock()
        self._active: set[str] = set()
        self._completed: set[str] = set()
        self._failed_at: dict[str, float] = {}
        self._last_error: dict[str, str] = {}
        self._paused = False

    @property
    def enabled(self) -> bool:
        return self.command.is_file()

    def schedule(self, db, visible_tile_ids: Iterable[str]) -> list[str]:
        paused = bathymetry_demand_paused(db)
        with self._lock:
            self._paused = paused
        if not self.enabled or paused:
            return []
        jobs = sorted(eligible_fjord_jobs(db, visible_tile_ids))
        failures = {
            job_id: _read_failure(db, job_id, self.log) for job_id in jobs
        }
        submitted = []
        now = time.time()
        with self._lock:
            for job_id in jobs:
                # ``jobs`` contains only currently eligible tiles with no
                # bathymetry row. A global derived-data reset can therefore
                # make a job eligible again after this process completed it;
                # persistent state wins over the in-memory completion hint.
                self._completed.discard(job_id)
                failure = failures[job_id]
                if failure is not None:
                    self._failed_at[job_id] = failure["failed_at"]
                    self._last_error[job_id] = failure["error"]
                if (
                    job_id in self._active
                    or (
                        failure is not None
                        and now < failure["retry_at"]
                    )
                ):
                    continue
                self._active.add(job_id)
                future = self._pool.submit(self._run_job, job_id)
                future.add_done_callback(
                    lambda done, jid=job_id: self._finish(jid, done)
                )
                submitted.append(job_id)
        return submitted

    def _run_job(self, job_id: str) -> subprocess.CompletedProcess:
        command = [
            str(self.command),
            "--tile",
            job_id,
            "--db",
            str(self.db_path),
            "--commit",
        ]
        if self.log is not None:
            self.log.info(f"[bathymetry-demand] job={job_id} stage=started")
        return self._runner(
            command,
            cwd=str(self.glacier_root),
            capture_output=True,
            text=True,
            check=False,
        )

    def _record_failure(self, job_id: str, error: str) -> dict:
        """Persist exponential retry state so a restart cannot reset it."""
        now = time.time()
        state = None
        if self.db_path.is_file():
            db = None
            try:
                db = sqlite3.connect(self.db_path, timeout=5)
                previous = _read_failure(db, job_id, self.log)
                attempts = int(previous["attempts"]) + 1 if previous else 1
                delay = min(
                    self.retry_seconds * (2 ** min(attempts - 1, 20)),
                    self.retry_max_seconds,
                )
                state = {
                    "attempts": attempts,
                    "failed_at": now,
                    "retry_at": now + delay,
                    "error": error,
                }
                db.execute(
                    "INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)",
                    (_failure_key(job_id), json.dumps(state, sort_keys=True)),
                )
                db.commit()
            except sqlite3.Error as exc:
                if self.log is not None:
                    self.log.warning(
                        f"[bathymetry-demand] job={job_id} "
                        f"stage=cooldown_persist_failed error={exc}"
                    )
            finally:
                if db is not None:
                    db.close()
        if state is None:
            state = {
                "attempts": 1,
                "failed_at": now,
                "retry_at": now + self.retry_seconds,
                "error": error,
            }
        return state

    def _clear_failure(self, job_id: str) -> None:
        if not self.db_path.is_file():
            return
        db = None
        try:
            db = sqlite3.connect(self.db_path, timeout=5)
            db.execute(
                "DELETE FROM metadata WHERE key = ?", (_failure_key(job_id),)
            )
            db.commit()
        except sqlite3.Error as exc:
            if self.log is not None:
                self.log.warning(
                    f"[bathymetry-demand] job={job_id} "
                    f"stage=cooldown_clear_failed error={exc}"
                )
        finally:
            if db is not None:
                db.close()

    def _finish(self, job_id: str, future: Future) -> None:
        error = None
        try:
            result = future.result()
            if result.returncode != 0:
                output = (result.stderr or result.stdout or "").strip()
                error = output.splitlines()[-1] if output else (
                    f"worker exited {result.returncode}"
                )
        except Exception as exc:  # pragma: no cover - executor boundary
            error = f"{type(exc).__name__}: {exc}"

        failure = (
            self._record_failure(job_id, error) if error is not None else None
        )
        if failure is None:
            self._clear_failure(job_id)

        with self._lock:
            self._active.discard(job_id)
            if failure is None:
                self._completed.add(job_id)
                self._failed_at.pop(job_id, None)
                self._last_error.pop(job_id, None)
            else:
                self._failed_at[job_id] = failure["failed_at"]
                self._last_error[job_id] = failure["error"]

        if error is None and self.db_path.is_file():
            try:
                from bathymetry_health import refresh_sounding_health

                db = sqlite3.connect(self.db_path, timeout=30)
                try:
                    refreshed = refresh_sounding_health(db, tile_id=job_id)
                    db.commit()
                finally:
                    db.close()
                if self.log is not None and refreshed:
                    self.log.info(
                        f"[bathymetry-demand] job={job_id} "
                        f"stage=soundings_compared count={refreshed}"
                    )
            except Exception as exc:  # pragma: no cover - worker integration
                if self.log is not None:
                    self.log.warning(
                        f"[bathymetry-demand] job={job_id} "
                        f"stage=soundings_compare_failed "
                        f"error={type(exc).__name__}: {exc}"
                    )

        if self.log is not None:
            if error is None:
                self.log.info(
                    f"[bathymetry-demand] job={job_id} stage=completed"
                )
            else:
                self.log.warning(
                    f"[bathymetry-demand] job={job_id} stage=failed "
                    f"error={error}"
                )

    def status(self) -> dict:
        with self._lock:
            return {
                "enabled": self.enabled,
                "paused": self._paused,
                "active": sorted(self._active),
                "completed": len(self._completed),
                "cooldown": sorted(self._failed_at),
                "errors": dict(self._last_error),
            }
