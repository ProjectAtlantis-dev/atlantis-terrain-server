"""Google-reference fetch failures remain distinguishable from code defects."""
import unittest
from unittest.mock import patch

from google_ref import google_reference


class GoogleReferenceFailureTest(unittest.TestCase):
    def test_cache_miss_is_an_expected_absence(self):
        with patch("google_ref._fetch_tile", side_effect=FileNotFoundError("missing")):
            self.assertIsNone(
                google_reference((-1000, -1000, 1000, 1000), size=2,
                                 allow_network=False)
            )

    def test_network_or_decode_failure_is_reported_as_unavailable(self):
        with patch("google_ref._fetch_tile", side_effect=OSError("offline")):
            self.assertIsNone(
                google_reference((-1000, -1000, 1000, 1000), size=2)
            )

    def test_unexpected_programming_error_is_not_buried(self):
        with patch("google_ref._fetch_tile", side_effect=RuntimeError("bug")):
            with self.assertRaisesRegex(RuntimeError, "bug"):
                google_reference((-1000, -1000, 1000, 1000), size=2)


if __name__ == "__main__":
    unittest.main()
