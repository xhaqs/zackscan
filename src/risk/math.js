// Numeric helpers for risk scoring. Pure functions, no I/O.

export const clamp = (x, lo = 0, hi = 100) => Math.min(hi, Math.max(lo, x));

/** Linear interpolation through [x, y] points (x ascending), flat beyond the ends. */
export function piecewise(x, points) {
  if (x <= points[0][0]) return points[0][1];
  for (let i = 1; i < points.length; i++) {
    const [x1, y1] = points[i];
    if (x <= x1) {
      const [x0, y0] = points[i - 1];
      return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
    }
  }
  return points.at(-1)[1];
}

const logFact = [0];
function logFactorial(n) {
  for (let k = logFact.length; k <= n; k++) logFact[k] = logFact[k - 1] + Math.log(k);
  return logFact[n];
}

/** P(N >= n) for N ~ Poisson(lambda). Summed in log space so large n don't underflow. */
export function poissonUpperTail(n, lambda) {
  if (n <= 0) return 1;
  if (lambda <= 0) return 0;
  const logTerm = (k) => -lambda + k * Math.log(lambda) - logFactorial(k);
  if (n <= lambda) {
    // Upper tail is large: 1 minus the lower sum is accurate here.
    let lower = 0;
    for (let k = 0; k < n; k++) lower += Math.exp(logTerm(k));
    return clamp(1 - lower, 0, 1);
  }
  // Upper tail is small: add terms from n upward until they stop mattering.
  let tail = 0;
  for (let k = n; k < n + 10_000; k++) {
    const t = Math.exp(logTerm(k));
    tail += t;
    if (t < tail * 1e-12) break;
  }
  return clamp(tail, 0, 1);
}

/**
 * Turn a probability into a 0-100 surprise score: 20 points per factor of
 * ten. p=0.1 -> 20, 0.01 -> 40, 0.001 -> 60, 1e-5 or rarer -> 100.
 */
export const surpriseScore = (p) => (p >= 1 ? 0 : clamp(-20 * Math.log10(Math.max(p, 1e-12))));

/**
 * Wet-bulb temperature (°C) from air temperature (°C) and relative humidity (%),
 * Stull (2011), J. Appl. Meteor. Climatol. 50, 2267-2269. Valid for RH 5-99%
 * and T -20..50 °C, error within about ±1 °C. Inputs are clamped to that range.
 */
export function wetBulbStull(tempC, rhPct) {
  const T = clamp(tempC, -20, 50);
  const RH = clamp(rhPct, 5, 99);
  return (
    T * Math.atan(0.151977 * Math.sqrt(RH + 8.313659)) +
    Math.atan(T + RH) -
    Math.atan(RH - 1.676331) +
    0.00391838 * RH ** 1.5 * Math.atan(0.023101 * RH) -
    4.686035
  );
}

export function meanStd(values) {
  const n = values.length;
  if (!n) return { mean: NaN, std: NaN, n: 0 };
  const mean = values.reduce((s, v) => s + v, 0) / n;
  const variance = n > 1 ? values.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1) : 0;
  return { mean, std: Math.sqrt(variance), n };
}

export function median(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// US EPA PM2.5 AQI breakpoints (24-hour, µg/m³), as revised in 2024.
const PM25_AQI = [
  [0.0, 9.0, 0, 50],
  [9.1, 35.4, 51, 100],
  [35.5, 55.4, 101, 150],
  [55.5, 125.4, 151, 200],
  [125.5, 225.4, 201, 300],
  [225.5, 325.4, 301, 500],
];

/** AQI for a PM2.5 concentration. Latest readings are used as a stand-in for the 24-h mean. */
export function aqiFromPm25(pm) {
  const c = Math.floor(Math.max(0, pm) * 10) / 10;
  for (const [cLo, cHi, iLo, iHi] of PM25_AQI)
    if (c <= cHi) return Math.round(((iHi - iLo) / (cHi - cLo)) * (Math.max(c, cLo) - cLo) + iLo);
  return 500;
}

export function levelFor(score) {
  if (score == null) return "unknown";
  if (score >= 80) return "severe";
  if (score >= 60) return "high";
  if (score >= 40) return "elevated";
  if (score >= 20) return "guarded";
  return "low";
}

/** Great-circle distance in km. */
export function distanceKm(lat1, lon1, lat2, lon2) {
  const r = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * r) / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lon2 - lon1) * r) / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(a));
}
