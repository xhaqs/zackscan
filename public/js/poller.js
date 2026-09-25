// Adaptive poller: runs `task` on a schedule that backs off on failure,
// stops completely while offline or while the tab is hidden, and slows down
// on data-saver or slow connections. See nextPollDelay for the rules.

import { nextPollDelay, wantDataSaver } from "./offline-logic.js";

const SLOW_MS = 5_000;
let slowResponses = 0;

/** Shared "save data" decision: user setting, browser hint, or a slow link we've measured. */
export function dataSaverOn() {
  let userSetting = "auto";
  try {
    userSetting = localStorage.getItem("zackscan.dataSaver") || "auto";
  } catch {}
  return wantDataSaver({ connection: navigator.connection, userSetting, slowResponses });
}

/** Wrap a fetch-like call to measure how slow the link is. */
export async function timed(fn) {
  const t0 = performance.now();
  const out = await fn();
  slowResponses = performance.now() - t0 > SLOW_MS ? slowResponses + 1 : 0;
  return out;
}

/**
 * @param task    async () => void; throw to count as a failure
 * @param baseMs  () => number, the normal interval (can change, e.g. per profile)
 * @param onState ({failures, nextAt, online}) => void, for the status line
 */
export function createPoller({ task, baseMs, onState = () => {} }) {
  let timer = null;
  let failures = 0;
  let running = false;
  let rerun = false; // restart() asked for while a run was in flight
  let stopped = false;

  function schedule() {
    clearTimeout(timer);
    timer = null;
    const online = navigator.onLine !== false;
    const delay = nextPollDelay({ baseMs: baseMs(), failures, online, dataSaver: dataSaverOn() });
    onState({ failures, online, nextAt: delay == null ? null : Date.now() + delay });
    if (delay != null && !stopped) timer = setTimeout(() => (document.visibilityState === "visible" ? run() : schedule()), delay);
  }

  async function run() {
    if (stopped) return;
    if (running) {
      rerun = true;
      return;
    }
    running = true;
    try {
      await task();
      failures = 0;
    } catch {
      failures++;
    } finally {
      running = false;
      if (rerun) {
        rerun = false;
        run(); // e.g. the profile changed mid-fetch: load the new one now
      } else schedule();
    }
  }

  // Back online, or back in view after a while: update now instead of waiting.
  const onOnline = () => {
    failures = 0;
    run();
  };
  const onOffline = () => schedule(); // cancels the timer and reports offline
  const onVisible = () => document.visibilityState === "visible" && !timer && !running && run();
  addEventListener("online", onOnline);
  addEventListener("offline", onOffline);
  document.addEventListener("visibilitychange", onVisible);

  return {
    run,
    /** Restart immediately (e.g. the user switched profile). */
    restart() {
      failures = 0;
      run();
    },
    stop() {
      stopped = true;
      clearTimeout(timer);
      removeEventListener("online", onOnline);
      removeEventListener("offline", onOffline);
      document.removeEventListener("visibilitychange", onVisible);
    },
  };
}
