// Web Push: RFC 8030 transport, RFC 8291 aes128gcm payload encryption,
// RFC 8292 VAPID auth. Hand-rolled on WebCrypto because the npm `web-push`
// library needs Node's crypto/https and doesn't run in a Worker.
// Ported from Riakoine Empire's src/index.js, where it's proven in production.
//
// Secrets: VAPID_PUBLIC_KEY (base64url, 65-byte uncompressed P-256 point) and
// VAPID_PRIVATE_KEY (base64url, 32-byte private scalar d).

// Only POST to real browser push services. The endpoint URL comes from the
// client, so without this the cron would fetch any URL a caller stored.
const PUSH_HOST_ALLOW = [
  /(^|\.)fcm\.googleapis\.com$/, // Chrome, Android, Edge on Android
  /(^|\.)push\.services\.mozilla\.com$/, // Firefox
  /(^|\.)push\.apple\.com$/, // Safari, iOS home-screen apps
  /(^|\.)notify\.windows\.com$/, // Edge on Windows
];

export function isAllowedPushEndpoint(endpoint) {
  try {
    const u = new URL(endpoint);
    return u.protocol === "https:" && PUSH_HOST_ALLOW.some((re) => re.test(u.hostname));
  } catch {
    return false;
  }
}

export function b64uToBytes(str) {
  let s = String(str).replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToB64u(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function concatBytes(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

export async function hkdfBytes(salt, ikm, info, length) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, length * 8));
}

// Trimmed: secrets piped in via `echo` can carry a stray newline.
export function vapidKeys(env) {
  return { pub: String(env.VAPID_PUBLIC_KEY || "").trim(), priv: String(env.VAPID_PRIVATE_KEY || "").trim() };
}

export async function vapidAuthorization(env, endpoint, now = Date.now()) {
  const te = new TextEncoder();
  const keys = vapidKeys(env);
  const pub = b64uToBytes(keys.pub);
  const signingKey = await crypto.subtle.importKey(
    "jwk",
    { kty: "EC", crv: "P-256", d: keys.priv, x: bytesToB64u(pub.slice(1, 33)), y: bytesToB64u(pub.slice(33, 65)), ext: true },
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const header = bytesToB64u(te.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = bytesToB64u(
    te.encode(
      JSON.stringify({
        aud: new URL(endpoint).origin,
        exp: Math.floor(now / 1000) + 12 * 3600,
        sub: env.VAPID_SUBJECT || "https://zackscan.riakoine.workers.dev",
      }),
    ),
  );
  // WebCrypto's ECDSA output is already raw r||s, exactly JWT's ES256 form.
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, signingKey, te.encode(header + "." + claims)));
  return `vapid t=${header}.${claims}.${bytesToB64u(sig)}, k=${keys.pub}`;
}

export async function encryptPushPayload(sub, plaintextBytes) {
  const te = new TextEncoder();
  const uaPublic = b64uToBytes(sub.p256dh);
  const authSecret = b64uToBytes(sub.auth);
  const asKeys = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", asKeys.publicKey));
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, asKeys.privateKey, 256));
  const ikm = await hkdfBytes(authSecret, ecdhSecret, concatBytes(te.encode("WebPush: info\0"), uaPublic, asPublic), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdfBytes(salt, ikm, te.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdfBytes(salt, ikm, te.encode("Content-Encoding: nonce\0"), 12);
  const aesKey = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  // Single record: payload + 0x02 "last record" padding delimiter.
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aesKey, concatBytes(plaintextBytes, new Uint8Array([2]))));
  // Header: salt(16) | record size(4, BE 4096) | keyid len(1) | keyid(65)
  return concatBytes(salt, new Uint8Array([0, 0, 0x10, 0]), new Uint8Array([asPublic.length]), asPublic, ciphertext);
}

/**
 * Send one push. Returns the push service's HTTP status (201 = accepted;
 * 404/410 = the subscription is dead and should be deleted), or 0 on a
 * network error or missing configuration.
 * urgency "high" asks the push service to deliver even in battery saving.
 */
export async function sendWebPush(env, sub, payload, { ttlSeconds = 3600, urgency = "high", topic, fetch = globalThis.fetch } = {}) {
  const keys = vapidKeys(env);
  if (!keys.pub || !keys.priv) return 0;
  if (!sub || !isAllowedPushEndpoint(sub.endpoint)) return 0;
  try {
    const body = await encryptPushPayload(sub, new TextEncoder().encode(JSON.stringify(payload)));
    const res = await fetch(sub.endpoint, {
      method: "POST",
      headers: {
        TTL: String(ttlSeconds),
        Urgency: urgency,
        // Topic replaces an undelivered older push with the same topic (e.g. the same rule and region).
        ...(topic ? { Topic: topic } : {}),
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
        Authorization: await vapidAuthorization(env, sub.endpoint),
      },
      body,
      signal: AbortSignal.timeout(8000),
    });
    return res.status;
  } catch {
    return 0;
  }
}
