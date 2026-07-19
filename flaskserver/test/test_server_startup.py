import os
import unittest
from unittest.mock import MagicMock, patch

os.environ.setdefault("DATAFORSYNINGEN_TOKEN", "test-token")

import serve_flask


class ServerStartupTest(unittest.TestCase):
    def test_occupied_flask_port_aborts_startup(self):
        probe = MagicMock()
        probe.__enter__.return_value.bind.side_effect = OSError(48, "Address in use")

        with patch.object(serve_flask.socket, "socket", return_value=probe):
            with self.assertRaisesRegex(
                SystemExit, r"cannot bind to 127\.0\.0\.1:5180"
            ):
                serve_flask._require_available_port("127.0.0.1", 5180)

    def test_free_flask_port_passes_preflight(self):
        probe = MagicMock()

        with patch.object(serve_flask.socket, "socket", return_value=probe):
            serve_flask._require_available_port("127.0.0.1", 5180)

        probe.__enter__.return_value.bind.assert_called_once_with(
            ("127.0.0.1", 5180)
        )


if __name__ == "__main__":
    unittest.main()
