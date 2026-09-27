from pathlib import Path
import time

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from .config import TOPIC_CMD_BRIGHTNESS
from .mqtt_publisher import MqttPublisher
from .mqtt_subscriber import start_mqtt_subscriber
from .state import SharedState, now_ms

app = FastAPI()

# --- MQTT / shared state ---
shared = SharedState()
pub = None
mqtt_client = None

# --- MQTT topics for ramps (match ESP32 code exactly) ---
TOPIC_CMD_RAMP = "chronolight/esp32_1/cmd/ramp"
TOPIC_CMD_RAMP_CANCEL = "chronolight/esp32_1/cmd/ramp/cancel"

# --- AUTO COMP (Behavior B: dim -> target, bright -> restore) ---
DIM_LUX = 200
AUTO_TARGET_PCT = 60
AUTO_COOLDOWN_SEC = 2

# --- SLEEP SAFETY (MOTION NIGHT LIGHT) ---
SLEEP_TARGET_DEFAULT_PCT = 12.0
SLEEP_DURATION_DEFAULT_SEC = 30  # NEW: auto-off duration
SLEEP_COOLDOWN_SEC = 2
SLEEP_SUPPRESS_SEC = 300  # if user turns OFF manually, don't re-trigger for 5 minutes


class BrightnessCmd(BaseModel):
    brightnessPct: float


class RampCmd(BaseModel):
    direction: str  # "up" or "down"


class AutoCmd(BaseModel):
    enabled: bool


class SleepSafetyCmd(BaseModel):
    enabled: bool
    targetPct: float | None = None
    durationSec: int | None = None  # NEW


def _runtime_set(**kwargs):
    try:
        shared.set_backend_fields(**kwargs)
    except Exception:
        pass


def _set_last_source(source: str):
    # Track who last set the brightness so auto-off doesn't fight manual actions
    setattr(shared, "lastBrightnessSource", source)


def _publish_brightness(pct: float, source: str, reason: str) -> bool:
    pct = float(max(0.0, min(100.0, pct)))
    payload = {"brightnessPct": pct, "source": source, "ts": now_ms(), "reason": reason}

    if not pub:
        return False

    pub.publish_json(TOPIC_CMD_BRIGHTNESS, payload)

    _set_last_source(source)
    _runtime_set(brightnessPct=pct, reason=reason)
    return True


def evaluate_sleep_safety_timeout() -> bool:
    """
    NEW: Auto-off timer.
    If Sleep Safety previously turned the light on and the timer elapsed,
    turn it back OFF (0%), but ONLY if brightness was last set by Sleep Safety.
    """
    if not bool(getattr(shared, "sleepSafetyEnabled", False)):
        return False

    active_until = float(getattr(shared, "sleepSafetyActiveUntil", 0.0))
    if active_until <= 0:
        return False

    now_s = time.time()
    if now_s < active_until:
        return False

    # Timer elapsed; only auto-off if we were the last one to set brightness
    last_src = getattr(shared, "lastBrightnessSource", None)
    if last_src != "sleepSafety":
        shared.sleepSafetyActiveUntil = 0.0
        setattr(shared, "sleepSafetyReason", "Timer elapsed (manual override detected)")
        return False

    snap = shared.snapshot()
    current_b = snap.get("brightnessPct")
    current_b = 0.0 if current_b is None else float(current_b)

    # Only turn off if it's still basically on (avoid spamming off)
    if current_b > 0.5:
        ok = _publish_brightness(
            0.0,
            source="sleepSafety",
            reason="Sleep Safety: auto-off timer elapsed",
        )
        shared.sleepSafetyActiveUntil = 0.0
        setattr(shared, "sleepSafetyReason", "Auto-off (timer)")
        if ok:
            _runtime_set(autoDecision="SleepSafety OFF", reason="Timer elapsed")
            return True

    shared.sleepSafetyActiveUntil = 0.0
    return False


def evaluate_sleep_safety_trigger() -> bool:
    """
    Trigger rule:
    If sleepSafetyEnabled AND lux < DIM_LUX AND motion==1 AND brightness==0
    then set brightness to sleepSafetyPct and start an auto-off timer.
    """
    if not bool(getattr(shared, "sleepSafetyEnabled", False)):
        return False

    snap = shared.snapshot()
    lux = snap.get("lux")
    motion = snap.get("motion")
    current_b = snap.get("brightnessPct")

    if lux is None or motion is None:
        return False

    lux = float(lux)
    motion = 1 if int(motion) else 0
    current_b = 0.0 if current_b is None else float(current_b)

    if not (lux < DIM_LUX and motion == 1):
        setattr(shared, "sleepSafetyReason", "Waiting (needs dim + motion)")
        return False

    now_s = time.time()

    suppressed_until = float(getattr(shared, "sleepSafetySuppressedUntil", 0.0))
    if now_s < suppressed_until:
        setattr(shared, "sleepSafetyReason", f"Suppressed ({int(suppressed_until - now_s)}s left)")
        return False

    last_s = float(getattr(shared, "lastSleepSafetyAt", 0.0))
    if (now_s - last_s) < SLEEP_COOLDOWN_SEC:
        setattr(shared, "sleepSafetyReason", "Cooldown")
        return False

    # Only trigger from OFF -> ON so we don't fight manual lighting
    if current_b > 0.5:
        setattr(shared, "sleepSafetyReason", "Already on (manual/other mode)")
        return False

    target = float(getattr(shared, "sleepSafetyPct", SLEEP_TARGET_DEFAULT_PCT))
    target = float(max(1.0, min(30.0, target)))

    duration_sec = int(getattr(shared, "sleepSafetyDurationSec", SLEEP_DURATION_DEFAULT_SEC))
    duration_sec = int(max(5, min(600, duration_sec)))  # clamp 5s..10min

    ok = _publish_brightness(
        target,
        source="sleepSafety",
        reason=f"Sleep Safety: motion in dim room ({int(lux)} lux) → {int(target)}%",
    )
    if ok:
        shared.lastSleepSafetyAt = now_s
        shared.sleepSafetyActiveUntil = now_s + duration_sec  # NEW: start timer
        setattr(shared, "sleepSafetyReason", f"Triggered ({int(target)}%) • auto-off {duration_sec}s")
        _runtime_set(autoDecision=f"SleepSafety {int(target)}%", reason=f"Motion + dim ({int(lux)} lux)")
        return True

    return False


def evaluate_sleep_safety() -> bool:
    """
    Sleep Safety has TWO parts, checked on each /raw:
    1) Timer-based auto-off
    2) Trigger on motion+dim+off
    """
    if evaluate_sleep_safety_timeout():
        return True
    return evaluate_sleep_safety_trigger()


def evaluate_auto():
    if not bool(getattr(shared, "autoEnabled", False)):
        return

    snap = shared.snapshot()
    lux = snap.get("lux")
    if lux is None:
        return
    lux = float(lux)

    now_s = time.time()
    last_auto = float(getattr(shared, "lastAutoAt", 0.0))
    if (now_s - last_auto) < AUTO_COOLDOWN_SEC:
        return

    auto_applied = bool(getattr(shared, "autoApplied", False))
    restore_pct = float(getattr(shared, "autoRestorePct", 35.0))

    if lux < DIM_LUX:
        if not auto_applied:
            ok = _publish_brightness(
                AUTO_TARGET_PCT,
                source="auto",
                reason=f"Dim ({int(lux)} lux < {DIM_LUX})",
            )
            if ok:
                shared.autoApplied = True
                shared.lastAutoAt = now_s
                _runtime_set(autoDecision=f"Set {AUTO_TARGET_PCT}%", reason=f"Dim ({int(lux)} lux < {DIM_LUX})")
        else:
            _runtime_set(autoDecision="Hold", reason="Already at dim target")
        return

    if auto_applied:
        ok = _publish_brightness(
            restore_pct,
            source="auto",
            reason=f"Bright ({int(lux)} lux ≥ {DIM_LUX}) → restore",
        )
        if ok:
            shared.autoApplied = False
            shared.lastAutoAt = now_s
            _runtime_set(autoDecision=f"Restore {int(restore_pct)}%", reason=f"Bright ({int(lux)} lux ≥ {DIM_LUX})")
    else:
        _runtime_set(autoDecision="Hold", reason="Bright enough")


def on_raw(shared_state: SharedState, payload: dict):
    try:
        # Sleep Safety has priority (so AUTO doesn't jump to 60% at night).
        triggered = evaluate_sleep_safety()
        if not triggered:
            evaluate_auto()
    except Exception as e:
        print(f"[LOGIC] on_raw error: {e}")


@app.on_event("startup")
def startup():
    global mqtt_client, pub
    try:
        pub = MqttPublisher()
        mqtt_client = start_mqtt_subscriber(shared, on_raw=on_raw)
        print("[MQTT] OK")
    except Exception as e:
        print(f"[MQTT] Not available yet: {e}")
    print("[API] Ready: GET /api/sensors")


@app.get("/api/sensors")
def get_sensors():
    snap = shared.snapshot()

    snap["autoEnabled"] = bool(getattr(shared, "autoEnabled", False))
    snap["mode"] = getattr(shared, "mode", None)

    # Sleep Safety fields
    snap["sleepSafetyEnabled"] = bool(getattr(shared, "sleepSafetyEnabled", False))
    snap["sleepSafetyPct"] = float(getattr(shared, "sleepSafetyPct", SLEEP_TARGET_DEFAULT_PCT))
    snap["sleepSafetyReason"] = getattr(shared, "sleepSafetyReason", None)

    snap["sleepSafetyDurationSec"] = int(getattr(shared, "sleepSafetyDurationSec", SLEEP_DURATION_DEFAULT_SEC))

    suppressed_until = float(getattr(shared, "sleepSafetySuppressedUntil", 0.0))
    snap["sleepSafetySuppressed"] = (time.time() < suppressed_until)

    active_until = float(getattr(shared, "sleepSafetyActiveUntil", 0.0))
    snap["sleepSafetyActive"] = (time.time() < active_until) if active_until > 0 else False

    return snap


@app.post("/api/set-auto")
def set_auto(cmd: AutoCmd):
    enabled = bool(cmd.enabled)

    shared.autoEnabled = enabled
    shared.mode = "AUTO" if enabled else "MANUAL"

    if enabled:
        snap = shared.snapshot()
        current = snap.get("brightnessPct")
        if current is None:
            current = getattr(shared, "lastManualPct", 35.0)

        shared.autoRestorePct = float(current)
        shared.autoApplied = False
        shared.lastAutoAt = 0.0

        _runtime_set(autoDecision="AUTO enabled", reason="Auto compensation toggle")
        evaluate_auto()
    else:
        if bool(getattr(shared, "autoApplied", False)):
            restore_pct = float(getattr(shared, "autoRestorePct", getattr(shared, "lastManualPct", 35.0)))
            _publish_brightness(restore_pct, source="auto", reason="Auto OFF → restore")
        shared.autoApplied = False
        _runtime_set(autoDecision="AUTO disabled", reason="Auto compensation toggle")

    return {"ok": True, "autoEnabled": enabled}


@app.post("/api/set-sleep-safety")
def set_sleep_safety(cmd: SleepSafetyCmd):
    enabled = bool(cmd.enabled)
    shared.sleepSafetyEnabled = enabled

    if cmd.targetPct is not None:
        pct = float(max(1.0, min(30.0, float(cmd.targetPct))))
        shared.sleepSafetyPct = pct
    else:
        if not hasattr(shared, "sleepSafetyPct"):
            shared.sleepSafetyPct = SLEEP_TARGET_DEFAULT_PCT

    # NEW: duration
    if cmd.durationSec is not None:
        dur = int(max(5, min(600, int(cmd.durationSec))))
        shared.sleepSafetyDurationSec = dur
    else:
        if not hasattr(shared, "sleepSafetyDurationSec"):
            shared.sleepSafetyDurationSec = SLEEP_DURATION_DEFAULT_SEC

    if enabled:
        # Avoid AUTO fighting it
        shared.autoEnabled = False
        shared.autoApplied = False
        shared.mode = "MANUAL"

        shared.sleepSafetySuppressedUntil = 0.0
        shared.lastSleepSafetyAt = 0.0
        shared.sleepSafetyActiveUntil = 0.0
        setattr(shared, "sleepSafetyReason", f"Enabled ({int(shared.sleepSafetyPct)}%)")
        _runtime_set(autoDecision="Sleep Safety enabled", reason="Motion-triggered night light")

        evaluate_sleep_safety()  # apply immediately if conditions already match
    else:
        shared.sleepSafetyActiveUntil = 0.0
        setattr(shared, "sleepSafetyReason", "Disabled")
        _runtime_set(autoDecision="Sleep Safety disabled", reason="Sleep Safety toggle")

    return {
        "ok": True,
        "sleepSafetyEnabled": enabled,
        "sleepSafetyPct": float(getattr(shared, "sleepSafetyPct", SLEEP_TARGET_DEFAULT_PCT)),
        "sleepSafetyDurationSec": int(getattr(shared, "sleepSafetyDurationSec", SLEEP_DURATION_DEFAULT_SEC)),
    }


@app.post("/api/set-brightness")
def set_brightness(cmd: BrightnessCmd):
    pct = float(max(0.0, min(100.0, float(cmd.brightnessPct))))
    payload = {"brightnessPct": pct, "source": "ui", "ts": now_ms()}

    # Manual override disables auto
    shared.autoEnabled = False
    shared.autoApplied = False
    shared.mode = "MANUAL"
    shared.lastManualPct = pct

    _set_last_source("ui")

    # If Sleep Safety is ON and user turns OFF manually, suppress re-trigger for a while
    if bool(getattr(shared, "sleepSafetyEnabled", False)) and pct <= 0.5:
        shared.sleepSafetySuppressedUntil = time.time() + SLEEP_SUPPRESS_SEC
        shared.sleepSafetyActiveUntil = 0.0
        setattr(shared, "sleepSafetyReason", f"Suppressed for {SLEEP_SUPPRESS_SEC}s after manual OFF")

    _runtime_set(autoDecision=f"Manual set to {int(pct)}%", reason="Manual slider", brightnessPct=pct)

    if pub:
        pub.publish_json(TOPIC_CMD_BRIGHTNESS, payload)
    else:
        return {"ok": False, "error": "MQTT not connected", "sent": payload}

    return {"ok": True, "sent": payload, "topic": TOPIC_CMD_BRIGHTNESS}


@app.post("/api/ramp")
def start_ramp(cmd: RampCmd):
    direction = (cmd.direction or "").lower().strip()
    if direction not in ("up", "down"):
        return {"ok": False, "error": "direction must be 'up' or 'down'"}

    shared.autoEnabled = False
    shared.autoApplied = False
    shared.mode = "MANUAL"

    _set_last_source("ui")

    _runtime_set(autoDecision="Hold", reason=f"Ramp {direction}", status="RAMPING")
    payload = {"direction": direction, "source": "ui", "ts": now_ms()}

    if pub:
        pub.publish_json(TOPIC_CMD_RAMP, payload)
    else:
        return {"ok": False, "error": "MQTT not connected", "sent": payload}

    return {"ok": True, "sent": payload, "topic": TOPIC_CMD_RAMP}


@app.post("/api/ramp/cancel")
def cancel_ramp():
    payload = {"source": "ui", "ts": now_ms()}

    _set_last_source("ui")

    if pub:
        pub.publish_json(TOPIC_CMD_RAMP_CANCEL, payload)
    else:
        return {"ok": False, "error": "MQTT not connected", "sent": payload}

    _runtime_set(status="READY", reason="Ramp canceled")
    return {"ok": True, "sent": payload, "topic": TOPIC_CMD_RAMP_CANCEL}


# --- Serve dashboard at root ---
BASE_DIR = Path(__file__).resolve().parent.parent
DASH_DIR = BASE_DIR / "dashboard"
app.mount("/", StaticFiles(directory=str(DASH_DIR), html=True), name="dashboard")