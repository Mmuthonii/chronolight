from dataclasses import dataclass, field
from threading import Lock
from time import time
from typing import Any, Dict, List, Optional

def now_ms() -> int:
    return int(time() * 1000)

@dataclass
class RuntimeState:
    lux: Optional[float] = None
    tempC: Optional[float] = None
    motion: Optional[int] = None
    lastMotionAt: Optional[int] = None

    dose: Optional[float] = None                # backend can compute later
    lightHistory: List[float] = field(default_factory=list)

    phase: Optional[str] = None                  # backend can compute later
    next: Optional[str] = None                   # backend can compute later
    autoDecision: Optional[str] = None           # backend can compute later
    brightnessPct: Optional[float] = None        # backend can compute later

    status: Optional[str] = None                 # SAFE/WARN/DANGER (optional)
    reason: Optional[str] = None                 # optional reason string

    updatedAt: Optional[int] = None

class SharedState:
    """
    Thread-safe state shared between MQTT thread and FastAPI thread.
    """
    def __init__(self):
        self._lock = Lock()
        self.runtime = RuntimeState()

    def update_from_raw(self, payload: Dict[str, Any], history_max: int = 60):
        with self._lock:
            r = self.runtime

            if "lux" in payload and payload["lux"] is not None:
                r.lux = float(payload["lux"])
                r.lightHistory.append(r.lux)
                if len(r.lightHistory) > history_max:
                    r.lightHistory = r.lightHistory[-history_max:]

            if "tempC" in payload and payload["tempC"] is not None:
                r.tempC = float(payload["tempC"])

            if "motion" in payload and payload["motion"] is not None:
                m = 1 if int(payload["motion"]) else 0
                r.motion = m
                if m == 1:
                    r.lastMotionAt = now_ms()

            # You can compute these later in Python (phase/dose/auto brightness)
            # For now, just provide simple defaults that keep the UI happy:
            if r.phase is None:
                r.phase = "—"
            if r.next is None:
                r.next = "—"
            if r.autoDecision is None:
                r.autoDecision = "—"

            # “updatedAt” drives the UI “Last updated”
            r.updatedAt = now_ms()

    def set_backend_fields(self, **kwargs):
        with self._lock:
            for k, v in kwargs.items():
                if hasattr(self.runtime, k):
                    setattr(self.runtime, k, v)

    def snapshot(self) -> Dict[str, Any]:
        with self._lock:
            r = self.runtime
            return {
                "lux": r.lux,
                "tempC": r.tempC,
                "motion": r.motion,
                "lastMotionAt": r.lastMotionAt,
                "dose": r.dose,
                "lightHistory": list(r.lightHistory),
                "phase": r.phase,
                "next": r.next,
                "autoDecision": r.autoDecision,
                "brightnessPct": r.brightnessPct,
                "status": r.status,
                "reason": r.reason,
                "updatedAt": r.updatedAt,
            }