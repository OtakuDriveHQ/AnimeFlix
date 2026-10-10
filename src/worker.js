/**
 * worker.js  –  Cloudflare Workers entry point
 */

import { fetchWithCookies, COOKIES } from "./fetcher.js";
import { parsePostSitemapIndex, parsePostSitemap, sortNewestFirst, slugToTitle } from "./parser.js";
import { scrapePost } from "./postScraper.js";
import { scrapeEpisode, resolvePlatformLink } from "./episodeScraper.js";
import {
  formatEpisodePost,
  formatBatchPost,
  sendToTelegram,
  formatChannelPost,
  handleTelegramWebhook,
  processPendingDeletions,
  getBotToken,
  getChatId,
  getBotUsername,
  saveTelegramConfig,
  setTelegramWebhook,
  getTelegramWebhookInfo,
  extractInstantDownloadLink,
  extractHubcloudDownloadLink,
  escapeHtml,
} from "./telegram.js";
import { isAuthenticated, handleLogin, handleLogout } from "./auth.js";
import { handleDownloadPage } from "./downloadPage.js";

const SITEMAP_INDEX = "https://toonworld4all.me/sitemap_index.xml";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Public health check, webhook, and login/logout endpoints
    if (url.pathname === "/health") return jsonResponse({ status: "ok" });
    if (url.pathname === "/telegram/webhook") return handleTelegramWebhook(request, env);
    if (url.pathname === "/login")  return handleLogin(request, env);
    if (url.pathname === "/logout") return handleLogout(request);

    // Public download pages opened from the Telegram bot (no login required)
    if (url.pathname.startsWith("/d/")) return handleDownloadPage(request, env, url);

    // Check authentication for all other endpoints
    if (!isAuthenticated(request, env)) {
      const accept = request.headers.get("Accept") || "";
      if (accept.includes("text/html") || url.searchParams.get("format") === "html" || url.pathname === "/") {
        return new Response(null, {
          status: 302,
          headers: { Location: "/login" },
        });
      }
      return new Response(JSON.stringify({ error: "Unauthorized. Please authenticate with your username and password." }), {
        status: 401,
        headers: {
          "Content-Type": "application/json",
          "WWW-Authenticate": 'Basic realm="GDFlix Scraper Access"',
        },
      });
    }

    // Default redirect to web UI
    if (url.pathname === "/") {
      return new Response(null, {
        status: 302,
        headers: { Location: "/posts?format=html" },
      });
    }

    if (url.pathname === "/posts")   return handlePosts(url);
    if (url.pathname === "/post")    return handlePost(url, request);
    if (url.pathname === "/episode") return handleEpisode(url, request);
    if (url.pathname === "/resolve") return handleResolve(url, request);
    if (url.pathname === "/scrape")  return handleScrape(url);
    if (url.pathname === "/telegram/send") return handleTelegramSend(request, env);
    if (url.pathname === "/telegram/post-channel") return handleTelegramPostChannel(request, env, url);
    if (url.pathname === "/telegram/setup-webhook") return handleTelegramSetupWebhook(request, env, url);
    if (url.pathname === "/telegram/webhook-info") return handleTelegramWebhookInfo(request, env);
    if (url.pathname === "/telegram/config") return handleTelegramConfig(request, env);
    if (url.pathname === "/extract-direct" || url.pathname === "/generate-link") return handleExtractDirect(url, request);
    return errorResponse(404, "Routes: /health | /posts | /post | /episode | /resolve | /scrape | /extract-direct | /telegram/send | /telegram/post-channel | /telegram/setup-webhook | /telegram/webhook-info | /telegram/config | /login | /logout");
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(processPendingDeletions(env));
  },
};

// ─── /posts ───────────────────────────────────────────────────────────────────
async function handlePosts(url) {
  const page   = Math.max(1, parseInt(url.searchParams.get("page")  ?? "1",  10));
  const limit  = Math.min(500, Math.max(1, parseInt(url.searchParams.get("limit") ?? "50", 10)));
  const format = url.searchParams.get("format") ?? "json";
  const search = (url.searchParams.get("q") || url.searchParams.get("search") || "").trim();

  try {
    const indexRes = await fetchWithCookies(SITEMAP_INDEX);
    if (!indexRes.ok) return errorResponse(indexRes.status, `Sitemap fetch failed: ${indexRes.statusText}`);

    const postSitemaps = parsePostSitemapIndex(await indexRes.text());
    if (!postSitemaps.length) return errorResponse(404, "No post-sitemaps found.");

    const results = await Promise.allSettled(
      postSitemaps.map(async ({ loc }) => {
        const res = await fetchWithCookies(loc);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return parsePostSitemap(await res.text(), loc.split("/").pop());
      })
    );

    let allPosts = [], errors = [];
    results.forEach((r, i) => {
      if (r.status === "fulfilled") allPosts = allPosts.concat(r.value);
      else errors.push({ sitemap: postSitemaps[i].loc, error: r.reason?.message });
    });

    const sorted = sortNewestFirst(allPosts);
    let filteredPosts = sorted;

    if (search) {
      const qLower = search.toLowerCase();
      const keywords = qLower.split(/\s+/).filter(Boolean);
      filteredPosts = sorted.filter(p => {
        const slug = p.url.replace(/\/$/, "").split("/").pop() || "";
        const title = slugToTitle(slug);
        const text = (title + " " + slug).toLowerCase();
        return keywords.every(kw => text.includes(kw));
      });
    }

    const total      = filteredPosts.length;
    const totalPages = Math.ceil(total / limit) || 1;
    const paginated  = filteredPosts.slice((page - 1) * limit, page * limit);
    const meta = {
      total,
      page,
      limit,
      totalPages,
      sitemapsFetched: postSitemaps.length - errors.length,
      search,
      totalUnfiltered: sorted.length,
    };

    if (format === "html") {
      return new Response(buildHtmlPage(paginated, meta, COOKIES),
        { headers: { "Content-Type": "text/html;charset=UTF-8" } });
    }
    return jsonResponse({ meta, posts: paginated });
  } catch (err) {
    return errorResponse(500, err.message);
  }
}

// ─── /post ────────────────────────────────────────────────────────────────────
async function handlePost(url, request) {
  const raw = url.searchParams.get("url");
  if (!raw) return errorResponse(400, "Missing ?url=");
  let target;
  try { target = decodeURIComponent(raw); new URL(target); }
  catch { return errorResponse(400, "Invalid url"); }
  const customCookies = request ? (request.headers.get("x-cookies") || url.searchParams.get("cookies")) : null;
  try {
    const res = await fetchWithCookies(target, { customCookies });
    if (!res.ok) return errorResponse(res.status, `Upstream ${res.status}`);
    return jsonResponse(scrapePost(await res.text()));
  } catch (err) {
    return errorResponse(500, err.message);
  }
}

// ─── /episode ─────────────────────────────────────────────────────────────────
async function handleEpisode(url, request) {
  const raw = url.searchParams.get("url");
  if (!raw) return errorResponse(400, "Missing ?url=");
  const resolve = url.searchParams.get("resolve") !== "false";
  const customCookies = request ? (request.headers.get("x-cookies") || url.searchParams.get("cookies")) : null;
  let target;
  try { target = decodeURIComponent(raw); new URL(target); }
  catch { return errorResponse(400, "Invalid url"); }
  try {
    const data = await scrapeEpisode(target, resolve, customCookies);
    return jsonResponse(data);
  } catch (err) {
    return errorResponse(500, err.message);
  }
}

// ─── /resolve ─────────────────────────────────────────────────────────────────
async function handleResolve(url, request) {
  const raw = url.searchParams.get("url");
  if (!raw) return errorResponse(400, "Missing ?url=");
  const customCookies = request ? (request.headers.get("x-cookies") || url.searchParams.get("cookies")) : null;
  let target;
  try { target = decodeURIComponent(raw); new URL(target); }
  catch { return errorResponse(400, "Invalid url"); }
  try {
    const result = await resolvePlatformLink(target, customCookies);
    return jsonResponse(result);
  } catch (err) {
    return errorResponse(500, err.message);
  }
}

// ─── /scrape ──────────────────────────────────────────────────────────────────
async function handleScrape(url) {
  const raw = url.searchParams.get("url");
  if (!raw) return errorResponse(400, "Missing ?url=");
  let target;
  try { target = decodeURIComponent(raw); new URL(target); }
  catch { return errorResponse(400, "Invalid url"); }
  try {
    const res = await fetchWithCookies(target);
    return new Response(await res.text(), {
      status: res.status,
      headers: { "Content-Type": res.headers.get("content-type") ?? "text/html", "Cache-Control": "no-store" },
    });
  } catch (err) {
    return errorResponse(500, err.message);
  }
}

// ─── /extract-direct ──────────────────────────────────────────────────────────
async function handleExtractDirect(url, request) {
  const raw = url.searchParams.get("url");
  if (!raw) return errorResponse(400, "Missing ?url=");
  const type = (url.searchParams.get("type") || "").toLowerCase();
  const isDebug = url.searchParams.get("debug") === "1";
  const debugLogs = [];
  let target;
  try { target = decodeURIComponent(raw); new URL(target); }
  catch { return errorResponse(400, "Invalid url"); }

  try {
    let directUrl = null;
    let usedPlatform = "gdflix";

    if (type === "hubcloud" || /hubcloud|gamerxyt|sportverse/i.test(target)) {
      directUrl = await extractHubcloudDownloadLink(target, 1, debugLogs);
      usedPlatform = "hubcloud";
    } else {
      directUrl = await extractInstantDownloadLink(target);
      usedPlatform = "gdflix";
      // Fallback: if gdflix failed and hubcloud was provided
      if (!directUrl && url.searchParams.get("hubcloudUrl")) {
        const hubUrl = decodeURIComponent(url.searchParams.get("hubcloudUrl"));
        directUrl = await extractHubcloudDownloadLink(hubUrl, 1, debugLogs);
        if (directUrl) usedPlatform = "hubcloud";
      }
    }

    if (directUrl && /^https?:\/\//i.test(directUrl)) {
      const res = { ok: true, directUrl, target, platform: usedPlatform, debug: debugLogs };
      return jsonResponse(res);
    }
    const errText = "Could not generate direct CDN link for this platform.\\nDebug: " + debugLogs.join(" | ");
    const res = { ok: false, error: errText, debug: debugLogs };
    return jsonResponse(res, 200);
  } catch (err) {
    return errorResponse(500, err.message || "Extraction error");
  }
}

// ─── /telegram/send ───────────────────────────────────────────────────────────
async function handleTelegramSend(request, env) {
  if (request.method !== "POST") return errorResponse(405, "Method not allowed. Use POST.");
  try {
    const body = await request.json();
    const botToken = body.botToken || await getBotToken(env);
    const chatId = body.chatId || await getChatId(env);
    if (!botToken || !chatId) {
      return errorResponse(400, "Missing Telegram Bot Token or Chat ID. Please configure it in Telegram Bot Setup.");
    }

    const { type, postData, episodeData, episodesList, text } = body;

    if (type === "episode") {
      const formatted = formatEpisodePost(postData, episodeData);
      const res = await sendToTelegram({
        botToken,
        chatId,
        text: formatted.text,
        photoUrl: formatted.photoUrl,
        replyMarkup: formatted.replyMarkup,
      });
      return jsonResponse({ ok: true, messageId: res.messageId });
    } else if (type === "batch") {
      const chunks = formatBatchPost(postData, episodesList || []);
      const results = [];
      for (const chunk of chunks) {
        const res = await sendToTelegram({
          botToken,
          chatId,
          text: chunk.text,
          photoUrl: chunk.photoUrl,
        });
        results.push(res.messageId);
      }
      return jsonResponse({ ok: true, messageIds: results });
    } else {
      const res = await sendToTelegram({
        botToken,
        chatId,
        text: text || "🔔 Test notification from ToonWorld4All Scraper bot!",
      });
      return jsonResponse({ ok: true, messageId: res.messageId });
    }
  } catch (err) {
    return errorResponse(500, err.message);
}
}

// ─── /telegram/post-channel ───────────────────────────────────────────────────
async function handleTelegramPostChannel(request, env, url) {
  if (request.method !== "POST") return errorResponse(405, "Method not allowed. Use POST.");
  try {
    const body = await request.json();
    let postData = body.postData;
    const postUrl = body.postUrl;

    if (!postData && postUrl) {
      const res = await fetchWithCookies(postUrl);
      if (res.ok) {
        postData = scrapePost(await res.text());
      }
    }

    if (!postData) {
      return errorResponse(400, "Missing postData or postUrl");
    }

    const botToken = body.botToken || await getBotToken(env);
    const chatId = body.chatId || await getChatId(env);

    if (!botToken || !chatId) {
      return errorResponse(400, "Missing Telegram Bot Token or Chat ID. Please configure it in Telegram Bot Setup.");
    }

    let botUsername = body.botUsername || await getBotUsername(env, botToken);
    if (botUsername) botUsername = botUsername.replace(/^@+/, "");

    // Create a safe short postId
    let slug = "";
    if (postUrl) {
      slug = postUrl.replace(/\/$/, "").split("/").pop();
    } else if (postData.title) {
      slug = postData.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 30);
    }
    const shortHash = Math.random().toString(36).slice(2, 7);
    const postId = `p_${(slug ? slug.slice(0, 24) : "post")}_${shortHash}`;

    // Store full post data into BOT_KV so bot can interact with seasons and episodes
    if (env?.BOT_KV) {
      await env.BOT_KV.put(`post:${postId}`, JSON.stringify(postData), { expirationTtl: 30 * 86400 });
      if (slug) {
        await env.BOT_KV.put(`post:${slug}`, JSON.stringify(postData), { expirationTtl: 30 * 86400 });
        await env.BOT_KV.put(`post:p_${slug}`, JSON.stringify(postData), { expirationTtl: 30 * 86400 });
      }
      // Also cache token & chat id if provided
      if (body.botToken || body.chatId || body.botUsername) {
        await saveTelegramConfig(env, { botToken, chatId, botUsername });
      }
      // Automatically register the webhook with Cloudflare Worker so Telegram routes /start and callbacks here
      const webhookUrl = `${url.protocol}//${url.host}/telegram/webhook`;
      await setTelegramWebhook(botToken, webhookUrl).catch(e => console.warn("Auto-set webhook failed:", e.message));
    }

    const formatted = formatChannelPost(postData, postId, botUsername);
    const sendRes = await sendToTelegram({
      botToken,
      chatId,
      text: formatted.text,
      photoUrl: formatted.photoUrl,
      replyMarkup: formatted.replyMarkup,
    });

    return jsonResponse({
      ok: true,
      messageId: sendRes.messageId,
      postId,
      botUsername,
    });
  } catch (err) {
    return errorResponse(500, err.message);
  }
}

// ─── /telegram/setup-webhook ──────────────────────────────────────────────────
async function handleTelegramSetupWebhook(request, env, url) {
  try {
    let botToken = await getBotToken(env);
    if (!botToken && request.method === "POST") {
      const b = await request.json().catch(() => ({}));
      botToken = b.botToken;
    }
    if (!botToken) return errorResponse(400, "Missing Bot Token.");

    const webhookUrl = `${url.protocol}//${url.host}/telegram/webhook`;
    const res = await setTelegramWebhook(botToken, webhookUrl);
    return jsonResponse({ ok: res.ok, result: res, webhookUrl });
  } catch (err) {
    return errorResponse(500, err.message);
  }
}

// ─── /telegram/webhook-info ───────────────────────────────────────────────────
async function handleTelegramWebhookInfo(request, env) {
  try {
    const botToken = await getBotToken(env);
    if (!botToken) return errorResponse(400, "Missing Bot Token.");
    const info = await getTelegramWebhookInfo(botToken);
    return jsonResponse(info);
  } catch (err) {
    return errorResponse(500, err.message);
  }
}

// ─── /telegram/config ─────────────────────────────────────────────────────────
async function handleTelegramConfig(request, env) {
  if (request.method === "POST") {
    try {
      const body = await request.json();
      await saveTelegramConfig(env, body);
      return jsonResponse({ ok: true, saved: true });
    } catch (e) {
      return errorResponse(400, e.message);
    }
  }
  const botToken = await getBotToken(env);
  const chatId = await getChatId(env);
  const botUsername = await getBotUsername(env, botToken);
  return jsonResponse({
    botToken: botToken ? `${botToken.slice(0, 6)}...${botToken.slice(-4)}` : "",
    hasBotToken: !!botToken,
    chatId,
    botUsername,
  });
}

// ─── HTML page ────────────────────────────────────────────────────────────────
function buildHtmlPage(posts, meta, cookies) {
  const { page, limit, totalPages, total, sitemapsFetched, search } = meta;
  cookies = cookies || [];

  const qParam   = search ? `&q=${encodeURIComponent(search)}` : "";
  const prevHref = page > 1 ? `?page=${page-1}&limit=${limit}&format=html${qParam}` : "";
  const nextHref = page < totalPages ? `?page=${page+1}&limit=${limit}&format=html${qParam}` : "";

  // ── Cookie status rows ───────────────────────────────────────────────────────
  const now = Date.now();
  const cookieRows = cookies.map(c => {
    const exp     = c.expires ? new Date(c.expires) : null;
    const expired = exp && exp.getTime() < now;
    const daysLeft = exp ? Math.ceil((exp.getTime() - now) / 86400000) : null;
    const statusClass = expired ? "ck-expired" : "ck-ok";
    const statusText  = expired
      ? "Expired"
      : daysLeft !== null
        ? `${daysLeft}d left`
        : "Session";
    const valDisplay = c.value.length > 40 ? c.value.slice(0, 40) + "…" : c.value;
    return [
      `<tr class="${statusClass}">`,
        `<td class="ck-name">${c.name}</td>`,
        `<td class="ck-domain">${c.domain}</td>`,
        `<td class="ck-val" title="${c.value}">${valDisplay}</td>`,
        `<td class="ck-exp">${exp ? exp.toISOString().slice(0, 10) : "—"}</td>`,
        `<td class="ck-status">${statusText}</td>`,
      `</tr>`,
    ].join("");
  }).join("");

  const expiredCount = cookies.filter(c => c.expires && new Date(c.expires).getTime() < now).length;
  const activeCount  = cookies.length - expiredCount;

  // Build card HTML
  const cards = posts.map((p, i) => {
    const n     = (page - 1) * limit + i + 1;
    const enc   = encodeURIComponent(p.url);
    const slug  = p.url.replace(/\/$/, "").split("/").pop() || "";
    const title = slugToTitle(slug);
    const date  = p.lastmod ? p.lastmod.slice(0, 10) : "";
    return [
      `<div class="card" id="card-${i}" data-title="${escapeHtml(title.toLowerCase())}" data-slug="${escapeHtml(slug.toLowerCase())}">`,
        `<div class="card-top">`,
          `<div class="card-meta">`,
            `<div class="card-title-row">`,
              `<span class="card-num">#${n}</span>`,
              `<h3 class="card-title" title="${escapeHtml(title)}">${escapeHtml(title)}</h3>`,
            `</div>`,
            `<div class="card-sub-meta">`,
              `<span class="card-date">📅 ${date}</span>`,
              `<span class="card-src">${escapeHtml(p.source)}</span>`,
            `</div>`,
          `</div>`,
          `<div class="card-btns">`,
            `<button class="btn-scrape" id="btn-${i}" data-enc="${enc}" data-i="${i}">Scrape</button>`,
            `<button class="btn-tg-post-card" onclick="onQuickPostToTelegram(event, this, '${enc}', ${i})" title="Post this anime/series directly to Telegram Channel with poster, synopsis & season buttons">✈️ Post on Telegram</button>`,
          `</div>`,
        `</div>`,
        `<div class="card-detail hidden" id="det-${i}"></div>`,
      `</div>`,
    ].join("");
  }).join("");

  const scriptBody = `
var BASE = location.protocol + "//" + location.host;

function getSavedCacheKey(url) {
  return "tw4_cache_" + url;
}

function getSavedEpisode(url) {
  try {
    var raw = localStorage.getItem(getSavedCacheKey(url));
    if (raw) return JSON.parse(raw);
  } catch (e) {}
  return null;
}

function saveEpisodeData(url, data) {
  try {
    localStorage.setItem(getSavedCacheKey(url), JSON.stringify({
      data: data,
      savedAt: new Date().toISOString()
    }));
    updateSavedCounter();
  } catch (e) {}
}

function clearAllSavedData() {
  if (!confirm("Are you sure you want to clear all locally saved/cached episodes?")) return;
  var keys = [];
  for (var i = 0; i < localStorage.length; i++) {
    var k = localStorage.key(i);
    if (k && k.indexOf("tw4_cache_") === 0) {
      keys.push(k);
    }
  }
  for (var j = 0; j < keys.length; j++) {
    localStorage.removeItem(keys[j]);
  }
  updateSavedCounter();
  alert("Cleared " + keys.length + " saved episode caches.");
}

function updateSavedCounter() {
  var count = 0;
  for (var i = 0; i < localStorage.length; i++) {
    var k = localStorage.key(i);
    if (k && k.indexOf("tw4_cache_") === 0) count++;
  }
  var el = document.getElementById("saved-count-num");
  if (el) el.textContent = count;
  var btnClr = document.getElementById("btn-clear-cache");
  if (btnClr) {
    btnClr.textContent = "🗑️ Clear Saved Data (" + count + ")";
    btnClr.style.display = count > 0 ? "inline-block" : "none";
  }
}

function setOldCookiesOnOpen() {
  var sCf = "${cookies.find(c => c.name === 'cf_clearance')?.value || ''}";
  var sUser = "${cookies.find(c => c.name === 'user')?.value || ''}";
  if (sCf || sUser) {
    localStorage.setItem("user_cf_clearance", sCf);
    localStorage.setItem("user_session_token", sUser);
    var combined = "";
    if (sCf) combined += "cf_clearance=" + sCf + "; ";
    if (sUser) combined += "user=" + sUser;
    localStorage.setItem("user_24h_cookies", combined.trim());
  }
}

function attachButtons() {
  setOldCookiesOnOpen();
  var btns = document.querySelectorAll(".btn-scrape");
  for (var b = 0; b < btns.length; b++) {
    btns[b].addEventListener("click", onScrapeClick);
  }
  setupSearchFilter();
  updateCustomCookieStatus();
  updateSavedCounter();
  updateTelegramStatus();
  updateTitlesFromSavedCache();
}

function setupSearchFilter() {
  var searchInput = document.getElementById("post-search-input");
  var clearBtn = document.getElementById("clear-search-btn");
  if (!searchInput) return;

  searchInput.addEventListener("input", function(e) {
    var query = e.target.value.trim().toLowerCase();
    if (clearBtn) {
      clearBtn.style.display = query ? "inline-flex" : "none";
    }
    var cards = document.querySelectorAll(".card");
    var keywords = query.split(/\s+/).filter(Boolean);
    cards.forEach(function(card) {
      var t = card.getAttribute("data-title") || "";
      var s = card.getAttribute("data-slug") || "";
      var combined = t + " " + s;
      var match = keywords.length === 0 || keywords.every(function(kw) {
        return combined.indexOf(kw) !== -1;
      });
      card.style.display = match ? "" : "none";
    });
  });

  if (clearBtn) {
    clearBtn.addEventListener("click", function() {
      searchInput.value = "";
      clearBtn.style.display = "none";
      document.querySelectorAll(".card").forEach(function(card) {
        card.style.display = "";
      });
      searchInput.focus();
    });
  }
}

function updateTitlesFromSavedCache() {
  var cards = document.querySelectorAll(".card");
  for (var c = 0; c < cards.length; c++) {
    var card = cards[c];
    var scrapeBtn = card.querySelector(".btn-scrape");
    if (!scrapeBtn) continue;
    var rawUrl = decodeURIComponent(scrapeBtn.getAttribute("data-enc") || "");
    var cached = getSavedEpisode(rawUrl);
    if (cached && cached.data && cached.data.title) {
      var tEl = card.querySelector(".card-title");
      if (tEl) {
        tEl.textContent = cached.data.title;
        tEl.setAttribute("title", cached.data.title);
      }
      card.setAttribute("data-title", cached.data.title.toLowerCase());
    }
  }
}

function updateCustomCookieStatus() {
  var storedCf = localStorage.getItem("user_cf_clearance");
  var storedUser = localStorage.getItem("user_session_token");
  var storedExp = localStorage.getItem("user_cookie_expiry") || "1791010525521";

  var badge = document.getElementById("custom-cookie-badge");
  if (badge) {
    if (storedUser) {
      badge.textContent = "24h Access Active ✅";
      badge.className = "badge-active";
    } else {
      badge.textContent = "Pre-loaded 24h Cookies ✅";
      badge.className = "badge-active";
    }
  }

  var cfInput = document.getElementById("input-cf-clearance");
  var userInput = document.getElementById("input-user-cookie");
  var expInput = document.getElementById("input-expiry");

  if (cfInput) {
    cfInput.value = storedCf || "${cookies.find(c => c.name === 'cf_clearance')?.value || ''}";
  }
  if (userInput) {
    userInput.value = storedUser || "${cookies.find(c => c.name === 'user')?.value || ''}";
  }
  if (expInput) {
    expInput.value = storedExp;
  }
}

function saveCustomCookies() {
  var cfInput = document.getElementById("input-cf-clearance");
  var userInput = document.getElementById("input-user-cookie");
  var expInput = document.getElementById("input-expiry");
  var statusMsg = document.getElementById("save-status-msg");

  var cfVal = (cfInput ? cfInput.value : "").trim();
  var userVal = (userInput ? userInput.value : "").trim();
  var expVal = (expInput ? expInput.value : "").trim();

  if (cfVal || userVal) {
    localStorage.setItem("user_cf_clearance", cfVal);
    localStorage.setItem("user_session_token", userVal);
    localStorage.setItem("user_cookie_expiry", expVal || "1791010525521");
    var combined = "cf_clearance=" + cfVal + "; user=" + userVal;
    localStorage.setItem("user_24h_cookies", combined);
    if (statusMsg) {
      statusMsg.textContent = "Cookies saved & activated! Direct platform links unlocked ✅";
      statusMsg.style.display = "block";
      statusMsg.style.color = "#22c55e";
      setTimeout(function() { statusMsg.style.display = "none"; }, 5000);
    }
  } else {
    localStorage.removeItem("user_cf_clearance");
    localStorage.removeItem("user_session_token");
    localStorage.removeItem("user_cookie_expiry");
    localStorage.removeItem("user_24h_cookies");
    if (statusMsg) {
      statusMsg.textContent = "Cookies cleared. Reverting to default values.";
      statusMsg.style.display = "block";
      statusMsg.style.color = "#94a3b8";
      setTimeout(function() { statusMsg.style.display = "none"; }, 3000);
    }
  }
  updateCustomCookieStatus();
}

function onScrapeClick(e) {
  var btn = e.currentTarget;
  var i   = btn.getAttribute("data-i");
  var enc = btn.getAttribute("data-enc");
  var det = document.getElementById("det-" + i);

  if (btn.classList.contains("done") && !det.classList.contains("hidden")) {
    det.classList.add("hidden");
    btn.textContent = "Scrape";
    btn.classList.remove("done");
    return;
  }

  det.classList.remove("hidden");
  det.innerHTML = "<div class=\\"loading\\"><div class=\\"spin\\"></div> Scraping post details...</div>";
  btn.disabled = true;
  btn.textContent = "Loading...";

  var customCookies = localStorage.getItem("user_24h_cookies") || "";
  var headers = {};
  if (customCookies) {
    headers["X-Cookies"] = customCookies;
  }

  fetch(BASE + "/post?url=" + enc, { headers: headers })
    .then(function(r) { return r.json().then(function(d) { return { ok: r.ok, d: d }; }); })
    .then(function(res) {
      if (!res.ok) { throw new Error(res.d.error || "Server error"); }
      det.dataset.postData = JSON.stringify(res.d);
      det.innerHTML = buildCard(res.d, "det-" + i);
      if (res.d && res.d.title) {
        var cardEl = document.getElementById("card-" + i);
        if (cardEl) {
          var tEl = cardEl.querySelector(".card-title");
          if (tEl) {
            tEl.textContent = res.d.title;
            tEl.setAttribute("title", res.d.title);
          }
          cardEl.setAttribute("data-title", res.d.title.toLowerCase());
        }
      }
      btn.classList.add("done");
      btn.textContent = "Close";
      btn.disabled = false;
    })
    .catch(function(err) {
      det.innerHTML = "<div class=\\"err\\">Error: " + String(err.message) + "</div>";
      btn.textContent = "Retry";
      btn.disabled = false;
    });
}

function buildCard(d, detId) {
  var html = "";

  if (d.thumbnail) {
    html += "<div class=\\"dc-thumb\\"><img src=\\"" + d.thumbnail + "\\" alt=\\"thumb\\" loading=\\"lazy\\"></div>";
  }

  html += "<div class=\\"dc-title\\">" + safe(d.title) + "</div>";

  var meta = d.meta || {};
  var keys = Object.keys(meta);
  if (keys.length) {
    html += "<div class=\\"dc-meta\\">";
    for (var k = 0; k < keys.length; k++) {
      var key = keys[k];
      if (key.toLowerCase() === "synopsis") continue;
      html += "<span class=\\"mk\\">" + safe(key) + ":</span><span class=\\"mv\\">" + safe(meta[key]) + "</span>";
    }
    html += "</div>";
  }

  if (d.synopsis) {
    html += "<div class=\\"dc-syn-lbl\\">Synopsis</div>";
    html += "<div class=\\"dc-syn\\">" + safe(d.synopsis) + "</div>";
  }

  html += "<div class=\\"series-actions\\">";
  html += "<button class=\\"btn-fetch-all\\" onclick=\\"onFetchAllEpisodes('" + detId + "')\\">&#9889; Fetch All Episodes with Qualities</button>";
  html += "<div class=\\"export-btn-group\\">";
  html += "<button class=\\"btn-tg-channel-hero\\" onclick=\\"onPostCardToTelegram(this, '" + detId + "')\\" title=\\"Post series to Telegram Channel with poster, details, synopsis & Season deep-link buttons\\">&#9992; Post on Telegram</button>";
  html += "<button class=\\"btn-save-data\\" onclick=\\"onExportJson('" + detId + "')\\" title=\\"Download JSON of all fetched episodes\\">&#128190; Save Data (JSON)</button>";
  html += "<button class=\\"btn-copy-all\\" onclick=\\"onCopyAllLinks(this, '" + detId + "')\\" title=\\"Copy all direct platform links\\">&#128203; Copy All Links</button>";
  html += "<button class=\\"btn-txt-links\\" onclick=\\"onDownloadTxtLinks('" + detId + "')\\" title=\\"Download raw links .txt\\">&#128196; Links .txt</button>";
  html += "<button class=\\"btn-tg-post\\" onclick=\\"onPostSeriesToTelegram(this, '" + detId + "')\\" title=\\"Post all episodes to Telegram Channel\\">&#128203; Post Batch Text</button>";
  html += "</div></div>";

  var seasons = d.seasons || [];
  for (var s = 0; s < seasons.length; s++) {
    var season = seasons[s];
    html += "<div class=\\"season\\"><div class=\\"season-name\\">" + safe(season.name) + "</div>";
    html += "<div class=\\"ep-list\\">";
    var eps = season.episodes || [];
    for (var e = 0; e < eps.length; e++) {
      var ep = eps[e];
      var epUid = "ep-" + s + "-" + e + "-" + Math.random().toString(36).slice(2, 7);
      var links = ep.links || [];
      var mainHref = (links[0] && links[0].href) ? links[0].href : "";

      var cached = mainHref ? getSavedEpisode(mainHref) : null;
      var isCached = !!(cached && cached.data);
      var btnText = isCached ? "&#9889; View Qualities (Saved &#128190;)" : "&#9889; Extract Qualities & Links";
      var btnDone = isCached ? " done" : "";

      html += "<div class=\\"ep-container\\" id=\\"" + epUid + "\\">";
      html += "<div class=\\"ep\\">";
      html += "<span class=\\"ep-lbl\\">" + safe(ep.label) + (isCached ? "<span class=\\"badge-cached\\">&#128190; Saved</span>" : "") + "</span>";
      html += "<span class=\\"ep-actions\\">";
      if (mainHref) {
        html += "<button class=\\"btn-extract" + btnDone + "\\" data-enc=\\"" + encodeURIComponent(mainHref) + "\\" data-uid=\\"" + epUid + "\\" onclick=\\"onExtractEpisode(this, '" + encodeURIComponent(mainHref) + "', '" + epUid + "')\\">" + btnText + "</button>";
        html += "<button class=\\"btn-tg-ep\\" onclick=\\"onPostEpisodeToTelegram(this, '" + epUid + "', '" + encodeURIComponent(mainHref) + "')\\" title=\\"Post this episode directly to Telegram Channel\\">&#9992; Telegram</button>";
        html += "<a href=\\"" + safe(mainHref) + "\\" target=\\"_blank\\" rel=\\"noopener\\" class=\\"ep-archive-link\\">Archive Page &nearr;</a>";
      }
      html += "</span></div>";
      html += "<div class=\\"ep-qualities-box hidden\\" id=\\"" + epUid + "-box\\"></div>";
      html += "</div>";
    }
    html += "</div></div>";
  }

  return "<div class=\\"det-inner\\">" + html + "</div>";
}

function onExtractEpisode(btn, encUrl, epUid, forceRefresh) {
  var box = document.getElementById(epUid + "-box");
  if (!box) return Promise.resolve(null);

  if (!forceRefresh && btn.classList.contains("done") && !box.classList.contains("hidden")) {
    box.classList.add("hidden");
    btn.textContent = "⚡ Extract Qualities & Links";
    btn.classList.remove("done");
    return Promise.resolve(null);
  }

  box.classList.remove("hidden");

  // Check saved cache
  var rawUrl = decodeURIComponent(encUrl);
  var cached = !forceRefresh ? getSavedEpisode(rawUrl) : null;
  if (cached && cached.data) {
    btn.disabled = false;
    btn.textContent = "Hide Qualities (Saved 💾)";
    btn.classList.add("done");
    box.innerHTML = renderEpisodeQualities(cached.data);
    return Promise.resolve(cached.data);
  }

  box.innerHTML = "<div class=\\"loading\\" style=\\"padding:12px;\\"><div class=\\"spin\\"></div> Decrypting direct platform links...</div>";
  btn.disabled = true;
  btn.textContent = "Extracting...";

  var customCookies = localStorage.getItem("user_24h_cookies") || "";
  var headers = {};
  if (customCookies) {
    headers["X-Cookies"] = customCookies;
  }

  return fetch(BASE + "/episode?url=" + encUrl + "&resolve=true", { headers: headers })
    .then(function(r) { return r.json().then(function(d) { return { ok: r.ok, d: d }; }); })
    .then(function(res) {
      btn.disabled = false;
      if (!res.ok) throw new Error(res.d.error || "Failed to extract episode");
      btn.textContent = "Hide Qualities (Saved 💾)";
      btn.classList.add("done");
      // Save data once fetched!
      saveEpisodeData(rawUrl, res.d);
      box.innerHTML = renderEpisodeQualities(res.d);
      return res.d;
    })
    .catch(function(err) {
      btn.disabled = false;
      btn.textContent = "Retry Extract";
      box.innerHTML = "<div class=\\"err\\">Error: " + safe(err.message) + "</div>";
      return null;
    });
}

function onFetchAllEpisodes(detId) {
  var det = document.getElementById(detId);
  if (!det) return;

  var epContainers = det.querySelectorAll(".ep-container");
  if (!epContainers || !epContainers.length) {
    alert("No episodes found to fetch.");
    return;
  }

  var btn = det.querySelector(".btn-fetch-all");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "⏳ Fetching (0/" + epContainers.length + ")...";
  }

  var total = epContainers.length;
  var completed = 0;
  var queue = Array.from(epContainers);
  var CONCURRENCY = 3;

  function processContainer(c) {
    var extractBtn = c.querySelector(".btn-extract");
    if (!extractBtn) return Promise.resolve(null);
    var enc = extractBtn.getAttribute("data-enc");
    var uid = extractBtn.getAttribute("data-uid");
    if (!enc || !uid) return Promise.resolve(null);

    return onExtractEpisode(extractBtn, enc, uid, false).then(function(d) {
      completed++;
      if (btn) {
        btn.textContent = "⏳ Fetching (" + completed + "/" + total + ")...";
      }
      return d;
    });
  }

  function runWorker() {
    if (!queue.length) return Promise.resolve();
    var c = queue.shift();
    return processContainer(c).then(function() {
      return runWorker();
    });
  }

  var workers = [];
  for (var w = 0; w < Math.min(CONCURRENCY, queue.length); w++) {
    workers.push(runWorker());
  }

  Promise.all(workers).then(function() {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "✅ All Fetched (" + completed + "/" + total + ")";
      btn.classList.add("done");
    }
  });
}

function onExportJson(detId) {
  var det = document.getElementById(detId);
  if (!det) return;
  var title = det.querySelector(".dc-title") ? det.querySelector(".dc-title").textContent.trim() : "series";

  var epContainers = det.querySelectorAll(".ep-container");
  var list = [];
  for (var i = 0; i < epContainers.length; i++) {
    var c = epContainers[i];
    var extractBtn = c.querySelector(".btn-extract");
    if (extractBtn) {
      var rawUrl = decodeURIComponent(extractBtn.getAttribute("data-enc") || "");
      var cached = getSavedEpisode(rawUrl);
      if (cached && cached.data) {
        list.push(cached.data);
      }
    }
  }

  if (!list.length) {
    alert("No fetched episode data found yet. Click 'Fetch All Episodes' first!");
    return;
  }

  var payload = {
    series: title,
    totalEpisodes: list.length,
    exportedAt: new Date().toISOString(),
    episodes: list
  };

  var blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  var url = URL.createObjectURL(blob);
  var a = document.createElement("a");
  a.href = url;
  a.download = (title.replace(/[^a-z0-9_-]/gi, "_") || "episodes") + ".json";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function onCopyAllLinks(btn, detId) {
  var det = document.getElementById(detId);
  if (!det) return;
  var title = det.querySelector(".dc-title") ? det.querySelector(".dc-title").textContent.trim() : "Series";

  var epContainers = det.querySelectorAll(".ep-container");
  var text = "=== " + title + " ===\\n\\n";
  var count = 0;

  for (var i = 0; i < epContainers.length; i++) {
    var c = epContainers[i];
    var extractBtn = c.querySelector(".btn-extract");
    if (!extractBtn) continue;
    var rawUrl = decodeURIComponent(extractBtn.getAttribute("data-enc") || "");
    var cached = getSavedEpisode(rawUrl);
    if (cached && cached.data) {
      var ep = cached.data;
      var epNum = "S" + String(ep.season || 1).padStart(2, "0") + "E" + String(ep.episode || (i + 1)).padStart(2, "0");
      text += "[" + epNum + "] " + (ep.title || title) + "\\n";
      var quals = ep.qualities || [];
      for (var q = 0; q < quals.length; q++) {
        var qual = quals[q];
        text += "  " + (qual.resolution || "HD") + " (" + (qual.size || "") + "):\\n";
        var files = qual.files || [];
        for (var f = 0; f < files.length; f++) {
          var file = files[f];
          var finalLink = file.finalUrl || file.destinationUrl || file.redirectUrl;
          text += "    - " + file.host + ": " + finalLink + "\\n";
          count++;
        }
      }
      text += "\\n";
    }
  }

  if (!count) {
    alert("No fetched episode links found yet. Click 'Fetch All Episodes' first!");
    return;
  }

  navigator.clipboard.writeText(text).then(function() {
    var orig = btn.innerHTML;
    btn.innerHTML = "✅ Copied " + count + " Links!";
    setTimeout(function() { btn.innerHTML = orig; }, 2500);
  });
}

function onDownloadTxtLinks(detId) {
  var det = document.getElementById(detId);
  if (!det) return;
  var title = det.querySelector(".dc-title") ? det.querySelector(".dc-title").textContent.trim() : "Series";

  var epContainers = det.querySelectorAll(".ep-container");
  var lines = [];

  for (var i = 0; i < epContainers.length; i++) {
    var c = epContainers[i];
    var extractBtn = c.querySelector(".btn-extract");
    if (!extractBtn) continue;
    var rawUrl = decodeURIComponent(extractBtn.getAttribute("data-enc") || "");
    var cached = getSavedEpisode(rawUrl);
    if (cached && cached.data) {
      var ep = cached.data;
      var quals = ep.qualities || [];
      for (var q = 0; q < quals.length; q++) {
        var files = quals[q].files || [];
        for (var f = 0; f < files.length; f++) {
          var finalLink = files[f].finalUrl || files[f].destinationUrl || files[f].redirectUrl;
          if (finalLink && !finalLink.includes("/redirect/")) {
            lines.push(finalLink);
          }
        }
      }
    }
  }

  if (!lines.length) {
    alert("No links ready to download. Click 'Fetch All Episodes' first!");
    return;
  }

  var blob = new Blob([lines.join("\\n")], { type: "text/plain" });
  var url = URL.createObjectURL(blob);
  var a = document.createElement("a");
  a.href = url;
  a.download = (title.replace(/[^a-z0-9_-]/gi, "_") || "download_links") + ".txt";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function getTelegramConfig() {
  return {
    botToken: (localStorage.getItem("tg_bot_token") || "8886391655:AAGzveDdUEtAmPe08Ym-C1k7mZXaQ70iwgM").trim(),
    chatId: (localStorage.getItem("tg_chat_id") || "@OtakuDriveHQ").trim(),
    botUsername: (localStorage.getItem("tg_bot_username") || "OtakuDriveBot").trim().replace(/^@/, "")
  };
}

function updateTelegramStatus() {
  var conf = getTelegramConfig();
  var badge = document.getElementById("tg-status-badge");
  if (badge) {
    if (conf.botToken && conf.chatId) {
      var uInfo = conf.botUsername ? ("(@" + conf.botUsername + ")") : "";
      badge.textContent = "Telegram: " + conf.chatId + " " + uInfo + " ✅";
      badge.className = "badge-active";
    } else {
      badge.textContent = "Telegram: Not Configured ⚠️";
      badge.className = "badge-default";
    }
  }
  var inpToken = document.getElementById("input-tg-bot-token");
  var inpChat = document.getElementById("input-tg-chat-id");
  var inpUname = document.getElementById("input-tg-bot-username");
  if (inpToken && !inpToken.value) inpToken.value = conf.botToken;
  if (inpChat && !inpChat.value) inpChat.value = conf.chatId;
  if (inpUname && !inpUname.value && conf.botUsername) inpUname.value = "@" + conf.botUsername;
}

function saveTelegramConfig() {
  var token = (document.getElementById("input-tg-bot-token").value || "").trim();
  var chat = (document.getElementById("input-tg-chat-id").value || "").trim();
  var uname = (document.getElementById("input-tg-bot-username").value || "").trim().replace(/^@/, "");
  var msg = document.getElementById("tg-status-msg");

  if (token && chat) {
    localStorage.setItem("tg_bot_token", token);
    localStorage.setItem("tg_chat_id", chat);
    if (uname) localStorage.setItem("tg_bot_username", uname);
    else localStorage.removeItem("tg_bot_username");

    // Also persist into Cloudflare BOT_KV
    fetch(BASE + "/telegram/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ botToken: token, chatId: chat, botUsername: uname })
    }).catch(function() {});

    if (msg) {
      msg.textContent = "Telegram configuration saved & synced to Worker! ✅";
      msg.style.display = "block";
      msg.style.color = "#22c55e";
      setTimeout(function() { msg.style.display = "none"; }, 3500);
    }
  } else {
    localStorage.removeItem("tg_bot_token");
    localStorage.removeItem("tg_chat_id");
    localStorage.removeItem("tg_bot_username");
    if (msg) {
      msg.textContent = "Telegram settings cleared.";
      msg.style.display = "block";
      msg.style.color = "#94a3b8";
      setTimeout(function() { msg.style.display = "none"; }, 3000);
    }
  }
  updateTelegramStatus();
}

function autoDetectBotUsername(btn) {
  var token = (document.getElementById("input-tg-bot-token").value || "").trim();
  if (!token) {
    alert("Please enter a Telegram Bot Token first!");
    return;
  }
  btn.disabled = true;
  var orig = btn.textContent;
  btn.textContent = "Detecting...";

  fetch("https://api.telegram.org/bot" + token + "/getMe")
    .then(function(r) { return r.json(); })
    .then(function(d) {
      btn.disabled = false;
      btn.textContent = orig;
      if (d.ok && d.result && d.result.username) {
        var inpUname = document.getElementById("input-tg-bot-username");
        if (inpUname) inpUname.value = "@" + d.result.username;
        saveTelegramConfig();
        alert("Bot detected: @" + d.result.username + " (" + d.result.first_name + ")");
      } else {
        alert("Detection failed: " + (d.description || "Invalid Bot Token"));
      }
    })
    .catch(function(e) {
      btn.disabled = false;
      btn.textContent = orig;
      alert("Network error: " + e.message);
    });
}

function setupTelegramWebhook(btn) {
  var conf = getTelegramConfig();
  if (!conf.botToken) {
    alert("Please enter a Bot Token first!");
    return;
  }
  btn.disabled = true;
  var orig = btn.textContent;
  btn.textContent = "Linking Webhook...";

  fetch(BASE + "/telegram/setup-webhook", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ botToken: conf.botToken })
  })
    .then(function(r) { return r.json(); })
    .then(function(d) {
      btn.disabled = false;
      btn.textContent = orig;
      if (d.ok) {
        alert("✅ Webhook Linked Successfully!\\nWebhook URL: " + d.webhookUrl + "\\n\\nYour bot is now listening live! When users tap Season buttons, the bot will show episode lists & generate GDFlix links!");
      } else {
        alert("Webhook setup failed: " + (d.error || JSON.stringify(d)));
      }
    })
    .catch(function(e) {
      btn.disabled = false;
      btn.textContent = orig;
      alert("Error: " + e.message);
    });
}

function checkWebhookInfo(btn) {
  var conf = getTelegramConfig();
  if (!conf.botToken) {
    alert("Please enter a Bot Token first!");
    return;
  }
  btn.disabled = true;
  var orig = btn.textContent;
  btn.textContent = "Checking...";

  fetch(BASE + "/telegram/webhook-info")
    .then(function(r) { return r.json(); })
    .then(function(d) {
      btn.disabled = false;
      btn.textContent = orig;
      if (d.ok && d.result) {
        var info = d.result;
        alert("📡 Telegram Webhook Status:\\n- Webhook URL: " + (info.url || "None (Not Set)") + "\\n- Pending Updates: " + info.pending_update_count + "\\n- Last Error: " + (info.last_error_message || "None") + "\\n- Max Connections: " + (info.max_connections || 40));
      } else {
        alert("Could not get webhook info: " + (d.description || JSON.stringify(d)));
      }
    })
    .catch(function(e) {
      btn.disabled = false;
      btn.textContent = orig;
      alert("Error: " + e.message);
    });
}

function onQuickPostToTelegram(e, btn, encUrl, idx) {
  if (e) e.stopPropagation();
  var conf = getTelegramConfig();
  if (!conf.botToken || !conf.chatId) {
    var drawer = document.getElementById("tg-drawer");
    if (drawer) drawer.classList.add("open");
    alert("Please set up Telegram Bot Token & Channel ID in Telegram Bot Setup first!");
    return;
  }

  btn.disabled = true;
  var orig = btn.innerHTML;
  btn.innerHTML = "⏳ Posting...";

  var rawUrl = decodeURIComponent(encUrl);
  var customCookies = localStorage.getItem("user_24h_cookies") || "";
  var headers = {};
  if (customCookies) headers["X-Cookies"] = customCookies;

  var det = document.getElementById("det-" + idx);
  var postDataPromise;
  if (det && det.dataset && det.dataset.postData) {
    try {
      postDataPromise = Promise.resolve(JSON.parse(det.dataset.postData));
    } catch (err) {
      postDataPromise = fetch(BASE + "/post?url=" + encUrl, { headers: headers }).then(function(r) { return r.json(); });
    }
  } else {
    postDataPromise = fetch(BASE + "/post?url=" + encUrl, { headers: headers }).then(function(r) { return r.json(); });
  }

  postDataPromise.then(function(postData) {
    if (!postData || !postData.title) throw new Error("Could not fetch post details.");

    return fetch(BASE + "/telegram/post-channel", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        postData: postData,
        postUrl: rawUrl,
        botToken: conf.botToken,
        chatId: conf.chatId,
        botUsername: conf.botUsername
      })
    });
  })
  .then(function(r) { return r.json(); })
  .then(function(d) {
    btn.disabled = false;
    if (d.ok) {
      btn.innerHTML = "✅ Posted!";
      btn.style.background = "#16a34a";
      setTimeout(function() { btn.innerHTML = orig; btn.style.background = ""; }, 4000);
    } else {
      btn.innerHTML = orig;
      alert("Telegram Error: " + (d.error || "Failed to post"));
    }
  })
  .catch(function(err) {
    btn.disabled = false;
    btn.innerHTML = orig;
    alert("Error posting to Telegram: " + err.message);
  });
}

function onPostCardToTelegram(btn, detId) {
  var conf = getTelegramConfig();
  if (!conf.botToken || !conf.chatId) {
    var drawer = document.getElementById("tg-drawer");
    if (drawer) drawer.classList.add("open");
    alert("Please set up Telegram Bot Token & Channel ID in Telegram Bot Setup first!");
    return;
  }

  var det = document.getElementById(detId);
  if (!det) return;

  var postData = null;
  if (det.dataset && det.dataset.postData) {
    try { postData = JSON.parse(det.dataset.postData); } catch (e) {}
  }

  if (!postData) {
    alert("Post data is still loading. Please wait or scrape again.");
    return;
  }

  btn.disabled = true;
  var orig = btn.innerHTML;
  btn.innerHTML = "⏳ Publishing to Channel...";

  fetch(BASE + "/telegram/post-channel", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      postData: postData,
      botToken: conf.botToken,
      chatId: conf.chatId,
      botUsername: conf.botUsername
    })
  })
  .then(function(r) { return r.json(); })
  .then(function(d) {
    btn.disabled = false;
    if (d.ok) {
      btn.innerHTML = "✅ Channel Post Published!";
      btn.style.background = "#16a34a";
      setTimeout(function() { btn.innerHTML = orig; btn.style.background = ""; }, 4000);
    } else {
      btn.innerHTML = orig;
      alert("Telegram Error: " + (d.error || "Failed to post"));
    }
  })
  .catch(function(err) {
    btn.disabled = false;
    btn.innerHTML = orig;
    alert("Error: " + err.message);
  });
}


function testTelegramPost(btn) {
  var conf = getTelegramConfig();
  if (!conf.botToken || !conf.chatId) {
    alert("Please enter both Bot Token and Chat ID first!");
    return;
  }
  btn.disabled = true;
  var orig = btn.textContent;
  btn.textContent = "Sending test ping...";

  fetch(BASE + "/telegram/send", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      botToken: conf.botToken,
      chatId: conf.chatId,
      text: "🔔 <b>Telegram Bot Connected!</b>\\n\\nToonWorld4All Scraper is successfully linked to this channel. You can now post episodes and direct download links directly!"
    })
  })
  .then(function(r) { return r.json(); })
  .then(function(d) {
    btn.disabled = false;
    btn.textContent = orig;
    if (d.ok) {
      alert("Test message sent successfully to Telegram! ✅ (Message ID: " + d.messageId + ")");
    } else {
      alert("Failed to send: " + (d.error || "Unknown error"));
    }
  })
  .catch(function(e) {
    btn.disabled = false;
    btn.textContent = orig;
    alert("Network error: " + e.message);
  });
}

function onPostEpisodeToTelegram(btn, epUid, encHref) {
  var conf = getTelegramConfig();
  if (!conf.botToken || !conf.chatId) {
    var drawer = document.getElementById("tg-drawer");
    if (drawer) drawer.classList.add("open");
    alert("Please set up your Telegram Bot Token & Chat ID first in Telegram Bot Setup!");
    return;
  }

  var rawUrl = decodeURIComponent(encHref);
  var cached = getSavedEpisode(rawUrl);

  var fetchPromise;
  if (cached && cached.data) {
    fetchPromise = Promise.resolve(cached.data);
  } else {
    var epBox = document.getElementById(epUid);
    var extractBtn = epBox ? epBox.querySelector(".btn-extract") : null;
    fetchPromise = onExtractEpisode(extractBtn, encHref, epUid, false);
  }

  btn.disabled = true;
  var origText = btn.innerHTML;
  btn.innerHTML = "⏳ Posting...";

  fetchPromise.then(function(epData) {
    if (!epData) {
      throw new Error("Could not extract episode download links.");
    }

    var card = btn.closest(".card-detail") || document;
    var title = card.querySelector(".dc-title") ? card.querySelector(".dc-title").textContent.trim() : epData.title;
    var thumb = card.querySelector(".dc-thumb img") ? card.querySelector(".dc-thumb img").src : null;

    var postData = {
      title: title,
      thumbnail: thumb
    };

    return fetch(BASE + "/telegram/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        botToken: conf.botToken,
        chatId: conf.chatId,
        type: "episode",
        postData: postData,
        episodeData: epData
      })
    });
  })
  .then(function(r) { return r.json(); })
  .then(function(d) {
    btn.disabled = false;
    if (d.ok) {
      btn.innerHTML = "✅ Sent!";
      btn.style.background = "#16a34a";
      setTimeout(function() { btn.innerHTML = origText; btn.style.background = ""; }, 3000);
    } else {
      btn.innerHTML = origText;
      alert("Telegram send error: " + (d.error || "Unknown"));
    }
  })
  .catch(function(err) {
    btn.disabled = false;
    btn.innerHTML = origText;
    alert("Error: " + err.message);
  });
}

function onPostSeriesToTelegram(btn, detId) {
  var conf = getTelegramConfig();
  if (!conf.botToken || !conf.chatId) {
    var drawer = document.getElementById("tg-drawer");
    if (drawer) drawer.classList.add("open");
    alert("Please set up your Telegram Bot Token & Chat ID first in Telegram Bot Setup!");
    return;
  }

  var det = document.getElementById(detId);
  if (!det) return;

  var epContainers = det.querySelectorAll(".ep-container");
  var list = [];
  for (var i = 0; i < epContainers.length; i++) {
    var c = epContainers[i];
    var extractBtn = c.querySelector(".btn-extract");
    if (extractBtn) {
      var rawUrl = decodeURIComponent(extractBtn.getAttribute("data-enc") || "");
      var cached = getSavedEpisode(rawUrl);
      if (cached && cached.data) {
        list.push(cached.data);
      }
    }
  }

  if (!list.length) {
    alert("No fetched episodes to send. Click 'Fetch All Episodes with Qualities' first!");
    return;
  }

  btn.disabled = true;
  var origText = btn.innerHTML;
  btn.innerHTML = "⏳ Sending to Telegram...";

  var title = det.querySelector(".dc-title") ? det.querySelector(".dc-title").textContent.trim() : "Series";
  var thumb = det.querySelector(".dc-thumb img") ? det.querySelector(".dc-thumb img").src : null;

  var postData = {
    title: title,
    thumbnail: thumb
  };

  fetch(BASE + "/telegram/send", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      botToken: conf.botToken,
      chatId: conf.chatId,
      type: "batch",
      postData: postData,
      episodesList: list
    })
  })
  .then(function(r) { return r.json(); })
  .then(function(d) {
    btn.disabled = false;
    if (d.ok) {
      btn.innerHTML = "✅ Posted to Telegram!";
      btn.style.background = "#16a34a";
      setTimeout(function() { btn.innerHTML = origText; btn.style.background = ""; }, 4000);
    } else {
      btn.innerHTML = origText;
      alert("Telegram error: " + (d.error || "Unknown"));
    }
  })
  .catch(function(e) {
    btn.disabled = false;
    btn.innerHTML = origText;
    alert("Network error: " + e.message);
  });
}

function renderEpisodeQualities(data) {
  var qualities = data.qualities || [];
  if (!qualities.length) {
    return "<div class=\\"err\\">No quality encodes found for this episode.</div>";
  }

  var html = "<div class=\\"qualities-list\\">";
  for (var i = 0; i < qualities.length; i++) {
    var q = qualities[i];
    html += "<div class=\\"quality-card\\">";
    html += "<div class=\\"quality-header\\">";
    html += "<span class=\\"q-badge\\">" + safe(q.resolution || "HD") + "</span>";
    html += "<span class=\\"q-codec\\">" + safe(q.codec) + "</span>";
    html += "<span class=\\"q-size\\">" + safe(q.size) + "</span>";
    html += "</div>";

    html += "<div class=\\"platform-grid\\">";
    var files = q.files || [];
    for (var f = 0; f < files.length; f++) {
      var file = files[f];
      var hostName = file.host || "File";
      var redir = file.redirectUrl;
      var dest = file.finalUrl || file.destinationUrl;
      var isAd = file.isAdShortener;
      var targetLink = dest || redir;
      var isGdflix = /gdflix/i.test(hostName) || /gdflix/i.test(targetLink);
      var isHubcloud = /hubcloud/i.test(hostName) || /hubcloud/i.test(targetLink);

      html += "<div class=\\"platform-chip\\">";
      html += "<div class=\\"platform-info\\"><span class=\\"p-name\\">" + safe(hostName) + "</span>";
      if (file.short) {
        html += "<span class=\\"p-sub\\">(" + safe(file.short) + ")</span>";
      }
      html += "</div>";
      html += "<div class=\\"platform-actions\\">";

      // If GDFlix or HubCloud, add Generate Link button in front
      if (isGdflix || isHubcloud) {
        var pType = isHubcloud ? "hubcloud" : "gdflix";
        html += "<button class=\\"p-btn-gen\\" onclick=\\"onGenerateDirectLink(this, '" + safe(targetLink) + "', '" + pType + "')\\" title=\\"Generate direct Google CDN link\\">&#9889; Generate Link</button>";
      }
// If decrypted or final platform link is available without shortener:
      if (dest && !dest.includes("/redirect/") && !isAd) {
        html += "<a href=\\"" + safe(dest) + "\\" target=\\"_blank\\" rel=\\"noopener\\" class=\\"p-btn-final\\" title=\\"Direct Platform Download Link\\">&#9889; Direct " + safe(hostName) + " Link &rarr;</a>";
      } else {
        html += "<a href=\\"" + safe(redir) + "\\" target=\\"_blank\\" rel=\\"noopener\\" class=\\"p-btn-redir\\" title=\\"Open official redirect link\\">Open Link &nearr;</a>";
        if (dest && isAd) {
          html += "<a href=\\"" + safe(dest) + "\\" target=\\"_blank\\" rel=\\"noopener\\" class=\\"p-btn-short\\" title=\\"Shortener Link\\">Shortener &rarr;</a>";
        }
      }
      html += "<button class=\\"p-btn-copy\\" onclick=\\"copyLink(this, '" + safe(dest || redir) + "')\\" title=\\"Copy Link\\">&#128203;</button>";
      html += "</div></div>";
    }
    html += "</div></div>";
  }
  html += "</div>";
  return html;
}

function onGenerateDirectLink(btn, url, type) {
  if (!url) return;
  btn.disabled = true;
  var origHtml = btn.innerHTML;
  btn.innerHTML = "<span class=\\"spin\\" style=\\"display:inline-block;width:10px;height:10px;border-width:2px;vertical-align:middle;margin-right:3px;\\"></span> Extracting...";

  fetch(BASE + "/extract-direct?url=" + encodeURIComponent(url) + "&type=" + encodeURIComponent(type))
    .then(function(r) { return r.json(); })
    .then(function(d) {
      if (d && d.ok && d.directUrl) {
        btn.outerHTML = "<a href=\\"" + safe(d.directUrl) + "\\" target=\\"_blank\\" rel=\\"noopener\\" class=\\"p-btn-direct-ready\\" title=\\"High-Speed Direct Google CDN Link\\">&#9889; Direct CDN Link &rarr;</a>" +
          "<button class=\\"p-btn-copy\\" onclick=\\"copyLink(this, '" + safe(d.directUrl) + "')\\" title=\\"Copy Direct CDN Link\\">&#128203;</button>" +
          "<a href=\\"https://watch.otakudrivehq.workers.dev/?url=" + encodeURIComponent(d.directUrl) + "\\" target=\\"_blank\\" class=\\"p-btn-play\\" title=\\"Play Video in Web Player\\">&#9654; Play</a>";
      } else {
        btn.disabled = false;
        btn.innerHTML = origHtml;
        var msg = "Could not automatically resolve direct Google CDN link (" + (d && d.error ? d.error : "WAF challenge") + ").\\n\\nWould you like to open the " + (type === "hubcloud" ? "HubCloud" : "platform") + " page directly?";
        if (confirm(msg)) {
          window.open(url, "_blank");
          btn.outerHTML = "<a href=\\"" + safe(url) + "\\" target=\\"_blank\\" rel=\\"noopener\\" class=\\"p-btn-final\\" style=\\"background:#dc2626;\\" title=\\"Open Platform Direct Link\\">&#9889; Open " + (type === "hubcloud" ? "HubCloud" : "Direct") + " &rarr;</a>";
        }
      }
    })
    .catch(function(e) {
      btn.disabled = false;
      btn.innerHTML = origHtml;
      if (confirm("Network error: " + e.message + "\\n\\nWould you like to open the page directly?")) {
        window.open(url, "_blank");
      }
    });
}

function copyLink(btn, text) {
  navigator.clipboard.writeText(text).then(function() {
    var orig = btn.innerHTML;
    btn.innerHTML = "&#9989;";
    setTimeout(function() { btn.innerHTML = orig; }, 1500);
  });
}

function safe(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

window.saveCustomCookies = saveCustomCookies;
window.onExtractEpisode = onExtractEpisode;
window.copyLink = copyLink;
window.onScrapeClick = onScrapeClick;
window.updateCustomCookieStatus = updateCustomCookieStatus;
window.onFetchAllEpisodes = onFetchAllEpisodes;
window.onExportJson = onExportJson;
window.onCopyAllLinks = onCopyAllLinks;
window.onDownloadTxtLinks = onDownloadTxtLinks;
window.clearAllSavedData = clearAllSavedData;
window.saveTelegramConfig = saveTelegramConfig;
window.testTelegramPost = testTelegramPost;
window.onPostEpisodeToTelegram = onPostEpisodeToTelegram;
window.onPostSeriesToTelegram = onPostSeriesToTelegram;
window.autoDetectBotUsername = autoDetectBotUsername;
window.setupTelegramWebhook = setupTelegramWebhook;
window.checkWebhookInfo = checkWebhookInfo;
window.onQuickPostToTelegram = onQuickPostToTelegram;
window.onPostCardToTelegram = onPostCardToTelegram;
window.onGenerateDirectLink = onGenerateDirectLink;

window.addEventListener("DOMContentLoaded", attachButtons);
`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ToonWorld4All - Posts</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0f0f14;color:#e2e8f0;font-family:system-ui,sans-serif;font-size:14px;min-height:100vh}

/* ── Top bar ── */
.topbar{background:#161622;border-bottom:1px solid #2a2a40;padding:12px 16px}
.topbar-row1{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-bottom:10px}
.topbar-title{font-weight:700;font-size:15px;color:#fff;display:flex;align-items:center;gap:6px}
.stats-row{display:flex;gap:12px;flex-wrap:wrap}
.stat-box{background:#1e1e30;border:1px solid #2a2a40;border-radius:8px;padding:6px 14px;text-align:center}
.stat-num{font-size:18px;font-weight:800;color:#7c3aed;line-height:1}
.stat-lbl{font-size:10px;color:#64748b;text-transform:uppercase;letter-spacing:.05em;margin-top:2px}
.stat-box.green .stat-num{color:#22c55e}
.stat-box.red .stat-num{color:#ef4444}
.stat-box.blue .stat-num{color:#06b6d4}
.stat-box.gold .stat-num{color:#fbbf24}

/* ── Cookie panel & Drawer ── */
.btn-toolbar{display:flex;gap:8px;flex-wrap:wrap;margin-top:8px;align-items:center}
.ck-toggle{background:none;border:1px solid #2a2a40;color:#94a3b8;border-radius:6px;padding:5px 12px;font-size:11px;cursor:pointer}
.ck-toggle:hover{background:#1e1e30;color:#e2e8f0}
.btn-custom-ck{background:#2563eb;color:#fff;border:none;border-radius:6px;padding:5px 12px;font-size:11px;font-weight:700;cursor:pointer}
.btn-custom-ck:hover{background:#1d4ed8}
.badge-active{background:rgba(34,197,94,.15);color:#22c55e;border:1px solid #22c55e;padding:3px 8px;border-radius:4px;font-size:11px;font-weight:700}
.badge-default{background:rgba(148,163,184,.15);color:#94a3b8;border:1px solid #475569;padding:3px 8px;border-radius:4px;font-size:11px}
.drawer{display:none;background:#181828;border:1px solid #2d2d45;border-radius:8px;padding:12px;margin-top:10px}
.drawer.open{display:block}
.drawer h3{font-size:13px;font-weight:700;color:#f1f5f9;margin-bottom:6px}
.drawer p{font-size:11px;color:#94a3b8;margin-bottom:8px;line-height:1.4}
.drawer textarea{width:100%;height:80px;background:#10101c;border:1px solid #2d2d45;border-radius:6px;color:#e2e8f0;padding:8px;font-family:monospace;font-size:11px;resize:vertical;outline:none}
.drawer textarea:focus{border-color:#38bdf8}
.drawer-actions{display:flex;gap:8px;margin-top:8px}
.btn-save-ck{background:#16a34a;color:#fff;border:none;border-radius:6px;padding:6px 14px;font-size:12px;font-weight:700;cursor:pointer}
.btn-save-ck:hover{background:#15803d}
.btn-clear-ck{background:#475569;color:#fff;border:none;border-radius:6px;padding:6px 14px;font-size:12px;cursor:pointer}

.ck-table{width:100%;border-collapse:collapse;font-size:11px}
.ck-table th{background:#12121e;color:#64748b;font-weight:600;padding:5px 8px;text-align:left;border-bottom:1px solid #2a2a40;white-space:nowrap}
.ck-table td{padding:5px 8px;border-bottom:1px solid #1e1e30;word-break:break-all}
.ck-name{color:#a78bfa;font-weight:600;white-space:nowrap;max-width:160px;overflow:hidden;text-overflow:ellipsis}
.ck-domain{color:#38bdf8;white-space:nowrap}
.ck-val{color:#cbd5e1;max-width:220px}
.ck-exp{color:#94a3b8;white-space:nowrap}
.ck-status{white-space:nowrap;font-weight:700;text-align:center}
tr.ck-ok .ck-status{color:#22c55e}
tr.ck-expired .ck-status{color:#ef4444}
tr.ck-expired td{opacity:.55}

/* ── Pagination ── */
.pagebar{background:#161622;border-bottom:1px solid #2a2a40;padding:8px 16px;display:flex;align-items:center;gap:10px;font-size:12px;color:#94a3b8;flex-wrap:wrap}
.pagebar a{background:#22223a;color:#06b6d4;padding:4px 10px;border-radius:6px;text-decoration:none;border:1px solid #2d2d45}
.pagebar a:hover{background:#2d2d45}

/* ── List ── */
.list{padding:12px 16px;display:flex;flex-direction:column;gap:10px;max-width:960px;margin:0 auto}

/* ── Card ── */
.card{background:#1a1a28;border:1px solid #2a2a40;border-radius:10px;overflow:hidden;transition:border-color .15s}
.card:hover{border-color:#383854}
.card-top{display:flex;align-items:center;justify-content:space-between;padding:12px 14px;gap:12px;flex-wrap:wrap}
.card-meta{display:flex;flex-direction:column;gap:5px;flex:1;min-width:0}
.card-title-row{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}
.card-num{font-size:11px;font-weight:700;color:#64748b;background:#12121e;padding:1px 6px;border-radius:4px;border:1px solid #222234;flex-shrink:0}
.card-title{font-size:14px;font-weight:700;color:#f8fafc;word-break:break-word;line-height:1.4;margin:0}
.card-sub-meta{display:flex;align-items:center;gap:8px;font-size:11px}
.card-date{font-size:11px;color:#94a3b8}
.card-src{font-size:10px;color:#475569;background:#1e1e30;padding:2px 6px;border-radius:4px;display:inline-block;width:fit-content}

/* ── Search Bar ── */
.search-bar-wrap{margin-top:12px;width:100%}
.search-form{display:flex;width:100%;max-width:720px}
.search-input-box{display:flex;align-items:center;width:100%;background:#10101c;border:1px solid #2d2d45;border-radius:8px;padding:3px 6px;transition:border-color .15s,box-shadow .15s}
.search-input-box:focus-within{border-color:#7c3aed;box-shadow:0 0 0 3px rgba(124,58,237,.2)}
.search-icon{font-size:13px;padding:0 8px;color:#64748b;user-select:none}
#post-search-input{flex:1;background:transparent;border:none;outline:none;color:#f8fafc;font-size:13px;padding:7px 4px;font-family:inherit}
#post-search-input::placeholder{color:#64748b}
.search-clear-btn{background:none;border:none;color:#94a3b8;cursor:pointer;padding:4px 8px;font-size:13px;text-decoration:none;display:inline-flex;align-items:center;justify-content:center;border-radius:4px}
.search-clear-btn:hover{color:#f8fafc;background:rgba(255,255,255,.08)}
.search-btn{background:#7c3aed;color:#fff;border:none;border-radius:6px;padding:6px 14px;font-size:12px;font-weight:700;cursor:pointer;transition:background .15s;white-space:nowrap;margin-left:4px}
.search-btn:hover{background:#6d28d9}
.search-banner{background:#181828;border:1px solid #2d2d45;border-radius:8px;padding:8px 14px;margin:12px auto 0;display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:12px;color:#e2e8f0;max-width:960px}
.search-banner b{color:#a78bfa}
.btn-clear-search-link{color:#f87171;text-decoration:none;font-weight:700;padding:2px 8px;border-radius:4px;border:1px solid rgba(248,113,113,.3)}
.btn-clear-search-link:hover{background:rgba(248,113,113,.1)}
.no-posts-card{background:#1a1a28;border:1px solid #2a2a40;border-radius:12px;padding:36px 16px;text-align:center;max-width:480px;margin:24px auto}
.btn-scrape{flex-shrink:0;background:#7c3aed;color:#fff;border:none;border-radius:8px;padding:7px 14px;font-size:12px;font-weight:700;cursor:pointer;white-space:nowrap;transition:background .15s}
.btn-scrape:hover{background:#6d28d9}
.btn-scrape:disabled{background:#4b5563;cursor:not-allowed}
.btn-scrape.done{background:#16a34a}

/* ── Detail panel ── */
.card-detail{border-top:1px solid #2a2a40;padding:14px;background:#12121e}
.card-detail.hidden{display:none}

/* ── Detail inner ── */
.det-inner{display:flex;flex-direction:column;gap:14px}
.dc-thumb img{width:120px;border-radius:8px;display:block}
.dc-title{font-size:14px;font-weight:700;line-height:1.4;color:#f1f5f9}
.dc-meta{display:grid;grid-template-columns:auto 1fr;gap:4px 10px;font-size:12px;background:#1a1a28;padding:10px;border-radius:8px;border:1px solid #2a2a40}
.mk{color:#f87171;font-weight:700;white-space:nowrap}
.mv{color:#cbd5e1}
.dc-syn-lbl{font-size:11px;font-weight:700;color:#fbbf24;text-transform:uppercase;letter-spacing:.05em}
.dc-syn{font-size:12px;color:#94a3b8;line-height:1.6}

/* ── Seasons & Episodes ── */
.season{display:flex;flex-direction:column;gap:6px}
.season-name{font-size:12px;font-weight:700;color:#fbbf24;background:rgba(251,191,36,.08);border-left:3px solid #fbbf24;padding:5px 10px;border-radius:4px;text-transform:uppercase;letter-spacing:.04em}
.ep-list{display:flex;flex-direction:column;gap:8px}
.ep-container{background:#161624;border:1px solid #2a2a40;border-radius:8px;overflow:hidden}
.ep{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 12px;flex-wrap:wrap}
.ep-lbl{font-size:12px;font-weight:700;color:#e2e8f0;min-width:90px}
.ep-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.btn-extract{background:#0284c7;color:#fff;border:none;border-radius:6px;padding:5px 12px;font-size:11px;font-weight:700;cursor:pointer;transition:background .15s}
.btn-extract:hover{background:#0369a1}
.btn-extract.done{background:#059669}
.btn-extract:disabled{background:#475569;cursor:not-allowed}
.ep-archive-link{color:#94a3b8;text-decoration:none;font-size:11px;padding:4px 8px;border:1px solid #2d2d45;border-radius:6px}
.ep-archive-link:hover{color:#e2e8f0;background:#1e1e30}

/* ── Episode Qualities Box ── */
.ep-qualities-box{padding:12px;border-top:1px solid #2a2a40;background:#10101c}
.ep-qualities-box.hidden{display:none}
.qualities-list{display:flex;flex-direction:column;gap:10px}
.quality-card{background:#181828;border:1px solid #2d2d45;border-radius:8px;padding:10px}
.quality-header{display:flex;align-items:center;gap:8px;margin-bottom:8px;flex-wrap:wrap}
.q-badge{background:#7c3aed;color:#fff;font-size:10px;font-weight:800;padding:2px 7px;border-radius:4px;text-transform:uppercase}
.q-codec{font-size:12px;font-weight:700;color:#f1f5f9}
.q-size{font-size:11px;color:#06b6d4;font-weight:600;margin-left:auto}

/* ── Platform Grid ── */
.platform-grid{display:grid;grid-template-columns:repeat(auto-fill, minmax(280px, 1fr));gap:8px}
.platform-chip{display:flex;align-items:center;justify-content:space-between;background:#202034;border:1px solid #2d2d45;border-radius:6px;padding:6px 10px;gap:8px;flex-wrap:wrap}
.platform-info{display:flex;align-items:center;gap:6px}
.p-name{font-size:12px;font-weight:700;color:#e2e8f0}
.p-sub{font-size:10px;color:#94a3b8}
.platform-actions{display:flex;align-items:center;gap:5px;margin-left:auto}
.p-btn-redir{background:#0284c7;color:#fff;text-decoration:none;font-size:11px;font-weight:700;padding:4px 9px;border-radius:4px;white-space:nowrap}
.p-btn-redir:hover{background:#0369a1}
.p-btn-final{background:#16a34a;color:#fff;text-decoration:none;font-size:11px;font-weight:700;padding:4px 9px;border-radius:4px;white-space:nowrap}
.p-btn-final:hover{background:#15803d}
.p-btn-short{background:#6366f1;color:#fff;text-decoration:none;font-size:11px;font-weight:600;padding:4px 9px;border-radius:4px;white-space:nowrap}
.p-btn-short:hover{background:#4f46e5}
.p-btn-gen{background:linear-gradient(135deg,#f59e0b 0%,#d97706 100%);color:#fff;border:none;border-radius:4px;padding:4px 9px;font-size:11px;font-weight:700;cursor:pointer;display:inline-flex;align-items:center;gap:3px;transition:all .15s;white-space:nowrap}
.p-btn-gen:hover{background:#b45309;transform:translateY(-1px)}
.p-btn-gen:disabled{opacity:.65;cursor:wait;transform:none}
.p-btn-direct-ready{background:linear-gradient(135deg,#10b981 0%,#059669 100%);color:#fff;text-decoration:none;border-radius:4px;padding:4px 9px;font-size:11px;font-weight:700;display:inline-flex;align-items:center;gap:4px;box-shadow:0 0 10px rgba(16,185,129,.45);white-space:nowrap}
.p-btn-copy{background:#334155;color:#fff;border:none;border-radius:4px;padding:4px 7px;cursor:pointer;font-size:11px}
.p-btn-play{background:#ec4899;color:#fff;text-decoration:none;border-radius:4px;padding:4px 9px;font-size:11px;font-weight:700;display:inline-flex;align-items:center;gap:4px;box-shadow:0 0 10px rgba(236,72,153,.3);white-space:nowrap;margin-left:4px}
.p-btn-play:hover{background:#f472b6}
.p-btn-copy:hover{background:#475569}

/* ── States ── */
.loading{display:flex;align-items:center;gap:8px;color:#94a3b8;font-size:13px}
.spin{width:14px;height:14px;border:2px solid #334155;border-top-color:#7c3aed;border-radius:50%;animation:sp .7s linear infinite;flex-shrink:0}
@keyframes sp{to{transform:rotate(360deg)}}
.err{color:#f87171;background:rgba(248,113,113,.1);border-radius:6px;padding:10px;font-size:12px}

/* ── Action Toolbar for Fetch All & Save ── */
.series-actions{display:flex;align-items:center;justify-content:space-between;gap:8px;background:#181828;border:1px solid #2d2d45;border-radius:8px;padding:10px 12px;margin:4px 0 10px 0;flex-wrap:wrap}
.btn-fetch-all{background:#7c3aed;color:#fff;border:none;border-radius:6px;padding:7px 16px;font-size:12px;font-weight:700;cursor:pointer;display:inline-flex;align-items:center;gap:6px;transition:all .15s}
.btn-fetch-all:hover{background:#6d28d9}
.btn-fetch-all:disabled{background:#4b5563;cursor:not-allowed}
.btn-fetch-all.done{background:#16a34a}
.export-btn-group{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.btn-save-data{background:#059669;color:#fff;border:none;border-radius:6px;padding:6px 12px;font-size:11px;font-weight:700;cursor:pointer;transition:background .15s}
.btn-save-data:hover{background:#047857}
.btn-copy-all{background:#0284c7;color:#fff;border:none;border-radius:6px;padding:6px 12px;font-size:11px;font-weight:700;cursor:pointer;transition:background .15s}
.btn-copy-all:hover{background:#0369a1}
.btn-txt-links{background:#4f46e5;color:#fff;border:none;border-radius:6px;padding:6px 12px;font-size:11px;font-weight:700;cursor:pointer;transition:background .15s}
.btn-txt-links:hover{background:#4338ca}
.badge-cached{background:rgba(34,197,94,.18);color:#22c55e;border:1px solid #22c55e;padding:2px 6px;border-radius:4px;font-size:10px;font-weight:700;margin-left:6px}
.btn-clear-cache{background:#334155;color:#cbd5e1;border:none;border-radius:6px;padding:5px 10px;font-size:11px;cursor:pointer;margin-left:auto}
.btn-clear-cache:hover{background:#475569;color:#fff}
.stat-box.purple .stat-num{color:#c084fc}

.btn-tg-post{background:#0284c7;color:#fff;border:none;border-radius:6px;padding:6px 12px;font-size:11px;font-weight:700;cursor:pointer;transition:background .15s}
.btn-tg-post:hover{background:#0369a1}
.btn-tg-post:disabled{background:#475569;cursor:not-allowed}
.btn-tg-ep{background:#0284c7;color:#fff;border:none;border-radius:6px;padding:4px 9px;font-size:11px;font-weight:700;cursor:pointer;transition:background .15s}
.btn-tg-ep:hover{background:#0369a1}
.btn-tg-ep:disabled{background:#475569;cursor:not-allowed}

.card-btns{display:flex;gap:6px;align-items:center;flex-wrap:wrap}
.btn-tg-post-card{background:#0284c7;color:#fff;border:none;border-radius:8px;padding:7px 12px;font-size:11px;font-weight:700;cursor:pointer;white-space:nowrap;transition:background .15s}
.btn-tg-post-card:hover{background:#0369a1}
.btn-tg-post-card:disabled{background:#475569;cursor:not-allowed}

.btn-tg-channel-hero{background:linear-gradient(135deg,#0284c7,#0369a1);color:#fff;border:none;border-radius:6px;padding:6px 14px;font-size:11px;font-weight:800;cursor:pointer;transition:all .15s;display:inline-flex;align-items:center;gap:5px;box-shadow:0 2px 6px rgba(2,132,199,.25)}
.btn-tg-channel-hero:hover{background:#0284c7;box-shadow:0 3px 10px rgba(2,132,199,.4)}
.btn-tg-channel-hero:disabled{background:#475569;cursor:not-allowed;box-shadow:none}

.tg-info-box{background:#111827;border:1px solid #1e293b;border-radius:6px;padding:10px 12px;font-size:11px;color:#cbd5e1;line-height:1.5;margin-top:10px}
.tg-info-box b{color:#38bdf8}

@media(max-width:550px){
  .card-top{flex-direction:column;align-items:flex-start}
  .btn-scrape,.btn-tg-post-card{width:100%}
  .platform-grid{grid-template-columns:1fr}
}
</style>
</head>
<body>

<div class="topbar">
  <div class="topbar-row1">
    <div class="topbar-title">&#128194; ToonWorld4All &mdash; Scraper</div>
    <div class="stats-row">
      <div class="stat-box blue">
        <div class="stat-num">${total.toLocaleString()}</div>
        <div class="stat-lbl">Total Posts</div>
      </div>
      <div class="stat-box">
        <div class="stat-num">${page} / ${totalPages}</div>
        <div class="stat-lbl">Page</div>
      </div>
      <div class="stat-box gold">
        <div class="stat-num">${sitemapsFetched}</div>
        <div class="stat-lbl">Sitemaps</div>
      </div>
      <div class="stat-box green">
        <div class="stat-num">${activeCount}</div>
        <div class="stat-lbl">Active Cookies</div>
      </div>
      <div class="stat-box red">
        <div class="stat-num">${expiredCount}</div>
        <div class="stat-lbl">Expired Cookies</div>
      </div>
      <div class="stat-box purple">
        <div class="stat-num" id="saved-count-num">0</div>
        <div class="stat-lbl">Saved Episodes</div>
      </div>
    </div>
  </div>

  <div class="search-bar-wrap">
    <form id="search-form" action="/posts" method="GET" class="search-form">
      <input type="hidden" name="format" value="html">
      <div class="search-input-box">
        <span class="search-icon">🔍</span>
        <input type="text" id="post-search-input" name="q" value="${escapeHtml(search || "")}" placeholder="Search posts by name... (e.g. Beyblade, Naruto, Ranma, Jujutsu)" autocomplete="off" spellcheck="false">
        ${search ? `<a href="/posts?format=html" class="search-clear-btn" title="Clear search">✕</a>` : `<button type="button" id="clear-search-btn" class="search-clear-btn" style="display:none;" title="Clear filter">✕</button>`}
        <button type="submit" class="search-btn">Search</button>
      </div>
    </form>
  </div>

  <div class="btn-toolbar">
    <button class="ck-toggle" onclick="var p=document.getElementById('ck-panel');p.classList.toggle('open');this.textContent=p.classList.contains('open')?'Hide Default Cookies':'Show Default Cookies (${cookies.length})'">Show Default Cookies (${cookies.length})</button>
    <button class="btn-custom-ck" onclick="var d=document.getElementById('custom-ck-drawer');d.classList.toggle('open');">🍪 Update 24h Session Cookies</button>
    <span id="custom-cookie-badge" class="badge-default">Default Cookies</span>
    <button class="btn-custom-ck" style="background:#0284c7;" onclick="var d=document.getElementById('tg-drawer');d.classList.toggle('open');">✈️ Telegram Bot Setup</button>
    <span id="tg-status-badge" class="badge-active">Telegram: @OtakuDriveHQ (@OtakuDriveBot) ✅</span>
    <button id="btn-clear-cache" class="btn-clear-cache" onclick="clearAllSavedData()" style="display:none;">🗑️ Clear Saved Data (0)</button>
    <a href="/logout" class="btn-custom-ck" style="background:#dc2626;text-decoration:none;margin-left:auto;">🚪 Logout</a>
  </div>

  <div class="drawer" id="tg-drawer">
    <h3>✈️ Telegram Bot &amp; Channel Configuration</h3>
    <p>Configure your Telegram Bot to publish posts to your channel and power interactive episode/quality selection with 30-minute auto-destruct:</p>
    <div style="display:flex;flex-direction:column;gap:10px;margin-top:6px;">
      <div>
        <label style="font-size:11px;font-weight:700;color:#38bdf8;display:block;margin-bottom:3px;">1. Telegram Bot Token (from @BotFather)</label>
        <input type="text" id="input-tg-bot-token" style="width:100%;background:#10101c;border:1px solid #2d2d45;border-radius:6px;color:#e2e8f0;padding:6px 8px;font-size:11px;" value="8886391655:AAGzveDdUEtAmPe08Ym-C1k7mZXaQ70iwgM" placeholder="e.g. 123456789:ABCdefGHIjklMNOpqrSTUvwxYZ" />
      </div>
      <div>
        <label style="font-size:11px;font-weight:700;color:#38bdf8;display:block;margin-bottom:3px;">2. Target Channel / Chat ID</label>
        <input type="text" id="input-tg-chat-id" style="width:100%;background:#10101c;border:1px solid #2d2d45;border-radius:6px;color:#e2e8f0;padding:6px 8px;font-size:11px;" value="@OtakuDriveHQ" placeholder="e.g. @MyChannel or -1001234567890" />
      </div>
      <div>
        <label style="font-size:11px;font-weight:700;color:#38bdf8;display:block;margin-bottom:3px;">3. Bot Username (for Season deep-link buttons)</label>
        <div style="display:flex;gap:6px;">
          <input type="text" id="input-tg-bot-username" style="flex:1;background:#10101c;border:1px solid #2d2d45;border-radius:6px;color:#e2e8f0;padding:6px 8px;font-size:11px;" value="@OtakuDriveBot" placeholder="e.g. @MyGdflixBot" />
          <button class="btn-custom-ck" style="background:#4f46e5;white-space:nowrap;" onclick="autoDetectBotUsername(this)">🔍 Auto-Detect</button>
        </div>
      </div>
    </div>
    <div class="drawer-actions" style="flex-wrap:wrap;gap:8px;">
      <button class="btn-save-ck" style="background:#0284c7;" onclick="saveTelegramConfig()">💾 Save Settings</button>
      <button class="btn-save-ck" style="background:#7c3aed;" onclick="setupTelegramWebhook(this)">🔗 Link Webhook to Worker</button>
      <button class="btn-save-ck" style="background:#334155;" onclick="checkWebhookInfo(this)">ℹ️ Webhook Info</button>
      <button class="btn-save-ck" style="background:#16a34a;" onclick="testTelegramPost(this)">🔔 Test Channel Ping</button>
    </div>
    <div id="tg-status-msg" style="margin-top:8px;font-size:12px;font-weight:700;display:none;"></div>

    <div class="tg-info-box">
      <b>🚀 How the Channel &amp; Bot Workflow Works:</b><br>
      • <b>Post on Telegram:</b> Posts poster thumbnail, post title, details &amp; synopsis with clickable <code>📁 Season</code> buttons.<br>
      • <b>Interactive Bot:</b> When users click a Season button, the bot opens with the <b>list of episodes</b> &rarr; user selects an episode &rarr; bot shows <b>available qualities</b> &rarr; user selects quality &rarr; bot generates the <b>GDFlix download link</b>!<br>
      • <b>⏳ 30-Minute Self-Destruct:</b> All bot messages and user prompts in the private bot conversation are automatically deleted after 30 minutes!
    </div>
  </div>

  <div class="drawer" id="custom-ck-drawer">
    <h3>🍪 24-Hour Access Cookies Manager</h3>
    <p>Directly paste your <code>cf_clearance</code> and <code>user</code> cookie values from Chrome Mobile to unlock direct platform links without any shorteners:</p>
    <div style="display:flex;flex-direction:column;gap:8px;margin-top:6px;">
      <div>
        <label style="font-size:11px;font-weight:700;color:#38bdf8;display:block;margin-bottom:3px;">1. cf_clearance Cookie</label>
        <textarea id="input-cf-clearance" style="height:60px;font-size:11px;" placeholder="Paste cf_clearance token..."></textarea>
      </div>
      <div>
        <label style="font-size:11px;font-weight:700;color:#38bdf8;display:block;margin-bottom:3px;">2. user Cookie (24-Hour Access Token)</label>
        <textarea id="input-user-cookie" style="height:70px;font-size:11px;" placeholder="Paste user cookie token..."></textarea>
      </div>
      <div>
        <label style="font-size:11px;font-weight:700;color:#94a3b8;display:block;margin-bottom:3px;">3. Expiry Timestamp (Optional)</label>
        <input type="text" id="input-expiry" style="width:100%;background:#10101c;border:1px solid #2d2d45;border-radius:6px;color:#e2e8f0;padding:6px 8px;font-size:11px;" placeholder="e.g. 1791010525521" />
      </div>
    </div>
    <div class="drawer-actions">
      <button class="btn-save-ck" onclick="saveCustomCookies()">Save &amp; Apply 24h Cookies</button>
      <button class="btn-clear-ck" onclick="document.getElementById('input-cf-clearance').value='';document.getElementById('input-user-cookie').value='';saveCustomCookies();">Clear</button>
    </div>
    <div id="save-status-msg" style="margin-top:8px;font-size:12px;font-weight:700;display:none;"></div>
  </div>

  <div class="drawer" id="ck-panel">
    <table class="ck-table">
      <thead>
        <tr><th>Name</th><th>Domain</th><th>Value</th><th>Expires</th><th>Status</th></tr>
      </thead>
      <tbody>${cookieRows}</tbody>
    </table>
  </div>
</div>

${search ? `
<div class="search-banner">
  <span>🔍 Found <b>${total.toLocaleString()}</b> post${total === 1 ? '' : 's'} matching <b>"${escapeHtml(search)}"</b></span>
  <a href="/posts?format=html" class="btn-clear-search-link">✕ Clear Search</a>
</div>
` : ""}

<div class="pagebar">
  <span>Showing ${posts.length} of ${total} posts</span>
  ${prevHref ? `<a href="${prevHref}">&larr; Prev</a>` : ""}
  <span>Page ${page} / ${totalPages}</span>
  ${nextHref ? `<a href="${nextHref}">Next &rarr;</a>` : ""}
</div>

<div class="list">
  ${cards.length > 0 ? cards : `
    <div class="no-posts-card">
      <div style="font-size:2.2rem;margin-bottom:10px">🔍</div>
      <h3 style="color:#fff;margin-bottom:6px">No posts found matching "${escapeHtml(search)}"</h3>
      <p style="color:#94a3b8;font-size:12px;margin-bottom:14px">Try searching with a shorter title keyword or check spelling.</p>
      <a href="/posts?format=html" class="btn-custom-ck" style="background:#7c3aed;text-decoration:none;display:inline-block">Show All Posts</a>
    </div>
  `}
</div>

<div class="pagebar" style="border-top:1px solid #2a2a40;border-bottom:none">
  ${prevHref ? `<a href="${prevHref}">&larr; Prev</a>` : ""}
  <span>Page ${page} / ${totalPages}</span>
  ${nextHref ? `<a href="${nextHref}">Next &rarr;</a>` : ""}
</div>

<script>${scriptBody}<\/script>
</body>
</html>`;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
function errorResponse(status, message) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
