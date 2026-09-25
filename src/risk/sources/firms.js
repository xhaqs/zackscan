// NASA FIRMS active-fire detections (area API, CSV). Free, but needs a
// MAP_KEY: https://firms.modaps.eosdis.nasa.gov/api/map_key/
// Limit: 5000 transactions per 10 minutes per key.
// https://firms.modaps.eosdis.nasa.gov/api/area/

import { getText, SourceError } from "./http.js";
import { fireBox } from "../regions.js";

const BASE = "https://firms.modaps.eosdis.nasa.gov/api/area/csv/";
export const FIRMS_SOURCES = ["VIIRS_NOAA20_NRT", "VIIRS_NOAA21_NRT", "VIIRS_SNPP_NRT", "MODIS_NRT"];

/** Detections in the region's box over the last `days` (1-5) days. */
export async function fireDetections(region, { mapKey, source = "VIIRS_NOAA20_NRT", days = 1, fetch } = {}) {
  if (!FIRMS_SOURCES.includes(source)) throw new SourceError("FIRMS", `unknown source ${source}`);
  const url = `${BASE}${encodeURIComponent(mapKey)}/${source}/${fireBox(region).join(",")}/${days}`;
  const text = await getText("FIRMS", url, { fetch });
  return parseFirmsCsv(text);
}

/**
 * FIRMS answers a bad key with a plain-text message and HTTP 200, so the
 * header row is checked before anything is trusted.
 */
export function parseFirmsCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  const header = (lines[0] || "").split(",");
  const col = (name) => header.indexOf(name);
  if (col("latitude") < 0 || col("longitude") < 0) {
    const msg = (lines[0] || "empty response").slice(0, 80);
    throw new SourceError("FIRMS", /invalid|key/i.test(msg) ? "MAP_KEY rejected" : "unexpected response: " + msg, {
      code: /invalid|key/i.test(msg) ? "unauthorized" : "bad_response",
    });
  }
  const [iLat, iLon, iFrp, iConf, iDate, iTime] = ["latitude", "longitude", "frp", "confidence", "acq_date", "acq_time"].map(col);
  return lines.slice(1).filter(Boolean).map((line) => {
    const f = line.split(",");
    return {
      lat: Number(f[iLat]),
      lon: Number(f[iLon]),
      frpMw: iFrp >= 0 ? Number(f[iFrp]) || 0 : 0,
      confidence: iConf >= 0 ? f[iConf] : "",
      acq: iDate >= 0 ? `${f[iDate]} ${iTime >= 0 ? f[iTime] : ""}`.trim() : "",
    };
  });
}

/** VIIRS confidence is l/n/h; MODIS is 0-100. Low-confidence detections are dropped. */
export function isConfident(d) {
  if (/^[lnh]$/i.test(d.confidence)) return d.confidence.toLowerCase() !== "l";
  const n = Number(d.confidence);
  return Number.isFinite(n) ? n >= 30 : true;
}
