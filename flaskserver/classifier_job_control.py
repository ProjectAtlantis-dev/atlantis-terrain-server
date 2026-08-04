from __future__ import annotations

import copy
import datetime
import json
import os
import sqlite3
import threading
import uuid
from pathlib import Path
from typing import Any, Callable


def _utc_now() -> str:
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


class ClassifierJobControl:
    """Run one classifier verification job while exposing thread-safe status."""

    def __init__(
        self,
        db_path: str | Path,
        *,
        verify_tile: Callable[..., dict | None] | None = None,
        finish_job: Callable[[str, list[dict]], None] | None = None,
    ) -> None:
        self.db_path = Path(db_path)
        self._verify_tile_override = verify_tile
        self._finish_job_override = finish_job
        self._lock = threading.Lock()
        self._thread: threading.Thread | None = None
        self._state = self._idle_state()

    @staticmethod
    def _idle_state() -> dict[str, Any]:
        return {
            "jobId": None,
            "status": "idle",
            "scope": None,
            "useGoogle": False,
            "total": 0,
            "processed": 0,
            "succeeded": 0,
            "skipped": 0,
            "failed": 0,
            "currentTile": None,
            "startedAt": None,
            "completedAt": None,
            "error": None,
            "errors": [],
            "recent": [],
        }

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            return copy.deepcopy(self._state)

    def start(
        self,
        *,
        scope: str,
        tiles: list[str],
        use_google: bool,
    ) -> dict[str, Any]:
        deduped = list(dict.fromkeys(tiles))
        if not deduped:
            raise ValueError("classifier job has no tiles")
        with self._lock:
            if self._state["status"] in {"queued", "running"}:
                raise RuntimeError("a classifier job is already running")
            self._state = {
                "jobId": uuid.uuid4().hex,
                "status": "queued",
                "scope": scope,
                "useGoogle": bool(use_google),
                "total": len(deduped),
                "processed": 0,
                "succeeded": 0,
                "skipped": 0,
                "failed": 0,
                "currentTile": None,
                "startedAt": _utc_now(),
                "completedAt": None,
                "error": None,
                "errors": [],
                "recent": [f"Queued {len(deduped)} tile(s)"],
            }
            snapshot = copy.deepcopy(self._state)
            self._thread = threading.Thread(
                target=self._run,
                args=(scope, deduped, bool(use_google)),
                daemon=True,
                name=f"classifier-{self._state['jobId'][:8]}",
            )
            self._thread.start()
            return snapshot

    def wait(self, timeout: float = 5.0) -> dict[str, Any]:
        thread = self._thread
        if thread is not None:
            thread.join(timeout)
        return self.snapshot()

    def _append_recent(self, message: str) -> None:
        self._state["recent"].append(message)
        self._state["recent"] = self._state["recent"][-30:]

    @staticmethod
    def _default_output_dir(scope: str) -> str:
        root = Path(__file__).resolve().parent / "sample"
        return str(root / ("regression" if scope == "regressions" else "classifier_verify"))

    def _verify(
        self,
        db: sqlite3.Connection,
        tile_id: str,
        output_dir: str,
        *,
        use_google: bool,
    ) -> dict | None:
        if self._verify_tile_override is not None:
            return self._verify_tile_override(
                db, tile_id, output_dir, use_google=use_google,
            )
        from classifier_verify import verify_tile

        return verify_tile(
            db, tile_id, output_dir, use_google=use_google,
        )

    def _finish(self, scope: str, metrics: list[dict]) -> None:
        if self._finish_job_override is not None:
            self._finish_job_override(scope, metrics)
            return
        if scope == "regressions":
            import regression_cases

            cases = regression_cases.load_cases()
            baked = [
                (case, regression_cases._metrics_from_disk(case["tile"]))
                for case in cases
            ]
            regression_cases.build_gallery(baked)
            return
        from classifier_verify import OUT_DIR, build_gallery

        build_gallery(OUT_DIR, metrics)

    def _run(self, scope: str, tiles: list[str], use_google: bool) -> None:
        metrics: list[dict] = []
        db: sqlite3.Connection | None = None
        try:
            with self._lock:
                self._state["status"] = "running"
                self._append_recent("Classifier worker started")
            db = sqlite3.connect(str(self.db_path), timeout=30)
            db.execute("PRAGMA busy_timeout=30000")
            output_dir = self._default_output_dir(scope)
            os.makedirs(output_dir, exist_ok=True)

            for tile_id in tiles:
                with self._lock:
                    self._state["currentTile"] = tile_id
                    self._append_recent(f"Classifying {tile_id}")
                try:
                    result = self._verify(
                        db,
                        tile_id,
                        output_dir,
                        use_google=use_google,
                    )
                except Exception as exc:
                    message = f"{type(exc).__name__}: {exc}"
                    with self._lock:
                        self._state["failed"] += 1
                        self._state["errors"].append({
                            "tile": tile_id,
                            "message": message,
                        })
                        self._state["errors"] = self._state["errors"][-50:]
                        self._append_recent(f"{tile_id} failed: {message}")
                else:
                    with self._lock:
                        if result is None:
                            self._state["skipped"] += 1
                            self._append_recent(f"{tile_id} skipped: inputs not ready")
                        else:
                            metrics.append(result)
                            self._state["succeeded"] += 1
                            self._append_recent(f"{tile_id} complete")
                finally:
                    with self._lock:
                        self._state["processed"] += 1

            self._finish(scope, metrics)
            with self._lock:
                self._state["status"] = "complete"
                self._state["currentTile"] = None
                self._state["completedAt"] = _utc_now()
                self._append_recent("Job complete")
        except Exception as exc:
            with self._lock:
                self._state["status"] = "error"
                self._state["currentTile"] = None
                self._state["completedAt"] = _utc_now()
                self._state["error"] = f"{type(exc).__name__}: {exc}"
                self._append_recent(f"Job stopped: {self._state['error']}")
        finally:
            if db is not None:
                db.close()


def classifier_inventory(db: sqlite3.Connection) -> dict[str, Any]:
    """Summarize persisted classifier coverage for the operations page."""
    from classifier.vote_ladder import LADDER_SOURCE

    rows = [
        {
            "schema": str(schema),
            "source": str(source),
            "count": int(count),
            "current": str(source) == LADDER_SOURCE,
        }
        for schema, source, count in db.execute(
            "SELECT class_schema, source, COUNT(*) FROM classifier_tiles "
            "GROUP BY class_schema, source ORDER BY COUNT(*) DESC"
        )
    ]
    ready_d12 = int(db.execute(
        "SELECT COUNT(*) FROM textures x JOIN tiles t ON t.tile_id=x.tile_id "
        "WHERE x.tile_id LIKE '12-%' "
        "AND x.source NOT LIKE '%procedural%' "
        "AND x.source NOT IN ('ancestor_crop', 'placeholder') "
        "AND t.heightmap IS NOT NULL"
    ).fetchone()[0])
    total = sum(row["count"] for row in rows)
    current = sum(row["count"] for row in rows if row["current"])
    covered_d12 = int(db.execute(
        "SELECT COUNT(*) FROM classifier_tiles c JOIN tiles t USING(tile_id) "
        "WHERE t.depth=12 AND c.source=?",
        (LADDER_SOURCE,),
    ).fetchone()[0])
    return {
        "currentSource": LADDER_SOURCE,
        "totalRows": total,
        "currentRows": current,
        "legacyRows": total - current,
        "readyD12": ready_d12,
        "coveredD12": covered_d12,
        "coveragePct": (
            round(100.0 * covered_d12 / ready_d12, 2) if ready_d12 else 0.0
        ),
        "sources": rows,
    }


def regression_case_summaries() -> list[dict[str, Any]]:
    import regression_cases

    summaries = []
    for case in regression_cases.load_cases():
        tile_id = str(case.get("tile", ""))
        metrics_path = Path(regression_cases.OUT_DIR) / tile_id / "metrics.json"
        metrics = None
        if metrics_path.exists():
            try:
                with metrics_path.open() as handle:
                    metrics = json.load(handle)
            except (OSError, ValueError):
                metrics = None
        summaries.append({
            "tile": tile_id,
            "note": str(case.get("note", "")),
            "flaggedAt": case.get("flagged_at"),
            "baked": metrics is not None,
            "metrics": metrics,
            "textureUrl": (
                f"/api/regression/{tile_id}/step_01_texture.png"
                if metrics is not None else None
            ),
            "classifierUrl": (
                f"/api/regression/{tile_id}/step_12_final.png"
                if metrics is not None else None
            ),
        })
    return summaries
