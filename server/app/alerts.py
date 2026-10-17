from dataclasses import dataclass

from .schemas import AlertLevel, ArrivalRisk


@dataclass(frozen=True)
class AlertDecision:
    previous: AlertLevel
    current: AlertLevel
    changed: bool
    should_call: bool
    reason: str


def target_level(risk: ArrivalRisk) -> AlertLevel:
    if risk.probability_1h >= 0.50:
        return AlertLevel.IMMINENT
    if risk.probability_3h >= 0.50:
        return AlertLevel.WARNING
    if risk.probability_6h >= 0.30:
        return AlertLevel.WATCH
    return AlertLevel.NONE


def evaluate_alert(previous: AlertLevel, risk: ArrivalRisk) -> AlertDecision:
    """Evaluate one observation; persistence for downgrade hysteresis belongs in the store."""
    current = target_level(risk)
    changed = current != previous
    upgraded = current > previous
    should_call = upgraded and current >= AlertLevel.WARNING
    return AlertDecision(
        previous=previous,
        current=current,
        changed=changed,
        should_call=should_call,
        reason=(
            f"p1h={risk.probability_1h:.2f}, p3h={risk.probability_3h:.2f}, "
            f"p6h={risk.probability_6h:.2f}, eta={risk.eta_min:.0f}m"
        ),
    )
