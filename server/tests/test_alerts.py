import unittest

from app.alerts import evaluate_alert
from app.schemas import AlertLevel, ArrivalRisk


def risk(p1: float, p3: float, p6: float) -> ArrivalRisk:
    return ArrivalRisk(
        community_id="altadena",
        incident_id="incident-1",
        probability_1h=p1,
        probability_3h=p3,
        probability_6h=p6,
        eta_min=90,
    )


class AlertTests(unittest.TestCase):
    def test_warning_upgrade_triggers_call(self) -> None:
        decision = evaluate_alert(AlertLevel.WATCH, risk(0.1, 0.5, 0.8))
        self.assertEqual(decision.current, AlertLevel.WARNING)
        self.assertTrue(decision.should_call)

    def test_same_warning_does_not_trigger_duplicate_call(self) -> None:
        decision = evaluate_alert(AlertLevel.WARNING, risk(0.1, 0.6, 0.8))
        self.assertEqual(decision.current, AlertLevel.WARNING)
        self.assertFalse(decision.should_call)

    def test_one_hour_risk_has_highest_priority(self) -> None:
        decision = evaluate_alert(AlertLevel.NONE, risk(0.5, 0.2, 0.1))
        self.assertEqual(decision.current, AlertLevel.IMMINENT)

    def test_downgrade_requires_two_consecutive_low_observations(self) -> None:
        first = evaluate_alert(AlertLevel.WARNING, risk(0.1, 0.1, 0.1))
        second = evaluate_alert(AlertLevel.WARNING, risk(0.1, 0.1, 0.1), first.below_count)
        self.assertEqual(first.current, AlertLevel.WARNING)
        self.assertEqual(second.current, AlertLevel.NONE)


if __name__ == "__main__":
    unittest.main()
