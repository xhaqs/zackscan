// Can this device receive background alerts (Web Push) while Zackscan is
// closed? When it can't, say so clearly instead of failing silently in an
// emergency.
//
// Known limits:
// - iOS/iPadOS: Web Push works only in an app added to the Home Screen, on
//   iOS 16.4 or later. In Safari tabs it never arrives.
// - In-app browsers (WhatsApp, Facebook, Instagram…) have no push at all.
// - A notification permission of "denied" can only be undone in browser settings.
// - Vibration: not supported on iOS.

export function detectPlatform(nav = navigator, win = globalThis) {
  const ua = nav.userAgent || "";
  const iOS = /iPad|iPhone|iPod/.test(ua) || (nav.platform === "MacIntel" && nav.maxTouchPoints > 1); // iPadOS reports as a Mac
  const m = ua.match(/OS (\d+)[_.](\d+)/);
  const iosVersion = iOS && m ? Number(m[1]) + Number(m[2]) / 100 : null;
  const standalone = nav.standalone === true || !!win.matchMedia?.("(display-mode: standalone)").matches;
  const inAppBrowser = /FBAN|FBAV|Instagram|WhatsApp|Line\/|Snapchat|; wv\)/.test(ua);
  const hasPush = "PushManager" in win && "serviceWorker" in nav && "Notification" in win;
  const permission = "Notification" in win ? win.Notification.permission : "unsupported";
  return { iOS, iosVersion, standalone, inAppBrowser, hasPush, permission, canVibrate: typeof nav.vibrate === "function" };
}

/**
 * What background alerts can do here.
 * @returns {status, message, action?} status: "ready" | "needs-permission" | "blocked" | "install" | "unsupported"
 */
export function pushReadiness(p) {
  if (p.inAppBrowser)
    return { status: "unsupported", message: "This in-app browser can't show alerts when Zackscan is closed. Open zackscan in Chrome or Safari instead." };
  if (p.iOS && p.iosVersion != null && p.iosVersion < 16.4)
    return { status: "unsupported", message: "Background alerts need iOS 16.4 or later. Update iOS, and keep Zackscan open for alarms in the meantime." };
  if (p.iOS && !p.standalone)
    return {
      status: "install",
      message: "On iPhone and iPad, alerts only arrive when Zackscan is on your Home Screen. In Safari, tap Share, then Add to Home Screen, and open Zackscan from there.",
    };
  if (!p.hasPush) return { status: "unsupported", message: "This browser can't receive background alerts. Keep Zackscan open for alarms, or use Chrome, Edge, Firefox or Safari." };
  if (p.permission === "denied")
    return { status: "blocked", message: "Notifications are blocked for this site. Allow them in your browser's site settings, then come back." };
  if (p.permission !== "granted") return { status: "needs-permission", message: "Turn on background alerts to be warned even when Zackscan is closed." };
  return { status: "ready", message: "Background alerts can reach this device." };
}
