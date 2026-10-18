"""Emergency contact dispatcher: calls the homes nearest the fire first, texts everyone nearby.

Two priority queues run in parallel, each with its own limit:

* Calls: `call_lines` concurrent lines; the queue head is the home with the earliest expected
  fire arrival (vulnerable residents five minutes earlier). No answer is retried once after
  three minutes, then falls back to text. Each call holds its line for a short wrap-up after it
  ends, so the outcome stays on the line board before the next call takes the line.
* Texts: `sms_per_second`; every home in the text zone, including the call zone as a backup.

Priority combines two sources. The baseline is the distance from each home to the nearest fire
cell, weighted downwind, so the dispatcher keeps working without a browser. When the simulator
reports model arrival times for buildings, the earlier of the two is used.

Time runs on the wall clock with a demo speed-up (`demo_speed`, 10 means a 60 s call lasts 6 s),
independent of the replay clock, so the audience can watch the queue move.

Providers are mocks unless `real_caller` is set: only a home whose building has a consented,
registered resident is called through Retell. The synthetic households have fictional numbers
and are never dialled.
"""

import asyncio
import random
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from math import cos, radians, sin

import numpy as np

from .households import Household

# Zones are deliberately tight: the simulator has no suppression, so its fire grows large, and a
# wide radius would put most of the map in the queues and bury the homes that matter now.
CALL_ETA_MIN = 30
CALL_DISTANCE_M = 300
TEXT_ETA_MIN = 90
TEXT_DISTANCE_M = 1500
VULNERABLE_BONUS_MIN = 5
RETRY_AFTER_S = 180
WRAP_UP_S = 15  # after-call work, in call seconds (1.5 s on screen at demo speed 10)

CALL_ACTIVE = {"ringing", "talking"}
CALL_FINAL = {"confirmed", "needs_help", "no_answer", "failed"}
TEXT_FINAL = {"delivered", "failed"}


@dataclass
class ContactTask:
    id: str
    household: Household
    channel: str  # "call" | "text"
    status: str = "queued"
    eta_min: float = 0.0
    distance_m: float = 0.0
    attempt: int = 1
    provider: str = "mock"
    line: int | None = None  # 1-based call line; kept after the call so the board shows the outcome
    ready_at: float = 0.0
    updated_at: float = field(default_factory=time.time)

    @property
    def priority(self) -> float:
        return self.eta_min - (VULNERABLE_BONUS_MIN if self.household.vulnerable else 0)

    def public(self) -> dict:
        return {
            "id": self.id,
            "channel": self.channel,
            "status": self.status,
            "attempt": self.attempt,
            "line": self.line,
            "etaMin": round(self.eta_min, 1),
            "distanceM": round(self.distance_m),
            "provider": self.provider,
            "updatedAt": self.updated_at,
            "household": self.household.public(),
        }


Broadcast = Callable[[str, dict], Awaitable[None]]
RealCaller = Callable[[ContactTask], Awaitable[str | None]]


class Dispatcher:
    def __init__(
        self,
        load_households: Callable[[], list[Household]],
        broadcast: Broadcast,
        *,
        cell_size: float = 25.0,
        call_lines: int = 6,
        sms_per_second: float = 25.0,
        demo_speed: float = 10.0,
        seed: int = 7,
        real_caller: RealCaller | None = None,
    ) -> None:
        self._load = load_households
        self._broadcast = broadcast
        self.cell_size = cell_size
        self.call_lines = call_lines
        self.sms_per_second = sms_per_second
        self.demo_speed = demo_speed
        self.real_caller = real_caller
        self.rng = random.Random(seed)
        self.active = False
        self.households: list[Household] = []
        self.tasks: dict[str, ContactTask] = {}
        self._by_household: dict[tuple[str, str], ContactTask] = {}
        self._workers: list[asyncio.Task] = []
        self._running: set[asyncio.Task] = set()
        self._lines: list[str | None] = [None] * call_lines  # task id holding each line
        self._xy: np.ndarray | None = None
        self._vulnerable: np.ndarray | None = None

    # ---- lifecycle ----
    async def preload(self) -> None:
        """Generate the household directory in the background so the first start is instant."""
        if not self.households:
            self.households = await asyncio.to_thread(self._load)
            self._xy = np.array([(h.x, h.y) for h in self.households], dtype=np.float32)

    async def start(self, demo_speed: float | None = None, call_lines: int | None = None) -> dict:
        if demo_speed:
            self.demo_speed = max(0.1, demo_speed)
        if call_lines:
            self.call_lines = max(1, call_lines)
            held = self._lines[: self.call_lines]
            self._lines = held + [None] * (self.call_lines - len(held))
        await self.preload()
        if not self.active:
            self.active = True
            self._workers = [
                asyncio.create_task(self._call_loop()),
                asyncio.create_task(self._text_loop()),
                asyncio.create_task(self._summary_loop()),
            ]
        return self.summary()

    async def stop(self) -> None:
        self.active = False
        for task in [*self._workers, *self._running]:
            task.cancel()
        self._workers.clear()
        self._running.clear()
        self.tasks.clear()
        self._by_household.clear()
        self._lines = [None] * self.call_lines
        await self._broadcast("dispatch_snapshot", self.snapshot())

    # ---- fire updates ----
    async def update_fire(
        self,
        cells: list[int],
        width: int,
        etas: dict[str, float] | None = None,
        wind_from_deg: float | None = None,
        wind_speed_ms: float | None = None,
    ) -> int:
        """Recompute arrival estimates; queue new homes and reorder waiting tasks.

        Returns the number of new tasks.
        """
        if not self.active or not cells or self._xy is None:
            return 0
        fire = np.array([(c % width + 0.5, c // width + 0.5) for c in cells], dtype=np.float32)
        lo = fire.min(0) - TEXT_DISTANCE_M / self.cell_size
        hi = fire.max(0) + TEXT_DISTANCE_M / self.cell_size
        near = np.nonzero(np.all((self._xy >= lo) & (self._xy <= hi), axis=1))[0]
        if wind_from_deg is not None and wind_speed_ms:
            # Direction the wind blows towards, in grid coordinates (x east, y south)
            toward = np.array([-sin(radians(wind_from_deg)), cos(radians(wind_from_deg))])
            wind = float(wind_speed_ms)
        else:
            toward, wind = np.zeros(2), 0.0
        etas = etas or {}
        created = 0
        for start in range(0, len(near), 2048):
            idx = near[start : start + 2048]
            delta = self._xy[idx, None, :] - fire[None, :, :]
            dist2 = (delta**2).sum(-1)
            nearest = dist2.argmin(1)
            d_cells = np.sqrt(dist2[np.arange(len(idx)), nearest])
            vec = delta[np.arange(len(idx)), nearest]
            cosine = (vec @ toward) / np.maximum(d_cells, 1e-6)
            # Distance-based estimate: 3 m/min upwind, faster downwind with the wind speed
            rate = 3.0 + 2.5 * wind * np.maximum(cosine, 0)
            distance_m = d_cells * self.cell_size
            eta = distance_m / rate
            for k, i in enumerate(idx):
                h = self.households[int(i)]
                model = etas.get(h.building_id)
                e = float(min(eta[k], model)) if model is not None else float(eta[k])
                d = float(distance_m[k])
                in_call = e <= CALL_ETA_MIN or d <= CALL_DISTANCE_M
                in_text = in_call or e <= TEXT_ETA_MIN or d <= TEXT_DISTANCE_M
                if in_text:
                    created += await self._ensure(h, "text", e, d)
                if in_call:
                    created += await self._ensure(h, "call", e, d)
        return created

    async def _ensure(self, h: Household, channel: str, eta: float, distance: float) -> int:
        task = self._by_household.get((h.id, channel))
        if task:
            if task.status == "queued":
                task.eta_min, task.distance_m = eta, distance
            return 0
        task = ContactTask(
            id=f"{channel}-{h.id}", household=h, channel=channel, eta_min=eta, distance_m=distance
        )
        self.tasks[task.id] = task
        self._by_household[(h.id, channel)] = task
        await self._emit(task)
        return 1

    # ---- workers ----
    def _next(self, channel: str) -> ContactTask | None:
        now = time.monotonic()
        ready = [
            t
            for t in self.tasks.values()
            if t.channel == channel and t.status == "queued" and t.ready_at <= now
        ]
        return min(ready, key=lambda t: t.priority) if ready else None

    async def _call_loop(self) -> None:
        while self.active:
            for i, holder in enumerate(self._lines):
                if holder is not None:
                    continue
                task = self._next("call")
                if not task:
                    break
                task.line = i + 1
                self._lines[i] = task.id
                task.status = "ringing"
                await self._emit(task)
                self._spawn(self._run_call(task))
            await asyncio.sleep(0.1)

    def _spawn(self, coro: Awaitable[None]) -> None:
        runner = asyncio.ensure_future(coro)
        self._running.add(runner)
        runner.add_done_callback(self._running.discard)

    async def _wrap_up(self, task: ContactTask) -> None:
        """Hold the line on the call's outcome for a moment, then free it for the next call."""
        line = (task.line or 0) - 1  # read first: a retried call may move to another line
        await self._sleep(WRAP_UP_S)
        if 0 <= line < len(self._lines) and self._lines[line] == task.id:
            self._lines[line] = None

    async def _sleep(self, real_seconds: float) -> None:
        await asyncio.sleep(real_seconds / self.demo_speed)

    async def _run_call(self, task: ContactTask) -> None:
        if self.real_caller:
            call_id = await self.real_caller(task)
            if call_id:
                # The Retell webhook reports the outcome through on_provider_status(), which
                # also frees the line
                task.provider = "retell"
                await self._emit(task)
                return
        await self._sleep(self.rng.uniform(8, 22))
        roll = self.rng.random()
        if roll < 0.65:
            task.status = "talking"
            await self._emit(task)
            await self._sleep(self.rng.uniform(30, 75))
            help_chance = 0.25 if task.household.vulnerable else 0.06
            task.status = "needs_help" if self.rng.random() < help_chance else "confirmed"
            await self._emit(task)
        elif roll < 0.95:
            await self._no_answer(task)
        else:
            task.status = "failed"
            await self._emit(task)
        await self._wrap_up(task)

    async def _no_answer(self, task: ContactTask) -> None:
        if task.attempt == 1:
            # Retry once after three minutes (scaled); the text is the backup in the meantime
            task.attempt = 2
            task.status = "queued"
            task.ready_at = time.monotonic() + RETRY_AFTER_S / self.demo_speed
        else:
            task.status = "no_answer"
        await self._emit(task)
        text = self._by_household.get((task.household.id, "text"))
        if text and text.status == "queued":
            text.eta_min = min(text.eta_min, task.eta_min) - 30  # jump the text queue

    async def _text_loop(self) -> None:
        budget = 0.0
        last = time.monotonic()
        while self.active:
            now = time.monotonic()
            budget = min(self.sms_per_second, budget + (now - last) * self.sms_per_second)
            last = now
            while budget >= 1:
                task = self._next("text")
                if not task:
                    break
                budget -= 1
                task.status = "sending"
                await self._emit(task)
                self._spawn(self._run_text(task))
            await asyncio.sleep(0.05)

    async def _run_text(self, task: ContactTask) -> None:
        await asyncio.sleep(self.rng.uniform(0.3, 0.8))
        task.status = "sent"
        await self._emit(task)
        await asyncio.sleep(self.rng.uniform(1.0, 3.0))
        task.status = "delivered" if self.rng.random() < 0.97 else "failed"
        await self._emit(task)

    async def _summary_loop(self) -> None:
        last = None
        while self.active:
            summary = self.summary()
            if summary != last:
                await self._broadcast("dispatch_summary", summary)
                last = summary
            await asyncio.sleep(1.0)

    # ---- provider callbacks (Retell webhook) ----
    async def on_provider_status(self, task_id: str, status: str) -> bool:
        task = self.tasks.get(task_id)
        if not task:
            return False
        mapped = {
            "in_progress": "talking",
            "confirmed": "confirmed",
            "needs_help": "needs_help",
            "completed": "confirmed",
            "ended": "confirmed",
            "no_answer": "no_answer",
        }.get(status)
        if not mapped:
            return False
        if mapped == "no_answer":
            await self._no_answer(task)
        else:
            task.status = mapped
            await self._emit(task)
        if task.status not in CALL_ACTIVE:
            self._spawn(self._wrap_up(task))
        return True

    # ---- state ----
    async def _emit(self, task: ContactTask) -> None:
        task.updated_at = time.time()
        await self._broadcast("contact", {"task": task.public()})

    def summary(self) -> dict:
        counts = {
            "calling": 0,
            "callQueued": 0,
            "confirmed": 0,
            "needsHelp": 0,
            "noAnswer": 0,
            "callFailed": 0,
            "textQueued": 0,
            "texting": 0,
            "texted": 0,
            "textFailed": 0,
        }
        for t in self.tasks.values():
            if t.channel == "call":
                key = {
                    "ringing": "calling",
                    "talking": "calling",
                    "queued": "callQueued",
                    "confirmed": "confirmed",
                    "needs_help": "needsHelp",
                    "no_answer": "noAnswer",
                    "failed": "callFailed",
                }[t.status]
            else:
                key = {
                    "queued": "textQueued",
                    "sending": "texting",
                    "sent": "texted",
                    "delivered": "texted",
                    "failed": "textFailed",
                }[t.status]
            counts[key] += 1
        return {
            "active": self.active,
            "demoSpeed": self.demo_speed,
            "callLines": self.call_lines,
            "households": len(self.households),
            **counts,
        }

    def snapshot(self) -> dict:
        return {"summary": self.summary(), "tasks": [t.public() for t in self.tasks.values()]}
