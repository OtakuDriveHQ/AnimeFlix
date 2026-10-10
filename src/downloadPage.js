/**
 * downloadPage.js
 *
 * Public episode download landing page opened from the Telegram bot.
 * Displays episode details (title, season, episode, quality, size, poster)
 * and generates the fresh direct download link on demand when the user clicks.
 */

import { extractInstantDownloadLink, extractHubcloudDownloadLink, escapeHtml } from "./telegram.js";

/**
 * Main router for public /d/* routes.
 *
 * Routes handled:
 *  - GET  /d/:token           -> HTML landing page with episode details & download button
 *  - POST /d/:token/generate  -> AJAX endpoint to extract the fresh direct video link
 *  - GET  /d/:token/extract   -> Same as /generate (GET alias)
 *  - GET  /d/:token/download  -> Direct 302 redirect to the final video URL
 */
export async function handleDownloadPage(request, env, url) {
  const parts = url.pathname.split("/").filter(Boolean); // ['d', '<token>', ...]
  const token = parts[1];

  if (!token) {
    return errorHtmlResponse("Invalid Request", "No download token was provided.", 400);
  }

  // 1. Load download info from BOT_KV
  let dlInfo = null;
  if (env?.BOT_KV) {
    try {
      dlInfo = await env.BOT_KV.get("dl:" + token, "json");
    } catch (e) {
      console.warn("Failed to fetch dlInfo from KV:", e.message);
    }
  }

  if (!dlInfo || (!dlInfo.gdflixUrl && !dlInfo.hubcloudUrl)) {
    return errorHtmlResponse(
      "Download Link Expired",
      "This download session has expired or is no longer available. Please choose your episode and quality again in the Telegram bot.",
      404
    );
  }

  const action = parts[2]; // 'generate', 'extract', 'download', or undefined

  // 2. Action: Extract direct link on demand (AJAX)
  if (action === "generate" || action === "extract") {
    const primaryUrl = dlInfo.gdflixUrl || dlInfo.hubcloudUrl;
    const fallbackMirror = dlInfo.gdflixUrl || dlInfo.hubcloudUrl;
    const cacheKey = "cache_link:" + primaryUrl;

    // Fast check: return from KV cache if generated in the last hour
    if (env?.BOT_KV) {
      try {
        const cached = await env.BOT_KV.get(cacheKey);
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
      if (dlInfo.gdflixUrl) {
        directUrl = await extractInstantDownloadLink(dlInfo.gdflixUrl, dlInfo.hubcloudUrl);
      }
      if (!directUrl && dlInfo.hubcloudUrl) {
        directUrl = await extractHubcloudDownloadLink(dlInfo.hubcloudUrl);
      }

      if (directUrl && /^https?:\/\//i.test(directUrl)) {
        // Cache in KV for 1 hour
        if (env?.BOT_KV) {
          env.BOT_KV.put(cacheKey, directUrl, { expirationTtl: 3600 }).catch(() => {});
        }
        return jsonResponse({
          ok: true,
          directUrl,
          title: dlInfo.title,
          episode: dlInfo.episode,
          quality: dlInfo.quality,
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

  // 3. Action: Direct 302 redirect
  if (action === "download") {
    try {
      const directUrl = await extractInstantDownloadLink(dlInfo.gdflixUrl);
      if (directUrl && /^https?:\/\//i.test(directUrl)) {
        return new Response(null, {
          status: 302,
          headers: { Location: directUrl },
        });
      }
    } catch (e) {}
    // Fallback redirect to GDFlix page
    return new Response(null, {
      status: 302,
      headers: { Location: dlInfo.gdflixUrl },
    });
  }

  // 4. Default: Render the beautiful download page HTML
  return renderDownloadHtml(token, dlInfo, url.origin);
}

/**
 * Render the full HTML page with episode metadata, thumbnail, and interactive download button.
 */
function renderDownloadHtml(token, info, origin) {
  const title = escapeHtml(info.title || "Episode Download");
  const season = escapeHtml(info.season || "");
  const episode = escapeHtml(info.episode || "");
  const quality = escapeHtml(info.quality || "HD");
  const size = escapeHtml(info.size || "");
  const thumbnail = info.thumbnail ? escapeHtml(info.thumbnail) : "";
  const gdflixUrl = escapeHtml(info.gdflixUrl || "https://gdflix.dev");

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
      --card-bg: rgba(20, 24, 35, 0.85);
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
    /* Subtle background ambient lights */
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
      margin-bottom: 1.5rem;
    }
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 0.35rem;
      background: var(--badge-bg);
      border: 1px solid rgba(255, 255, 255, 0.08);
      padding: 0.4rem 0.75rem;
      border-radius: 10px;
      font-size: 0.8rem;
      font-weight: 600;
      color: #e5e7eb;
    }
    .badge-quality {
      background: rgba(246, 130, 31, 0.15);
      border-color: rgba(246, 130, 31, 0.3);
      color: var(--primary);
    }
    .notice {
      background: rgba(255, 255, 255, 0.03);
      border: 1px dashed rgba(255, 255, 255, 0.12);
      border-radius: 14px;
      padding: 0.85rem 1rem;
      font-size: 0.82rem;
      color: var(--text-muted);
      margin-bottom: 1.75rem;
      line-height: 1.45;
    }
    .notice strong { color: #fff; }
    .btn {
      width: 100%;
      padding: 1rem 1.5rem;
      border-radius: 16px;
      border: none;
      font-family: inherit;
      font-size: 1.05rem;
      font-weight: 700;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 0.6rem;
      text-decoration: none;
      transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
      position: relative;
      user-select: none;
    }
    .btn-primary {
      background: linear-gradient(135deg, #f6821f 0%, #ea580c 100%);
      color: #fff;
      box-shadow: 0 10px 25px var(--primary-glow);
    }
    .btn-primary:hover:not(:disabled) {
      background: linear-gradient(135deg, #ea580c 0%, #c2410c 100%);
      transform: translateY(-2px);
      box-shadow: 0 14px 30px var(--primary-glow);
    }
    .btn-primary:active:not(:disabled) {
      transform: translateY(0);
    }
    .btn-primary:disabled {
      opacity: 0.75;
      cursor: wait;
    }
    .btn-success {
      background: linear-gradient(135deg, #10b981 0%, #059669 100%);
      color: #fff;
      box-shadow: 0 10px 25px var(--success-glow);
      margin-bottom: 0.75rem;
    }
    .btn-success:hover {
      background: linear-gradient(135deg, #059669 0%, #047857 100%);
      transform: translateY(-2px);
      box-shadow: 0 14px 30px var(--success-glow);
    }
    .btn-secondary {
      background: rgba(255, 255, 255, 0.06);
      border: 1px solid rgba(255, 255, 255, 0.1);
      color: #e5e7eb;
      font-size: 0.9rem;
      padding: 0.75rem 1rem;
      border-radius: 12px;
      margin-top: 0.75rem;
    }
    .btn-secondary:hover {
      background: rgba(255, 255, 255, 0.1);
      color: #fff;
    }
    .spinner {
      width: 20px;
      height: 20px;
      border: 3px solid rgba(255, 255, 255, 0.3);
      border-top-color: #fff;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
      display: inline-block;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    .status-area {
      margin-top: 1.25rem;
      padding: 1rem;
      border-radius: 14px;
      background: rgba(0, 0, 0, 0.35);
      border: 1px solid rgba(255, 255, 255, 0.05);
      display: none;
      animation: fadeIn 0.3s ease-out;
    }
    .status-text {
      font-size: 0.88rem;
      color: #e5e7eb;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 0.5rem;
    }
    .auto-notice {
      font-size: 0.78rem;
      color: #6ee7b7;
      margin-top: 0.5rem;
    }
    .error-box {
      background: rgba(239, 68, 68, 0.12);
      border: 1px solid rgba(239, 68, 68, 0.3);
      color: #fca5a5;
      padding: 0.85rem 1rem;
      border-radius: 12px;
      font-size: 0.85rem;
      margin-top: 1rem;
      display: none;
      line-height: 1.4;
    }
    .footer {
      margin-top: 2rem;
      text-align: center;
      font-size: 0.78rem;
      color: #6b7280;
    }
  </style>
</head>
<body>
  <div class="wrapper">
    <div class="card">
      ${thumbnail ? `<div class="poster-wrap"><img src="${thumbnail}" alt="${title}" class="poster-img" onerror="this.parentElement.style.display='none'"></div>` : ""}

      <h1 class="title">${title}</h1>
      <div class="sub-meta">${season ? season + " • " : ""}${episode || "Episode"}</div>

      <div class="badges-row">
        <span class="badge badge-quality">🎥 ${quality}</span>
        ${size ? `<span class="badge">💾 ${size}</span>` : ""}
        <span class="badge">⚡ Google High Speed CDN</span>
      </div>

      <div class="notice">
        ⚡ <strong>Fresh Link Generation:</strong><br>
        Click the button below to generate a fresh direct download link.
      </div>

      <button id="btnMain" class="btn btn-primary" onclick="generateLink()">
        <span>🚀 Generate Download Link</span>
      </button>

      <div id="statusBox" class="status-area">
        <div id="statusText" class="status-text">
          <span class="spinner"></span>
          <span>Resolving high-speed download link...</span>
        </div>
        <div id="autoNotice" class="auto-notice" style="display:none;">
          ⬇️ Download starting automatically...
        </div>
      </div>

      <div id="successArea" style="display:none; margin-top:1.25rem;">
        <a id="btnDirect" class="btn btn-success" href="#" target="_blank" download>
          <span>⬇️ Click to Download (${quality})</span>
        </a>
        <button class="btn btn-secondary" onclick="copyLink()">
          <span>📋 Copy Download Link</span>
        </button>
      </div>

      <div id="errorBox" class="error-box"></div>

      <a id="btnFallback" href="${gdflixUrl}" target="_blank" rel="noopener noreferrer" class="btn btn-secondary" style="display:none;">
        <span>🔗 Open GDFlix Mirror Page</span>
      </a>
    </div>

    <div class="footer">
      GDFlix Downloader • Links expire in 3 hours once generated
    </div>
  </div>

  <script>
    const token = ${JSON.stringify(token)};
    let directDownloadUrl = "";
    let prewarmPromise = null;
    let prewarmResult = null;

    // Automatic pre-warm in the background when the user opens the page
    function initPrewarm() {
      prewarmPromise = fetch("/d/" + token + "/generate", {
        method: "POST",
        headers: { "Accept": "application/json" }
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
        }
        return data;
      })
      .catch(() => null);
    }
    setTimeout(initPrewarm, 150);

    async function generateLink() {
      const btn = document.getElementById("btnMain");
      const statusBox = document.getElementById("statusBox");
      const statusText = document.getElementById("statusText");
      const autoNotice = document.getElementById("autoNotice");
      const successArea = document.getElementById("successArea");
      const btnDirect = document.getElementById("btnDirect");
      const errorBox = document.getElementById("errorBox");
      const btnFallback = document.getElementById("btnFallback");

      // 1. Instant path: already resolved by background prewarm
      if (prewarmResult && prewarmResult.directUrl) {
        directDownloadUrl = prewarmResult.directUrl;
        btn.style.display = "none";
        statusBox.style.display = "block";
        statusText.innerHTML = "✅ <b>Direct Link Ready!</b>";
        autoNotice.style.display = "block";
        btnDirect.href = directDownloadUrl;
        successArea.style.display = "block";
        setTimeout(() => {
          try { window.location.href = directDownloadUrl; } catch (e) {}
        }, 300);
        return;
      }

      // 2. Loading state
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner"></span><span>Connecting to CDN...</span>';
      statusBox.style.display = "block";
      if (errorBox) errorBox.style.display = "none";
      statusText.innerHTML = '<span class="spinner"></span><span>Extracting direct Google CDN link...</span>';

      try {
        let data = null;

        if (prewarmPromise) {
          data = await prewarmPromise;
        }

        if (!data || !data.ok || !data.directUrl) {
          const resp = await fetch("/d/" + token + "/generate", {
            method: "POST",
            headers: { "Accept": "application/json" }
          });
          data = await resp.json();
        }

        if (data && data.ok && data.directUrl) {
          directDownloadUrl = data.directUrl;
          btn.style.display = "none";
          statusText.innerHTML = "✅ <b>Direct Link Ready!</b>";
          autoNotice.style.display = "block";

          btnDirect.href = directDownloadUrl;
          successArea.style.display = "block";

          setTimeout(() => {
            try { window.location.href = directDownloadUrl; } catch (e) {}
          }, 350);
          return;
        }

        throw new Error((data && data.error) || "Could not automatically resolve direct Google CDN link. You can open the GDFlix mirror directly.");

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

/**
 * Return an error HTML page.
 */
function errorHtmlResponse(title, message, status = 404) {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
  <style>
    body {
      background: #090a0f;
      color: #f3f4f6;
      font-family: system-ui, -apple-system, sans-serif;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 1.5rem;
      margin: 0;
    }
    .card {
      background: #141823;
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 20px;
      padding: 2.25rem 1.75rem;
      max-width: 440px;
      width: 100%;
      text-align: center;
      box-shadow: 0 20px 40px rgba(0,0,0,0.5);
    }
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
