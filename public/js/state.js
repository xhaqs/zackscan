// App state. Selecting a Mission Profile changes three things at once:
//   1. how often feeds are polled (profile.pollMs, adapted by the poller)
//   2. the UI palette (CSS custom properties on <html>)
//   3. what the AI evaluates (the Worker reads the profile's metrics)
//
// Offline: each successful feed is saved to IndexedDB. If a fetch fails, the
// saved events are shown and `offlineFrom` says how old they are.

import { PROFILES, DEFAULT_PROFILE, getProfile } from "./profiles.js";
import { api } from "./api.js";
import { createPoller, timed } from "./poller.js";
import { saveSnapshot, loadSnapshot } from "./offline-store.js";

const PREF = "zackscan.profile";

function savedProfile() {
  try {
    return getProfile(localStorage.getItem(PREF))?.id;
  } catch {
    return null;
  }
}

export function createMissionState({ root = document.documentElement, onChange = () => {}, onPoll = () => {} } = {}) {
  const state = { profile: null, events: [], feedErrors: [], lastFetch: 0, loading: false, error: null, offlineFrom: null };
  let generation = 0; // ignore answers from a profile we've since left

  function applyPalette(p) {
    for (const [k, v] of Object.entries(p.palette)) root.style.setProperty("--" + k.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase()), v);
    root.dataset.profile = p.id;
  }

  async function poll() {
    const gen = generation;
    const id = state.profile.id;
    state.loading = true;
    onChange(state);
    try {
      const data = await timed(() => api.feed(id));
      if (gen !== generation) return;
      Object.assign(state, { events: data.events, feedErrors: data.errors, lastFetch: data.fetchedAt, error: null, offlineFrom: null });
      await saveSnapshot("feed:" + id, data, data.fetchedAt || Date.now());
    } catch (e) {
      if (gen !== generation) return;
      state.error = e.message;
      const snap = await loadSnapshot("feed:" + id);
      if (snap && gen === generation)
        Object.assign(state, { events: snap.data.events, feedErrors: snap.data.errors || [], lastFetch: snap.fetchedAt, offlineFrom: snap.fetchedAt });
      throw e; // let the poller back off
    } finally {
      if (gen === generation) {
        state.loading = false;
        onChange(state);
      }
    }
  }

  const poller = createPoller({ task: poll, baseMs: () => state.profile.pollMs, onState: onPoll });

  const api_ = {
    get state() {
      return state;
    },
    profiles: Object.values(PROFILES),
    setProfile(id) {
      const p = getProfile(id) || PROFILES[DEFAULT_PROFILE];
      generation++;
      Object.assign(state, { profile: p, events: [], offlineFrom: null, error: null });
      try {
        localStorage.setItem(PREF, p.id);
      } catch {}
      applyPalette(p);
      poller.restart();
    },
    refresh: () => poller.restart(),
    stop: () => poller.stop(),
  };

  api_.setProfile(savedProfile() || DEFAULT_PROFILE);
  return api_;
}
