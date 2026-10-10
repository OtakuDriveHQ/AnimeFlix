/**
 * telegram.js
 *
 * Full Telegram Channel & Interactive Bot Integration for ToonWorld4All / GDFlix:
 * 1. Post to Channel: Thumbnail + Post Details + Synopsis + Season redirect buttons (deep links).
 * 2. Telegram Bot Interaction:
 *    - /start <post_id>_s<season_idx> -> displays episode list as inline keyboard buttons.
 *    - episode click -> displays available qualities for that episode.
 *    - quality click -> generates and displays GDFlix platform download link.
 * 3. 30-Minute Auto-Deletion:
 *    - All bot messages and user prompts in private chats are scheduled and deleted after 30 minutes.
 * 4. Automatic Webhook registration & KV configuration storage.
 */

import { scrapeEpisode, decryptRedirectUrl } from "./episodeScraper.js";
import { scrapePost } from "./postScraper.js";
import { fetchWithCookies } from "./fetcher.js";

/**
 * Escapes HTML characters for Telegram HTML parse mode.
 */
export function escapeHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// ─── Configuration Helpers ───────────────────────────────────────────────────

export const DEFAULT_TELEGRAM_BOT_TOKEN = "8886391655:AAGzveDdUEtAmPe08Ym-C1k7mZXaQ70iwgM";
export const DEFAULT_TELEGRAM_CHAT_ID = "@OtakuDriveHQ";
export const DEFAULT_TELEGRAM_BOT_USERNAME = "OtakuDriveBot";

export async function getBotToken(env) {
  if (env?.BOT_KV) {
    const val = await env.BOT_KV.get("tg_bot_token");
    if (val && val.trim()) return val.trim();
  }
  if (env?.TELEGRAM_BOT_TOKEN && env.TELEGRAM_BOT_TOKEN.trim()) {
    return env.TELEGRAM_BOT_TOKEN.trim();
  }
  return DEFAULT_TELEGRAM_BOT_TOKEN;
}

export async function getChatId(env) {
  if (env?.BOT_KV) {
    const val = await env.BOT_KV.get("tg_chat_id");
    if (val && val.trim()) return val.trim();
  }
  if (env?.TELEGRAM_CHAT_ID && env.TELEGRAM_CHAT_ID.trim()) {
    return env.TELEGRAM_CHAT_ID.trim();
  }
  return DEFAULT_TELEGRAM_CHAT_ID;
}

export async function getBotUsername(env, botToken) {
  if (env?.BOT_KV) {
    const val = await env.BOT_KV.get("tg_bot_username");
    if (val && val.trim()) return val.trim().replace(/^@/, "");
  }
  if (env?.TELEGRAM_BOT_USERNAME && env.TELEGRAM_BOT_USERNAME.trim()) {
    return env.TELEGRAM_BOT_USERNAME.trim().replace(/^@/, "");
  }
  if (botToken) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${botToken}/getMe`);
      const data = await res.json();
      if (data.ok && data.result?.username) {
        const username = data.result.username.replace(/^@/, "");
        if (env?.BOT_KV) {
          await env.BOT_KV.put("tg_bot_username", username);
        }
        return username;
      }
    } catch (e) {
      console.warn("getMe failed:", e.message);
    }
  }
  return DEFAULT_TELEGRAM_BOT_USERNAME;
}

export async function saveTelegramConfig(env, { botToken, chatId, botUsername }) {
  if (!env?.BOT_KV) return false;
  if (botToken !== undefined) await env.BOT_KV.put("tg_bot_token", (botToken || "").trim());
  if (chatId !== undefined) await env.BOT_KV.put("tg_chat_id", (chatId || "").trim());
  if (botUsername !== undefined) await env.BOT_KV.put("tg_bot_username", (botUsername || "").trim().replace(/^@/, ""));
  return true;
}

// ─── Format Channel Post (Poster + Synopsis + Season Buttons) ───────────────

/**
 * Maps common meta key names to emoji icons for the channel post.
 */
const META_EMOJI_MAP = {
  year:       "📅",
  released:   "📅",
  aired:      "📅",
  rating:     "🏆",
  score:      "🏆",
  imdb:       "🏆",
  episode:    "📺",
  episodes:   "📺",
  length:     "📺",
  total:      "📺",
  audio:      "🔊",
  language:   "🔊",
  dubbed:     "🔊",
  status:     "⚡",
  genre:      "🎨",
  genres:     "🎨",
  category:   "🎨",
  quality:    "🎬",
  resolution: "🎬",
  format:     "📦",
  size:       "💾",
  studio:     "🏢",
  network:    "📡",
  director:   "🎥",
  country:    "🌍",
  type:       "📂",
  source:     "📖",
};

/** Pick an emoji for a given meta key. */
function metaEmoji(key) {
  const k = key.toLowerCase().trim();
  for (const [pattern, emoji] of Object.entries(META_EMOJI_MAP)) {
    if (k.includes(pattern)) return emoji;
  }
  return "▫️";
}

/**
 * Formats a post to be published to the Telegram channel.
 *
 * @param {Object} postData       Scraped post data
 * @param {string} postId         Unique short ID stored in BOT_KV
 * @param {string} botUsername   Telegram bot username for deep-link
 * @returns {{ text: string, photoUrl: string|null, replyMarkup: Object }}
 */
export function formatChannelPost(postData = {}, postId = "", botUsername = "") {
  const title = postData.title || "Series";
  const photoUrl = postData.thumbnail || null;
  const seasons = postData.seasons || [];

  // ── Title
  const header = `🍿 <b>${escapeHtml(title)}</b>\n\n`;

  // ── Metadata with per-field emojis
  let metaText = "";
  if (postData.meta) {
    const keys = Object.keys(postData.meta).filter(k => !/synopsis|download/i.test(k));
    for (const k of keys) {
      const emoji = metaEmoji(k);
      const value = postData.meta[k];
      if (/rating|score|imdb/i.test(k)) {
        metaText += `${emoji} <b>${escapeHtml(k)}:</b> ⭐ ${escapeHtml(value)}\n`;
      } else {
        metaText += `${emoji} <b>${escapeHtml(k)}:</b> ${escapeHtml(value)}\n`;
      }
    }
    if (metaText) metaText += "\n";
  }

  // ── Synopsis block
  let synText = "";
  if (postData.synopsis) {
    synText = `Synopsis\n${escapeHtml(postData.synopsis)}\n\n`;
  }

  // Fit into Telegram photo caption limit (1024 chars)
  let fullText = header + metaText + synText;
  if (photoUrl && fullText.length > 1020) {
    const budget = Math.max(60, 1020 - header.length - metaText.length - 20);
    const trimmedSyn = postData.synopsis ? postData.synopsis.slice(0, budget) + "…" : "";
    synText = trimmedSyn ? `Synopsis\n${escapeHtml(trimmedSyn)}\n\n` : "";
    fullText = header + metaText + synText;
  }

  // ── Season inline buttons → bot deep links
  const inlineKeyboard = [];
  const botLink = botUsername ? `https://t.me/${botUsername}` : null;

  if (seasons.length > 0 && botLink) {
    let row = [];
    for (let i = 0; i < seasons.length; i++) {
      const s = seasons[i];
      const sName = s.name || `Season ${i + 1}`;
      const deepLink = `${botLink}?start=${postId}_s${i}`;
      row.push({ text: `📁 ${sName}`, url: deepLink });
      if (row.length === 2) { inlineKeyboard.push(row); row = []; }
    }
    if (row.length > 0) inlineKeyboard.push(row);
  } else if (botLink) {
    inlineKeyboard.push([{ text: "📁 Get Episodes & Qualities", url: `${botLink}?start=${postId}_s0` }]);
  }

  return {
    text: fullText,
    photoUrl,
    replyMarkup: inlineKeyboard.length ? { inline_keyboard: inlineKeyboard } : null,
  };
}


// ─── 30-Minute Message Deletion Mechanism ───────────────────────────────────

/**
 * Record a message to be deleted after `ttlMs` (default 30 mins).
 */
export async function recordMessageForDeletion(env, chatId, messageId, ttlMs = 30 * 60 * 1000) {
  if (!env?.BOT_KV || !chatId || !messageId) return;
  const deleteAt = Date.now() + ttlMs;
  const padded = String(deleteAt).padStart(15, "0");
  const key = `msgdel:${padded}:${chatId}:${messageId}`;
  try {
    // Keep in KV for up to 3 hours as safety margin
    await env.BOT_KV.put(key, "1", { expirationTtl: 10800 });
  } catch (err) {
    console.error("Failed to record message for deletion:", err.message);
  }
}

/**
 * Process pending message deletions. Runs in cron trigger or opportunistically.
 */
export async function processPendingDeletions(env) {
  if (!env?.BOT_KV) return { deleted: 0 };
  const botToken = await getBotToken(env);
  if (!botToken) return { deleted: 0 };

  const now = Date.now();
  let deletedCount = 0;

  try {
    const list = await env.BOT_KV.list({ prefix: "msgdel:", limit: 50 });
    for (const item of list.keys) {
      const parts = item.name.split(":");
      if (parts.length < 4) {
        await env.BOT_KV.delete(item.name);
        continue;
      }

      const deleteAt = parseInt(parts[1], 10);
      const chatId = parts[2];
      const messageId = parts[3];

      if (deleteAt <= now) {
        await deleteTelegramMessage(botToken, chatId, messageId);
        await env.BOT_KV.delete(item.name);
        deletedCount++;
      } else {
        // Since keys are padded with timestamp, list is chronologically sorted.
        // Once we hit a future timestamp, stop processing this batch.
        break;
      }
    }
  } catch (err) {
    console.error("Error processing pending deletions:", err.message);
  }

  return { deleted: deletedCount };
}

/**
 * Delete a specific message from Telegram chat.
 */
export async function deleteTelegramMessage(botToken, chatId, messageId) {
  if (!botToken || !chatId || !messageId) return false;
  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/deleteMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, message_id: messageId }),
    });
    const d = await res.json();
    return d.ok === true;
  } catch (e) {
    return false;
  }
}

// ─── GDFlix Link Generator & Instant DL Extractor ────────────────────────────

/**
 * Opens the GDFlix page and extracts the fresh "Instant DL" download link.
 *
 * @param {string} gdflixUrl
 * @returns {Promise<string|null>}
 */
/**
 * Extracts the final Google Video download link from a quick.foxcloud.rest page:
 * <a class="btn btn-lg btn-danger" href="https://video-downloads.googleusercontent.com/...">Instant Download</a>
 *
 * @param {string} foxcloudUrl
 * @returns {Promise<string|null>}
 */
/**
 * Fast Foxcloud direct link extractor with strict timeout.
 *
 * @param {string} foxcloudUrl
 * @returns {Promise<string|null>}
 */
export async function extractFoxcloudLink(foxcloudUrl) {
  if (!foxcloudUrl) return null;
  const GOOGLE_RE = /https?:\/\/video-downloads\.googleusercontent\.com\/[^\s"'<>]+/i;

  if (GOOGLE_RE.test(foxcloudUrl)) {
    return foxcloudUrl.match(GOOGLE_RE)[0];
  }

  try {
    const res = await fetch(foxcloudUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Referer": "https://new4.gdflix.io/",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(4500),
    });

    if (GOOGLE_RE.test(res.url)) {
      return res.url.match(GOOGLE_RE)[0];
    }

    const ct = res.headers.get("content-type") || "";
    if (ct.includes("video/") || ct.includes("octet-stream")) {
      return res.url;
    }

    if (!res.ok) return null;
    const html = await res.text();

    // 1. Look for <a class="...btn-danger..." href="...">Instant Download</a>
    const btnMatch = html.match(/<a[^>]+class=["'][^"']*btn-danger[^"']*["'][^>]*href=["']([^"']+)["']/i)
      || html.match(/<a[^>]+href=["']([^"']+)["'][^>]*class=["'][^"']*btn-danger[^"']*["']/i);
    if (btnMatch && GOOGLE_RE.test(btnMatch[1])) {
      return btnMatch[1];
    }

    // 2. Any anchor with "Instant Download" text
    const anchorRe = /<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    let m;
    while ((m = anchorRe.exec(html)) !== null) {
      const text = m[2].replace(/<[^>]+>/g, "").trim();
      if (/instant\s*download/i.test(text) && GOOGLE_RE.test(m[1])) {
        return m[1];
      }
    }

    // 3. Direct regex match
    const gm = html.match(GOOGLE_RE);
    if (gm) return gm[0];

  } catch (err) {
    console.warn("extractFoxcloudLink error:", err.message);
  }
  return null;
}

/**
 * High-speed extractor for GDFlix instant download links.
 *
 * Optimizations:
 *  - 1-hop manual redirect check: resolves busycdn -> ?url=<GOOGLE> in ~150-300ms without fetching destination page
 *  - Never reads r.text() on binary/video streams (prevents gigabyte downloads into memory)
 *  - Strict per-request timeouts (3.5s - 5s) to eliminate hanging
 *  - Dual flow support: fastdl-one + quick.foxcloud.rest
 *
 * @param {string} gdflixUrl
 * @returns {Promise<string|null>}
 */
export async function extractInstantDownloadLink(gdflixUrl, hubcloudUrl = null) {
  if (!gdflixUrl && !hubcloudUrl) return null;

  if (gdflixUrl && /hubcloud|gamerxyt|sportverse/i.test(gdflixUrl)) {
    return await extractHubcloudDownloadLink(gdflixUrl);
  }

  if (gdflixUrl) {
    const direct = await extractSingleGdflix(gdflixUrl);
    if (direct) return direct;
  }

  // Automatic Fallback to HubCloud if GDFlix extraction failed
  if (hubcloudUrl) {
    console.log("GDFlix extraction failed. Falling back to HubCloud:", hubcloudUrl);
    try {
      const hubRes = await extractHubcloudDownloadLink(hubcloudUrl);
      if (hubRes) return hubRes;
    } catch (e) {
      console.warn("Fallback to HubCloud failed:", e.message);
    }
  }

  return null;
}

async function extractSingleGdflix(gdflixUrl) {
  if (!gdflixUrl) return null;

  const GOOGLE_RE = /https?:\/\/video-downloads\.googleusercontent\.com\/[^\s"'<>]+/i;

  if (GOOGLE_RE.test(gdflixUrl)) {
    return gdflixUrl.match(GOOGLE_RE)[0];
  }

  if (gdflixUrl.includes("foxcloud.rest")) {
    const fox = await extractFoxcloudLink(gdflixUrl);
    if (fox) return fox;
  }

  /** Fast attribute / regex scanner for the instant download URL. */
  function findInstantUrl(html) {
    // 1. Any attribute containing busycdn or foxcloud
    const attrRe = /(?:href|src|data-url|data-href|data-link|action)=["'](https?:\/\/[^"']*(?:busycdn|foxcloud)[^"']*?)["']/gi;
    let m = attrRe.exec(html);
    if (m) return m[1];

    // 2. Any JS string containing busycdn or foxcloud
    const jsRe = /["'](https?:\/\/[^"']*(?:busycdn|foxcloud)[^"']+?)["']/gi;
    m = jsRe.exec(html);
    if (m) return m[1];

    // 3. Bare busycdn or foxcloud URL anywhere in HTML
    const bareRe = /https?:\/\/[a-zA-Z0-9.-]*(?:busycdn|foxcloud)[a-zA-Z0-9./?=_:%-]+/gi;
    m = bareRe.exec(html);
    if (m) return m[0];

    // 4. <a> tag with "Instant DL" or "10GBPS" or "Instant Download" text
    const aRe = /<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    let am;
    while ((am = aRe.exec(html)) !== null) {
      const text = am[2].replace(/<[^>]+>/g, "").trim();
      if (/instant\s*dl|10gbps|instant\s*download/i.test(text)) return am[1];
    }

    // 5. Any <a class="...btn-danger...">
    const btnRe = /<a[^>]+class=["'][^"']*btn-danger[^"']*["'][^>]*href=["']([^"']+)["']/i;
    const bm = html.match(btnRe);
    if (bm && /^https?:/i.test(bm[1])) return bm[1];

    return null;
  }

  /**
   * Fast-path resolution of the instant URL.
   * Checks manual 302 first to catch ?url= directly from the Location header.
   */
  async function followInstantUrl(instantUrl) {
    if (GOOGLE_RE.test(instantUrl)) {
      return instantUrl.match(GOOGLE_RE)[0];
    }

    // If it's directly a foxcloud link, resolve it immediately
    if (instantUrl.includes("foxcloud.rest")) {
      const fox = await extractFoxcloudLink(instantUrl);
      if (fox) return fox;
    }

    // --- Fast Path: 1-hop manual redirect check ---
    try {
      const fastRes = await fetch(instantUrl, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Referer": "https://new4.gdflix.io/",
        },
        redirect: "manual",
        signal: AbortSignal.timeout(3500),
      });

      const loc = fastRes.headers.get("location");
      if (loc) {
        // A. Location header contains direct Google link
        if (GOOGLE_RE.test(loc)) {
          return loc.match(GOOGLE_RE)[0];
        }

        // B. Location header contains ?url=<DIRECT_LINK> (fastdl-one)
        try {
          const targetUrl = new URL(loc, instantUrl);
          const p = targetUrl.searchParams.get("url");
          if (p && GOOGLE_RE.test(p)) {
            return p.match(GOOGLE_RE)[0];
          }
        } catch (e) {}

        // C. Location header redirects to foxcloud
        if (loc.includes("foxcloud.rest")) {
          const fox = await extractFoxcloudLink(loc);
          if (fox) return fox;
        }
      }

      // If status 200, check content type before reading body
      if (fastRes.status === 200) {
        if (GOOGLE_RE.test(fastRes.url)) return fastRes.url.match(GOOGLE_RE)[0];
        const ct = fastRes.headers.get("content-type") || "";
        if (ct.includes("video/") || ct.includes("octet-stream")) {
          return fastRes.url;
        }
        const html = await fastRes.text();
        const gm = html.match(GOOGLE_RE);
        if (gm) return gm[0];
      }
    } catch (e) {
      // Manual hop timed out or failed, fall through to automatic follow
    }

    // --- Fallback: Automatic Follow with strict timeout ---
    try {
      const r = await fetch(instantUrl, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Referer": "https://new4.gdflix.io/",
        },
        redirect: "follow",
        signal: AbortSignal.timeout(4500),
      });

      // Check if landed on Google CDN directly
      if (GOOGLE_RE.test(r.url)) {
        return r.url.match(GOOGLE_RE)[0];
      }

      // Check content-type to never stream video bytes into RAM
      const ct = r.headers.get("content-type") || "";
      if (ct.includes("video/") || ct.includes("octet-stream")) {
        return r.url;
      }

      // Check ?url= param on final landing URL
      if (r.url && r.url.includes("?url=")) {
        const p = new URL(r.url).searchParams.get("url");
        if (p && GOOGLE_RE.test(p)) {
          return p.match(GOOGLE_RE)[0];
        }
      }

      // If landed on foxcloud.rest
      if (r.url && r.url.includes("foxcloud.rest")) {
        const fox = await extractFoxcloudLink(r.url);
        if (fox) return fox;
      }

      const html = await r.text();

      // Check for foxcloud button on landing HTML
      const foxBtn = html.match(/<a[^>]+class=["'][^"']*btn-danger[^"']*["'][^>]*href=["']([^"']+)["']/i)
                  || html.match(/<a[^>]+href=["']([^"']+)["'][^>]*class=["'][^"']*btn-danger[^"']*["']/i);
      if (foxBtn && GOOGLE_RE.test(foxBtn[1])) return foxBtn[1];

      // Direct googleusercontent link in landing HTML
      const gm = html.match(GOOGLE_RE);
      if (gm) return gm[0];

      // ?url= in HTML attribute or JS string
      const um = html.match(/[?&]url=([^&"'\s<>]+)/i);
      if (um) {
        const dec = decodeURIComponent(um[1]);
        if (GOOGLE_RE.test(dec)) return dec.match(GOOGLE_RE)[0];
      }

      // href="#vd" Download button
      const vd = html.match(/href=["']([^"']+)["'][^>]*id=["']vd["']/i)
              || html.match(/id=["']vd["'][^>]*href=["']([^"']+)["']/i);
      if (vd && GOOGLE_RE.test(vd[1])) return vd[1];

    } catch (e) {
      console.warn("followInstantUrl fallback error:", e.message);
    }
    return null;
  }

  try {
    // Step 1: Fetch GDFlix page with cookies (Cloudflare bypass) + timeout
    const res = await fetchWithCookies(gdflixUrl, {
      signal: AbortSignal.timeout(5500),
    });
    if (!res.ok) {
      console.warn("GDFlix fetch returned HTTP", res.status);
      return null;
    }
    const html = await res.text();

    // Step 2: Find Instant DL button URL in page HTML
    const instantUrl = findInstantUrl(html);

    if (!instantUrl) {
      const gd = html.match(GOOGLE_RE);
      if (gd) return gd[0];
      console.warn("Instant DL URL not found on GDFlix page. Preview:", html.slice(0, 300));
      return null;
    }

    // Direct match check
    if (GOOGLE_RE.test(instantUrl)) {
      return instantUrl.match(GOOGLE_RE)[0];
    }

    // Step 3: Fast primary resolution (manual 302 + automatic follow)
    const primary = await followInstantUrl(instantUrl);
    if (primary) return primary;

    // Step 4: Fallback hop-by-hop chain (max 4 hops with 3s timeouts)
    const chainRes = await followRedirectChain(instantUrl);
    if (chainRes) return chainRes;

  } catch (err) {
    console.warn("extractSingleGdflix error:", err.message);
  }

  return null;
}

async function followRedirectChain(startUrl) {
  const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";
  const GOOGLE_RE = /https?:\/\/video-downloads\.googleusercontent\.com\/[^\s"'<>]+/i;
  let current = startUrl;
  const seen = new Set();

  for (let hop = 0; hop < 4; hop++) {
    if (!current || seen.has(current)) break;
    seen.add(current);

    if (GOOGLE_RE.test(current)) return current.match(GOOGLE_RE)[0];

    // If current is foxcloud, extract directly
    if (current.includes("foxcloud.rest")) {
      const fox = await extractFoxcloudLink(current);
      if (fox) return fox;
    }

    let resp;
    try {
      resp = await fetch(current, {
        headers: {
          "User-Agent": UA,
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Referer": "https://new4.gdflix.io/",
        },
        redirect: "manual",
        signal: AbortSignal.timeout(3000),
      });
    } catch (e) {
      break;
    }

    // HTTP redirect (301, 302, 303, 307, 308)
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
    if (ct.includes("video/") || ct.includes("octet-stream")) {
      return resp.url;
    }

    const body = await resp.text();

    // 1. Foxcloud button
    const foxBtn = body.match(/<a[^>]+class=["'][^"']*btn-danger[^"']*["'][^>]*href=["']([^"']+)["']/i)
                || body.match(/<a[^>]+href=["']([^"']+)["'][^>]*class=["'][^"']*btn-danger[^"']*["']/i);
    if (foxBtn && GOOGLE_RE.test(foxBtn[1])) return foxBtn[1];

    // 2. Direct regex match
    const g = body.match(GOOGLE_RE);
    if (g) return g[0];

    // 3. ?url= parameter
    const um = body.match(/[?&]url=([^&"'\s<>]+)/i);
    if (um) {
      try {
        const dec = decodeURIComponent(um[1]);
        if (GOOGLE_RE.test(dec)) return dec.match(GOOGLE_RE)[0];
      } catch (e) {}
    }

    // 4. meta refresh or JS redirect
    const meta = body.match(/<meta[^>]+http-equiv=["']?refresh["']?[^>]+content=["']?\d+;\s*url=([^"'\s>]+)/i);
    const js = body.match(/(?:window\.location(?:\.href)?|location\.href|location\.replace\()\s*=?\s*\(?["']([^"']+)["']/i);
    const nextRaw = (meta && meta[1]) || (js && js[1]);
    if (nextRaw) {
      current = new URL(nextRaw, current).href;
      continue;
    }
    break;
  }
  return null;
}

/**
 * Dedicated multi-hop extractor for HubCloud platform download links:
 * - Step 1: Open HubCloud landing page -> Find "Generate Direct Download Link" button
 * - Step 2: Open hubcloud.php intermediate page -> Find "Download [Server : 10Gbps]" button
 * - Step 3: Follow redirect (to worker or dl.php) -> Extract Google CDN video link from ?link= or #downloadBtn
 */
export async function extractHubcloudDownloadLink(hubcloudUrl, retries = 1) {
  if (!hubcloudUrl) return null;
  const GOOGLE_RE = /https?:\/\/video-downloads\.googleusercontent\.com\/[^\s"'<>]+/i;
  const MOBILE_UA = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36";
  const baseHeaders = {
    "User-Agent": MOBILE_UA,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": "https://new4.gdflix.io/",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "same-origin",
  };

  if (GOOGLE_RE.test(hubcloudUrl)) return hubcloudUrl.match(GOOGLE_RE)[0];

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      // 1. Fetch HubCloud Initial Page
      const res1 = await fetch(hubcloudUrl, {
        headers: baseHeaders,
        redirect: "follow",
        signal: AbortSignal.timeout(20000),
      });
      if (!res1.ok) {
        console.warn("HubCloud Step 1 returned HTTP", res1.status);
        if (attempt < retries) continue;
        return null;
      }
      const html1 = await res1.text();

      // Find Step 1 button: "Generate Direct Download Link" or link with "hubcloud.php"
      let step2Url = null;
      const re1 = /<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
      let m;
      while ((m = re1.exec(html1)) !== null) {
        const href = m[1];
        const text = m[2];
        if (/generate\s*direct\s*download\s*link/i.test(text) || /hubcloud\.php/i.test(href)) {
          step2Url = href;
          break;
        }
      }
      if (!step2Url) {
        const mPhp = html1.match(/href=["']([^"']*hubcloud\.php[^"']*)["']/i);
        if (mPhp) step2Url = mPhp[1];
      }
      if (!step2Url) {
        console.warn("Could not find Step 1 button in HubCloud HTML");
        if (attempt < retries) continue;
        return null;
      }

      step2Url = new URL(step2Url, res1.url).href;

      // 2. Fetch Step 2 (hubcloud.php)
      const res2 = await fetch(step2Url, {
        headers: {
          ...baseHeaders,
          "Referer": res1.url,
        },
        redirect: "follow",
        signal: AbortSignal.timeout(20000),
      });
      if (!res2.ok) {
        console.warn("HubCloud Step 2 returned HTTP", res2.status);
        if (attempt < retries) continue;
        return null;
      }
      const html2 = await res2.text();

      // Find Step 2 button: "Download [Server : 10Gbps]" or "gpdl" or "btn-danger"
      let step3Url = null;
      const re2 = /<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
      while ((m = re2.exec(html2)) !== null) {
        const href = m[1];
        const text = m[2];
        if (/download\s*\[server/i.test(text) || /gpdl/i.test(href) || (m[0].includes("btn-danger") && /hubcloud/i.test(href))) {
          step3Url = href;
          break;
        }
      }
      if (!step3Url) {
        const mDanger = html2.match(/<a[^>]+class=["'][^"']*btn-danger[^"']*["'][^>]*href=["']([^"']+)["']/i)
          || html2.match(/<a[^>]+href=["']([^"']+)["'][^>]*class=["'][^"']*btn-danger[^"']*["']/i);
        if (mDanger) step3Url = mDanger[1];
      }
      if (!step3Url) {
        console.warn("Could not find Step 2 button in HubCloud HTML");
        if (attempt < retries) continue;
        return null;
      }

      step3Url = new URL(step3Url, res2.url).href;

      // 3. Resolve Step 3 (gpdl link)
      let targetUrl = step3Url;
      try {
        const r3Manual = await fetch(step3Url, {
          headers: {
            ...baseHeaders,
            "Referer": res2.url,
          },
          redirect: "manual",
          signal: AbortSignal.timeout(10000),
        });
        if ([301, 302, 303, 307, 308].includes(r3Manual.status)) {
          const loc = r3Manual.headers.get("location");
          if (loc) {
            targetUrl = new URL(loc, step3Url).href;
          }
        }
      } catch (e) {}

      if (GOOGLE_RE.test(targetUrl)) {
        return targetUrl.match(GOOGLE_RE)[0];
      }
      try {
        const paramLink = new URL(targetUrl).searchParams.get("link");
        if (paramLink && GOOGLE_RE.test(paramLink)) {
          return paramLink.match(GOOGLE_RE)[0];
        }
      } catch (e) {}

      const res3 = await fetch(targetUrl, {
        headers: {
          ...baseHeaders,
          "Referer": step3Url,
        },
        redirect: "follow",
        signal: AbortSignal.timeout(20000),
      });

      if (GOOGLE_RE.test(res3.url)) {
        return res3.url.match(GOOGLE_RE)[0];
      }
      try {
        const finalParam = new URL(res3.url).searchParams.get("link");
        if (finalParam && GOOGLE_RE.test(finalParam)) {
          return finalParam.match(GOOGLE_RE)[0];
        }
      } catch (e) {}

      const html3 = await res3.text();

      const mFinal = html3.match(/id=["']downloadBtn["'][^>]*href=["']([^"']+)["']/i)
        || html3.match(/href=["']([^"']+)["'][^>]*id=["']downloadBtn["']/i)
        || html3.match(/href=["'](https?:\/\/video-downloads\.googleusercontent\.com\/[^"']+)["']/i)
        || html3.match(GOOGLE_RE);

      if (mFinal) {
        const found = mFinal[1] || mFinal[0];
        if (GOOGLE_RE.test(found)) return found.match(GOOGLE_RE)[0];
        return found;
      }

      const mQuery = html3.match(/[?&]link=(https?:\/\/video-downloads\.googleusercontent\.com\/[^"'\s&]+)/i);
      if (mQuery) return decodeURIComponent(mQuery[1]);

    } catch (err) {
      if (attempt < retries) {
        console.warn(`HubCloud attempt ${attempt + 1} error (${err.message}), retrying...`);
        continue;
      }
      console.warn("extractHubcloudDownloadLink error:", err.message);
    }
  }
  return null;
}

export function generateGdflixLink(quality = {}, file = {}) {
  // 1. If explicit GDFlix link exists
  if (file?.finalUrl && /gdflix/i.test(file.finalUrl)) {
    return file.finalUrl;
  }
  if (file?.destinationUrl && /gdflix/i.test(file.destinationUrl)) {
    return file.destinationUrl;
  }

  // 2. Return direct platform link (MEGA, FilePress, AppDrive, HubCloud)
  if (file?.finalUrl && !file.finalUrl.includes("/redirect/")) {
    return file.finalUrl;
  }
  if (file?.destinationUrl && !file.destinationUrl.includes("/redirect/")) {
    return file.destinationUrl;
  }

  // 3. Fallback to redirect link or default platform url
  return file?.redirectUrl || "https://gdflix.io";
}

// ─── Telegram Bot Webhook & Interactive Handlers ────────────────────────────

/**
 * Handle incoming Telegram webhook updates (messages, /start, callback queries).
 */
let WORKER_ORIGIN = "";

export async function handleTelegramWebhook(request, env) {
  try {
    WORKER_ORIGIN = new URL(request.url).origin;
    if (env?.BOT_KV && WORKER_ORIGIN) {
      env.BOT_KV.put("worker_origin", WORKER_ORIGIN).catch(() => {});
    }
  } catch (e) {}
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  let update;
  try {
    update = await request.json();
  } catch (e) {
    return new Response("Invalid JSON", { status: 400 });
  }

  const botToken = await getBotToken(env);
  if (!botToken) {
    return new Response("Bot token not configured", { status: 200 });
  }

  // 1. Opportunistically check expired messages in background
  if (env?.BOT_KV) {
    processPendingDeletions(env).catch(() => {});
  }

  try {
    // 2. Incoming message (e.g. /start <payload>)
    if (update.message) {
      await handleIncomingMessage(update.message, env, botToken);
    }
    // 3. Callback query (inline button clicks)
    else if (update.callback_query) {
      await handleCallbackQuery(update.callback_query, env, botToken);
    }
  } catch (err) {
    console.error("Webhook processing error:", err);
  }

  return new Response(JSON.stringify({ ok: true }), {
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Handle incoming private chat messages (/start, commands).
 */
async function handleIncomingMessage(message, env, botToken) {
  const chatId = message.chat?.id;
  const messageId = message.message_id;
  const text = (message.text || "").trim();

  if (!chatId) return;

  // Auto-delete the user's incoming message after 30 minutes as well
  await recordMessageForDeletion(env, chatId, messageId);

  // Check /start command
  if (text.startsWith("/start")) {
    const parts = text.split(" ");
    const payload = parts[1] ? parts[1].trim() : "";

    if (payload) {
      await handleStartPayload(chatId, payload, env, botToken);
    } else {
      // General welcome message
      const welcome = await sendToTelegram({
        botToken,
        chatId,
        text: `👋 <b>Welcome!</b>\n\nI am your <b>GDFlix & ToonWorld4All</b> Episode Assistant.\n\nTo download episodes:\n1. Browse our Telegram channel.\n2. Click any <b>📁 Season</b> button on a post.\n3. Choose your episode & quality here!\n\n⏳ <i>All bot messages automatically self-destruct in 30 minutes.</i>`,
      });
      if (welcome?.messageId) {
        await recordMessageForDeletion(env, chatId, welcome.messageId);
      }
    }
  }
}

/**
 * Handle /start with deep link payload: e.g. p_<post_id>_s<season_idx>
 */
async function handleStartPayload(chatId, payload, env, botToken) {
  let postId = payload;
  let seasonIdx = 0;

  const m = payload.match(/^(?:p_)?([a-zA-Z0-9_-]+?)(?:_s(\d+))?$/);
  if (m) {
    postId = `p_${m[1]}`;
    seasonIdx = parseInt(m[2] || "0", 10);
  }

  // 1. Try to retrieve post data from BOT_KV directly across all possible keys
  let postData = null;
  if (env?.BOT_KV) {
    postData = await env.BOT_KV.get(`post:${postId}`, "json");
    if (!postData) postData = await env.BOT_KV.get(`post:${payload}`, "json");
    if (!postData && m) postData = await env.BOT_KV.get(`post:${m[1]}`, "json");
    const slug = (m ? m[1] : payload).replace(/^p_/, "").replace(/_[a-z0-9]{4,8}$/, "");
    if (!postData && slug) {
      postData = await env.BOT_KV.get(`post:${slug}`, "json");
      if (!postData) postData = await env.BOT_KV.get(`post:p_${slug}`, "json");
    }
  }

  // 2. If not found in KV, dynamically fetch and re-scrape from ToonWorld4All!
  if (!postData || !postData.title) {
    const waitMsg = await sendToTelegram({
      botToken,
      chatId,
      text: "⏳ <i>Loading series and episodes for you...</i>",
    });
    if (waitMsg?.messageId) await recordMessageForDeletion(env, chatId, waitMsg.messageId);

    const slug = (m ? m[1] : payload).replace(/^p_/, "").replace(/_[a-z0-9]{4,8}$/, "");
    const candidateUrls = [
      `https://toonworld4all.me/anime/${slug}/`,
      `https://toonworld4all.me/${slug}/`,
      `https://toonworld4all.me/series/${slug}/`,
    ];

    for (const testUrl of candidateUrls) {
      try {
        const res = await fetchWithCookies(testUrl);
        if (res.ok) {
          const html = await res.text();
          postData = scrapePost(html);
          if (postData && postData.title) break;
        }
      } catch (e) {}
    }

    // Fallback: Search Toonworld4all for the title if direct URLs did not match
    if (!postData || !postData.title) {
      try {
        const searchQuery = slug.replace(/[-_]+/g, " ");
        const searchRes = await fetchWithCookies(`https://toonworld4all.me/?s=${encodeURIComponent(searchQuery)}`);
        if (searchRes.ok) {
          const searchHtml = await searchRes.text();
          const firstArticle = searchHtml.match(/<h2[^>]*class="[^"]*entry-title[^"]*"[^>]*>\s*<a[^>]+href="([^"]+)"/i);
          if (firstArticle && firstArticle[1]) {
            const pageRes = await fetchWithCookies(firstArticle[1]);
            if (pageRes.ok) {
              postData = scrapePost(await pageRes.text());
            }
          }
        }
      } catch (e) {}
    }

    // Save to BOT_KV for future clicks
    if (postData && postData.title && env?.BOT_KV) {
      await env.BOT_KV.put(`post:${postId}`, JSON.stringify(postData), { expirationTtl: 30 * 86400 });
      if (slug) {
        await env.BOT_KV.put(`post:${slug}`, JSON.stringify(postData), { expirationTtl: 30 * 86400 });
        await env.BOT_KV.put(`post:p_${slug}`, JSON.stringify(postData), { expirationTtl: 30 * 86400 });
      }
    }

    // Clean up temporary loading message
    if (waitMsg?.messageId) {
      await deleteTelegramMessage(botToken, chatId, waitMsg.messageId);
    }
  }

  if (!postData || !postData.title) {
    const sent = await sendToTelegram({
      botToken,
      chatId,
      text: "⚠️ <b>Post not found.</b>\nPlease ensure you clicked a valid post from the channel, or try posting it again from the dashboard.",
    });
    if (sent?.messageId) await recordMessageForDeletion(env, chatId, sent.messageId);
    return;
  }

  await sendEpisodeSelectionMenu(chatId, postData, postId, seasonIdx, env, botToken);
}

/**
 * Sends the Episode Selection Menu with inline keyboard buttons.
 * Supports clean pagination for anime/series with large numbers of episodes.
 */
async function sendEpisodeSelectionMenu(chatId, postData, postId, seasonIdx, env, botToken, editMessageId = null, epPage = 0) {
  const seasons = postData.seasons || [];
  const season = seasons[seasonIdx] || seasons[0] || { name: "Season 1", episodes: [] };
  const episodes = season.episodes || [];

  const PAGE_SIZE = 30;
  const totalEpPages = Math.ceil(episodes.length / PAGE_SIZE) || 1;
  const curPage = Math.min(totalEpPages - 1, Math.max(0, epPage));
  const startIdx = curPage * PAGE_SIZE;
  const endIdx = Math.min(startIdx + PAGE_SIZE, episodes.length);
  const pageEpisodes = episodes.slice(startIdx, endIdx);

  let text = `🎬 <b>${escapeHtml(postData.title)}</b>\n`;
  text += `📺 <b>${escapeHtml(season.name)}</b> (Total: ${episodes.length} Episodes)\n\n`;
  if (totalEpPages > 1) {
    text += `📄 <i>Episodes ${startIdx + 1}–${endIdx} (Page ${curPage + 1}/${totalEpPages})</i>\n\n`;
  }
  text += `👇 <b>Choose an episode to select available qualities:</b>\n\n`;

  // Build grid of episode buttons (3 per row)
  const keyboard = [];
  let row = [];

  for (let i = 0; i < pageEpisodes.length; i++) {
    const globalIdx = startIdx + i;
    const ep = pageEpisodes[i];
    // Short clean label: "Ep 01", "Ep 02", etc.
    let shortLabel = `Ep ${globalIdx + 1}`;
    const epMatch = ep.label?.match(/Episode\s*(\d+)/i);
    if (epMatch) {
      shortLabel = `Ep ${epMatch[1].padStart(2, "0")}`;
    }

    row.push({
      text: `▶️ ${shortLabel}`,
      callback_data: `ep:${postId}:${seasonIdx}:${globalIdx}`,
    });

    if (row.length === 3) {
      keyboard.push(row);
      row = [];
    }
  }
  if (row.length > 0) keyboard.push(row);

  // Pagination row if more than 30 episodes
  if (totalEpPages > 1) {
    const navRow = [];
    if (curPage > 0) {
      navRow.push({
        text: `⬅️ Prev`,
        callback_data: `p_ep:${postId}:${seasonIdx}:${curPage - 1}`,
      });
    }
    navRow.push({
      text: `Page ${curPage + 1}/${totalEpPages}`,
      callback_data: `noop`,
    });
    if (curPage < totalEpPages - 1) {
      navRow.push({
        text: `Next ➡️`,
        callback_data: `p_ep:${postId}:${seasonIdx}:${curPage + 1}`,
      });
    }
    keyboard.push(navRow);
  }

  // If multiple seasons exist, add buttons to switch seasons
  if (seasons.length > 1) {
    const seasonRow = [];
    for (let s = 0; s < seasons.length; s++) {
      if (s !== seasonIdx) {
        seasonRow.push({
          text: `📁 ${seasons[s].name || `S${s+1}`}`,
          callback_data: `sn:${postId}:${s}`,
        });
      }
    }
    if (seasonRow.length) keyboard.push(seasonRow);
  }

  const replyMarkup = { inline_keyboard: keyboard };

  if (editMessageId) {
    const edited = await editTelegramMessage({
      botToken,
      chatId,
      messageId: editMessageId,
      text,
      replyMarkup,
    });
    if (edited?.messageId) {
      await recordMessageForDeletion(env, chatId, edited.messageId);
    }
  } else {
    const sent = await sendToTelegram({
      botToken,
      chatId,
      text,
      replyMarkup,
    });
    if (sent?.messageId) {
      await recordMessageForDeletion(env, chatId, sent.messageId);
    }
  }
}

/**
 * Handle callback queries (inline buttons clicks).
 */
async function handleCallbackQuery(cbQuery, env, botToken) {
  const cbId = cbQuery.id;
  const data = cbQuery.data || "";
  const chatId = cbQuery.message?.chat?.id;
  const messageId = cbQuery.message?.message_id;

  if (!chatId || !messageId) return;

  // Answer callback query right away to clear loading spinner on user's Telegram client
  await answerCallback(botToken, cbId);

  // No-op click (e.g. page indicator)
  if (data === "noop") return;

  // Helper to get postData from KV with multi-key and dynamic scrape fallback
  async function fetchPostFromKv(id) {
    if (!id) return null;
    if (env?.BOT_KV) {
      let p = await env.BOT_KV.get(`post:${id}`, "json");
      if (!p && id.startsWith("p_")) p = await env.BOT_KV.get(`post:${id.slice(2)}`, "json");
      if (!p && !id.startsWith("p_")) p = await env.BOT_KV.get(`post:p_${id}`, "json");
      const cleanSlug = id.replace(/^p_/, "").replace(/_[a-z0-9]{4,8}$/, "");
      if (!p && cleanSlug) {
        p = await env.BOT_KV.get(`post:${cleanSlug}`, "json");
        if (!p) p = await env.BOT_KV.get(`post:p_${cleanSlug}`, "json");
      }
      if (p) return p;
    }

    // Dynamic fallback scrape if missing from KV
    try {
      const cleanSlug = id.replace(/^p_/, "").replace(/_[a-z0-9]{4,8}$/, "");
      for (const testUrl of [
        `https://toonworld4all.me/anime/${cleanSlug}/`,
        `https://toonworld4all.me/${cleanSlug}/`,
        `https://toonworld4all.me/series/${cleanSlug}/`,
      ]) {
        const res = await fetchWithCookies(testUrl);
        if (res.ok) {
          const scraped = scrapePost(await res.text());
          if (scraped && scraped.title) {
            if (env?.BOT_KV) {
              await env.BOT_KV.put(`post:${id}`, JSON.stringify(scraped), { expirationTtl: 30 * 86400 });
            }
            return scraped;
          }
        }
      }
    } catch (e) {}
    return null;
  }

  // 1. Switch Season: sn:<postId>:<seasonIdx>
  if (data.startsWith("sn:")) {
    const [, postId, sIdxStr] = data.split(":");
    const seasonIdx = parseInt(sIdxStr, 10);
    const postData = await fetchPostFromKv(postId);
    if (postData) {
      await sendEpisodeSelectionMenu(chatId, postData, postId, seasonIdx, env, botToken, messageId);
    }
    return;
  }

  // Switch Episode Page: p_ep:<postId>:<seasonIdx>:<page>
  if (data.startsWith("p_ep:")) {
    const [, postId, sIdxStr, pStr] = data.split(":");
    const seasonIdx = parseInt(sIdxStr, 10);
    const targetPage = parseInt(pStr, 10);
    const postData = await fetchPostFromKv(postId);
    if (postData) {
      await sendEpisodeSelectionMenu(chatId, postData, postId, seasonIdx, env, botToken, messageId, targetPage);
    }
    return;
  }

  // 2. Select Episode: ep:<postId>:<seasonIdx>:<epIdx>
  if (data.startsWith("ep:")) {
    const [, postId, sIdxStr, eIdxStr] = data.split(":");
    const seasonIdx = parseInt(sIdxStr, 10);
    const epIdx = parseInt(eIdxStr, 10);

    const postData = await fetchPostFromKv(postId);
    if (!postData) {
      await editTelegramMessage({
        botToken,
        chatId,
        messageId,
        text: "⚠️ <i>Post session expired. Please re-open from the channel.</i>",
      });
      return;
    }

    const season = postData.seasons?.[seasonIdx] || postData.seasons?.[0];
    const episode = season?.episodes?.[epIdx];
    if (!episode) return;

    // Show temporary "Loading qualities..." status
    await editTelegramMessage({
      botToken,
      chatId,
      messageId,
      text: `⏳ <i>Loading available qualities for ${escapeHtml(episode.label)}...</i>`,
    });

    // Check cached qualities in BOT_KV or fetch
    const archiveUrl = episode.links?.[0]?.href || "";
    let epData = null;

    if (archiveUrl && env?.BOT_KV) {
      epData = await env.BOT_KV.get(`ep_cache:${archiveUrl}`, "json");
    }

    if (!epData && archiveUrl) {
      try {
        const customCookies = await env?.BOT_KV?.get("user_24h_cookies");
        epData = await scrapeEpisode(archiveUrl, true, customCookies);
        if (epData && env?.BOT_KV) {
          // Cache for 7 days
          await env.BOT_KV.put(`ep_cache:${archiveUrl}`, JSON.stringify(epData), { expirationTtl: 86400 * 7 });
        }
      } catch (err) {
        console.warn("Episode live scrape failed:", err.message);
      }
    }

    const qualities = epData?.qualities || [];

    let qText = `🎬 <b>${escapeHtml(postData.title)}</b>\n`;
    qText += `📺 <b>${escapeHtml(season.name)} • ${escapeHtml(episode.label)}</b>\n\n`;

    const qKeyboard = [];

    if (qualities.length > 0) {
      qText += `⚙️ <b>Select Available Quality:</b>\n\n`;

      // 1 button per quality row
      for (let q = 0; q < qualities.length; q++) {
        const qual = qualities[q];
        const res = qual.resolution || "HD";
        const size = qual.size ? ` [${qual.size}]` : "";
        const codec = qual.codec ? ` • ${qual.codec}` : "";

        qKeyboard.push([
          {
            text: `🎥 ${res}${size}${codec}`,
            callback_data: `q:${postId}:${seasonIdx}:${epIdx}:${q}`,
          },
        ]);
      }
    } else {
      // Fallback: If no encodes, use the links from accordion directly
      qText += `⚡ <b>Available Links:</b>\n\n`;
      const links = episode.links || [];
      for (let l = 0; l < links.length; l++) {
        qKeyboard.push([
          {
            text: `⬇️ ${links[l].text || "Download"}`,
            callback_data: `q:${postId}:${seasonIdx}:${epIdx}:${l}`,
          },
        ]);
      }
    }

    // Back to episode list button
    qKeyboard.push([
      {
        text: "🔙 Back to Episodes",
        callback_data: `b_ep:${postId}:${seasonIdx}`,
      },
    ]);

    await editTelegramMessage({
      botToken,
      chatId,
      messageId,
      text: qText,
      replyMarkup: { inline_keyboard: qKeyboard },
    });
    return;
  }

  // 3. Return to episodes list: b_ep:<postId>:<seasonIdx>
  if (data.startsWith("b_ep:")) {
    const [, postId, sIdxStr] = data.split(":");
    const seasonIdx = parseInt(sIdxStr, 10);
    const postData = await fetchPostFromKv(postId);
    if (postData) {
      await sendEpisodeSelectionMenu(chatId, postData, postId, seasonIdx, env, botToken, messageId);
    }
    return;
  }

  // 4. Quality Selected -> Generate GDFlix Platform Link: q:<postId>:<seasonIdx>:<epIdx>:<qIdx>
  if (data.startsWith("q:")) {
    const [, postId, sIdxStr, eIdxStr, qIdxStr] = data.split(":");
    const seasonIdx = parseInt(sIdxStr, 10);
    const epIdx = parseInt(eIdxStr, 10);
    const qIdx = parseInt(qIdxStr, 10);

    const postData = await fetchPostFromKv(postId);
    if (!postData) return;

    const season = postData.seasons?.[seasonIdx] || postData.seasons?.[0];
    const episode = season?.episodes?.[epIdx];
    if (!episode) return;

    const archiveUrl = episode.links?.[0]?.href || "";
    let epData = null;
    if (archiveUrl && env?.BOT_KV) {
      epData = await env.BOT_KV.get(`ep_cache:${archiveUrl}`, "json");
    }
    if (!epData && archiveUrl) {
      try {
        const customCookies = await env?.BOT_KV?.get("user_24h_cookies");
        epData = await scrapeEpisode(archiveUrl, true, customCookies);
        if (epData && env?.BOT_KV) {
          await env.BOT_KV.put(`ep_cache:${archiveUrl}`, JSON.stringify(epData), { expirationTtl: 86400 * 7 });
        }
      } catch (e) {}
    }

    let quality = epData?.qualities?.[qIdx];
    let baseGdflixUrl = "";
    let res = "HD";
    let size = "";

    if (quality) {
      res = quality.resolution || "HD";
      size = quality.size ? ` [${quality.size}]` : "";
      const files = quality.files || [];
      let gdflixFile = files.find(f => /gdflix/i.test(f.host) || /gdflix/i.test(f.finalUrl) || /gdflix/i.test(f.destinationUrl));
      if (!gdflixFile) {
        for (const f of files) {
          const raw = f.finalUrl || f.destinationUrl || f.redirectUrl;
          if (raw && (raw.includes("/redirect/") || /^[a-f0-9]{32,}$/i.test(raw))) {
            const dec = await decryptRedirectUrl(raw);
            if (dec && /gdflix/i.test(dec)) {
              gdflixFile = { ...f, finalUrl: dec, destinationUrl: dec };
              break;
            }
          }
        }
      }
      baseGdflixUrl = gdflixFile ? (gdflixFile.finalUrl || gdflixFile.destinationUrl || gdflixFile.redirectUrl || "") : "";

      let hubcloudFile = files.find(f => /hubcloud/i.test(f.host) || /hubcloud/i.test(f.finalUrl) || /hubcloud/i.test(f.destinationUrl));
      if (!hubcloudFile) {
        for (const f of files) {
          const raw = f.finalUrl || f.destinationUrl || f.redirectUrl;
          if (raw && (raw.includes("/redirect/") || /^[a-f0-9]{32,}$/i.test(raw))) {
            const dec = await decryptRedirectUrl(raw);
            if (dec && /hubcloud/i.test(dec)) {
              hubcloudFile = { ...f, finalUrl: dec, destinationUrl: dec };
              break;
            }
          }
        }
      }
      let baseHubcloudUrl = hubcloudFile ? (hubcloudFile.finalUrl || hubcloudFile.destinationUrl || hubcloudFile.redirectUrl || "") : "";
    } else if (episode.links?.[qIdx]) {
      const linkItem = episode.links[qIdx];
      baseGdflixUrl = linkItem.href || "";
      res = linkItem.text || "Direct";
    }

    // Decrypt AES redirect link if baseGdflixUrl is still encrypted
    if (baseGdflixUrl && (baseGdflixUrl.includes("/redirect/") || /^[a-f0-9]{32,}$/i.test(baseGdflixUrl))) {
      try {
        const dec = await decryptRedirectUrl(baseGdflixUrl);
        if (dec) baseGdflixUrl = dec;
      } catch (e) {}
    }
    if (baseHubcloudUrl && (baseHubcloudUrl.includes("/redirect/") || /^[a-f0-9]{32,}$/i.test(baseHubcloudUrl))) {
      try {
        const dec = await decryptRedirectUrl(baseHubcloudUrl);
        if (dec) baseHubcloudUrl = dec;
      } catch (e) {}
    }

    // Build a worker download page (details + Download button). The final link is generated
    // fresh when the user presses Download on that page.
    if (!baseGdflixUrl && !baseHubcloudUrl) {
      await editTelegramMessage({
        botToken,
        chatId,
        messageId,
        text: "⚠️ <b>No GDFlix or HubCloud link is available for this quality.</b>",
        replyMarkup: { inline_keyboard: [[{ text: "🔙 Back", callback_data: "ep:" + postId + ":" + seasonIdx + ":" + epIdx }]] },
      });
      return;
    }

    // Prepare compact payload containing only the necessary data
    const compactPayload = {
      t: postData.title || "",
      s: season?.name || "",
      e: episode.label || "",
      q: res,
      sz: String(size || "").replace(/^\s*\[|\]\s*$/g, "").trim(),
      th: postData.thumbnail || "",
      u: baseGdflixUrl,
      hub: baseHubcloudUrl || "",
    };
    const b64Payload = btoa(unescape(encodeURIComponent(JSON.stringify(compactPayload))))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");

    // Also store in KV for fallback / caching
    const token = crypto.randomUUID().replace(/-/g, "").slice(0, 20);
    if (env?.BOT_KV) {
      await env.BOT_KV.put("dl:" + token, JSON.stringify(compactPayload), { expirationTtl: 86400 }).catch(() => {});
    }

    // Resolve dedicated download worker origin
    let dlWorkerOrigin = "";
    if (env?.BOT_KV) {
      try { dlWorkerOrigin = await env.BOT_KV.get("download_worker_url"); } catch (e) {}
    }
    if (!dlWorkerOrigin && env?.DOWNLOAD_WORKER_URL) {
      dlWorkerOrigin = env.DOWNLOAD_WORKER_URL;
    }
    if (!dlWorkerOrigin) {
      dlWorkerOrigin = "https://downloads.otakudrivehq.workers.dev";
    }

    const pageUrl = dlWorkerOrigin.replace(/\/$/, "") + "/d?p=" + encodeURIComponent(b64Payload);

    let resText = "🎬 <b>" + escapeHtml(postData.title) + "</b>\n";
    resText += "📺 <b>" + escapeHtml(season.name) + " • " + escapeHtml(episode.label) + "</b>\n";
    resText += "🔹 <b>Quality:</b> " + escapeHtml(res) + escapeHtml(size) + "\n\n";

    const dlKeyboard = [
      [{ text: "⚡ Open Download Page (" + res + ")", url: pageUrl }],
      [
        { text: "🔄 Change Quality", callback_data: "ep:" + postId + ":" + seasonIdx + ":" + epIdx },
        { text: "📁 Episode List", callback_data: "b_ep:" + postId + ":" + seasonIdx },
      ],
    ];

    await editTelegramMessage({
      botToken,
      chatId,
      messageId,
      text: resText,
      replyMarkup: { inline_keyboard: dlKeyboard },
    });
    return;
  }
}

// ─── Low-level Telegram API Wrappers ────────────────────────────────────────

/**
 * Edit an existing Telegram message text & inline keyboard.
 */
export async function editTelegramMessage({ botToken, chatId, messageId, text, replyMarkup = null }) {
  if (!botToken || !chatId || !messageId) return null;
  const cleanToken = String(botToken || "").trim();
  const cleanChatId = String(chatId || "").trim();

  const body = {
    chat_id: cleanChatId,
    message_id: messageId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
  };
  if (replyMarkup) body.reply_markup = replyMarkup;

  try {
    const res = await fetch(`https://api.telegram.org/bot${cleanToken}/editMessageText`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const d = await res.json();
    if (d.ok) {
      return { ok: true, messageId };
    }

    // Check if failure is because message has no text (e.g. photo message with caption)
    const desc = d.description || "";
    if (/no text in the message/i.test(desc) || /message to edit/i.test(desc)) {
      const capBody = {
        chat_id: cleanChatId,
        message_id: messageId,
        caption: text.slice(0, 1024),
        parse_mode: "HTML",
      };
      if (replyMarkup) capBody.reply_markup = replyMarkup;

      const resCap = await fetch(`https://api.telegram.org/bot${cleanToken}/editMessageCaption`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(capBody),
      });
      const dCap = await resCap.json();
      if (dCap.ok) {
        return { ok: true, messageId };
      }
      console.warn("editMessageCaption failed:", dCap.description);
    }

    // If editing failed (message not found or cannot be modified), send a new message
    console.warn("Falling back to sendToTelegram after edit failure:", desc);
    const sent = await sendToTelegram({
      botToken: cleanToken,
      chatId: cleanChatId,
      text,
      replyMarkup,
    });
    return sent;
  } catch (err) {
    console.error("editTelegramMessage error:", err.message);
    return null;
  }
}

/**
 * Answer a callback query.
 */
export async function answerCallback(botToken, callbackQueryId, text = "") {
  if (!botToken || !callbackQueryId) return;
  try {
    await fetch(`https://api.telegram.org/bot${botToken}/answerCallbackQuery`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ callback_query_id: callbackQueryId, text }),
    });
  } catch (e) {}
}

/**
 * Sends a message or photo with caption to Telegram.
 */
export async function sendToTelegram({ botToken, chatId, text, photoUrl = null, replyMarkup = null }) {
  if (!botToken || !chatId) {
    throw new Error("Missing botToken or chatId");
  }

  const cleanToken = String(botToken || "").trim();
  const cleanChatId = String(chatId || "").trim();

  // If photo is available and caption fits Telegram 1024 char limit:
  if (photoUrl && text.length <= 1024) {
    try {
      const body = {
        chat_id: cleanChatId,
        photo: photoUrl,
        caption: text,
        parse_mode: "HTML",
      };
      if (replyMarkup) body.reply_markup = replyMarkup;

      const res = await fetch(`https://api.telegram.org/bot${cleanToken}/sendPhoto`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      const data = await res.json();
      if (data.ok) return { ok: true, messageId: data.result?.message_id };
    } catch (photoErr) {
      console.warn("sendPhoto failed, falling back to sendMessage:", photoErr.message);
    }
  }

  // Fallback to sendMessage (supports up to 4096 chars)
  const body = {
    chat_id: cleanChatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: !photoUrl,
  };
  if (replyMarkup) body.reply_markup = replyMarkup;

  const res = await fetch(`https://api.telegram.org/bot${cleanToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const data = await res.json();
  if (!data.ok) {
    throw new Error(data.description || `Telegram API error (${res.status})`);
  }

  return { ok: true, messageId: data.result?.message_id };
}

/**
 * Set the Telegram Webhook to point to this Cloudflare Worker.
 */
export async function setTelegramWebhook(botToken, webhookUrl) {
  if (!botToken || !webhookUrl) throw new Error("Missing botToken or webhookUrl");
  const res = await fetch(`https://api.telegram.org/bot${botToken.trim()}/setWebhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      url: webhookUrl.trim(),
      allowed_updates: ["message", "callback_query"],
      drop_pending_updates: false,
    }),
  });
  return await res.json();
}

/**
 * Get current webhook status from Telegram API.
 */
export async function getTelegramWebhookInfo(botToken) {
  if (!botToken) throw new Error("Missing botToken");
  const res = await fetch(`https://api.telegram.org/bot${botToken.trim()}/getWebhookInfo`);
  return await res.json();
}

// ─── Legacy / Batch Support ──────────────────────────────────────────────────

export function formatEpisodePost(postData = {}, episodeData = {}) {
  const title = postData.title || episodeData.title || "Episode Download";
  const season = episodeData.season || 1;
  const episode = episodeData.episode || 1;
  const photoUrl = postData.thumbnail || null;

  let text = `🎬 <b>${escapeHtml(title)}</b>\n`;
  text += `📺 <b>Season ${season} • Episode ${episode}</b>\n\n`;

  if (postData.meta) {
    const metaEntries = Object.entries(postData.meta)
      .filter(([k]) => !/synopsis|download/i.test(k))
      .slice(0, 3);
    for (const [k, v] of metaEntries) {
      text += `▫️ <b>${escapeHtml(k)}:</b> ${escapeHtml(v)}\n`;
    }
    if (metaEntries.length) text += "\n";
  }

  text += `⚡ <b>Direct Download Links:</b>\n`;
  const inlineKeyboard = [];
  const qualities = episodeData.qualities || [];

  for (const q of qualities) {
    const res = q.resolution || "HD";
    const size = q.size ? ` (${q.size})` : "";
    text += `\n🔹 <b>${escapeHtml(res)}${escapeHtml(size)}</b>\n`;

    const linksText = [];
    const rowButtons = [];

    for (const f of q.files || []) {
      const host = f.host || "Download";
      const finalUrl = f.finalUrl || f.destinationUrl || f.redirectUrl;

      if (finalUrl && !finalUrl.includes("/redirect/")) {
        linksText.push(`<a href="${finalUrl}">${escapeHtml(host)}</a>`);
        if (rowButtons.length < 2 && /gdflix|mega|hubcloud|filepress/i.test(host)) {
          rowButtons.push({
            text: `⬇️ ${host} (${res})`,
            url: finalUrl,
          });
        }
      }
    }

    if (linksText.length) {
      text += `👉 ${linksText.join(" | ")}\n`;
    }
    if (rowButtons.length) {
      inlineKeyboard.push(rowButtons);
    }
  }

  text += `\n🤖 <i>Shared via ToonWorld4All Scraper</i>`;
  return {
    text,
    photoUrl,
    replyMarkup: inlineKeyboard.length ? { inline_keyboard: inlineKeyboard } : null,
  };
}

export function formatBatchPost(postData = {}, episodesList = []) {
  const title = postData.title || "Series Download";
  const photoUrl = postData.thumbnail || null;

  let text = `🎬 <b>${escapeHtml(title)}</b>\n`;
  text += `📦 <b>Total Episodes: ${episodesList.length}</b>\n\n`;

  if (postData.meta?.Audio) {
    text += `🔊 <b>Audio:</b> ${escapeHtml(postData.meta.Audio)}\n\n`;
  }

  const chunks = [];
  let currentChunk = text;

  for (let i = 0; i < episodesList.length; i++) {
    const ep = episodesList[i];
    const s = ep.season || 1;
    const e = ep.episode || (i + 1);
    let epBlock = `━━━━━━━━━━━━━━━━━━━━\n`;
    epBlock += `📺 <b>S${String(s).padStart(2, "0")}E${String(e).padStart(2, "0")}</b>`;
    if (ep.title && ep.title !== title) {
      epBlock += ` - <i>${escapeHtml(ep.title)}</i>`;
    }
    epBlock += `\n`;

    for (const q of ep.qualities || []) {
      const res = q.resolution || "HD";
      const size = q.size ? ` [${q.size}]` : "";
      const links = (q.files || [])
        .map((f) => {
          const u = f.finalUrl || f.destinationUrl || f.redirectUrl;
          return u && !u.includes("/redirect/") ? `<a href="${u}">${escapeHtml(f.host)}</a>` : null;
        })
        .filter(Boolean);

      if (links.length) {
        epBlock += `▫️ <b>${escapeHtml(res)}${escapeHtml(size)}:</b> ${links.join(" • ")}\n`;
      }
    }
    epBlock += `\n`;

    if ((currentChunk + epBlock).length > 3900) {
      chunks.push({ text: currentChunk, photoUrl: chunks.length === 0 ? photoUrl : null });
      currentChunk = `🎬 <b>${escapeHtml(title)} (Part ${chunks.length + 1})</b>\n\n` + epBlock;
    } else {
      currentChunk += epBlock;
    }
  }

  if (currentChunk.trim()) {
    currentChunk += `\n🤖 <i>Shared via ToonWorld4All Scraper</i>`;
    chunks.push({ text: currentChunk, photoUrl: chunks.length === 0 ? photoUrl : null });
  }

  return chunks;
}
