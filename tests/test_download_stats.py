import contextlib
from datetime import datetime, timezone
import io
import json
import os
from pathlib import Path
import runpy
import sys
from tempfile import mkdtemp
import unittest
from unittest.mock import Mock, patch
from urllib.error import HTTPError


MAIN = runpy.run_path(str(Path(__file__).resolve().parents[1] / "tools/download-stats.py"))["main"]
TODAY = "2026-11-24"
YESTERDAY = "2026-11-23"
EARLIER = "2026-11-22"
COMPLETE = "last_complete_scheduled_update"


class DownloadStatsTest(unittest.TestCase):
    def setUp(self):
        self.directory = Path(mkdtemp(prefix="dsh-a2ui-download-test-"))
        self.archive = self.directory / "history.json"
        self.chart = self.directory / "trend.png"
        self.npm = Mock(return_value={YESTERDAY: 52})
        self.releases = Mock(return_value={"123": 498})
        self.clones = Mock(return_value={YESTERDAY: 57})
        self.enterContext(patch.dict(MAIN.__globals__, {
            "datetime": Mock(now=Mock(return_value=datetime(2026, 11, 24, 4, tzinfo=timezone.utc))),
            "npm_counts": self.npm,
            "release_asset_counts": self.releases,
            "clone_counts": self.clones,
        }))
        self.enterContext(patch.object(sys, "argv", ["download-stats.py", str(self.directory)]))
        self.output = self.enterContext(contextlib.redirect_stdout(io.StringIO()))

    def refresh(self, event="schedule"):
        with patch.dict(os.environ, {"GITHUB_EVENT_NAME": event}):
            MAIN()
        return json.loads(self.archive.read_text(encoding="utf-8"))

    def test_npm_http_error_does_not_block_other_sources_on_first_run(self):
        self.npm.side_effect = HTTPError("https://api.npmjs.org", 503, "", {}, None)
        history = self.refresh()
        self.assertEqual(history["github_snapshots"], {TODAY: 498})
        self.assertEqual(history["github_clones_daily"], {YESTERDAY: 57})
        self.assertNotIn(COMPLETE, history)
        self.assertIn("npm refresh failed (HTTP 503)", self.output.getvalue())
        self.assertTrue(self.chart.read_bytes().startswith(b"\x89PNG\r\n\x1a\n"))

    def test_release_error_does_not_create_a_false_snapshot(self):
        self.archive.write_text(json.dumps({
            "npm_daily": {EARLIER: 55},
            "github_assets": {"123": 480},
            "github_snapshots": {EARLIER: 480},
        }), encoding="utf-8")
        self.releases.side_effect = TimeoutError()
        history = self.refresh()
        self.assertEqual(history["npm_daily"], {EARLIER: 55, YESTERDAY: 52})
        self.assertEqual(history["github_snapshots"], {EARLIER: 480})
        self.assertNotIn(COMPLETE, history)

    def test_late_sources_can_catch_up_and_duplicate_schedule_skips(self):
        self.npm.return_value = {EARLIER: 55}
        self.clones.return_value = {EARLIER: 93}
        self.assertNotIn(COMPLETE, self.refresh())
        self.npm.return_value = {YESTERDAY: 52}
        self.assertNotIn(COMPLETE, self.refresh())
        self.clones.return_value = {YESTERDAY: 0}
        self.assertEqual(self.refresh()[COMPLETE], TODAY)
        self.assertEqual(self.refresh()[COMPLETE], TODAY)
        self.assertEqual(self.npm.call_count, 3)
        self.assertEqual(self.releases.call_count, 3)
        self.assertEqual(self.clones.call_count, 3)
        self.releases.return_value = {"123": 501}
        self.assertEqual(self.refresh("workflow_dispatch")["github_snapshots"][TODAY], 501)

    def test_all_sources_failing_leaves_published_chart_untouched(self):
        self.refresh("workflow_dispatch")
        before = self.archive.read_bytes(), self.chart.read_bytes()
        for source in (self.npm, self.releases, self.clones):
            source.side_effect = TimeoutError()
        with self.assertRaisesRegex(RuntimeError, "No download or clone data refreshed"):
            self.refresh()
        self.assertEqual((self.archive.read_bytes(), self.chart.read_bytes()), before)
