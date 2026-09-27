function $(sel) { return document.querySelector(sel); }
function $all(sel) { return Array.from(document.querySelectorAll(sel)); }

const STORE_KEY = "chronolight_mvp_v2";

const SENSOR_URL = "/api/sensors";
const BRIGHTNESS_CMD_URL = "/api/set-brightness";
const AUTO_MODE_URL = "/api/set-auto";
const SLEEP_SAFETY_URL = "/api/set-sleep-safety";
const RAMP_URL = "/api/ramp";
const RAMP_CANCEL_URL = "/api/ramp/cancel";

let rampTimeout = null;

const POLL_MS = 2000;
const STALE_AFTER_MS = 6000;

const DEFAULT_STATE = {
  mode: "manual",
  autoCompEnabled: false,

  sleepSafetyEnabled: false,
  sleepSafetyPct: 12,
  sleepSafetyDurationSec: 30,

  ui: {
    brightnessPct: 35,
    rampDurationSec: 20,
    rampTargetPct: 60
  },
  rampUi: {
    running: false,
    direction: null,
    runId: 0 // NEW: used to prevent stale timers from updating slider
  },
  runtime: {
    autoEnabled: null,
    mode: null,
    autoDecision: null,
    reason: null,
    status: null,
    lux: null,
    tempC: null,
    motion: null,
    lastMotionAt: null,
    brightnessPct: null,

    sleepSafetyEnabled: null,
    sleepSafetyPct: null,
    sleepSafetyReason: null,
    sleepSafetySuppressed: null,
    sleepSafetyDurationSec: null,
    sleepSafetyActive: null,

    updatedAt: null
  }
};

function clampNum(v, lo, hi) {
  const n = Number(v);
  if (Number.isNaN(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}

function loadState() {
  const s = structuredClone(DEFAULT_STATE);
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return s;
    const saved = JSON.parse(raw);

    if (saved?.mode) s.mode = saved.mode;
    if (typeof saved?.autoCompEnabled === "boolean") s.autoCompEnabled = saved.autoCompEnabled;

    if (typeof saved?.sleepSafetyEnabled === "boolean") s.sleepSafetyEnabled = saved.sleepSafetyEnabled;
    if (saved?.sleepSafetyPct != null) s.sleepSafetyPct = Number(saved.sleepSafetyPct);
    if (saved?.sleepSafetyDurationSec != null) s.sleepSafetyDurationSec = Number(saved.sleepSafetyDurationSec);

    if (saved?.ui) {
      if (saved.ui.brightnessPct != null) s.ui.brightnessPct = Number(saved.ui.brightnessPct);
      if (saved.ui.rampDurationSec != null) s.ui.rampDurationSec = Number(saved.ui.rampDurationSec);
      if (saved.ui.rampTargetPct != null) s.ui.rampTargetPct = Number(saved.ui.rampTargetPct);
    }
  } catch {}
  return s;
}

function saveState(state) {
  localStorage.setItem(STORE_KEY, JSON.stringify({
    mode: state.mode,
    autoCompEnabled: state.autoCompEnabled,
    sleepSafetyEnabled: state.sleepSafetyEnabled,
    sleepSafetyPct: state.sleepSafetyPct,
    sleepSafetyDurationSec: state.sleepSafetyDurationSec,
    ui: state.ui
  }));
}

function syncStateFromStorage(state) {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw);

    if (saved?.mode) state.mode = saved.mode;
    if (typeof saved?.autoCompEnabled === "boolean") state.autoCompEnabled = saved.autoCompEnabled;

    if (typeof saved?.sleepSafetyEnabled === "boolean") state.sleepSafetyEnabled = saved.sleepSafetyEnabled;
    if (saved?.sleepSafetyPct != null) state.sleepSafetyPct = Number(saved.sleepSafetyPct);
    if (saved?.sleepSafetyDurationSec != null) state.sleepSafetyDurationSec = Number(saved.sleepSafetyDurationSec);

    if (saved?.ui) {
      if (saved.ui.brightnessPct != null) state.ui.brightnessPct = Number(saved.ui.brightnessPct);
      if (saved.ui.rampDurationSec != null) state.ui.rampDurationSec = Number(saved.ui.rampDurationSec);
      if (saved.ui.rampTargetPct != null) state.ui.rampTargetPct = Number(saved.ui.rampTargetPct);
    }
  } catch {}
}

function nowMs() { return Date.now(); }

function fmtTimeAgo(msEpoch) {
  if (!msEpoch) return "—";
  const diffMs = Math.max(0, nowMs() - Number(msEpoch));
  const mins = Math.floor(diffMs / 60000);
  if (mins <= 0) return "just now";
  if (mins <= 5) return "5m ago";
  if (mins <= 10) return "10m ago";
  if (mins <= 20) return "20m ago";
  if (mins <= 30) return "30m ago";
  const hours = Math.floor(mins / 60);
  if (hours <= 1) return "1h ago";
  if (hours <= 2) return "2h ago";
  if (hours <= 3) return "3h ago";
  if (hours <= 6) return "6h ago";
  if (hours <= 12) return "12h ago";
  if (hours <= 24) return "24h ago";
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function isStale(updatedAt) {
  if (!updatedAt) return true;
  return (nowMs() - Number(updatedAt)) > STALE_AFTER_MS;
}

function setText(id, text) {
  const el = document.getElementById(id);
  if (!el) return;
  const next = String(text);
  if (el.textContent !== next) el.textContent = next;
}

function setChip(id, text, level) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = text;
  el.classList.remove("ok", "warn", "bad");
  el.classList.add(level);
}

function updateUpdatedLabels(state) {
  const updatedAt = state.runtime.updatedAt;

  ["updatedTime", "dashUpdatedTime"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.textContent = fmtTimeAgo(updatedAt);
  });

  const status = isStale(updatedAt) ? "STALE" : "CONNECTED";
  setText("connPill", `Status: ${status}`);
  setText("dashConnPill", `Status: ${status}`);
}

function applyRuntimeUpdate(state, payload) {
  if (!payload || typeof payload !== "object") return;
  const r = state.runtime;

  if (payload.lux !== undefined) r.lux = (payload.lux == null ? null : Number(payload.lux));
  if (payload.tempC !== undefined) r.tempC = (payload.tempC == null ? null : Number(payload.tempC));
  if (payload.motion !== undefined) r.motion = (payload.motion == null ? null : (Number(payload.motion) ? 1 : 0));
  if (payload.lastMotionAt !== undefined) r.lastMotionAt = payload.lastMotionAt ? Number(payload.lastMotionAt) : null;
  if (payload.brightnessPct !== undefined) r.brightnessPct = (payload.brightnessPct == null ? null : Number(payload.brightnessPct));

  if (payload.autoEnabled !== undefined) r.autoEnabled = !!payload.autoEnabled;
  if (payload.mode !== undefined) r.mode = payload.mode;
  if (payload.autoDecision !== undefined) r.autoDecision = payload.autoDecision;
  if (payload.reason !== undefined) r.reason = payload.reason;
  if (payload.status !== undefined) r.status = payload.status;

  if (payload.sleepSafetyEnabled !== undefined) r.sleepSafetyEnabled = !!payload.sleepSafetyEnabled;
  if (payload.sleepSafetyPct !== undefined) r.sleepSafetyPct = (payload.sleepSafetyPct == null ? null : Number(payload.sleepSafetyPct));
  if (payload.sleepSafetyReason !== undefined) r.sleepSafetyReason = payload.sleepSafetyReason == null ? null : String(payload.sleepSafetyReason);
  if (payload.sleepSafetySuppressed !== undefined) r.sleepSafetySuppressed = !!payload.sleepSafetySuppressed;
  if (payload.sleepSafetyDurationSec !== undefined) r.sleepSafetyDurationSec = payload.sleepSafetyDurationSec == null ? null : Number(payload.sleepSafetyDurationSec);
  if (payload.sleepSafetyActive !== undefined) r.sleepSafetyActive = !!payload.sleepSafetyActive;

  r.updatedAt = (payload.updatedAt != null) ? Number(payload.updatedAt) : nowMs();

  renderAll(state);
}

function getEffectiveBrightnessForDisplay(state) {
  if (state.mode === "off") return 0;
  if (state.mode === "manual") return Number(state.ui.brightnessPct ?? 0);
  const b = state.runtime.brightnessPct;
  return (b == null || Number.isNaN(b)) ? Number(state.ui.brightnessPct ?? 0) : b;
}

/* ---------- Backend commands ---------- */
async function sendBrightnessCommand(pct) {
  const v = clampNum(pct, 0, 100);
  try {
    await fetch(BRIGHTNESS_CMD_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ brightnessPct: v, source: "ui", ts: Date.now() })
    });
  } catch {}
}

async function sendAutoComp(enabled) {
  try {
    await fetch(AUTO_MODE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: !!enabled, source: "ui", ts: Date.now() })
    });
  } catch {}
}

async function sendSleepSafety(enabled, targetPct, durationSec) {
  const pct = clampNum(targetPct, 1, 30);
  const dur = clampNum(durationSec, 5, 600);
  try {
    await fetch(SLEEP_SAFETY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: !!enabled, targetPct: pct, durationSec: dur, source: "ui", ts: Date.now() })
    });
  } catch {}
}

async function startRamp(direction, durationSec, targetPct) {
  try {
    await fetch(RAMP_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ direction, durationSec, targetPct, source: "ui", ts: Date.now() })
    });
  } catch {}
}

async function cancelRamp() {
  try { await fetch(RAMP_CANCEL_URL, { method: "POST" }); } catch {}
}

/* ---------- RAMP TIMER (FIXED) ---------- */
function clearRampTimer() {
  if (rampTimeout) clearTimeout(rampTimeout);
  rampTimeout = null;
}

/**
 * NEW behavior:
 * - when ramp ends, we "commit" final brightness into slider state,
 *   so UI reflects the final result.
 * - This only applies if the ramp is still the same one (runId check)
 *   and wasn't canceled/overridden.
 */
function scheduleRampEnd(state, durationSec, finalBrightnessPct, runId) {
  const ms = Math.max(1000, Number(durationSec || 5) * 1000);
  clearRampTimer();

  rampTimeout = setTimeout(async () => {
    // If ramp was canceled or replaced, do nothing
    if (!state.rampUi.running) return;
    if (state.rampUi.runId !== runId) return;

    // End ramp UI state
    state.rampUi.running = false;
    state.rampUi.direction = null;

    // Commit final brightness to UI + slider (requested behavior)
    const finalPct = clampNum(finalBrightnessPct, 0, 100);
    state.ui.brightnessPct = finalPct;

    saveState(state);
    renderAll(state);

    // Optional but recommended:
    // send final brightness once so backend runtime + device + UI agree.
    await sendBrightnessCommand(finalPct);

    rampTimeout = null;
  }, ms);
}

function setRampButtonStates(state) {
  const wakeBtn = $("#wakeUpBtn");
  const downBtn = $("#windDownBtn");
  if (!wakeBtn || !downBtn) return;

  wakeBtn.classList.remove("is-active", "is-running");
  downBtn.classList.remove("is-active", "is-running");

  if (!state.rampUi.running) return;
  const active = state.rampUi.direction === "up" ? wakeBtn : downBtn;
  active.classList.add("is-active", "is-running");
}

/* ---------- RENDER ---------- */
function renderIndex(state) {
  if ($("#modePill")) $("#modePill").textContent = state.mode.toUpperCase();
  $all(".tab").forEach(btn => btn.classList.toggle("active", btn.dataset.tab === state.mode));

  const sub = $("#heroSubtitle");
  if (sub) {
    sub.textContent =
      state.mode === "auto"   ? "AUTO mode: smart features (toggle compensation below)." :
      state.mode === "manual" ? "MANUAL mode: slider + ramps." :
                                "OFF: light is disabled.";
  }

  const autoToggle = $("#autoModeToggle");
  if (autoToggle) {
    autoToggle.checked = !!state.autoCompEnabled;
    const isAuto = (state.mode === "auto");
    autoToggle.disabled = !isAuto;
    const wrapper = autoToggle.closest(".switch");
    if (wrapper) wrapper.classList.toggle("is-disabled", !isAuto);
  }

  const sleepToggle = $("#sleepSafetyToggle");
  const sleepPctInput = $("#sleepSafetyPctInput");
  const sleepDurInput = $("#sleepSafetyDurationInput");

  if (sleepToggle) {
    sleepToggle.checked = !!state.sleepSafetyEnabled;
    sleepToggle.disabled = (state.mode === "off");
    const wrap = sleepToggle.closest(".switch");
    if (wrap) wrap.classList.toggle("is-disabled", state.mode === "off");
  }
  if (sleepPctInput) {
    sleepPctInput.value = String(clampNum(state.sleepSafetyPct ?? 12, 1, 30));
    sleepPctInput.disabled = (state.mode === "off");
  }
  if (sleepDurInput) {
    sleepDurInput.value = String(clampNum(state.sleepSafetyDurationSec ?? 30, 5, 600));
    sleepDurInput.disabled = (state.mode === "off");
  }

  const dur = $("#rampDurationInput");
  const tgt = $("#rampTargetInput");
  if (dur) dur.value = String(state.ui.rampDurationSec ?? 20);
  if (tgt) tgt.value = String(state.ui.rampTargetPct ?? 60);

  const running = !!state.rampUi.running;
  const badge = $("#rampStatusBadge");
  if (badge) badge.textContent = running ? "RAMPING" : "READY";

  const note = $("#rampNote");
  if (note) note.textContent = running
    ? (state.rampUi.direction === "down" ? "Wind down in progress…" : "Wake up in progress…")
    : "—";

  const wakeBtn = $("#wakeUpBtn");
  const downBtn = $("#windDownBtn");
  const cancelBtn = $("#cancelRampBtn");

  const off = (state.mode === "off");
  if (wakeBtn) wakeBtn.disabled = off || (running && state.rampUi.direction !== "up");
  if (downBtn) downBtn.disabled = off || (running && state.rampUi.direction !== "down");
  if (cancelBtn) cancelBtn.disabled = !running;

  setRampButtonStates(state);

  const slider = $("#brightnessSlider");
  const brightnessSub = $("#brightnessSub");

  if (slider && brightnessSub) {
    if (off) {
      slider.disabled = true;
      slider.value = "0";
      brightnessSub.textContent = "Lights off";
    } else if (state.mode === "auto") {
      slider.disabled = false;
      slider.value = String(clampNum(getEffectiveBrightnessForDisplay(state), 0, 100));
      brightnessSub.textContent = "AUTO active (move slider to switch to MANUAL).";
    } else {
      slider.disabled = false;
      slider.value = String(clampNum(state.ui.brightnessPct ?? 35, 0, 100));
      brightnessSub.textContent = running ? "Manual override (cancels ramp)" : "Manual override";
    }
  }

  const pctEl = $("#brightnessPct");
  if (pctEl) pctEl.textContent = `${Math.round(getEffectiveBrightnessForDisplay(state))}%`;

  const noteEl = $("#autoNote");
  if (noteEl) {
    const ssOn = !!state.sleepSafetyEnabled;
    const ssReason = state.runtime.sleepSafetyReason || "";
    const ssActive = state.runtime.sleepSafetyActive ? " (active)" : "";
    noteEl.textContent =
      (state.mode === "auto")
        ? (state.autoCompEnabled ? "Auto compensation is ON." : "Auto compensation is OFF.")
        : "—";
    noteEl.textContent += `\nSleep Safety: ${ssOn ? "ON" : "OFF"}${ssActive}${ssReason ? " • " + ssReason : ""}`;
  }

  updateUpdatedLabels(state);
}

function labelLight(lux) {
  if (lux == null || Number.isNaN(Number(lux))) return { text: "—", level: "warn" };
  const n = Number(lux);
  if (n >= 600) return { text: "Bright", level: "ok" };
  if (n >= 200) return { text: "Okay", level: "warn" };
  return { text: "Dim", level: "bad" };
}

function labelTemp(tempC) {
  if (tempC == null || Number.isNaN(Number(tempC))) return { text: "—", level: "warn" };
  const t = Number(tempC);
  if (t >= 26) return { text: "Hot", level: "warn" };
  if (t >= 19) return { text: "Okay", level: "ok" };
  return { text: "Cool", level: "warn" };
}

function renderDashboard(state) {
  updateUpdatedLabels(state);

  const lux = state.runtime.lux;
  const temp = state.runtime.tempC;
  const motion = state.runtime.motion;

  setText("lightLux", lux == null ? "—" : Math.round(lux).toString());
  setText("tempC", temp == null ? "—" : Number(temp).toFixed(1));
  setText("motionNow", motion == null ? "—" : (motion ? "Yes" : "No"));

  const light = labelLight(lux);
  const tempL = labelTemp(temp);

  setChip("lightLabel", light.text, light.level);
  setChip("tempLabel", tempL.text, tempL.level);

  setText("lastMotion", state.runtime.lastMotionAt ? fmtTimeAgo(state.runtime.lastMotionAt) : "—");

  setText("dashBrightness", `${Math.round(getEffectiveBrightnessForDisplay(state))}%`);

  const autoOn = (state.runtime.autoEnabled != null)
    ? !!state.runtime.autoEnabled
    : (state.mode === "auto" && state.autoCompEnabled);
  setText("dashAuto", autoOn ? "ON" : "OFF");

  const ssOn = (state.runtime.sleepSafetyEnabled != null) ? !!state.runtime.sleepSafetyEnabled : !!state.sleepSafetyEnabled;
  const ssPct = (state.runtime.sleepSafetyPct != null) ? Math.round(state.runtime.sleepSafetyPct) : Math.round(state.sleepSafetyPct || 12);
  const ssSupp = !!state.runtime.sleepSafetySuppressed;
  setText("dashSleepSafety", ssOn ? `ON • ${ssPct}%${ssSupp ? " (suppressed)" : ""}` : "OFF");

  const dashNote =
    state.rampUi.running ? (state.rampUi.direction === "down" ? "Wind down running…" : "Wake up running…") :
    (ssOn) ? (`Sleep Safety: ${state.runtime.sleepSafetyReason || "—"}`) :
    (autoOn) ? (`Auto: ${state.runtime.autoDecision || "—"} • ${state.runtime.reason || ""}`.trim()) :
    "—";
  setText("autoNoteDash", dashNote);
}

function renderAll(state) {
  if ($("#brightnessSlider")) renderIndex(state);
  if ($("#lightLux") || $("#dashBrightness")) renderDashboard(state);
}

/* ---------- Handlers ---------- */
function bindCommonHandlers(state) {
  const backdrop = $("#modalBackdrop");
  const openBtn = $("#openSettingsBtn");
  const close1 = $("#closeModalBtn");
  const close2 = $("#closeModalBtn2");

  const openModal = () => { if (backdrop){ backdrop.classList.add("show"); backdrop.setAttribute("aria-hidden","false"); } };
  const closeModal = () => { if (backdrop){ backdrop.classList.remove("show"); backdrop.setAttribute("aria-hidden","true"); } };

  if (openBtn) openBtn.addEventListener("click", openModal);
  if (close1) close1.addEventListener("click", closeModal);
  if (close2) close2.addEventListener("click", closeModal);
  if (backdrop) backdrop.addEventListener("click", (e) => { if (e.target === backdrop) closeModal(); });

  const viewDashboardBtn = $("#viewDashboardBtn");
  const goDashboardBtn = $("#goDashboardBtn");
  const backBtn = $("#backBtn");

  if (viewDashboardBtn) viewDashboardBtn.addEventListener("click", () => window.location.href = "dashboard.html");
  if (goDashboardBtn) goDashboardBtn.addEventListener("click", () => window.location.href = "dashboard.html");
  if (backBtn) backBtn.addEventListener("click", () => window.location.href = "index.html");

  $all(".tab").forEach(btn => {
    btn.addEventListener("click", () => {
      const nextMode = btn.dataset.tab;

      if (state.mode === "auto" && nextMode !== "auto") sendAutoComp(false);
      state.mode = nextMode;

      if (state.mode === "off") {
        state.sleepSafetyEnabled = false;
        saveState(state);
        sendSleepSafety(false, state.sleepSafetyPct, state.sleepSafetyDurationSec);

        state.ui.brightnessPct = 0;
        state.rampUi.running = false;
        state.rampUi.direction = null;
        clearRampTimer();
        cancelRamp();
        sendBrightnessCommand(0);
      }

      if (state.mode === "auto") sendAutoComp(state.autoCompEnabled);

      saveState(state);
      renderAll(state);
    });
  });

  const autoToggle = $("#autoModeToggle");
  if (autoToggle) {
    autoToggle.addEventListener("change", () => {
      state.autoCompEnabled = !!autoToggle.checked;
      saveState(state);
      renderAll(state);
      if (state.mode === "auto") sendAutoComp(state.autoCompEnabled);
    });
  }

  // Sleep Safety
  const sleepToggle = $("#sleepSafetyToggle");
  const sleepPctInput = $("#sleepSafetyPctInput");
  const sleepDurInput = $("#sleepSafetyDurationInput");

  if (sleepPctInput) {
    sleepPctInput.addEventListener("change", () => {
      state.sleepSafetyPct = clampNum(sleepPctInput.value, 1, 30);
      sleepPctInput.value = String(state.sleepSafetyPct);
      saveState(state);
      renderAll(state);
      if (state.sleepSafetyEnabled) sendSleepSafety(true, state.sleepSafetyPct, state.sleepSafetyDurationSec);
    });
  }

  if (sleepDurInput) {
    sleepDurInput.addEventListener("change", () => {
      state.sleepSafetyDurationSec = clampNum(sleepDurInput.value, 5, 600);
      sleepDurInput.value = String(state.sleepSafetyDurationSec);
      saveState(state);
      renderAll(state);
      if (state.sleepSafetyEnabled) sendSleepSafety(true, state.sleepSafetyPct, state.sleepSafetyDurationSec);
    });
  }

  if (sleepToggle) {
    sleepToggle.addEventListener("change", () => {
      if (state.mode === "off") return;
      state.sleepSafetyEnabled = !!sleepToggle.checked;
      saveState(state);
      renderAll(state);
      sendSleepSafety(state.sleepSafetyEnabled, state.sleepSafetyPct, state.sleepSafetyDurationSec);
    });
  }

  // Ramp inputs
  const dur = $("#rampDurationInput");
  const tgt = $("#rampTargetInput");

  if (dur) {
    dur.addEventListener("change", () => {
      state.ui.rampDurationSec = clampNum(dur.value, 5, 600);
      dur.value = state.ui.rampDurationSec;
      saveState(state);
      renderAll(state);
    });
  }

  if (tgt) {
    tgt.addEventListener("change", () => {
      state.ui.rampTargetPct = clampNum(tgt.value, 0, 100);
      tgt.value = state.ui.rampTargetPct;
      saveState(state);
      renderAll(state);
    });
  }

  // Ramp buttons
  const wakeBtn = $("#wakeUpBtn");
  const downBtn = $("#windDownBtn");
  const cancelBtn = $("#cancelRampBtn");

  if (wakeBtn) {
    wakeBtn.addEventListener("click", () => {
      if (state.mode === "off") return;

      // Start a new ramp run
      state.rampUi.running = true;
      state.rampUi.direction = "up";
      state.rampUi.runId += 1;
      const runId = state.rampUi.runId;

      if (state.mode !== "manual") {
        if (state.mode === "auto") sendAutoComp(false);
        state.mode = "manual";
      }

      saveState(state);
      renderAll(state);

      const durSec = clampNum(state.ui.rampDurationSec, 5, 600);

      // You requested: Wake Up ends at 100% (regardless of target input)
      startRamp("up", durSec, 100);
      scheduleRampEnd(state, durSec, 100, runId);
    });
  }

  if (downBtn) {
    downBtn.addEventListener("click", () => {
      if (state.mode === "off") return;

      state.rampUi.running = true;
      state.rampUi.direction = "down";
      state.rampUi.runId += 1;
      const runId = state.rampUi.runId;

      if (state.mode !== "manual") {
        if (state.mode === "auto") sendAutoComp(false);
        state.mode = "manual";
      }

      saveState(state);
      renderAll(state);

      const durSec = clampNum(state.ui.rampDurationSec, 5, 600);

      // Wind down ends at 0%
      startRamp("down", durSec, 0);
      scheduleRampEnd(state, durSec, 0, runId);
    });
  }

  if (cancelBtn) {
    cancelBtn.addEventListener("click", () => {
      state.rampUi.running = false;
      state.rampUi.direction = null;
      clearRampTimer();
      saveState(state);
      renderAll(state);
      cancelRamp();
    });
  }

  // Slider: manual override
  const slider = $("#brightnessSlider");
  if (slider) {
    let sendTimer = null;

    slider.addEventListener("input", () => {
      if (state.mode === "off") return;

      // Cancel ramp if user touches slider (prevents ramp-end commit)
      if (state.rampUi.running) {
        state.rampUi.running = false;
        state.rampUi.direction = null;
        clearRampTimer();
        cancelRamp();
      }

      const shouldAutoSnap = (state.mode === "auto" && state.autoCompEnabled === true);
      if (state.mode === "auto" && !shouldAutoSnap) {
        sendAutoComp(false);
        state.mode = "manual";
      }

      const DIM_LUX = 200;
      const DIM_TARGET = 60;

      const lux = Number(state.runtime.lux);
      const isDim = Number.isFinite(lux) && lux < DIM_LUX;

      const desired = (shouldAutoSnap && isDim)
        ? DIM_TARGET
        : clampNum(slider.value, 0, 100);

      slider.value = String(desired);

      state.ui.brightnessPct = desired;
      saveState(state);
      renderAll(state);

      if (sendTimer) clearTimeout(sendTimer);
      sendTimer = setTimeout(() => sendBrightnessCommand(desired), 150);
    });

    slider.addEventListener("click", () => slider.dispatchEvent(new Event("input")));
  }
}

/* ---------- Polling ---------- */
function connectToBackend(state) {
  async function tick() {
    try {
      syncStateFromStorage(state);
      const res = await fetch(`${SENSOR_URL}?t=${Date.now()}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      applyRuntimeUpdate(state, data);
    } catch {
      renderAll(state);
    }
  }
  tick();
  setInterval(tick, POLL_MS);
}

function startUpdatedTicker(state) {
  setInterval(() => {
    updateUpdatedLabels(state);
    const lastMotionEl = $("#lastMotion");
    if (lastMotionEl && state.runtime.lastMotionAt) lastMotionEl.textContent = fmtTimeAgo(state.runtime.lastMotionAt);
  }, 1000);
}

document.addEventListener("DOMContentLoaded", () => {
  const state = loadState();
  bindCommonHandlers(state);
  renderAll(state);
  startUpdatedTicker(state);
  connectToBackend(state);

  window.addEventListener("storage", (e) => {
    if (e.key !== STORE_KEY) return;
    syncStateFromStorage(state);
    renderAll(state);
  });
});