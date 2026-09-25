// App state. Selecting a Mission Profile changes three things at once:
//   1. how often feeds are polled (profile.pollMs)
//   2. the UI palette (CSS custom properties on <html>)
//   3. what the AI evaluates (the Worker reads the profile's metrics)

import { PROFILES, DEFAULT_PROFILE, getProfile } from "./profiles.js";
import { api } from "./api.js";

const PREF = "zackscan.profile";

function savedProfile() {
  try {
    return getProfile(localStorage.getItem(PREF))?.id;
  } catch {
    return null;
  }
}

export function createMissionState({ root = document.documentElement, onChange = () => {} } = {}) {
  const state = { profile: null, events: [], feedErrors: [], lastFetch: 0, loading: false, error: null };
  let timer = null;
  let generation = 0; // ignore answers from a profile we've since left

  function applyPalette(p) {
    for (const [k, v] of Object.entries(p.palette)) root.style.setProperty("--" + k.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase()), v);
    root.dataset.profile = p.id;
  }

  async function poll() {
    const gen = generation;
    state.loading = true;
    onChange(state);
    try {
      const data = await api.feed(state.profile.id);
      if (gen !== generation) return;
      Object.assign(state, { events: data.events, feedErrors: data.errors, lastFetch: data.fetchedAt, error: null });
    } catch (e) {
      if (gen !== generation) return;
      state.error = e.message;
    } finally {
      if (gen === generation) {
        state.loading = false;
        onChange(state);
      }
    }
  }

  function schedule() {
    clearInterval(timer);
    timer = setInterval(() => document.visibilityState === "visible" && poll(), state.profile.pollMs);
  }

  const api_ = {
    get state() {
      return state;
    },
    profiles: Object.values(PROFILES),
    setProfile(id) {
      const p = getProfile(id) || PROFILES[DEFAULT_PROFILE];
      generation++;
      state.profile = p;
      state.events = [];
      try {
        localStorage.setItem(PREF, p.id);
      } catch {}
      applyPalette(p);
      schedule();
      poll();
    },
    refresh: poll,
    stop() {
      clearInterval(timer);
    },
  };

  // Catch up straight away when the tab comes back into view.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && state.profile && Date.now() - state.lastFetch > state.profile.pollMs) poll();
  });

  api_.setProfile(savedProfile() || DEFAULT_PROFILE);
  return api_;
}
