/**
 * Fanart Logo Worker - Cloudflare Worker
 *
 * Searches for TV shows and retrieves HDclearlogo images from fanart.tv
 * Uses TVmaze (free, no API key) for search + direct fanart.tv scraping for logos.
 *
 * API Endpoints:
 *   GET /                        → HTML search UI
 *   GET /api/search?q=<query>    → Search for TV shows (via TVmaze)
 *   GET /api/logos?id=<tvdb_id>&name=<name> → Get HDclearlogos by TVDB ID
 *   GET /api/logos?url=<url>     → Get HDclearlogos from a fanart.tv URL
 *   GET /api/auto?q=<query>     → Search + auto-fetch logos for top result
 *   GET /api/health             → Health check
 */

import {
  searchShowsTVMaze,
  getLogosByTVDBId,
  getLogosByUrl,
  searchAndGetLogos,
} from './scraper.js';
import {
  getSavedLogo,
  saveLogo,
  getAllSavedLogos,
  deleteSavedLogo,
  normalizeShowKey,
} from './storage.js';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

function errorResponse(message, status = 400) {
  return jsonResponse({ error: true, message }, status);
}

function getSearchUI() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Fanart Logo Finder</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: linear-gradient(135deg, #0a0a1a 0%, #1a1a3e 50%, #0d0d2b 100%);
      color: #e0e0e0;
      min-height: 100vh;
    }
    .container { max-width: 1000px; margin: 0 auto; padding: 2rem; }
    header { text-align: center; padding: 3rem 0 2rem; }
    h1 {
      font-size: 2.5rem;
      background: linear-gradient(135deg, #00d4ff, #7b2ff7);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
      margin-bottom: 0.5rem;
    }
    .subtitle { color: #8888aa; font-size: 1rem; }
    .search-box { display: flex; gap: 0.75rem; margin: 2rem 0; }
    .search-box input {
      flex: 1; padding: 0.9rem 1.2rem;
      border: 2px solid #2a2a4a; border-radius: 12px;
      background: #12122a; color: #fff; font-size: 1rem;
      outline: none; transition: border-color 0.3s;
    }
    .search-box input:focus { border-color: #00d4ff; }
    .search-box button {
      padding: 0.9rem 2rem; border: none; border-radius: 12px;
      background: linear-gradient(135deg, #00d4ff, #7b2ff7);
      color: white; font-size: 1rem; font-weight: 600;
      cursor: pointer; transition: transform 0.2s, box-shadow 0.2s;
    }
    .search-box button:hover {
      transform: translateY(-1px);
      box-shadow: 0 4px 20px rgba(0, 212, 255, 0.3);
    }
    .search-box button:disabled { opacity: 0.5; cursor: not-allowed; transform: none; }
    .loading { text-align: center; padding: 3rem; display: none; }
    .loading.active { display: block; }
    .spinner {
      display: inline-block; width: 40px; height: 40px;
      border: 3px solid #2a2a4a; border-top-color: #00d4ff;
      border-radius: 50%; animation: spin 0.8s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    .results { margin-top: 1rem; }
    .result-info {
      background: #1a1a3a; border-radius: 12px; padding: 1.2rem;
      margin-bottom: 1.5rem; border: 1px solid #2a2a4a;
    }
    .result-info h3 { color: #00d4ff; margin-bottom: 0.5rem; }
    .result-info .meta { color: #8888aa; font-size: 0.9rem; }
    .result-info .note {
      margin-top: 0.5rem; padding: 0.5rem 0.8rem;
      background: #2a1a3a; border-radius: 8px;
      color: #cca0ff; font-size: 0.85rem;
    }
    .search-results-list { margin-bottom: 2rem; }
    .search-results-list h3 { color: #ccc; margin-bottom: 1rem; font-size: 1.1rem; }
    .search-result-item {
      background: #15152f; border: 1px solid #2a2a4a; border-radius: 8px;
      padding: 0.8rem 1rem; margin-bottom: 0.5rem;
      display: flex; justify-content: space-between; align-items: center;
      cursor: pointer; transition: background 0.2s, border-color 0.2s;
    }
    .search-result-item:hover { background: #1f1f45; border-color: #7b2ff7; }
    .search-result-item .name { font-weight: 500; }
    .search-result-item .info {
      display: flex; gap: 0.5rem; align-items: center;
    }
    .search-result-item .type {
      background: #2a2a5a; padding: 0.2rem 0.6rem; border-radius: 20px;
      font-size: 0.75rem; color: #00d4ff;
    }
    .search-result-item .year {
      color: #6666aa; font-size: 0.8rem;
    }
    .logos-grid {
      display: grid; grid-template-columns: repeat(auto-fill, minmax(350px, 1fr));
      gap: 1.5rem;
    }
    .logo-card {
      background: #12122a; border: 1px solid #2a2a4a; border-radius: 12px;
      overflow: hidden; transition: transform 0.2s, box-shadow 0.2s;
    }
    .logo-card:hover {
      transform: translateY(-3px);
      box-shadow: 0 8px 30px rgba(0, 0, 0, 0.3);
    }
    .logo-preview {
      background: repeating-conic-gradient(#1a1a3a 0% 25%, #15152f 0% 50%) 50% / 20px 20px;
      padding: 1.5rem; display: flex; align-items: center;
      justify-content: center; min-height: 120px;
    }
    .logo-preview img { max-width: 100%; max-height: 150px; object-fit: contain; }
    .logo-info { padding: 1rem; border-top: 1px solid #2a2a4a; }
    .logo-info .lang {
      display: inline-block; background: #2a2a5a; padding: 0.15rem 0.5rem;
      border-radius: 12px; font-size: 0.75rem; color: #00d4ff; margin-bottom: 0.5rem;
    }
    .logo-url {
      display: block; word-break: break-all; font-size: 0.75rem;
      color: #6666aa; text-decoration: none; margin-top: 0.3rem;
    }
    .logo-url:hover { color: #00d4ff; }
    .btn-group { display: flex; gap: 0.5rem; margin-top: 0.5rem; }
    .copy-btn, .open-btn {
      padding: 0.4rem 0.8rem; border: 1px solid #3a3a6a; border-radius: 6px;
      background: transparent; color: #aaa; cursor: pointer;
      font-size: 0.8rem; transition: all 0.2s; text-decoration: none;
      display: inline-flex; align-items: center;
    }
    .copy-btn:hover, .open-btn:hover { border-color: #00d4ff; color: #00d4ff; }
    .error-box {
      background: #2a1020; border: 1px solid #5a2040; border-radius: 12px;
      padding: 1.5rem; text-align: center; color: #ff6b8a;
    }
    .no-results { text-align: center; padding: 3rem; color: #6666aa; }
    .api-docs { margin-top: 3rem; padding-top: 2rem; border-top: 1px solid #2a2a4a; }
    .api-docs h3 { color: #ccc; margin-bottom: 1rem; }
    .api-endpoint {
      background: #12122a; border: 1px solid #2a2a4a; border-radius: 8px;
      padding: 0.8rem 1rem; margin-bottom: 0.5rem;
      font-family: 'Fira Code', 'Consolas', monospace; font-size: 0.85rem;
    }
    .api-endpoint .method { color: #00d4ff; font-weight: 600; }
    .api-endpoint .path { color: #e0e0e0; }
    .api-endpoint .desc { color: #6666aa; font-size: 0.8rem; margin-top: 0.3rem; }
    .badge {
      display: inline-block; background: #1a3a1a; color: #4ade80; padding: 0.1rem 0.5rem;
      border-radius: 12px; font-size: 0.7rem; margin-left: 0.5rem;
    }
    .badge.warn { background: #3a3a1a; color: #fbbf24; }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>🎨 Fanart Logo Finder</h1>
      <p class="subtitle">Search for TV shows to get HDclearlogo images from fanart.tv</p>
      <p class="subtitle" style="margin-top:0.3rem; font-size:0.85rem; color:#6666aa">
        Powered by TVmaze (search) + fanart.tv (logos) — no API keys required
      </p>
    </header>

    <div class="search-box">
      <input type="text" id="searchInput"
             placeholder="Search for a show (e.g. Breaking Bad, Game of Thrones...)" />
      <button id="searchBtn" onclick="doSearch()">Search</button>
    </div>

    <div class="loading" id="loading">
      <div class="spinner"></div>
      <p style="margin-top: 1rem; color: #8888aa;" id="loadingText">Searching...</p>
    </div>

    <div class="results" id="results"></div>

    <div class="api-docs">
      <h3>📡 API Endpoints</h3>
      <div class="api-endpoint">
        <span class="method">GET</span> <span class="path">/api/search?q={query}</span>
        <div class="desc">Search TV shows via TVmaze, returns TVDB IDs for fanart.tv lookup</div>
      </div>
      <div class="api-endpoint">
        <span class="method">GET</span> <span class="path">/api/logos?id={tvdb_id}&name={show_name}</span>
        <div class="desc">Get HDclearlogos by TVDB ID (name is optional, used for page URL construction)</div>
      </div>
      <div class="api-endpoint">
        <span class="method">GET</span> <span class="path">/api/logos?url={fanart_tv_url}</span>
        <div class="desc">Get HDclearlogos from a specific fanart.tv show page URL</div>
      </div>
      <div class="api-endpoint">
        <span class="method">GET</span> <span class="path">/api/auto?q={query}</span>
        <div class="desc">Search + auto-fetch logos for the top result (combined endpoint)</div>
      </div>
      <div class="api-endpoint">
        <span class="method">GET</span> <span class="path">/api/health</span>
        <div class="desc">Health check</div>
      </div>
    </div>
  </div>

  <script>
    const input = document.getElementById('searchInput');
    const btn = document.getElementById('searchBtn');
    const loading = document.getElementById('loading');
    const loadingText = document.getElementById('loadingText');
    const resultsDiv = document.getElementById('results');

    input.addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });

    async function doSearch() {
      const query = input.value.trim();
      if (!query) return;

      btn.disabled = true;
      loading.classList.add('active');
      loadingText.textContent = 'Searching TVmaze + scraping fanart.tv...';
      resultsDiv.innerHTML = '';

      try {
        const res = await fetch('/api/auto?q=' + encodeURIComponent(query));
        const data = await res.json();

        if (data.error) {
          resultsDiv.innerHTML = '<div class="error-box">' + esc(data.message) + '</div>';
          return;
        }
        renderResults(data);
      } catch (err) {
        resultsDiv.innerHTML = '<div class="error-box">Request failed: ' + esc(err.message) + '</div>';
      } finally {
        btn.disabled = false;
        loading.classList.remove('active');
      }
    }

    function renderResults(data) {
      let html = '';

      if (!data.logos && (!data.all_search_results || data.all_search_results.length === 0)) {
        resultsDiv.innerHTML = '<div class="no-results">No results found for your search.</div>';
        return;
      }

      // Show logo results
      if (data.logos) {
        const logos = data.logos;
        html += '<div class="result-info">';
        html += '<h3>' + esc(logos.show_name || data.selected_result?.name || 'Unknown') + '</h3>';
        html += '<div class="meta">';
        html += logos.logo_count + ' HDclearlogo(s) found';
        if (logos.source) html += ' <span class="badge">' + logos.source + '</span>';
        html += '</div>';
        if (logos.note) {
          html += '<div class="note">ℹ️ ' + esc(logos.note) + '</div>';
        }
        if (logos.show_url) {
          html += '<div style="margin-top:0.5rem"><a href="' + esc(logos.show_url) + '" target="_blank" style="color:#7b2ff7;font-size:0.85rem">🔗 View on fanart.tv</a></div>';
        }
        html += '</div>';

        if (logos.logos && logos.logos.length > 0) {
          html += '<div class="logos-grid">';
          for (const logo of logos.logos) {
            html += '<div class="logo-card">';
            html += '<div class="logo-preview">';
            html += '<img src="' + esc(logo.preview_url || logo.full_url) + '" alt="HD Clear Logo" loading="lazy"';
            html += ' onerror="this.onerror=null;this.src=\\'';
            html += esc(logo.full_url) + '\\'" />';
            html += '</div>';
            html += '<div class="logo-info">';
            html += '<span class="lang">' + esc((logo.language || 'en').toUpperCase()) + '</span>';
            html += '<a class="logo-url" href="' + esc(logo.full_url) + '" target="_blank">' + esc(logo.full_url) + '</a>';
            html += '<div class="btn-group">';
            html += '<button class="copy-btn" onclick="copyUrl(this, \\'' + esc(logo.full_url).replace(/'/g, "\\\\'") + '\\')">📋 Copy URL</button>';
            html += '<a class="open-btn" href="' + esc(logo.full_url) + '" target="_blank">🔗 Open</a>';
            html += '</div></div></div>';
          }
          html += '</div>';
        }
      }

      // Show other search results
      if (data.all_search_results && data.all_search_results.length > 1) {
        html += '<div class="search-results-list" style="margin-top:2rem">';
        html += '<h3>Other search results:</h3>';
        for (let i = 1; i < data.all_search_results.length; i++) {
          const r = data.all_search_results[i];
          html += '<div class="search-result-item" onclick="fetchLogosById(' + r.tvdb_id + ', \\'' + esc(r.name).replace(/'/g, "\\\\'") + '\\')">';
          html += '<span class="name">' + esc(r.name) + '</span>';
          html += '<span class="info">';
          if (r.premiered) html += '<span class="year">' + r.premiered.substring(0, 4) + '</span>';
          html += '<span class="type">' + esc(r.type || 'TV') + '</span>';
          html += '</span></div>';
        }
        html += '</div>';
      }

      resultsDiv.innerHTML = html;
    }

    async function fetchLogosById(tvdbId, name) {
      btn.disabled = true;
      loading.classList.add('active');
      loadingText.textContent = 'Fetching logos from fanart.tv...';
      resultsDiv.innerHTML = '';

      try {
        const params = new URLSearchParams({ id: tvdbId });
        if (name) params.set('name', name);
        const res = await fetch('/api/logos?' + params.toString());
        const data = await res.json();

        if (data.error) {
          resultsDiv.innerHTML = '<div class="error-box">' + esc(data.message) + '</div>';
          return;
        }
        renderResults({ logos: data });
      } catch (err) {
        resultsDiv.innerHTML = '<div class="error-box">Request failed: ' + esc(err.message) + '</div>';
      } finally {
        btn.disabled = false;
        loading.classList.remove('active');
      }
    }

    function copyUrl(btnEl, url) {
      navigator.clipboard.writeText(url).then(() => {
        btnEl.textContent = '✅ Copied!';
        setTimeout(() => btnEl.textContent = '📋 Copy URL', 2000);
      });
    }

    function esc(str) {
      if (!str) return '';
      const d = document.createElement('div');
      d.textContent = str;
      return d.innerHTML;
    }
  </script>
</body>
</html>`;
}

// ==============================================================
// Main Worker Entry Point
// ==============================================================

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    try {
      // Home - Search UI
      if (path === '/' || path === '') {
        return new Response(getSearchUI(), {
          headers: { 'Content-Type': 'text/html' },
        });
      }

      // API: Search shows via TVmaze
      if (path === '/api/search') {
        const query = url.searchParams.get('q');
        if (!query) return errorResponse('Missing query parameter: q');

        const results = await searchShowsTVMaze(query);
        return jsonResponse({ query, count: results.length, results });
      }

      // API: Get logos
      if (path === '/api/logos') {
        const showUrl = url.searchParams.get('url');
        const tvdbId = url.searchParams.get('id');
        const showName = url.searchParams.get('name') || 'Unknown';

        if (showUrl) {
          if (!showUrl.includes('fanart.tv')) {
            return errorResponse('URL must be a fanart.tv URL');
          }
          const logos = await getLogosByUrl(showUrl);
          return jsonResponse(logos);
        }

        if (tvdbId) {
          const logos = await getLogosByTVDBId(tvdbId, showName);
          return jsonResponse(logos);
        }

        return errorResponse('Missing parameter: provide either url or id (TVDB ID)');
      }

      // API: List all saved logos from server side
      if (path === '/api/saved' || path === '/api/logos/saved') {
        const saved = await getAllSavedLogos(env);
        return jsonResponse({
          success: true,
          count: Object.keys(saved).length,
          logos: saved,
        });
      }

      // API: Get, save, or delete a single show logo
      if (path === '/api/logo') {
        // DELETE logo
        if (request.method === 'DELETE') {
          const showName = url.searchParams.get('show') || url.searchParams.get('q');
          if (!showName) return errorResponse('Missing show parameter');
          const success = await deleteSavedLogo(env, showName);
          return jsonResponse({ success, message: `Deleted logo for ${showName}` });
        }

        // POST /api/logo (manual save)
        if (request.method === 'POST') {
          try {
            const body = await request.json();
            const showName = body.show || body.name || body.title;
            const logoUrl = body.logo_url || body.logoUrl || body.url;
            if (!showName || !logoUrl) {
              return errorResponse('Missing required fields: show and logo_url');
            }

            const saved = await saveLogo(env, showName, {
              full_url: logoUrl,
              preview_url: body.preview_url || body.previewUrl || logoUrl,
              tvdb_id: body.tvdb_id || body.tvdbId || null,
              filename: body.filename || null,
            });

            return jsonResponse({ success: true, saved });
          } catch (err) {
            return errorResponse(`Invalid JSON payload: ${err.message}`, 400);
          }
        }

        // GET /api/logo (fetch saved or auto-fetch & save first logo)
        const showName = url.searchParams.get('show') || url.searchParams.get('q') || url.searchParams.get('name');
        if (!showName) return errorResponse('Missing show parameter');
        const force = url.searchParams.get('force') === 'true';

        if (!force) {
          const existing = await getSavedLogo(env, showName);
          if (existing) {
            return jsonResponse({ success: true, saved: true, cached: true, ...existing });
          }
        }

        // Not saved yet: auto search and get logos
        const result = await searchAndGetLogos(showName);
        if (result.logos?.logos?.length > 0) {
          const firstLogo = result.logos.logos[0];
          const saved = await saveLogo(env, result.selected_result?.name || showName, {
            ...firstLogo,
            tvdb_id: result.selected_result?.tvdb_id,
          });
          return jsonResponse({
            success: true,
            saved: true,
            cached: false,
            ...saved,
            available_count: result.logos.logos.length,
          });
        }

        return jsonResponse({
          success: false,
          saved: false,
          message: `No transparent logos found for "${showName}"`,
          result,
        }, 404);
      }

      // API: Save logo explicitly (POST)
      if (path === '/api/save' && request.method === 'POST') {
        try {
          const body = await request.json();
          const showName = body.show || body.name || body.title;
          const logoUrl = body.logo_url || body.logoUrl || body.url;
          if (!showName || !logoUrl) {
            return errorResponse('Missing required fields: show and logo_url');
          }

          const saved = await saveLogo(env, showName, {
            full_url: logoUrl,
            preview_url: body.preview_url || body.previewUrl || logoUrl,
            tvdb_id: body.tvdb_id || body.tvdbId || null,
            filename: body.filename || null,
          });

          return jsonResponse({ success: true, saved });
        } catch (err) {
          return errorResponse(`Invalid JSON payload: ${err.message}`, 400);
        }
      }

      // API: Auto search + fetch logos & automatically save first logo
      if (path === '/api/auto') {
        const query = url.searchParams.get('q');
        if (!query) return errorResponse('Missing query parameter: q');
        const force = url.searchParams.get('force') === 'true';

        if (!force) {
          const existing = await getSavedLogo(env, query);
          if (existing) {
            return jsonResponse({
              query,
              cached: true,
              saved: true,
              selected_result: { name: existing.show, tvdb_id: existing.tvdb_id },
              saved_logo: existing,
              first_logo_url: existing.logo_url,
            });
          }
        }

        const result = await searchAndGetLogos(query);
        let saved = null;
        if (result.logos?.logos?.length > 0) {
          const firstLogo = result.logos.logos[0];
          saved = await saveLogo(env, result.selected_result?.name || query, {
            ...firstLogo,
            tvdb_id: result.selected_result?.tvdb_id,
          });
        }

        return jsonResponse({
          ...result,
          saved: !!saved,
          saved_logo: saved,
          first_logo_url: saved?.logo_url || null,
        });
      }

      // API: Health check
      if (path === '/api/health') {
        return jsonResponse({
          status: 'ok',
          timestamp: new Date().toISOString(),
          version: '1.0.0',
          description: 'Fanart Logo Finder - HDclearlogo scraper',
        });
      }

      return errorResponse('Not found. Try: /, /api/search, /api/logos, /api/auto, /api/health', 404);
    } catch (err) {
      console.error('Worker error:', err);
      return errorResponse(`Internal error: ${err.message}`, 500);
    }
  },
};
