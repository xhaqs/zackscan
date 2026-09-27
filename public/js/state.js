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
const CUSTOM_PREF = "zackscan.profile.custom";

function savedProfile() {
  try {
    return getProfile(localStorage.getItem(PREF))?.id;
  } catch {
    return null;
  }
}

function savedCustomProfile() {
  try {
    const raw = localStorage.getItem(CUSTOM_PREF);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function createMissionState({
  root = document.documentElement,
  onChange = () => {},
  onPoll = () => {},
  // Extra profiles (e.g. custom) merged into the profiles list.
  extraProfiles = [],
  // Resolve a profile object by id when getProfile returns null (e.g. custom profiles).
  resolveProfile = null,
} = {}) {
  const state = {
    profile: null,
    events: [],
    feedErrors: [],
    lastFetch: 0,
    loading: false,
    error: null,
    offlineFrom: null,
  };
  let generation = 0; // ignore answers from a profile we've since left

  function applyPalette(p) {
    for (const [k, v] of Object.entries(p.palette))
      root.style.setProperty(
        "--" + k.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase()),
        v,
      );
    root.dataset.profile = p.id;
  }

  async function poll() {
    const gen = generation;
    const p = state.profile;
    state.loading = true;
    onChange(state);
    try {
      const data = await timed(() =>
        p.custom ? api.feedCustom(p) : api.feed(p.id),
      );
      if (gen !== generation) return;
      Object.assign(state, {
        events: data.events,
        feedErrors: data.errors,
        lastFetch: data.fetchedAt,
        error: null,
        offlineFrom: null,
      });
      await saveSnapshot("feed:" + p.id, data, data.fetchedAt || Date.now());
    } catch (e) {
      if (gen !== generation) return;
      state.error = e.message;
      const snap = await loadSnapshot("feed:" + p.id);
      if (snap && gen === generation)
        Object.assign(state, {
          events: snap.data.events,
          feedErrors: snap.data.errors || [],
          lastFetch: snap.fetchedAt,
          offlineFrom: snap.fetchedAt,
        });
      throw e; // let the poller back off
    } finally {
      if (gen === generation) {
        state.loading = false;
        onChange(state);
      }
    }
  }

  const poller = createPoller({
    task: poll,
    baseMs: () => state.profile.pollMs,
    onState: onPoll,
  });

  const api_ = {
    get state() {
      return state;
    },
    get profiles() {
      return [...Object.values(PROFILES), ...extraProfiles];
    },
    setProfile(id, profileObj = null) {
      const p =
        profileObj ||
        getProfile(id) ||
        (resolveProfile && resolveProfile(id)) ||
        PROFILES[DEFAULT_PROFILE];
      generation++;
      Object.assign(state, {
        profile: p,
        events: [],
        offlineFrom: null,
        error: null,
      });
      try {
        if (p.custom) {
          localStorage.setItem(PREF, "__custom__");
          localStorage.setItem(CUSTOM_PREF, JSON.stringify(p));
        } else {
          localStorage.setItem(PREF, p.id);
          localStorage.removeItem(CUSTOM_PREF);
        }
      } catch {}
      applyPalette(p);
      poller.restart();
    },
    refresh: () => poller.restart(),
    stop: () => poller.stop(),
  };

  // Restore last-used profile, including custom ones.
  const savedId = savedProfile();
  if (savedId === "__custom__") {
    const custom = savedCustomProfile();
    if (custom) {
      api_.setProfile(custom.id, custom);
    } else {
      api_.setProfile(DEFAULT_PROFILE);
    }
  } else {
    api_.setProfile(savedId || DEFAULT_PROFILE);
  }
  return api_;
}
