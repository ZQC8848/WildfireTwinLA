"""Validate synthetic wildfire arrival-time predictions.

The validator deliberately works on plain JSON-compatible values so results from the
TypeScript core, a GPU implementation, or a historical replay can use the same tool.
"""

from __future__ import annotations

import argparse
import json
import math
from collections.abc import Iterable, Mapping, Sequence
from pathlib import Path
from typing import Any

DEFAULT_STEP_CANDIDATES = tuple(value / 4 for value in range(1, 241))
VALIDATION_WARNING = (
    "Detection times are delayed proxies; use temporally held-out observations and "
    "timestamp-matched perimeters."
)


def _finite_number(value: object) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _arrival_minutes(arrival_steps: Sequence[object], step_minutes: float) -> list[float | None]:
    if not _finite_number(step_minutes) or step_minutes <= 0:
        raise ValueError("step_minutes must be finite and positive")

    converted: list[float | None] = []
    for step in arrival_steps:
        if step is None:
            converted.append(None)
        elif not _finite_number(step) or step < 0:
            raise ValueError("arrival steps must be non-negative finite numbers or null")
        else:
            converted.append(float(step) * step_minutes)
    return converted


def _detection_error(
    arrival_steps: Sequence[object],
    detections: Iterable[Mapping[str, object]],
    step_minutes: float,
) -> dict[str, float | int]:
    arrivals = _arrival_minutes(arrival_steps, step_minutes)
    errors: list[float] = []
    excluded = 0

    for detection in detections:
        cell = detection.get("cell")
        minutes = detection.get("minutes")
        if (
            not isinstance(cell, int)
            or isinstance(cell, bool)
            or cell < 0
            or cell >= len(arrivals)
            or not _finite_number(minutes)
            or minutes < 0
            or arrivals[cell] is None
        ):
            excluded += 1
            continue
        errors.append(abs(arrivals[cell] - float(minutes)))

    if not errors:
        raise ValueError("no reachable, valid detection samples")

    return {
        "stepMinutes": float(step_minutes),
        "detectionProxyMAEMinutes": sum(errors) / len(errors),
        "samplesUsed": len(errors),
        "samplesExcluded": excluded,
    }


def calibrate(
    arrival_steps: Sequence[object],
    detections: Iterable[Mapping[str, object]],
    step_candidates: Iterable[float] = DEFAULT_STEP_CANDIDATES,
) -> dict[str, float | int]:
    """Select the candidate minutes-per-step with the lowest detection-time MAE."""

    detections = list(detections)
    candidates = list(step_candidates)
    if not candidates:
        raise ValueError("at least one step candidate is required")

    results = [_detection_error(arrival_steps, detections, candidate) for candidate in candidates]
    return min(
        results,
        key=lambda result: (result["detectionProxyMAEMinutes"], result["stepMinutes"]),
    )


def iou(arrival_minutes: Sequence[object], observed_cells: Iterable[int], minutes: float) -> float:
    """Calculate intersection-over-union at a timestamp for predicted and observed cells."""

    if not _finite_number(minutes) or minutes < 0:
        raise ValueError("minutes must be a non-negative finite number")

    predicted = {
        cell
        for cell, arrival in enumerate(arrival_minutes)
        if _finite_number(arrival) and 0 <= arrival <= minutes
    }
    observed: set[int] = set()
    for cell in observed_cells:
        if (
            not isinstance(cell, int)
            or isinstance(cell, bool)
            or cell < 0
            or cell >= len(arrival_minutes)
        ):
            raise ValueError("observed cells must be valid array indexes")
        observed.add(cell)

    union = predicted | observed
    return len(predicted & observed) / len(union) if union else 1.0


def compare(
    cpu_arrival_minutes: Sequence[object], gpu_arrival_minutes: Sequence[object]
) -> dict[str, float | int]:
    """Compare paired arrival times and count reachability disagreements."""

    if len(cpu_arrival_minutes) != len(gpu_arrival_minutes):
        raise ValueError("CPU and GPU arrival arrays must have the same length")

    errors: list[float] = []
    disagreements = 0
    for cpu, gpu in zip(cpu_arrival_minutes, gpu_arrival_minutes):
        cpu_reachable = _finite_number(cpu)
        gpu_reachable = _finite_number(gpu)
        if cpu_reachable and gpu_reachable:
            if cpu < 0 or gpu < 0:
                raise ValueError("arrival minutes must be non-negative")
            errors.append(abs(float(cpu) - float(gpu)))
        elif cpu_reachable != gpu_reachable:
            disagreements += 1

    return {
        "pairedCells": len(errors),
        "arrivalMAEMinutes": sum(errors) / len(errors) if errors else 0.0,
        "reachabilityDisagreements": disagreements,
    }


def run(payload: Mapping[str, Any]) -> dict[str, Any]:
    """Run calibration and held-out checks for one JSON validation payload."""

    arrival_steps = payload.get("arrivalSteps")
    calibration_detections = payload.get("calibrationDetections")
    validation_detections = payload.get("validationDetections")
    perimeters = payload.get("perimeters", [])
    gpu_arrivals = payload.get("gpuArrivalMinutes")
    candidates = payload.get("stepCandidates", DEFAULT_STEP_CANDIDATES)

    if not isinstance(arrival_steps, list):
        raise TypeError("arrivalSteps must be an array")
    if not isinstance(calibration_detections, list) or not isinstance(validation_detections, list):
        raise TypeError("calibrationDetections and validationDetections must be arrays")
    if not isinstance(perimeters, list):
        raise TypeError("perimeters must be an array")

    calibration = calibrate(arrival_steps, calibration_detections, candidates)
    step_minutes = float(calibration["stepMinutes"])
    arrival_minutes = _arrival_minutes(arrival_steps, step_minutes)
    held_out = _detection_error(arrival_steps, validation_detections, step_minutes)

    perimeter_results = []
    for perimeter in perimeters:
        if not isinstance(perimeter, Mapping):
            raise TypeError("each perimeter must be an object")
        minutes = perimeter.get("minutes")
        cells = perimeter.get("cells")
        if not isinstance(cells, list):
            raise TypeError("perimeter cells must be an array")
        perimeter_results.append({"minutes": minutes, "iou": iou(arrival_minutes, cells, minutes)})

    result: dict[str, Any] = {
        "label": payload.get("label", "SYNTHETIC TEST ONLY — NOT EATON"),
        "calibration": calibration,
        "warning": VALIDATION_WARNING,
        "heldOut": held_out,
        "perimeters": perimeter_results,
    }
    if gpu_arrivals is not None:
        if not isinstance(gpu_arrivals, list):
            raise ValueError("gpuArrivalMinutes must be an array")
        result["cpuGpu"] = compare(arrival_minutes, gpu_arrivals)
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path, help="JSON validation input")
    parser.add_argument("--output", type=Path, help="write JSON to this file instead of stdout")
    args = parser.parse_args()

    with args.input.open(encoding="utf-8") as source:
        payload = json.load(source)
    result = json.dumps(run(payload), indent=2, ensure_ascii=False) + "\n"

    if args.output:
        args.output.write_text(result, encoding="utf-8")
    else:
        print(result, end="")


if __name__ == "__main__":
    main()
