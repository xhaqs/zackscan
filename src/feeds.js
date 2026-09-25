// Fetch and normalize a profile's public feeds (NASA EONET, USGS).
// URLs come only from the profile definition; nothing here takes a URL from
// the request.

export async function loadProfileEvents(profile, deps = {}) {
  const fetchImpl = deps.fetch || fetch;
  // Cache upstream for half the polling interval: fresh enough for the
  // profile, and many viewers polling costs one upstream fetch.
  const cacheTtl = Math.max(15, Math.floor(profile.pollMs / 2000));
  const results = await Promise.allSettled(
    profile.feeds.map(async (feed) => {
      const res = await fetchImpl(feed.url, { cf: { cacheTtl, cacheEverything: true }, signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`${feed.source} ${res.status}`);
      const data = await res.json();
      return feed.source === "usgs" ? fromUsgs(data) : fromEonet(data);
    }),
  );
  const events = [];
  const errors = [];
  results.forEach((r, i) => (r.status === "fulfilled" ? events.push(...r.value) : errors.push(profile.feeds[i].source)));
  events.sort((a, b) => b.time - a.time);
  return { events, errors, fetchedAt: Date.now() };
}

function fromEonet(data) {
  return (data.events || []).map((e) => {
    const g = (e.geometry || []).at(-1) || {};
    const [lon, lat] = pointOf(g);
    return {
      id: "eonet:" + e.id,
      source: "eonet",
      title: e.title,
      category: e.categories?.[0]?.id || "unknown",
      lat,
      lon,
      time: Date.parse(g.date) || 0,
      magnitude: g.magnitudeValue ?? null,
      magnitudeUnit: g.magnitudeUnit ?? null,
      updates: (e.geometry || []).length,
    };
  });
}

function fromUsgs(data) {
  return (data.features || []).map((f) => ({
    id: "usgs:" + f.id,
    source: "usgs",
    title: f.properties.title,
    category: "earthquakes",
    lon: f.geometry?.coordinates?.[0] ?? null,
    lat: f.geometry?.coordinates?.[1] ?? null,
    depthKm: f.geometry?.coordinates?.[2] ?? null,
    time: f.properties.time || 0,
    magnitude: f.properties.mag ?? null,
    magnitudeUnit: f.properties.magType || null,
    tsunami: f.properties.tsunami === 1,
  }));
}

// EONET geometry is a Point or a Polygon; reduce either to one coordinate.
function pointOf(g) {
  if (g.type === "Point") return g.coordinates;
  if (g.type === "Polygon" && g.coordinates?.[0]?.length) {
    const ring = g.coordinates[0];
    return [ring.reduce((s, p) => s + p[0], 0) / ring.length, ring.reduce((s, p) => s + p[1], 0) / ring.length];
  }
  return [null, null];
}
