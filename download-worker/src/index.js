/**
 * download-worker/src/index.js
 *
 * Dedicated standalone Cloudflare Worker for Episode Download Landing Page & Direct Link Generation.
 *
 * Receives episode details from Telegram:
 *  - Via URL payload:  /d?p=<base64_json> (Stateless, zero-database dependency)
 *  - Via Token in KV:  /d/:token (Fallback if using shared KV)
 *
 * Actions:
 *  - GET  /d           -> Beautiful dark UI with episode details & Instant Download button
 *  - POST /d/generate  -> AJAX endpoint returning the fresh direct Google CDN video link
 *  - GET  /health      -> Health check
 */

import { extractInstantDownloadLink, extractHubcloudDownloadLink, escapeHtml } from "./extractor.js";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Health check
    if (url.pathname === "/health" || url.pathname === "/ping") {
      return jsonResponse({ status: "ok", worker: "download-page", timestamp: Date.now() });
    }

    if (url.pathname === "/debug") {
      const target = url.searchParams.get("url") || "https://new4.gdflix.io/file/ludxx9ErRhg3zSD";
      const direct = await extractInstantDownloadLink(target);
      return jsonResponse({ target, direct });
    }

    // Default redirect to home/info
    if (url.pathname === "/") {
      return new Response("GDFlix Download Worker is active.", {
        status: 200,
        headers: { "Content-Type": "text/plain" },
      });
    }

    // Route: /d or /d/*
    if (url.pathname === "/d" || url.pathname.startsWith("/d/")) {
      return handleDownloadPage(request, env, url);
    }

    return new Response("Not Found", { status: 404 });
  },
};

/**
 * Handle download landing page and extraction API.
 */
async function handleDownloadPage(request, env, url) {
  const parts = url.pathname.split("/").filter(Boolean); // ['d', ...]
  const pParam = url.searchParams.get("p") || url.searchParams.get("data");
  let token = parts[1]; // may be token or 'generate' or undefined
  let action = parts[2];

  if (parts[1] === "generate" || parts[1] === "extract") {
    action = parts[1];
    token = null;
  }

  // 1. Resolve episode download info
  let dlInfo = null;

  // A. Check compact URL payload (Stateless, highest priority)
  if (pParam) {
    dlInfo = decodePayload(pParam);
  }

  // B. Check shared KV if token provided
  if (!dlInfo && token && env?.DOWNLOAD_KV) {
    try {
      dlInfo = await env.DOWNLOAD_KV.get("dl:" + token, "json");
    } catch (e) {}
  }

  // C. Check POST body if generating
  let bodyData = null;
  if (request.method === "POST") {
    try {
      bodyData = await request.clone().json().catch(() => ({}));
      if (bodyData.p && !dlInfo) dlInfo = decodePayload(bodyData.p);
    } catch (e) {}
  }

  // C. Check POST body if generating
  if (!dlInfo || (!dlInfo.gdflixUrl && !dlInfo.hubcloudUrl)) {
    if (bodyData && (bodyData.gdflixUrl || bodyData.hubcloudUrl)) {
      dlInfo = {
        title: bodyData.title || dlInfo?.title || "Episode",
        season: bodyData.season || dlInfo?.season || "",
        episode: bodyData.episode || dlInfo?.episode || "",
        quality: bodyData.quality || dlInfo?.quality || "HD",
        size: bodyData.size || dlInfo?.size || "",
        thumbnail: bodyData.thumbnail || dlInfo?.thumbnail || "",
        gdflixUrl: bodyData.gdflixUrl || dlInfo?.gdflixUrl || "",
        hubcloudUrl: bodyData.hubcloudUrl || dlInfo?.hubcloudUrl || "",
      };
    }
  }

  // 2. Action: Extract direct link on demand (AJAX)
  if (action === "generate" || action === "extract" || (request.method === "POST" && (action === "generate" || parts[1] === "generate"))) {
    if (!dlInfo || (!dlInfo.gdflixUrl && !dlInfo.hubcloudUrl)) {
      return jsonResponse({ ok: false, error: "Missing GDFlix or HubCloud URL or session data." }, 400);
    }

    const platform = (bodyData?.platform || url.searchParams.get("platform") || "").toLowerCase();
    const primaryUrl = platform === "hubcloud" ? (dlInfo.hubcloudUrl || dlInfo.gdflixUrl) : (dlInfo.gdflixUrl || dlInfo.hubcloudUrl);
    const fallbackMirror = dlInfo.gdflixUrl || dlInfo.hubcloudUrl;
    const cacheKey = "cache_link:" + primaryUrl;

    // Fast cache check in KV
    if (env?.DOWNLOAD_KV) {
      try {
        const cached = await env.DOWNLOAD_KV.get(cacheKey);
        if (cached && /^https?:\/\//i.test(cached)) {
          return jsonResponse({
            ok: true,
            directUrl: cached,
            title: dlInfo.title,
            episode: dlInfo.episode,
            quality: dlInfo.quality,
            cached: true,
          });
        }
      } catch (e) {}
    }

    try {
      let directUrl = null;
      let usedPlatform = "gdflix";

      if (platform === "hubcloud" && dlInfo.hubcloudUrl) {
        directUrl = await extractHubcloudDownloadLink(dlInfo.hubcloudUrl);
        usedPlatform = "hubcloud";
      } else {
        // Try GDFlix first
        if (dlInfo.gdflixUrl) {
          directUrl = await extractInstantDownloadLink(dlInfo.gdflixUrl, dlInfo.hubcloudUrl);
          usedPlatform = "gdflix";
        }
        // If GDFlix extraction failed or wasn't provided, try HubCloud
        if (!directUrl && dlInfo.hubcloudUrl) {
          directUrl = await extractHubcloudDownloadLink(dlInfo.hubcloudUrl);
          usedPlatform = "hubcloud";
        }
      }

      if (directUrl && /^https?:\/\//i.test(directUrl)) {
        if (env?.DOWNLOAD_KV) {
          env.DOWNLOAD_KV.put(cacheKey, directUrl, { expirationTtl: 3600 }).catch(() => {});
        }
        return jsonResponse({
          ok: true,
          directUrl,
          title: dlInfo.title,
          episode: dlInfo.episode,
          quality: dlInfo.quality,
          platform: usedPlatform,
        });
      }

      return jsonResponse({
        ok: false,
        fallbackUrl: fallbackMirror,
        error: "Could not automatically resolve direct Google CDN link. You can open the platform mirrors directly.",
      }, 200);
    } catch (err) {
      return jsonResponse({
        ok: false,
        fallbackUrl: fallbackMirror,
        error: err.message || "Extraction error",
      }, 500);
    }
  }

  // If no info found, show friendly expired page
  if (!dlInfo || (!dlInfo.gdflixUrl && !dlInfo.hubcloudUrl)) {
    return errorHtmlResponse(
      "Download Link Expired",
      "This download link is invalid or has expired. Please select your episode and quality again in the Telegram bot.",
      404
    );
  }

  // 3. Render HTML download landing page
  return renderDownloadHtml(dlInfo, url.origin, pParam || token || "");
}

/**
 * Decode compact URL-safe base64 payload.
 */
function decodePayload(p) {
  if (!p) return null;
  try {
    let b64 = String(p).trim().replace(/-/g, "+").replace(/_/g, "/");
    while (b64.length % 4 !== 0) {
      b64 += "=";
    }
    const jsonStr = decodeURIComponent(escape(atob(b64)));
    const data = JSON.parse(jsonStr);
    return {
      title: data.t || data.title || "",
      season: data.s || data.season || "",
      episode: data.e || data.episode || "",
      quality: data.q || data.quality || "HD",
      size: data.sz || data.size || "",
      thumbnail: data.th || data.thumbnail || "",
      gdflixUrl: data.u || data.gdflixUrl || "",
      hubcloudUrl: data.hub || data.hubcloudUrl || "",
    };
  } catch (e) {
    try {
      const data = JSON.parse(p);
      return {
        title: data.t || data.title || "",
        season: data.s || data.season || "",
        episode: data.e || data.episode || "",
        quality: data.q || data.quality || "HD",
        size: data.sz || data.size || "",
        thumbnail: data.th || data.thumbnail || "",
        gdflixUrl: data.u || data.gdflixUrl || "",
        hubcloudUrl: data.hub || data.hubcloudUrl || "",
      };
    } catch (e2) {
      return null;
    }
  }
}

/**
 * Render the full download landing page HTML.
 */
function renderDownloadHtml(info, origin, stateKey) {
  const title = escapeHtml(info.title || "Episode Download");
  const season = escapeHtml(info.season || "");
  const episode = escapeHtml(info.episode || "");
  const quality = escapeHtml(info.quality || "HD");
  const size = escapeHtml(info.size || "");
  const thumbnail = info.thumbnail ? escapeHtml(info.thumbnail) : "";
  const gdflixUrl = escapeHtml(info.gdflixUrl || "");
  const hubcloudUrl = escapeHtml(info.hubcloudUrl || "");

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} - ${episode} (${quality}) | Direct Download</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #090a0f;
      --card-bg: rgba(20, 24, 35, 0.88);
      --card-border: rgba(255, 255, 255, 0.08);
      --primary: #f6821f;
      --primary-hover: #e07010;
      --primary-glow: rgba(246, 130, 31, 0.35);
      --success: #10b981;
      --success-hover: #059669;
      --success-glow: rgba(16, 185, 129, 0.35);
      --text: #f3f4f6;
      --text-muted: #9ca3af;
      --badge-bg: rgba(255, 255, 255, 0.06);
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Plus Jakarta Sans', system-ui, -apple-system, sans-serif;
      background: var(--bg);
      color: var(--text);
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 1.25rem;
      position: relative;
      overflow-x: hidden;
    }
    body::before {
      content: '';
      position: fixed;
      top: -20%;
      left: 20%;
      width: 600px;
      height: 600px;
      background: radial-gradient(circle, rgba(246, 130, 31, 0.15) 0%, transparent 70%);
      pointer-events: none;
      z-index: 0;
    }
    body::after {
      content: '';
      position: fixed;
      bottom: -20%;
      right: 20%;
      width: 600px;
      height: 600px;
      background: radial-gradient(circle, rgba(59, 130, 246, 0.12) 0%, transparent 70%);
      pointer-events: none;
      z-index: 0;
    }
    .wrapper {
      position: relative;
      z-index: 1;
      width: 100%;
      max-width: 520px;
    }
    .card {
      background: var(--card-bg);
      backdrop-filter: blur(20px);
      -webkit-backdrop-filter: blur(20px);
      border: 1px solid var(--card-border);
      border-radius: 24px;
      padding: 2rem 1.75rem;
      box-shadow: 0 20px 50px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(255, 255, 255, 0.04);
      text-align: center;
      animation: fadeIn 0.4s ease-out;
    }
    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(12px); }
      to { opacity: 1; transform: translateY(0); }
    }
    .poster-wrap {
      width: 100%;
      max-height: 220px;
      border-radius: 16px;
      overflow: hidden;
      margin-bottom: 1.25rem;
      box-shadow: 0 10px 25px rgba(0,0,0,0.4);
      background: #111;
      position: relative;
    }
    .poster-img {
      width: 100%;
      height: 100%;
      max-height: 220px;
      object-fit: cover;
      display: block;
    }
    .title {
      font-size: 1.35rem;
      font-weight: 800;
      color: #fff;
      line-height: 1.35;
      margin-bottom: 0.5rem;
      word-break: break-word;
    }
    .sub-meta {
      font-size: 0.95rem;
      color: var(--primary);
      font-weight: 600;
      margin-bottom: 1.25rem;
    }
    .badges-row {
      display: flex;
      flex-wrap: wrap;
      justify-content: center;
      gap: 0.5rem;
      margin-bottom: 1.75rem;
    }
    .badge {
      background: var(--badge-bg);
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 10px;
      padding: 0.4rem 0.85rem;
      font-size: 0.8rem;
      font-weight: 600;
      color: #e5e7eb;
      display: inline-flex;
      align-items: center;
      gap: 0.35rem;
    }
    .badge.highlight {
      background: rgba(246, 130, 31, 0.15);
      border-color: rgba(246, 130, 31, 0.3);
      color: #fb923c;
    }
    .btn-main {
      width: 100%;
      background: linear-gradient(135deg, var(--primary) 0%, #ea580c 100%);
      color: #fff;
      border: none;
      border-radius: 14px;
      padding: 1rem 1.5rem;
      font-size: 1.05rem;
      font-weight: 700;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 0.6rem;
      box-shadow: 0 8px 20px var(--primary-glow);
      transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
      position: relative;
      overflow: hidden;
    }
    .btn-main:hover {
      background: linear-gradient(135deg, #fb923c 0%, #ea580c 100%);
      transform: translateY(-2px);
      box-shadow: 0 12px 28px var(--primary-glow);
    }
    .btn-main:active { transform: translateY(0); }
    .btn-main:disabled {
      opacity: 0.7;
      cursor: not-allowed;
      transform: none;
    }
    .status-box {
      margin-top: 1.25rem;
      padding: 1rem;
      border-radius: 12px;
      background: rgba(16, 185, 129, 0.1);
      border: 1px solid rgba(16, 185, 129, 0.25);
      font-size: 0.9rem;
      color: #34d399;
      display: none;
    }
    .error-box {
      margin-top: 1.25rem;
      padding: 1rem;
      border-radius: 12px;
      background: rgba(239, 68, 68, 0.1);
      border: 1px solid rgba(239, 68, 68, 0.25);
      font-size: 0.9rem;
      color: #f87171;
      display: none;
    }
    .actions-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 0.75rem;
      margin-top: 1rem;
    }
    .btn-secondary {
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid rgba(255, 255, 255, 0.1);
      color: #e5e7eb;
      border-radius: 10px;
      padding: 0.75rem 1rem;
      font-size: 0.85rem;
      font-weight: 600;
      text-decoration: none;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 0.4rem;
      cursor: pointer;
      transition: all 0.15s ease;
    }
    .btn-secondary:hover {
      background: rgba(255, 255, 255, 0.1);
      color: #fff;
    }
    .btn-direct-download {
      background: linear-gradient(135deg, var(--success) 0%, #059669 100%);
      color: #fff;
      border: none;
      border-radius: 14px;
      padding: 1rem 1.5rem;
      font-size: 1.05rem;
      font-weight: 700;
      text-decoration: none;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 0.6rem;
      box-shadow: 0 8px 20px var(--success-glow);
      width: 100%;
      margin-top: 0.75rem;
      transition: all 0.2s ease;
    }
    .btn-direct-download:hover {
      transform: translateY(-2px);
      box-shadow: 0 12px 28px var(--success-glow);
    }
    .spinner {
      width: 18px;
      height: 18px;
      border: 2px solid rgba(255, 255, 255, 0.3);
      border-top-color: #fff;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
      display: inline-block;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    .auto-notice {
      font-size: 0.8rem;
      color: var(--text-muted);
      margin-top: 0.5rem;
    }
    .footer {
      margin-top: 1.5rem;
      font-size: 0.75rem;
      color: #6b7280;
    }
  </style>
</head>
<body>
  <div class="wrapper">
    <div class="card">
      ${thumbnail ? `
      <div class="poster-wrap">
        <img class="poster-img" src="${thumbnail}" alt="${title}" loading="lazy">
      </div>` : ''}

      <h1 class="title">${title}</h1>
      <div class="sub-meta">${season ? season + ' • ' : ''}${episode}</div>

      <div class="badges-row">
        <div class="badge highlight">🎬 ${quality}</div>
        ${size ? `<div class="badge">💾 ${size}</div>` : ''}
        <div class="badge">⚡ High Speed</div>
      </div>

      <button id="btnMain" class="btn-main" onclick="generateLink()">
        <span>⚡ Instant Download</span>
      </button>

      <div id="statusBox" class="status-box">
        <div id="statusText"><span class="spinner"></span> Extracting direct link...</div>
        <div id="autoNotice" class="auto-notice" style="display:none;">Your download will begin automatically.</div>
      </div>

      <div id="errorBox" class="error-box"></div>

      <div id="successArea" style="display:none;">
        <a id="btnDirect" class="btn-direct-download" href="#" target="_blank" rel="noopener">
          <span>⬇️ Download Now (Google CDN)</span>
        </a>
        <div class="actions-grid">
          <button class="btn-secondary" onclick="copyLink()">📋 Copy Link</button>
          ${gdflixUrl ? `<a class="btn-secondary" href="${gdflixUrl}" target="_blank" rel="noopener">⚡ GDFlix Mirror</a>` : ''}
          ${hubcloudUrl ? `<a class="btn-secondary" href="${hubcloudUrl}" target="_blank" rel="noopener">☁️ HubCloud Mirror</a>` : ''}
        </div>
      </div>

      <div class="actions-grid" style="margin-top: 1rem;">
        ${gdflixUrl ? `<a id="btnFallback" class="btn-secondary" href="${gdflixUrl}" target="_blank" rel="noopener" style="display:none;">🌐 GDFlix Mirror</a>` : ''}
        ${hubcloudUrl ? `<a id="btnFallbackHub" class="btn-secondary" href="${hubcloudUrl}" target="_blank" rel="noopener" style="display:none;">☁️ HubCloud Mirror</a>` : ''}
      </div>

      <div class="footer">
        Powered by GDFlix &amp; HubCloud High-Speed Cloud
      </div>
    </div>
  </div>

  <script>
    const gdflixMirrorUrl = ${JSON.stringify(info.gdflixUrl || "")};
    const hubcloudMirrorUrl = ${JSON.stringify(info.hubcloudUrl || "")};
    const stateKey = ${JSON.stringify(stateKey)};
    let directDownloadUrl = null;
    let prewarmPromise = null;
    let prewarmResult = null;

    // Background prewarm on page load
    function initPrewarm() {
      prewarmPromise = fetch("/d/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Accept": "application/json" },
        body: JSON.stringify({ p: stateKey, gdflixUrl: gdflixMirrorUrl, hubcloudUrl: hubcloudMirrorUrl })
      })
      .then(r => r.json())
      .then(data => {
        if (data && data.ok && data.directUrl) {
          prewarmResult = data;
          const btn = document.getElementById("btnMain");
          if (btn && !btn.disabled) {
            btn.innerHTML = '<span>⚡ Instant Download Ready</span>';
            btn.style.boxShadow = '0 10px 25px rgba(16, 185, 129, 0.45)';
          }
          return data;
        }
        prewarmPromise = null;
        return null;
      })
      .catch(() => {
        prewarmPromise = null;
        return null;
      });
    }
    setTimeout(initPrewarm, 100);

    function showSuccess(url, platform) {
      directDownloadUrl = url;
      const btn = document.getElementById("btnMain");
      const statusBox = document.getElementById("statusBox");
      const statusText = document.getElementById("statusText");
      const autoNotice = document.getElementById("autoNotice");
      const successArea = document.getElementById("successArea");
      const btnDirect = document.getElementById("btnDirect");
      const errorBox = document.getElementById("errorBox");

      btn.style.display = "none";
      if (errorBox) errorBox.style.display = "none";
      statusBox.style.display = "block";
      var tag = platform === "hubcloud" ? " (via HubCloud)" : (platform === "gdflix" ? " (via GDFlix)" : "");
      statusText.innerHTML = "✅ <b>Direct Link Ready!" + tag + "</b>";
      autoNotice.style.display = "block";
      btnDirect.href = directDownloadUrl;
      successArea.style.display = "block";

      setTimeout(() => {
        try { window.location.href = directDownloadUrl; } catch (e) {}
      }, 350);
    }

    async function generateLink() {
      const btn = document.getElementById("btnMain");
      const statusBox = document.getElementById("statusBox");
      const statusText = document.getElementById("statusText");
      const errorBox = document.getElementById("errorBox");
      const btnFallback = document.getElementById("btnFallback");

      // 1. If prewarm already completed successfully
      if (prewarmResult && prewarmResult.directUrl) {
        showSuccess(prewarmResult.directUrl);
        return;
      }

      btn.disabled = true;
      btn.innerHTML = '<span class="spinner"></span><span>Connecting to CDN...</span>';
      statusBox.style.display = "block";
      if (errorBox) errorBox.style.display = "none";
      statusText.innerHTML = '<span class="spinner"></span><span>Extracting direct Google CDN link...</span>';

      try {
        let data = null;

        // 2. If prewarm is currently in flight, wait for it
        if (prewarmPromise) {
          data = await prewarmPromise;
        }

        // 3. If prewarm returned null or wasn't ok, do a fresh fetch
        if (!data || !data.ok || !data.directUrl) {
          const resp = await fetch("/d/generate", {
            method: "POST",
            headers: { "Content-Type": "application/json", "Accept": "application/json" },
            body: JSON.stringify({ p: stateKey, gdflixUrl: gdflixMirrorUrl, hubcloudUrl: hubcloudMirrorUrl })
          });
          data = await resp.json();
        }

        if (data && data.ok && data.directUrl) {
          prewarmResult = data;
          showSuccess(data.directUrl, data.platform);
          return;
        }

        throw new Error((data && data.error) || "Could not automatically resolve direct Google CDN link. You can open the platform mirrors directly.");

      } catch (err) {
        prewarmPromise = null;
        prewarmResult = null;
        statusBox.style.display = "none";
        btn.disabled = false;
        btn.innerHTML = "<span>🔄 Retry Link Generation</span>";
        if (errorBox) {
          errorBox.textContent = err.message || "An error occurred while generating the download link.";
          errorBox.style.display = "block";
        }
        if (btnFallback) {
          btnFallback.style.display = "inline-flex";
        }
        var btnFallbackHub = document.getElementById("btnFallbackHub");
        if (btnFallbackHub) {
          btnFallbackHub.style.display = "inline-flex";
        }
      }
    }

    function copyLink() {
      if (!directDownloadUrl) return;
      navigator.clipboard.writeText(directDownloadUrl).then(() => {
        alert("✅ Download link copied to clipboard!");
      }).catch(() => {
        prompt("Copy download link:", directDownloadUrl);
      });
    }
  </script>
</body>
</html>`;

  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store, no-cache, must-revalidate",
    },
  });
}

function errorHtmlResponse(title, message, status = 404) {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
  <style>
    body { background: #090a0f; color: #f3f4f6; font-family: system-ui, sans-serif; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 1.5rem; margin: 0; }
    .card { background: #141823; border: 1px solid rgba(255,255,255,0.08); border-radius: 20px; padding: 2.25rem 1.75rem; max-width: 440px; width: 100%; text-align: center; box-shadow: 0 20px 40px rgba(0,0,0,0.5); }
    .icon { font-size: 2.5rem; margin-bottom: 1rem; }
    h1 { font-size: 1.35rem; margin-bottom: 0.75rem; color: #fff; }
    p { font-size: 0.92rem; color: #9ca3af; line-height: 1.5; margin-bottom: 1.5rem; }
    .badge { background: rgba(246,130,31,0.15); color: #f6821f; padding: 0.4rem 0.8rem; border-radius: 8px; font-size: 0.8rem; font-weight: 600; display: inline-block; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">⚠️</div>
    <h1>${escapeHtml(title)}</h1>
    <p>${escapeHtml(message)}</p>
    <div class="badge">Return to Telegram to select an episode</div>
  </div>
</body>
</html>`;

  return new Response(html, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
