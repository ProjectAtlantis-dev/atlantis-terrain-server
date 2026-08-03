import unittest
from pathlib import Path

from gtk50_demand import Gtk50BlockDemand


class _Clock:
    def __init__(self) -> None:
        self.now = 0.0

    def __call__(self) -> float:
        return self.now


def _scheduler(
    *,
    present=(),
    offered=("72_-1", "73_-1"),
    creds="user:pass",
    download=None,
    clock=None,
    retry_after_s=300.0,
    unusable=(),
    refresh_summary=None,
):
    """Scheduler wired to fakes, running downloads inline for determinism."""
    state = {
        "present": set(present),
        "downloaded": [],
        "discarded": [],
        "listings": 0,
        "refreshes": 0,
    }
    clock = clock or _Clock()

    def do_download(block, _creds):
        if download is not None:
            download(block)
        state["downloaded"].append(block)
        state["present"].add(block)

    def listing(_creds):
        state["listings"] += 1
        return {block: 60_000_000 for block in offered}

    def refresh(block):
        state["refreshes"] += 1
        state.setdefault("refreshed_blocks", []).append(block)
        return refresh_summary

    def discard(block):
        state["discarded"].append(block)
        state["present"].discard(block)

    scheduler = Gtk50BlockDemand(
        credentials=lambda: creds,
        listing=listing,
        download=do_download,
        refresh=refresh,
        block_exists=lambda block: block in state["present"],
        block_usable=lambda block: block not in unusable,
        discard=discard,
        retry_after_s=retry_after_s,
        clock=clock,
    )
    # Run submitted work on the calling thread so assertions are not racy.
    scheduler._pool.submit = lambda fn, *a, **kw: fn(*a, **kw)  # noqa: SLF001
    return scheduler, state, clock


class Gtk50DemandTests(unittest.TestCase):
    def test_disabled_by_default_so_cli_and_tests_never_download(self):
        scheduler, state, _ = _scheduler()
        self.assertEqual(scheduler.request(["72_-1"]), [])
        self.assertEqual(state["downloaded"], [])

    def test_downloads_a_demanded_block_and_rebuilds_its_masks(self):
        scheduler, state, _ = _scheduler()
        scheduler.enable()

        self.assertEqual(scheduler.request(["72_-1"]), ["72_-1"])
        self.assertEqual(state["downloaded"], ["72_-1"])
        # Masks baked while the block was absent used WMS hydrography, so they
        # have to be rebuilt or the fjord stays wrong until the next restart.
        self.assertEqual(state["refreshes"], 1)

    def test_blocks_the_ftp_does_not_offer_are_not_retried(self):
        scheduler, state, _ = _scheduler(offered=("72_-1",))
        scheduler.enable()

        # Ice sheet and far ocean blocks simply do not exist upstream; a tile
        # over them must not re-trigger an FTP listing on every request.
        self.assertEqual(scheduler.request(["99_-9"]), ["99_-9"])
        self.assertEqual(scheduler.request(["99_-9"]), [])
        self.assertEqual(state["downloaded"], [])
        self.assertEqual(state["listings"], 1)

    def test_failed_downloads_back_off_then_retry(self):
        clock = _Clock()
        attempts = []

        def failing(block):
            attempts.append(block)
            raise RuntimeError("ftp unreachable")

        scheduler, _, _ = _scheduler(
            download=failing, clock=clock, retry_after_s=300.0
        )
        scheduler.enable()

        self.assertEqual(scheduler.request(["72_-1"]), ["72_-1"])
        # Immediately re-demanded by the next tile request: must not hammer.
        self.assertEqual(scheduler.request(["72_-1"]), [])
        clock.now += 299.0
        self.assertEqual(scheduler.request(["72_-1"]), [])
        clock.now += 2.0
        self.assertEqual(scheduler.request(["72_-1"]), ["72_-1"])
        self.assertEqual(len(attempts), 2)

    def test_missing_credentials_backs_off_instead_of_looping(self):
        scheduler, state, clock = _scheduler(creds=None)
        scheduler.enable()

        self.assertEqual(scheduler.request(["72_-1"]), ["72_-1"])
        self.assertEqual(state["downloaded"], [])
        self.assertEqual(state["listings"], 0)
        # The startup guard already logs the missing login loudly; this path
        # must not repeat it per tile.
        self.assertEqual(scheduler.request(["72_-1"]), [])

    def test_already_local_blocks_are_never_queued(self):
        scheduler, state, _ = _scheduler(present=("72_-1",))
        scheduler.enable()
        self.assertEqual(scheduler.request(["72_-1"]), [])
        self.assertEqual(state["downloaded"], [])

    def test_repeated_demand_is_deduplicated_within_one_call(self):
        scheduler, state, _ = _scheduler()
        scheduler.enable()
        self.assertEqual(
            scheduler.request(["72_-1", "72_-1", "73_-1"]), ["72_-1", "73_-1"]
        )
        self.assertEqual(state["downloaded"], ["72_-1", "73_-1"])

    def test_refresh_is_scoped_to_the_block_that_arrived(self):
        scheduler, state, _ = _scheduler()
        scheduler.enable()
        scheduler.request(["72_-1"])
        # A full-table re-derive per download is minutes of work to repair a
        # handful of tiles, and downloads are now routine.
        self.assertEqual(state["refreshed_blocks"], ["72_-1"])

    def test_listing_is_cached_across_demands(self):
        scheduler, state, _ = _scheduler()
        scheduler.enable()
        scheduler.request(["72_-1"])
        scheduler.request(["73_-1"])
        self.assertEqual(state["downloaded"], ["72_-1", "73_-1"])
        self.assertEqual(state["listings"], 1)


    def test_a_block_that_does_not_parse_is_discarded_and_retried(self):
        clock = _Clock()
        scheduler, state, _ = _scheduler(
            unusable=("72_-1",), clock=clock, retry_after_s=300.0
        )
        scheduler.enable()

        scheduler.request(["72_-1"])
        # A corrupt block rasterises as solid land and, left on disk, would be
        # treated as present forever. It must not survive.
        self.assertEqual(state["discarded"], ["72_-1"])
        self.assertNotIn("72_-1", state["present"])
        # And it must not be trusted enough to trigger a mask rebuild.
        self.assertEqual(state["refreshes"], 0)

        clock.now += 301.0
        self.assertEqual(scheduler.request(["72_-1"]), ["72_-1"])

    def test_masks_still_on_wms_after_a_block_lands_are_reported(self):
        clock = _Clock()
        scheduler, state, _ = _scheduler(
            refresh_summary={"rebuilt": 9, "vector": 7, "fallback": 2},
            clock=clock,
        )
        scheduler.enable()
        with self.assertLogs("terrain.gtk50.demand", level="ERROR") as captured:
            scheduler.request(["72_-1"])
        # Arriving is not the same as working; a block can land and still leave
        # tiles untrusted, which must never pass silently.
        self.assertTrue(any("still on WMS" in line for line in captured.output))
        self.assertEqual(state["refreshes"], 1)
        # A reported fallback is incomplete work, not a successful refresh.
        self.assertEqual(scheduler.request(["72_-1"]), [])
        clock.now += 301.0
        self.assertEqual(scheduler.request(["72_-1"]), ["72_-1"])
        self.assertEqual(state["downloaded"], ["72_-1"])

    def test_a_fully_converted_rebuild_reports_no_error(self):
        scheduler, _, _ = _scheduler(
            refresh_summary={"rebuilt": 9, "vector": 9, "fallback": 0}
        )
        scheduler.enable()
        with self.assertLogs("terrain.gtk50.demand", level="INFO") as captured:
            scheduler.request(["72_-1"])
        self.assertFalse(any("ERROR" in line for line in captured.output))
        self.assertTrue(
            any("all vector-sourced" in line for line in captured.output)
        )


class Gtk50DownloadAtomicityTests(unittest.TestCase):
    """A failed transfer must leave no file the next check would trust."""

    def test_failed_download_leaves_no_partial_block(self):
        import subprocess
        import tempfile
        from unittest import mock

        import ingest_coastline
        from gtk50_vector import block_path

        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "GL50_Vektordata_100km_72_-1.gpkg"

            def fake_run(cmd, **kwargs):
                # curl writes some bytes, then the transfer dies.
                out = Path(cmd[cmd.index("-o") + 1])
                out.write_bytes(b"partial")
                raise subprocess.CalledProcessError(18, cmd)

            with mock.patch.object(ingest_coastline, "block_path", return_value=target), \
                 mock.patch.object(subprocess, "run", side_effect=fake_run):
                with self.assertRaises(subprocess.CalledProcessError):
                    ingest_coastline._download_block("72_-1", "user:pass")

            # The visible path must be absent, not a truncated file that every
            # later existence check would treat as a complete block.
            self.assertFalse(target.exists())
            self.assertFalse(target.with_suffix(target.suffix + ".part").exists())

    def test_successful_download_is_renamed_into_place(self):
        import subprocess
        import tempfile
        from unittest import mock

        import ingest_coastline

        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "GL50_Vektordata_100km_72_-1.gpkg"

            def fake_run(cmd, **kwargs):
                out = Path(cmd[cmd.index("-o") + 1])
                out.write_bytes(b"complete block")
                return subprocess.CompletedProcess(cmd, 0)

            with mock.patch.object(ingest_coastline, "block_path", return_value=target), \
                 mock.patch.object(subprocess, "run", side_effect=fake_run):
                ingest_coastline._download_block("72_-1", "user:pass")

            self.assertEqual(target.read_bytes(), b"complete block")
            self.assertFalse(target.with_suffix(target.suffix + ".part").exists())


class Gtk50BlockCacheTests(unittest.TestCase):
    """A block downloaded mid-flight must not stay memoised as missing."""

    def test_clear_block_cache_drops_a_memoised_miss(self):
        import gtk50_vector

        # A server serving tiles over a block while it downloads caches the
        # miss. If that survives into the rebuild, the refresh skips exactly
        # the tiles the download was meant to repair — and does so silently,
        # because a skipped tile simply keeps its old WMS mask.
        gtk50_vector._block_cache["72_-1"] = None  # noqa: SLF001
        gtk50_vector.clear_block_cache()
        self.assertNotIn("72_-1", gtk50_vector._block_cache)  # noqa: SLF001

    def test_refresh_clears_the_cache_before_rebuilding(self):
        import inspect

        import ingest_coastline

        source = inspect.getsource(ingest_coastline._refresh_cached_masks)
        # Every download path reaches the rebuild through this function, so the
        # invalidation has to live here rather than in each caller.
        self.assertIn("clear_block_cache()", source)
        self.assertLess(
            source.index("clear_block_cache()"),
            source.index("cache_official_water_mask(db"),
            "cache must be cleared before any mask is rebuilt",
        )

    def test_startup_recovers_fallback_rows_covered_by_local_blocks(self):
        """Refresh debt must survive a crash after the block rename."""
        from unittest import mock

        import ingest_coastline

        with (
            mock.patch.object(
                ingest_coastline, "_local_block_ids", return_value=["72_-1"],
            ),
            mock.patch.object(
                ingest_coastline, "_refresh_cached_masks",
            ) as refresh,
            mock.patch("terrain_config.GTK50_BLOCKS", []),
        ):
            ingest_coastline.ensure_gtk50_blocks()

        refresh.assert_called_once_with(["72_-1"], fallback_only=True)


class Gtk50RefreshRetryTests(unittest.TestCase):
    """A download that lands but fails to rebuild must not strand its masks."""

    def test_failed_refresh_is_retried_without_redownloading(self):
        attempts = {"refresh": 0}

        def flaky_refresh_scheduler():
            state = {"present": set(), "downloaded": [], "listings": 0}

            def download(block, _creds):
                state["downloaded"].append(block)
                state["present"].add(block)

            def refresh(block):
                attempts["refresh"] += 1
                if attempts["refresh"] == 1:
                    # A transient SQLite lock is enough to land here.
                    raise RuntimeError("database is locked")
                return {"rebuilt": 3, "vector": 3, "fallback": 0}

            scheduler = Gtk50BlockDemand(
                credentials=lambda: "user:pass",
                listing=lambda _c: {"72_-1": 60_000_000},
                download=download,
                refresh=refresh,
                block_exists=lambda b: b in state["present"],
                block_usable=lambda b: True,
                discard=lambda b: state["present"].discard(b),
                retry_after_s=0.0,
                clock=_Clock(),
            )
            scheduler._pool.submit = lambda fn, *a, **kw: fn(*a, **kw)  # noqa: SLF001
            return scheduler, state

        scheduler, state = flaky_refresh_scheduler()
        scheduler.enable()

        scheduler.request(["72_-1"])
        self.assertEqual(state["downloaded"], ["72_-1"])
        self.assertEqual(attempts["refresh"], 1)

        # The block is on disk now, so a missing-blocks query returns nothing.
        # Without tracking refresh separately this retry never happens and
        # every mask the block covers stays on WMS permanently.
        self.assertEqual(scheduler.request(["72_-1"]), ["72_-1"])
        self.assertEqual(attempts["refresh"], 2)
        # And the retry must not re-fetch 60 MB to redo a database operation.
        self.assertEqual(state["downloaded"], ["72_-1"])

    def test_once_refreshed_a_present_block_is_left_alone(self):
        scheduler, state, _ = _scheduler(
            refresh_summary={"rebuilt": 1, "vector": 1, "fallback": 0}
        )
        scheduler.enable()
        scheduler.request(["72_-1"])
        self.assertEqual(scheduler.request(["72_-1"]), [])
        self.assertEqual(state["downloaded"], ["72_-1"])


class Gtk50ConcurrentDownloadTests(unittest.TestCase):
    """Startup seeding and demand can want the same block simultaneously."""

    def test_concurrent_downloads_do_not_share_a_staging_file(self):
        import subprocess
        import tempfile
        import threading
        from unittest import mock

        import ingest_coastline

        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "GL50_Vektordata_100km_72_-1.gpkg"
            staging_names = []
            barrier = threading.Barrier(2, timeout=5)

            def fake_run(cmd, **kwargs):
                out = Path(cmd[cmd.index("-o") + 1])
                staging_names.append(out.name)
                out.write_bytes(b"complete block")
                return subprocess.CompletedProcess(cmd, 0)

            def worker():
                barrier.wait()
                ingest_coastline._download_block("72_-1", "user:pass")

            with mock.patch.object(ingest_coastline, "block_path", return_value=target), \
                 mock.patch.object(subprocess, "run", side_effect=fake_run):
                threads = [threading.Thread(target=worker) for _ in range(2)]
                for thread in threads:
                    thread.start()
                for thread in threads:
                    thread.join()

            # The per-block lock means the second waiter sees the finished file
            # and skips entirely, so only one transfer happens. Two curls
            # sharing one .part name is what truncates a block.
            self.assertEqual(len(staging_names), 1)
            self.assertEqual(len(set(staging_names)), len(staging_names))
            self.assertEqual(target.read_bytes(), b"complete block")
            self.assertEqual(list(Path(tmp).glob("*.part")), [])

    def test_staging_name_is_unique_per_attempt(self):
        import subprocess
        import tempfile
        from unittest import mock

        import ingest_coastline

        seen = []
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "GL50_Vektordata_100km_72_-1.gpkg"

            def fake_run(cmd, **kwargs):
                out = Path(cmd[cmd.index("-o") + 1])
                seen.append(out.name)
                raise subprocess.CalledProcessError(18, cmd)

            with mock.patch.object(ingest_coastline, "block_path", return_value=target), \
                 mock.patch.object(subprocess, "run", side_effect=fake_run):
                for _ in range(2):
                    with self.assertRaises(subprocess.CalledProcessError):
                        ingest_coastline._download_block("72_-1", "user:pass")

            # Distinct staging paths mean a second process cannot clobber or
            # unlink the first one's in-flight transfer.
            self.assertEqual(len(set(seen)), 2)
            self.assertFalse(target.exists())


if __name__ == "__main__":
    unittest.main()
