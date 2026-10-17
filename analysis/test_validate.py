import json
import subprocess
import sys
import unittest
from pathlib import Path

from validate import calibrate, compare, iou, run

HERE = Path(__file__).parent


class ValidationTests(unittest.TestCase):
    def test_known_calibration(self):
        result = calibrate(
            [0, 2, 4, None],
            [
                {"cell": 1, "minutes": 10},
                {"cell": 2, "minutes": 20},
                {"cell": 3, "minutes": 30},
            ],
            [2, 5, 10],
        )
        self.assertEqual(result["stepMinutes"], 5)
        self.assertEqual(result["samplesUsed"], 2)
        self.assertEqual(result["samplesExcluded"], 1)

    def test_iou_and_reachability(self):
        self.assertEqual(iou([0, 10, None], [0, 2], 5), 0.5)
        comparison = compare([0, None], [0, 3])
        self.assertEqual(comparison["pairedCells"], 1)
        self.assertEqual(comparison["reachabilityDisagreements"], 1)

    def test_empty_sets_have_perfect_iou(self):
        self.assertEqual(iou([None, None], [], 10), 1.0)

    def test_no_reachable_calibration_data(self):
        with self.assertRaisesRegex(ValueError, "no reachable"):
            calibrate([None], [{"cell": 0, "minutes": 2}], [5])

    def test_mismatched_comparison_lengths(self):
        with self.assertRaisesRegex(ValueError, "same length"):
            compare([0], [0, 1])

    def test_synthetic_pipeline_matches_fixture(self):
        payload = json.loads((HERE / "synthetic-input.json").read_text(encoding="utf-8"))
        expected = json.loads((HERE / "synthetic-result.json").read_text(encoding="utf-8"))
        self.assertEqual(run(payload), expected)

    def test_cli_emits_the_expected_result(self):
        completed = subprocess.run(
            [sys.executable, str(HERE / "validate.py"), str(HERE / "synthetic-input.json")],
            check=True,
            capture_output=True,
            text=True,
        )
        expected = json.loads((HERE / "synthetic-result.json").read_text(encoding="utf-8"))
        self.assertEqual(json.loads(completed.stdout), expected)


if __name__ == "__main__":
    unittest.main()
