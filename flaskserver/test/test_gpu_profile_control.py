import os
import unittest

os.environ.setdefault("DATAFORSYNINGEN_TOKEN", "test-token")

from gpu_profile_control import GpuProfileControl
import serve_flask


class GpuProfileControlTest(unittest.TestCase):
  def test_start_stop_and_complete_report(self):
    control = GpuProfileControl()

    started = control.start(5)
    self.assertEqual(started["status"], "starting")
    self.assertTrue(started["desiredEnabled"])
    self.assertEqual(started["sampleInterval"], 5)

    running = control.report(
      profile_id=started["profileId"],
      phase="running",
      client={"backend": "webgl", "supported": True},
    )
    self.assertEqual(running["status"], "running")
    self.assertEqual(running["client"]["backend"], "webgl")

    stopping = control.stop()
    self.assertEqual(stopping["status"], "stopping")
    self.assertFalse(stopping["desiredEnabled"])

    complete = control.report(
      profile_id=started["profileId"],
      phase="complete",
      result={"wholeFrameAverageMs": 8.25, "passes": {}},
    )
    self.assertEqual(complete["status"], "complete")
    self.assertEqual(complete["result"]["wholeFrameAverageMs"], 8.25)
    self.assertIsNotNone(complete["completedAt"])

  def test_rejects_conflicting_commands_and_stale_reports(self):
    control = GpuProfileControl()
    started = control.start()

    with self.assertRaisesRegex(RuntimeError, "already active"):
      control.start()
    with self.assertRaisesRegex(LookupError, "does not match"):
      control.report(profile_id="stale", phase="running")

    control.stop()
    with self.assertRaisesRegex(RuntimeError, "no GPU profile"):
      control.stop()
    with self.assertRaisesRegex(RuntimeError, "already active"):
      control.start()
    with self.assertRaisesRegex(RuntimeError, "asked to stop"):
      control.report(profile_id=started["profileId"], phase="running")


class GpuProfileEndpointTest(unittest.TestCase):
  def setUp(self):
    serve_flask._gpu_profile_control = GpuProfileControl()
    self.client = serve_flask.app.test_client()

  def test_http_control_round_trip(self):
    response = self.client.post(
      "/api/gpu-profile/start",
      json={"sampleInterval": 3},
    )
    self.assertEqual(response.status_code, 202)
    started = response.get_json()

    response = self.client.post(
      "/api/gpu-profile/report",
      json={
        "profileId": started["profileId"],
        "phase": "running",
        "client": {"backend": "webgl", "supported": True},
      },
    )
    self.assertEqual(response.status_code, 200)
    self.assertEqual(response.get_json()["status"], "running")

    self.assertEqual(
      self.client.post("/api/gpu-profile/stop").status_code,
      202,
    )
    response = self.client.post(
      "/api/gpu-profile/report",
      json={
        "profileId": started["profileId"],
        "phase": "complete",
        "result": {"wholeFrameAverageMs": 4.5, "passes": {}},
      },
    )
    self.assertEqual(response.status_code, 200)

    response = self.client.get("/api/gpu-profile")
    self.assertEqual(response.status_code, 200)
    self.assertEqual(response.headers["Cache-Control"], "no-store")
    self.assertEqual(response.get_json()["status"], "complete")

  def test_start_validates_sample_interval(self):
    response = self.client.post(
      "/api/gpu-profile/start",
      json={"sampleInterval": 0},
    )
    self.assertEqual(response.status_code, 400)
