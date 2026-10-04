/**
 * download-worker/src/extractor.js
 *
 * Dedicated high-speed extractor for GDFlix download links:
 * - Flow 1: instant.busycdn.xyz -> fastdl-one.pages.dev/?url=<GOOGLE_CDN>
 * - Flow 2: instant.busycdn.xyz -> quick.foxcloud.rest -> <a class="btn-danger">Instant Download</a>
 * - 1-hop manual 302 fast-path
 * - Chrome Mobile headers & Cloudflare bypass session cookies
 * - Domain normalization (gdflix.dev / top / fun -> new4.gdflix.io)
 * - Stream guard against buffer overflow on large video downloads
 */

import { buildCookieHeader } from "./cookies.js";

export function escapeHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const GOOGLE_RE = /https?:\/\/video-downloads\.googleusercontent\.com\/[^\s"'<>]+/i;

const CHROME_MOBILE_UA =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36";

function getBrowserHeaders(targetUrl) {
  let hostname = "";
  try {
    hostname = new URL(targetUrl).hostname;
  } catch (e) {}

  const headers = {
    "User-Agent": CHROME_MOBILE_UA,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": "https://new4.gdflix.io/",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "same-origin",
  };

  if (hostname) {
    const cookieHeader = buildCookieHeader(hostname);
    if (cookieHeader) {
      headers["Cookie"] = cookieHeader;
    }
  }

  return headers;
}

/**
 * Extract Google CDN link from quick.foxcloud.rest
 */
export async function extractFoxcloudLink(foxcloudUrl) {
  if (!foxcloudUrl) return null;
  if (GOOGLE_RE.test(foxcloudUrl)) return foxcloudUrl.match(GOOGLE_RE)[0];

  try {
    const res = await fetch(foxcloudUrl, {
      headers: getBrowserHeaders(foxcloudUrl),
      redirect: "follow",
      signal: AbortSignal.timeout(5000),
    });

    if (GOOGLE_RE.test(res.url)) return res.url.match(GOOGLE_RE)[0];

    const ct = res.headers.get("content-type") || "";
    if (ct.includes("video/") || ct.includes("octet-stream")) return res.url;
    if (!res.ok) return null;

    const html = await res.text();

    // 1. Look for <a class="...btn-danger..." href="...">Instant Download</a>
    const btnMatch = html.match(/<a[^>]+class=["'][^"']*btn-danger[^"']*["'][^>]*href=["']([^"']+)["']/i)
      || html.match(/<a[^>]+href=["']([^"']+)["'][^>]*class=["'][^"']*btn-danger[^"']*["']/i);
    if (btnMatch && GOOGLE_RE.test(btnMatch[1])) return btnMatch[1];

    // 2. Any anchor with "Instant Download" text
    const anchorRe = /<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    let m;
    while ((m = anchorRe.exec(html)) !== null) {
      const text = m[2].replace(/<[^>]+>/g, "").trim();
      if (/instant\s*download/i.test(text) && GOOGLE_RE.test(m[1])) return m[1];
    }

    // 3. Direct regex match in HTML
    const gm = html.match(GOOGLE_RE);
    if (gm) return gm[0];

  } catch (err) {
    console.warn("extractFoxcloudLink error:", err.message);
  }
  return null;
}

/**
 * High-speed extractor for GDFlix instant download links.
 */
export async function extractInstantDownloadLink(rawUrl) {
  if (!rawUrl) return null;

  // 1. If already Google CDN
  if (GOOGLE_RE.test(rawUrl)) return rawUrl.match(GOOGLE_RE)[0];

  // 2. If already FoxCloud
  if (rawUrl.includes("foxcloud.rest")) {
    const fox = await extractFoxcloudLink(rawUrl);
    if (fox) return fox;
  }

  // 3. If fastdl pages
  if (rawUrl.includes("fastdl-one.pages.dev") && rawUrl.includes("?url=")) {
    try {
      const p = new URL(rawUrl).searchParams.get("url");
      if (p && GOOGLE_RE.test(p)) return p.match(GOOGLE_RE)[0];
    } catch (e) {}
  }

  // 4. Normalize GDFlix domain to eliminate 301 redirect latency
  let gdflixUrl = rawUrl.replace(
    /https?:\/\/(?:www\.)?gdflix\.(?:dev|top|fun|site|to|lat)\//i,
    "https://new4.gdflix.io/"
  );

  function findInstantUrl(html) {
    // A. Any href attribute containing busycdn or foxcloud
    const cdnHrefRe = /href=["'](https?:\/\/[^"']*(?:busycdn|foxcloud)[^"']*?)["']/i;
    let m = html.match(cdnHrefRe);
    if (m) return m[1];

    // B. Any other attribute (data-url, data-href, action, src) containing busycdn or foxcloud
    const attrRe = /(?:data-url|data-href|data-link|action|src)=["'](https?:\/\/[^"']*(?:busycdn|foxcloud)[^"']*?)["']/i;
    m = html.match(attrRe);
    if (m) return m[1];

    // C. Any JS string containing busycdn or foxcloud
    const jsRe = /["'](https?:\/\/[^"']*(?:busycdn|foxcloud)[^"']+?)["']/i;
    m = html.match(jsRe);
    if (m) return m[1];

    // D. Bare busycdn or foxcloud URL
    const bareRe = /https?:\/\/[a-zA-Z0-9.-]*(?:busycdn|foxcloud)[a-zA-Z0-9./?=_:%-]+/i;
    m = html.match(bareRe);
    if (m) return m[0];

    // E. <a> tag with "Instant DL", "Instant Download", "10GBPS", "Fast Cloud"
    const aRe = /<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    let am;
    while ((am = aRe.exec(html)) !== null) {
      const href = am[1];
      const text = am[2].replace(/<[^>]+>/g, "").trim();
      if (/instant\s*dl|10gbps|instant\s*download|fast\s*cloud|direct\s*dl/i.test(text)) {
        if (/^https?:/i.test(href) && !href.includes("/login")) return href;
      }
    }

    // F. Anchor with btn-danger, btn-success, btn-primary
    const btnRe = /<a[^>]+class=["'][^"']*(?:btn-danger|btn-success|btn-primary)[^"']*["'][^>]*href=["']([^"']+)["']/gi;
    let bm;
    while ((bm = btnRe.exec(html)) !== null) {
      const href = bm[1];
      if (/^https?:/i.test(href) && !href.includes("/login") && !href.includes("/about-us")) return href;
    }

    const btnReRev = /<a[^>]+href=["']([^"']+)["'][^>]*class=["'][^"']*(?:btn-danger|btn-success|btn-primary)[^"']*["']/gi;
    while ((bm = btnReRev.exec(html)) !== null) {
      const href = bm[1];
      if (/^https?:/i.test(href) && !href.includes("/login") && !href.includes("/about-us")) return href;
    }

    return null;
  }

  async function followInstantUrl(instantUrl) {
    if (GOOGLE_RE.test(instantUrl)) return instantUrl.match(GOOGLE_RE)[0];

    if (instantUrl.includes("foxcloud.rest")) {
      const fox = await extractFoxcloudLink(instantUrl);
      if (fox) return fox;
    }

    // --- Fast Path: 1-hop manual redirect check ---
    try {
      const fastRes = await fetch(instantUrl, {
        headers: getBrowserHeaders(instantUrl),
        redirect: "manual",
        signal: AbortSignal.timeout(3500),
      });

      const loc = fastRes.headers.get("location");
      if (loc) {
        if (GOOGLE_RE.test(loc)) return loc.match(GOOGLE_RE)[0];

        try {
          const targetUrl = new URL(loc, instantUrl);
          const p = targetUrl.searchParams.get("url");
          if (p && GOOGLE_RE.test(p)) return p.match(GOOGLE_RE)[0];
        } catch (e) {}

        if (loc.includes("foxcloud.rest")) {
          const fox = await extractFoxcloudLink(loc);
          if (fox) return fox;
        }
      }

      if (fastRes.status === 200) {
        if (GOOGLE_RE.test(fastRes.url)) return fastRes.url.match(GOOGLE_RE)[0];
        const ct = fastRes.headers.get("content-type") || "";
        if (ct.includes("video/") || ct.includes("octet-stream")) return fastRes.url;
        const html = await fastRes.text();
        const gm = html.match(GOOGLE_RE);
        if (gm) return gm[0];
      }
    } catch (e) {}

    // --- Fallback: Automatic Follow with strict timeout ---
    try {
      const r = await fetch(instantUrl, {
        headers: getBrowserHeaders(instantUrl),
        redirect: "follow",
        signal: AbortSignal.timeout(5000),
      });

      if (GOOGLE_RE.test(r.url)) return r.url.match(GOOGLE_RE)[0];

      const ct = r.headers.get("content-type") || "";
      if (ct.includes("video/") || ct.includes("octet-stream")) return r.url;

      if (r.url && r.url.includes("?url=")) {
        const p = new URL(r.url).searchParams.get("url");
        if (p && GOOGLE_RE.test(p)) return p.match(GOOGLE_RE)[0];
      }

      if (r.url && r.url.includes("foxcloud.rest")) {
        const fox = await extractFoxcloudLink(r.url);
        if (fox) return fox;
      }

      const html = await r.text();

      // Check for Google CDN regex in HTML
      const gm = html.match(GOOGLE_RE);
      if (gm) return gm[0];

      // Check for FoxCloud download button in HTML
      const foxBtn = html.match(/<a[^>]+class=["'][^"']*btn-danger[^"']*["'][^>]*href=["']([^"']+)["']/i)
                  || html.match(/<a[^>]+href=["']([^"']+)["'][^>]*class=["'][^"']*btn-danger[^"']*["']/i);
      if (foxBtn && GOOGLE_RE.test(foxBtn[1])) return foxBtn[1];

      // Any anchor with instant download
      const anchorRe = /<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
      let am;
      while ((am = anchorRe.exec(html)) !== null) {
        if (/instant\s*download/i.test(am[2]) && GOOGLE_RE.test(am[1])) return am[1];
      }

      // Check ?url= param in HTML
      const um = html.match(/[?&]url=([^&"'\s<>]+)/i);
      if (um) {
        const dec = decodeURIComponent(um[1]);
        if (GOOGLE_RE.test(dec)) return dec.match(GOOGLE_RE)[0];
      }

      const vd = html.match(/href=["']([^"']+)["'][^>]*id=["']vd["']/i)
              || html.match(/id=["']vd["'][^>]*href=["']([^"']+)["']/i);
      if (vd && GOOGLE_RE.test(vd[1])) return vd[1];

    } catch (e) {
      console.warn("followInstantUrl fallback error:", e.message);
    }
    return null;
  }

  try {
    const res = await fetch(gdflixUrl, {
      headers: getBrowserHeaders(gdflixUrl),
      signal: AbortSignal.timeout(6000),
    });

    if (!res.ok) return null;

    // Check if redirect landed directly on target
    if (GOOGLE_RE.test(res.url)) return res.url.match(GOOGLE_RE)[0];
    if (res.url && res.url.includes("foxcloud.rest")) {
      const fox = await extractFoxcloudLink(res.url);
      if (fox) return fox;
    }

    const html = await res.text();

    const instantUrl = findInstantUrl(html);
    if (!instantUrl) {
      const gd = html.match(GOOGLE_RE);
      if (gd) return gd[0];
      return null;
    }

    if (GOOGLE_RE.test(instantUrl)) return instantUrl.match(GOOGLE_RE)[0];

    const primary = await followInstantUrl(instantUrl);
    if (primary) return primary;

    return await followRedirectChain(instantUrl);
  } catch (err) {
    console.warn("extractInstantDownloadLink error:", err.message);
    return null;
  }
}

async function followRedirectChain(startUrl) {
  let current = startUrl;
  const seen = new Set();

  for (let hop = 0; hop < 4; hop++) {
    if (!current || seen.has(current)) break;
    seen.add(current);

    if (GOOGLE_RE.test(current)) return current.match(GOOGLE_RE)[0];

    if (current.includes("foxcloud.rest")) {
      const fox = await extractFoxcloudLink(current);
      if (fox) return fox;
    }

    let resp;
    try {
      resp = await fetch(current, {
        headers: getBrowserHeaders(current),
        redirect: "manual",
        signal: AbortSignal.timeout(3500),
      });
    } catch (e) {
      break;
    }

    if (resp.status >= 300 && resp.status < 400) {
      const loc = resp.headers.get("location");
      if (!loc) break;
      const next = new URL(loc, current).href;
      if (GOOGLE_RE.test(next)) return next.match(GOOGLE_RE)[0];
      const p = new URL(next).searchParams.get("url");
      if (p && GOOGLE_RE.test(p)) return p.match(GOOGLE_RE)[0];
      if (next.includes("foxcloud.rest")) {
        const fox = await extractFoxcloudLink(next);
        if (fox) return fox;
      }
      current = next;
      continue;
    }

    const ct = resp.headers.get("content-type") || "";
    if (ct.includes("video/") || ct.includes("octet-stream")) return resp.url;

    const body = await resp.text();

    const foxBtn = body.match(/<a[^>]+class=["'][^"']*btn-danger[^"']*["'][^>]*href=["']([^"']+)["']/i)
                || body.match(/<a[^>]+href=["']([^"']+)["'][^>]*class=["'][^"']*btn-danger[^"']*["']/i);
    if (foxBtn && GOOGLE_RE.test(foxBtn[1])) return foxBtn[1];

    const g = body.match(GOOGLE_RE);
    if (g) return g[0];

    const um = body.match(/[?&]url=([^&"'\s<>]+)/i);
    if (um) {
      try {
        const dec = decodeURIComponent(um[1]);
        if (GOOGLE_RE.test(dec)) return dec.match(GOOGLE_RE)[0];
      } catch (e) {}
    }
    break;
  }
  return null;
}
