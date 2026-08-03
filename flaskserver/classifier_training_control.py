"""Single-process background control for long-running neural training."""
from __future__ import annotations

import datetime
import threading
from pathlib import Path


class ClassifierTrainingControl:
    def __init__(self):
        self._lock = threading.Lock()
        self._thread: threading.Thread | None = None
        self._state: dict = {"status": "idle"}

    def status(self) -> dict:
        with self._lock:
            return dict(self._state)

    def start(self, **options) -> dict:
        with self._lock:
            if self._thread is not None and self._thread.is_alive():
                return dict(self._state)
            now = datetime.datetime.now(datetime.timezone.utc).isoformat()
            safe_options = {
                key: str(value) if isinstance(value, Path) else value
                for key, value in options.items()
            }
            self._state = {
                "status": "running", "startedAt": now, "options": safe_options,
            }
            self._thread = threading.Thread(
                target=self._run, kwargs=options, daemon=True,
                name="classifier-neural-training",
            )
            self._thread.start()
            return dict(self._state)

    def _run(self, **options) -> None:
        try:
            from classifier.neural import train_model
            result = train_model(**options)
            state = {
                "status": "complete", "startedAt": self._state.get("startedAt"),
                "completedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                "result": result,
            }
        except Exception as exc:  # visible through the status API
            state = {
                "status": "failed", "startedAt": self._state.get("startedAt"),
                "completedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                "error": f"{type(exc).__name__}: {exc}",
            }
        with self._lock:
            self._state = state
