"""On-demand acquisition of GTK50 vector coastline blocks.

A tile's sea mask is only authoritative when every 100 km block covering its
bbox is on disk; ``gtk50_vector.vector_water_mask`` returns ``None`` otherwise
and the caller falls back to rendered-WMS hydrography, which cannot be trusted
as sea because it includes lakes and watercourses.

The blocks a tile needs are computable from its bbox, so there is nothing to
predeclare. Previously ``terrain_config.GTK50_BLOCKS`` was a static allowlist:
fly outside the two preloaded blocks and every tile there silently degraded to
WMS forever, with the startup guard still reporting success because the list it
checked was satisfied. This records the demand instead, downloads the block in
the background, and rebuilds the masks it covers.

Blocks the FTP does not offer at all (ice sheet, far ocean) are remembered so a
tile over the ice cap cannot re-trigger a listing on every request.
"""
from __future__ import annotations

import threading
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Callable, Iterable

from colored_log import get_logger
from gtk50_vector import (
    block_is_usable,
    block_path,
    invalidate_block_cache,
    missing_blocks_for_bbox,
)

log_demand = get_logger("terrain.gtk50.demand")

# A failed download is usually the FTP being unreachable, so back off rather
# than retry on every tile request that touches the block.
RETRY_AFTER_S = 300.0
# The remote listing is one FTP round trip and the catalogue is immutable in
# practice; hold it long enough that a burst of demands shares one call.
LISTING_TTL_S = 1800.0


class Gtk50BlockDemand:
    """Background downloader for coastline blocks discovered at render time."""

    def __init__(
        self,
        *,
        credentials: Callable[[], str | None],
        listing: Callable[[str], dict[str, int]],
        download: Callable[[str, str], None],
        refresh: Callable[[str], dict | None],
        block_exists: Callable[[str], bool] | None = None,
        block_usable: Callable[[str], bool] | None = None,
        discard: Callable[[str], None] | None = None,
        workers: int = 1,
        retry_after_s: float = RETRY_AFTER_S,
        listing_ttl_s: float = LISTING_TTL_S,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._credentials = credentials
        self._listing = listing
        self._download = download
        self._refresh = refresh
        self._block_exists = block_exists or (lambda block: block_path(block).exists())
        self._block_usable = block_usable or block_is_usable
        self._discard = discard or (
            lambda block: block_path(block).unlink(missing_ok=True)
        )
        self._retry_after_s = retry_after_s
        self._listing_ttl_s = listing_ttl_s
        self._clock = clock
        # Serialised on purpose: blocks are ~60 MB and the FTP is the
        # bottleneck, so parallel fetches only slow each other down.
        self._pool = ThreadPoolExecutor(max_workers=max(1, workers))
        self._lock = threading.RLock()
        self._inflight: set[str] = set()
        self._unavailable: set[str] = set()
        self._failed_at: dict[str, float] = {}
        # Downloading and rebuilding are separate completions. A block whose
        # transfer succeeded but whose mask rebuild failed — a transient SQLite
        # lock is enough — is on disk, so it is no longer "missing" and both the
        # existence check and missing_blocks_for_bbox would skip it forever,
        # stranding every mask it covers on WMS. Blocks land here until their
        # refresh has actually succeeded.
        self._needs_refresh: set[str] = set()
        self._listing_cache: dict[str, int] | None = None
        self._listing_at = float("-inf")
        self._enabled = False

    def enable(self) -> None:
        with self._lock:
            self._enabled = True

    @property
    def enabled(self) -> bool:
        with self._lock:
            return self._enabled

    def request_for_bbox(self, bbox) -> list[str]:
        """Queue whatever blocks this bbox needs and does not have.

        Blocks already on disk whose rebuild never completed are included too:
        they are not missing, so a purely missing-based query would never
        retry them and their masks would stay on WMS permanently.
        """
        blocks = list(missing_blocks_for_bbox(bbox))
        with self._lock:
            pending_refresh = [b for b in self._needs_refresh if b not in blocks]
        return self.request(blocks + pending_refresh)

    def request(self, blocks: Iterable[str]) -> list[str]:
        """Queue missing blocks; returns the ids actually scheduled."""
        scheduled: list[str] = []
        with self._lock:
            if not self._enabled:
                return scheduled
            now = self._clock()
            for block in dict.fromkeys(blocks):
                if block in self._inflight or block in self._unavailable:
                    continue
                # A present block still needs scheduling when its refresh is
                # outstanding — that is the retry path for a failed rebuild.
                if self._block_exists(block) and block not in self._needs_refresh:
                    continue
                failed_at = self._failed_at.get(block)
                if failed_at is not None and now - failed_at < self._retry_after_s:
                    continue
                self._inflight.add(block)
                scheduled.append(block)
        for block in scheduled:
            log_demand.info(f"[gtk50-demand] {block}: queued from tile demand")
            self._pool.submit(self._run, block)
        return scheduled

    def _available(self, creds: str) -> dict[str, int]:
        with self._lock:
            # Bound locally so the not-None check narrows the value actually
            # returned; routing it through a separate `fresh` flag lost that,
            # leaving an Optional escaping a non-Optional return.
            cached = self._listing_cache
            if (
                cached is not None
                and self._clock() - self._listing_at < self._listing_ttl_s
            ):
                return cached
        listing = self._listing(creds)
        with self._lock:
            self._listing_cache = listing
            self._listing_at = self._clock()
        return listing

    def _run(self, block: str) -> None:
        try:
            # Retry path: the transfer already succeeded, only the rebuild is
            # outstanding. Re-downloading a 60 MB block to redo a database
            # operation would be pure waste.
            with self._lock:
                refresh_only = (
                    block in self._needs_refresh and self._block_exists(block)
                )
            if refresh_only:
                self._finish_refresh(block)
                return

            creds = self._credentials()
            if creds is None:
                # Logged loudly once by the startup guard; do not repeat it per
                # tile. Treat as a normal failure so the backoff applies.
                self._note_failure(block, "no Dataforsyningen login configured")
                return
            available = self._available(creds)
            if block not in available:
                with self._lock:
                    self._unavailable.add(block)
                log_demand.info(
                    f"[gtk50-demand] {block}: not offered by FTP (ice/ocean), "
                    "staying on WMS hydrography"
                )
                return
            started = self._clock()
            self._download(block, creds)
            # The parsed-geometry cache memoises the miss as None, so without
            # this the freshly downloaded block still reads as absent until the
            # process restarts.
            invalidate_block_cache(block)
            # A block that exists but does not parse is worse than a missing
            # one: it rasterises as solid land and never retries. Drop it and
            # take the backoff instead of trusting the file.
            if not self._block_usable(block):
                self._discard(block)
                self._note_failure(block, "downloaded block did not parse")
                return
            log_demand.info(
                f"[gtk50-demand] {block}: downloaded "
                f"({available[block] / 1e6:.0f} MB in {self._clock() - started:.0f}s)"
            )
            with self._lock:
                self._failed_at.pop(block, None)
                # Owed from the moment the file lands, cleared only once the
                # rebuild actually succeeds.
                self._needs_refresh.add(block)
            self._finish_refresh(block)
        except Exception as exc:  # pragma: no cover - network/FS failure path
            self._note_failure(block, f"{type(exc).__name__}: {exc}")
        finally:
            with self._lock:
                self._inflight.discard(block)

    def _finish_refresh(self, block: str) -> None:
        """Rebuild the masks this block covers, clearing the debt on success."""
        # Scoped to this block: a full-table re-derive per download is minutes
        # of work to repair a handful of tiles.
        summary = self._refresh(block) or {}
        fallback = summary.get("fallback", 0)
        if fallback:
            # A function return is not success when it explicitly reports
            # untrusted rows. Keep the refresh debt and apply the normal
            # backoff so later demand retries without hot-looping.
            with self._lock:
                self._needs_refresh.add(block)
                self._failed_at[block] = self._clock()
            # The block arrived but some tiles it covers still are not
            # vector-sourced. Silence here is what let a wrong fjord look
            # normal for weeks, so say so loudly.
            log_demand.error(
                f"[gtk50-demand] {block}: {fallback} of "
                f"{summary.get('rebuilt', 0)} rebuilt tiles are still on WMS "
                "hydrography — coastline for those remains untrusted; "
                f"retrying in {self._retry_after_s:.0f}s"
            )
            return
        with self._lock:
            self._needs_refresh.discard(block)
            self._failed_at.pop(block, None)
        if summary.get("rebuilt"):
            log_demand.info(
                f"[gtk50-demand] {block}: rebuilt {summary['rebuilt']} masks, "
                "all vector-sourced"
            )

    def _note_failure(self, block: str, reason: str) -> None:
        with self._lock:
            self._failed_at[block] = self._clock()
        log_demand.warning(
            f"[gtk50-demand] {block}: {reason} — retrying in "
            f"{self._retry_after_s:.0f}s"
        )

    def shutdown(self) -> None:
        self._pool.shutdown(wait=False)


def _build_default() -> Gtk50BlockDemand:
    # Imported lazily: ingest_coastline imports gtk50_vector, and the CLI must
    # stay usable without constructing a scheduler.
    def credentials() -> str | None:
        from ingest_coastline import _credentials

        return _credentials(strict=False)

    def listing(creds: str) -> dict[str, int]:
        from ingest_coastline import _remote_listing

        return _remote_listing(creds)

    def download(block: str, creds: str) -> None:
        from gtk50_vector import BLOCK_DIR
        from ingest_coastline import _download_block

        BLOCK_DIR.mkdir(exist_ok=True)
        _download_block(block, creds)

    def refresh(block: str) -> dict:
        from ingest_coastline import _refresh_cached_masks

        return _refresh_cached_masks([block])

    return Gtk50BlockDemand(
        credentials=credentials, listing=listing, download=download, refresh=refresh,
    )


_default: Gtk50BlockDemand | None = None
_default_lock = threading.Lock()


def default_demand() -> Gtk50BlockDemand:
    global _default
    with _default_lock:
        if _default is None:
            _default = _build_default()
        return _default


def enable() -> None:
    """Turn on background acquisition. Called from server startup.

    Left off by default so the ingest CLI and tests, which also build masks,
    never spawn downloads as a side effect.
    """
    default_demand().enable()


def request_for_bbox(bbox) -> list[str]:
    return default_demand().request_for_bbox(bbox)
