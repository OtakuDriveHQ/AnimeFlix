/**
 * fetcher.js
 *
 * A thin wrapper around fetch() that:
 *  - Injects the correct Cookie header for the target hostname
 *  - Spoofs a Chrome Mobile User-Agent (so the site serves mobile layout)
 *  - Follows redirects automatically
 *  - Returns the Response object for further parsing
 */

import { buildCookieHeader, COOKIES } from "./cookies.js";

export { COOKIES };

// Chrome Mobile User-Agent (Android / Chrome latest)
const CHROME_MOBILE_UA =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36";

/**
 * Fetch a URL with injected cookies and Chrome Mobile headers.
 *
 * @param {string} url              Full URL to request
 * @param {RequestInit} [options]   Extra fetch options (method, body, headers, …)
 * @returns {Promise<Response>}
 */
export async function fetchWithCookies(url, options = {}) {
  const parsedUrl = new URL(url);
  const extraCookies = options.customCookies || (options.headers && (options.headers["x-cookies"] || (options.headers.get && options.headers.get("x-cookies"))));
  const cookieHeader = buildCookieHeader(parsedUrl.hostname, extraCookies);

  const headers = new Headers(options.headers || {});

  // Inject cookies
  if (cookieHeader) {
    headers.set("Cookie", cookieHeader);
  }

  // Spoof Chrome Mobile
  headers.set("User-Agent", CHROME_MOBILE_UA);
  headers.set("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8");
  headers.set("Accept-Language", "en-US,en;q=0.9");
  headers.set("Accept-Encoding", "gzip, deflate, br");
  headers.set("Cache-Control", "no-cache");
  headers.set("Pragma", "no-cache");
  headers.set("Upgrade-Insecure-Requests", "1");
  headers.set("Sec-Fetch-Dest", "document");
  headers.set("Sec-Fetch-Mode", "navigate");
  headers.set("Sec-Fetch-Site", "none");
  headers.set("Sec-Fetch-User", "?1");

  const response = await fetch(url, {
    ...options,
    headers,
    redirect: "follow",
  });

  return response;
}
