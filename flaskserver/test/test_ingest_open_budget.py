import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from contextlib import nullcontext
from unittest.mock import patch

import ingest


class RemoteCogOpenBudgetTests(unittest.TestCase):
    def setUp(self):
        self._original_slots = ingest._remote_cog_open_slots

    def tearDown(self):
        ingest._remote_cog_open_slots = self._original_slots

    def test_budget_allows_multiple_datasets_in_parallel(self):
        ingest._remote_cog_open_slots = threading.BoundedSemaphore(2)
        both_open = threading.Barrier(2, timeout=2)

        def consume(url):
            with ingest._open_remote_cog(url):
                both_open.wait()

        with patch.object(ingest.rasterio, "open", side_effect=lambda _: nullcontext(object())):
            with ThreadPoolExecutor(max_workers=2) as pool:
                futures = [pool.submit(consume, f"cog-{index}") for index in range(2)]
                for future in futures:
                    future.result(timeout=3)

    def test_budget_slot_is_released_when_consumer_raises(self):
        slots = threading.BoundedSemaphore(1)
        ingest._remote_cog_open_slots = slots

        with patch.object(ingest.rasterio, "open", return_value=nullcontext(object())):
            with self.assertRaisesRegex(RuntimeError, "consumer failed"):
                with ingest._open_remote_cog("cog"):
                    raise RuntimeError("consumer failed")

        self.assertTrue(slots.acquire(blocking=False))
        slots.release()


if __name__ == "__main__":
    unittest.main()
