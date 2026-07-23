"""User-curated regression case store: flag, dedupe, gallery."""

import json
import os
import tempfile
import unittest
from unittest.mock import patch

os.environ.setdefault("DATAFORSYNINGEN_TOKEN", "test-token")

import regression_cases


class CaseStore(unittest.TestCase):
    def setUp(self):
        self._dir = tempfile.TemporaryDirectory()
        self.cases_path = os.path.join(self._dir.name, "cases.json")
        self.out_dir = os.path.join(self._dir.name, "gallery")
        self.patches = [
            patch.object(regression_cases, "CASES_PATH", self.cases_path),
            patch.object(regression_cases, "OUT_DIR", self.out_dir),
        ]
        for item in self.patches:
            item.start()

    def tearDown(self):
        for item in self.patches:
            item.stop()
        self._dir.cleanup()

    def test_flagging_twice_updates_instead_of_duplicating(self):
        regression_cases.add_case("12-1380-791", "green on the lake")
        cases = regression_cases.add_case("12-1380-791", "still wrong")
        self.assertEqual(len(cases), 1)
        self.assertEqual(cases[0]["note"], "still wrong")
        # A later flag with no note keeps the old note.
        cases = regression_cases.add_case("12-1380-791", "")
        self.assertEqual(cases[0]["note"], "still wrong")
        with open(self.cases_path) as handle:
            self.assertEqual(len(json.load(handle)), 1)

    def test_empty_gallery_builds_without_cases(self):
        regression_cases.build_gallery([])
        with open(os.path.join(self.out_dir, "index.html")) as handle:
            html = handle.read()
        self.assertIn("No cases yet", html)

    def test_gallery_shows_case_note_and_unbakeable_state(self):
        case = {"tile": "12-9999-9999", "note": "fjord edge is land"}
        regression_cases.build_gallery([(case, None)])
        with open(os.path.join(self.out_dir, "index.html")) as handle:
            html = handle.read()
        self.assertIn("fjord edge is land", html)
        self.assertIn("not bakeable", html)


if __name__ == "__main__":
    unittest.main()
