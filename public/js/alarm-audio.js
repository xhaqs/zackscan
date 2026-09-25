// Alarm sounds, synthesized locally with the Web Audio API (no audio files,
// works offline), plus vibration patterns.
//
//   critical  two-tone hi-lo siren (960 / 770 Hz), loops until stopped (max 60 s)
//   alarm     three sharp beeps
//   reminder  soft two-note chime
//
// Browsers only allow sound after the user has interacted with the page, so
// armAudioUnlock() resumes the AudioContext on the first tap or key press.
// Until then, alarms still show on screen, vibrate and notify.

let ctx = null;

function context() {
  const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!ctx && AC) ctx = new AC();
  return ctx;
}

export const audioReady = () => ctx?.state === "running";

/** Call from a user gesture (tap, key press, "Test alarm" button). */
export async function unlockAudio() {
  const c = context();
  if (!c) return false;
  // Safari 17+: play alarms through the ringer/silent switch, like a real alarm clock.
  try {
    if (navigator.audioSession) navigator.audioSession.type = "playback";
  } catch {}
  if (c.state !== "running") await c.resume().catch(() => {});
  return c.state === "running";
}

/** Unlock on the first interaction anywhere, so a later alarm can sound. */
export function armAudioUnlock() {
  const once = () => {
    unlockAudio();
    removeEventListener("pointerdown", once, true);
    removeEventListener("keydown", once, true);
  };
  addEventListener("pointerdown", once, true);
  addEventListener("keydown", once, true);
}

/**
 * Schedule the sound for `severity` into any BaseAudioContext (a live one,
 * or an OfflineAudioContext in tests). Returns the output gain node.
 */
export function scheduleAlarm(c, severity, { volume = 0.8, durationS, start = c.currentTime } = {}) {
  const out = c.createGain();
  out.gain.value = 0;
  out.connect(c.destination);
  const env = (t0, t1, peak) => {
    // Short ramps avoid clicks at every edge.
    out.gain.setValueAtTime(0, t0);
    out.gain.linearRampToValueAtTime(peak, t0 + 0.01);
    out.gain.setValueAtTime(peak, Math.max(t0 + 0.01, t1 - 0.01));
    out.gain.linearRampToValueAtTime(0, t1);
  };

  if (severity === "critical") {
    const dur = durationS ?? 60;
    const osc = c.createOscillator();
    osc.type = "square"; // harsh on purpose: cuts through noise
    const lp = c.createBiquadFilter(); // takes the painful edge off the square wave
    lp.type = "lowpass";
    lp.frequency.value = 3000;
    osc.connect(lp).connect(out);
    const half = 0.35;
    for (let t = 0, i = 0; t < dur; t += half, i++) osc.frequency.setValueAtTime(i % 2 ? 770 : 960, start + t);
    env(start, start + dur, 0.5 * volume);
    osc.start(start);
    osc.stop(start + dur);
    return { out, stopAt: start + dur, osc };
  }

  if (severity === "alarm") {
    const osc = c.createOscillator();
    osc.type = "sawtooth";
    osc.frequency.value = 880;
    osc.connect(out);
    for (let i = 0; i < 3; i++) env(start + i * 0.3, start + i * 0.3 + 0.18, 0.4 * volume);
    osc.start(start);
    osc.stop(start + 0.9);
    return { out, stopAt: start + 0.9, osc };
  }

  // reminder
  const osc = c.createOscillator();
  osc.type = "sine";
  osc.frequency.setValueAtTime(660, start);
  osc.frequency.setValueAtTime(880, start + 0.25);
  osc.connect(out);
  env(start, start + 0.6, 0.35 * volume);
  osc.start(start);
  osc.stop(start + 0.6);
  return { out, stopAt: start + 0.6, osc };
}

let current = null;

/** Play now. Returns stop(). Plays nothing (quietly) if audio is still locked. */
export function playAlarm(severity, { volume = 0.8 } = {}) {
  stopAlarm();
  const c = context();
  if (!c || c.state !== "running") return () => {};
  const node = scheduleAlarm(c, severity, { volume });
  current = node;
  node.osc.onended = () => current === node && (current = null);
  return stopAlarm;
}

export function stopAlarm() {
  if (!current) return;
  try {
    current.out.gain.cancelScheduledValues(ctx.currentTime);
    current.out.gain.setValueAtTime(0, ctx.currentTime);
    current.osc.stop();
  } catch {}
  current = null;
  navigator.vibrate?.(0);
}

export const VIBRATION = Object.freeze({
  // Long-short-long, repeated for ~10 s: unmistakable in a pocket.
  critical: Array.from({ length: 5 }, () => [700, 200, 700, 200, 200]).flat(),
  alarm: [300, 150, 300, 150, 300],
  reminder: [200],
});

/** Vibrate (Android browsers; iOS Safari has no Vibration API). Returns whether it's supported. */
export function vibrate(severity) {
  if (typeof navigator.vibrate !== "function") return false;
  try {
    return navigator.vibrate(VIBRATION[severity] || VIBRATION.alarm);
  } catch {
    return false;
  }
}
