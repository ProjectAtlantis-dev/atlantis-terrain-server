import io
import json
import tempfile
import unittest
import urllib.error
import zipfile
from pathlib import Path
from unittest import mock

import grundkort
from grundkort import GrundkortDemand


def _write_source_archive(path: Path, *, dbf_day: int, road_marker: bytes = b""):
    with zipfile.ZipFile(path, "w") as archive:
        for layer in ("BYGNING", "VEJMIDTE", "STIMIDTE"):
            marker = road_marker if layer == "VEJMIDTE" else b""
            archive.writestr(f"{layer}.shp", b"geometry" + marker)
            archive.writestr(
                f"{layer}.dbf", bytes((3, 126, 7, dbf_day)) + b"records" + marker
            )
            archive.writestr(f"{layer}.prj", b"projection")


class _Response(io.BytesIO):
    def __init__(self, payload: bytes, headers: dict[str, str]):
        super().__init__(payload)
        self.headers = headers

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        self.close()


class GrundkortRefreshTests(unittest.TestCase):
    def test_content_digest_ignores_dbf_export_date(self):
        with tempfile.TemporaryDirectory() as directory:
            first = Path(directory) / "first.zip"
            second = Path(directory) / "second.zip"
            _write_source_archive(first, dbf_day=6)
            _write_source_archive(second, dbf_day=20)

            self.assertEqual(
                grundkort._archive_content_digest(first),
                grundkort._archive_content_digest(second),
            )

            _write_source_archive(second, dbf_day=20, road_marker=b"updated")
            self.assertNotEqual(
                grundkort._archive_content_digest(first),
                grundkort._archive_content_digest(second),
            )

    def test_archive_is_not_checked_more_than_once_a_week(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            target = root / "0600NUK_TekniskGrundkort_SHP.zip"
            _write_source_archive(target, dbf_day=6)
            digest = grundkort._archive_content_digest(target)
            grundkort._write_refresh_metadata(target, {
                "checkedAt": 100.0,
                "contentDigest": digest,
                "ingestedDigest": digest,
                "etag": '"source-v1"',
            })
            with (
                mock.patch.object(grundkort, "ZIP_DIR", root),
                mock.patch.object(grundkort.urllib.request, "urlopen") as urlopen,
            ):
                changed = grundkort._download_settlement(
                    "0600NUK_Nuuk",
                    now=100.0 + grundkort.REFRESH_INTERVAL_S - 1,
                )

            self.assertFalse(changed)
            urlopen.assert_not_called()

    def test_conditional_304_records_a_successful_weekly_check(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            target = root / "0600NUK_TekniskGrundkort_SHP.zip"
            _write_source_archive(target, dbf_day=6)
            digest = grundkort._archive_content_digest(target)
            grundkort._write_refresh_metadata(target, {
                "checkedAt": 1.0,
                "contentDigest": digest,
                "ingestedDigest": digest,
                "etag": '"source-v1"',
            })
            not_modified = urllib.error.HTTPError(
                "https://example.invalid/source.zip", 304, "Not Modified",
                {"ETag": '"source-v1"', "Last-Modified": "now"}, None,
            )
            with (
                mock.patch.object(grundkort, "ZIP_DIR", root),
                mock.patch.object(
                    grundkort.urllib.request, "urlopen", side_effect=not_modified
                ) as urlopen,
            ):
                changed = grundkort._download_settlement(
                    "0600NUK_Nuuk", now=grundkort.REFRESH_INTERVAL_S + 2,
                )

            self.assertFalse(changed)
            request = urlopen.call_args.args[0]
            self.assertEqual(request.get_header("If-none-match"), '"source-v1"')
            metadata = json.loads(
                grundkort._refresh_metadata_path(target).read_text(encoding="utf-8")
            )
            self.assertEqual(metadata["checkedAt"], grundkort.REFRESH_INTERVAL_S + 2)

    def test_republished_equivalent_archive_does_not_force_reingest(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            target = root / "0600NUK_TekniskGrundkort_SHP.zip"
            replacement = root / "replacement.zip"
            _write_source_archive(target, dbf_day=6)
            _write_source_archive(replacement, dbf_day=20)
            digest = grundkort._archive_content_digest(target)
            grundkort._write_refresh_metadata(target, {
                "checkedAt": 1.0,
                "contentDigest": digest,
                "ingestedDigest": digest,
                "etag": '"source-v1"',
            })
            payload = replacement.read_bytes()
            response = _Response(payload, {
                "Content-Length": str(len(payload)), "ETag": '"source-v2"',
                "Last-Modified": "later",
            })
            with (
                mock.patch.object(grundkort, "ZIP_DIR", root),
                mock.patch.object(
                    grundkort.urllib.request, "urlopen", return_value=response
                ),
            ):
                changed = grundkort._download_settlement(
                    "0600NUK_Nuuk", now=grundkort.REFRESH_INTERVAL_S + 2,
                )

            self.assertFalse(changed)
            self.assertEqual(
                grundkort._archive_content_digest(target), digest
            )


class _Clock:
    def __init__(self):
        self.now = 0.0

    def __call__(self):
        return self.now


class GrundkortDemandTests(unittest.TestCase):
    def _demand(self, *, loaded=(), acquire=None, clock=None):
        state = {"loaded": set(loaded), "acquired": []}

        def do_acquire(folder):
            if acquire is not None:
                acquire(folder)
            state["acquired"].append(folder)
            state["loaded"].add(folder)

        demand = GrundkortDemand(
            centres=(("near", 100.0, 100.0), ("far", 100_000.0, 100_000.0)),
            acquire=do_acquire,
            loaded=lambda folder: folder in state["loaded"],
            radius_m=1_000.0,
            retry_after_s=300.0,
            clock=clock or _Clock(),
        )
        demand._pool.submit = lambda fn, *args, **kwargs: fn(*args, **kwargs)
        return demand, state

    def test_disabled_scheduler_never_acquires(self):
        demand, state = self._demand()
        self.assertEqual(demand.request_for_point(100.0, 100.0), [])
        self.assertEqual(state["acquired"], [])

    def test_camera_position_only_acquires_nearby_unloaded_settlement(self):
        demand, state = self._demand()
        demand.enable()
        self.assertEqual(demand.request_for_point(100.0, 100.0), ["near"])
        self.assertEqual(state["acquired"], ["near"])
        self.assertEqual(demand.request_for_point(100.0, 100.0), [])
        self.assertEqual(demand.request_for_point(100_000.0, 100_000.0), ["far"])

    def test_failed_acquisition_backs_off_until_later_camera_demand(self):
        clock = _Clock()
        attempts = []

        def fail_once(folder):
            attempts.append(folder)
            if len(attempts) == 1:
                raise RuntimeError("offline")

        demand, state = self._demand(acquire=fail_once, clock=clock)
        demand.enable()
        self.assertEqual(demand.request_for_point(100.0, 100.0), ["near"])
        self.assertEqual(demand.request_for_point(100.0, 100.0), [])
        clock.now = 301.0
        self.assertEqual(demand.request_for_point(100.0, 100.0), ["near"])
        self.assertEqual(state["acquired"], ["near"])


if __name__ == "__main__":
    unittest.main()
