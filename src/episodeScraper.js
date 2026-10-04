/**
 * episodeScraper.js
 *
 * Scrapes episode download options and decrypts direct platform links from archive.toonworld4all.me.
 */

import { fetchWithCookies } from "./fetcher.js";

// Secret key discovered from archive.toonworld4all.me SSR bundle
const ARCHIVE_SECRET_KEY = "e7868835439f5dbf27d679460c5dd2fab45e3d88cc5f0d3a5cedc3b0a67ec209";

class AESDecryptor {
  constructor() {
    this.encoder = new TextEncoder();
    this.decoder = new TextDecoder();
    this.keyCache = new Map();
  }

  fromHex(t) {
    const n = new Uint8Array(t.length / 2);
    for (let r = 0; r < n.length; r++) {
      n[r] = parseInt(t.substr(r * 2, 2), 16);
    }
    return n;
  }

  async getKey(t) {
    if (this.keyCache.has(t)) return this.keyCache.get(t);
    const n = this.encoder.encode(t);
    const r = await crypto.subtle.digest("SHA-256", n);
    const o = await crypto.subtle.importKey("raw", r, { name: "AES-CTR" }, false, ["encrypt", "decrypt"]);
    this.keyCache.set(t, o);
    return o;
  }

  async decrypt(t, n) {
    const r = this.fromHex(t);
    const o = r.slice(0, 16);
    const s = r.slice(16);
    const i = await this.getKey(n);
    const c = await crypto.subtle.decrypt({ name: "AES-CTR", counter: o, length: 64 }, i, s);
    return JSON.parse(this.decoder.decode(c));
  }
}

const decryptor = new AESDecryptor();

/**
 * Decrypt a /redirect/<hash> URL to extract the real direct platform link.
 *
 * @param {string} urlOrHash
 * @returns {Promise<string|null>}
 */
export async function decryptRedirectUrl(urlOrHash) {
  if (!urlOrHash) return null;
  const match = urlOrHash.match(/\/redirect\/([a-f0-9]+)/i);
  const hash = match ? match[1] : (urlOrHash.match(/^[a-f0-9]{32,}$/i) ? urlOrHash : null);
  if (!hash) return null;

  try {
    const decrypted = await decryptor.decrypt(hash, ARCHIVE_SECRET_KEY);
    return decrypted?.url || null;
  } catch (err) {
    console.error("AES-CTR decryption error:", err.message);
    return null;
  }
}

/**
 * Scrape episode qualities and direct download platform links from an episode URL.
 *
 * @param {string} episodeUrl  e.g. "https://archive.toonworld4all.me/episode/the-exiled-heavy-knight-knows-1x11"
 * @param {boolean} resolveLinks
 * @param {string|Array} [customCookies]
 * @returns {Promise<Object>}
 */
export async function scrapeEpisode(episodeUrl, resolveLinks = true, customCookies = null) {
  const parsedUrl = new URL(episodeUrl);
  const baseUrl = parsedUrl.origin;

  const res = await fetchWithCookies(episodeUrl, { customCookies });
  if (!res.ok) {
    throw new Error(`Episode page returned HTTP ${res.status}`);
  }

  const html = await res.text();
  const match = html.match(/window\.__PROPS__\s*=\s*(\{.*?\});/);
  if (!match) {
    throw new Error("Could not find episode data on page");
  }

  let props;
  try {
    props = JSON.parse(match[1]);
  } catch (err) {
    throw new Error("Failed to parse episode props JSON: " + err.message);
  }

  const epData = props.data?.data;
  if (!epData) {
    throw new Error("No episode details available");
  }

  const metadata = epData.metadata || {};
  const encodes = epData.encodes || [];

  const qualities = await Promise.all(encodes.map(async (enc) => {
    const files = await Promise.all((enc.files || []).map(async (f) => {
      const redirectUrl = f.link.startsWith("http")
        ? f.link
        : baseUrl + f.link;

      let finalUrl = null;
      if (resolveLinks) {
        finalUrl = await decryptRedirectUrl(f.link);
      }

      return {
        host: f.host,
        short: f.short || "",
        icon: f.icon || "",
        redirectUrl,
        finalUrl: finalUrl || redirectUrl,
        destinationUrl: finalUrl || redirectUrl,
        isAdShortener: false,
      };
    }));

    return {
      resolution: enc.resolution || "",
      codec: enc.readable?.codec || enc.codec || "",
      size: enc.readable?.size || "",
      files,
    };
  }));

  // If any link could not be decrypted via AES, fallback to network resolution with cookies
  if (resolveLinks) {
    for (const q of qualities) {
      for (const f of q.files) {
        if (!f.finalUrl || f.finalUrl.includes("/redirect/")) {
          try {
            const fallback = await resolveRedirectPage(f.redirectUrl, customCookies);
            f.finalUrl = fallback.url;
            f.destinationUrl = fallback.url;
            f.isAdShortener = fallback.isAdShortener;
          } catch (e) {
            // Ignore fallback errors
          }
        }
      }
    }
  }

  return {
    title: metadata.show || metadata.slug || "",
    season: metadata.season || 1,
    episode: metadata.episode || 1,
    updatedAt: epData.updated_at || "",
    qualities,
  };
}

/**
 * Access the redirect page or decrypt the link directly.
 *
 * @param {string} redirectUrl
 * @param {string|Array} [customCookies]
 * @returns {Promise<{ url: string, isAdShortener: boolean }>}
 */
export async function resolveRedirectPage(redirectUrl, customCookies = null) {
  // First attempt instant AES decryption
  const decrypted = await decryptRedirectUrl(redirectUrl);
  if (decrypted) {
    return { url: decrypted, isAdShortener: false };
  }

  // Fallback to HTTP request
  const res = await fetchWithCookies(redirectUrl, { customCookies });
  if (!res.ok) {
    throw new Error(`Redirect page returned HTTP ${res.status}`);
  }

  if (res.url && res.url !== redirectUrl && !res.url.includes("/redirect/")) {
    return { url: res.url, isAdShortener: false };
  }

  const html = await res.text();
  const match = html.match(/window\.__PROPS__\s*=\s*(\{.*?\});/);
  if (!match) {
    throw new Error("No props found on redirect page");
  }

  let props;
  try {
    props = JSON.parse(match[1]);
  } catch (err) {
    throw new Error("Failed to parse redirect props: " + err.message);
  }

  const destination = props.destination || "";
  const isAdShortener = /exe\.io|cuty\.io|gplinks\.com/i.test(destination);

  return {
    url: destination || redirectUrl,
    isAdShortener,
  };
}

export const resolvePlatformLink = resolveRedirectPage;
