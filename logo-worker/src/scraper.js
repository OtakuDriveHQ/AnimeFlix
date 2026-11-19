/**
 * Fanart.tv Scraper Module
 *
 * Multi-strategy approach to get HDclearlogo data without official API:
 * 
 * 1. TVmaze API (free, no key) for show search & TVDB IDs
 * 2. Wayback Machine archived snapshots of fanart.tv pages
 * 3. Direct fanart.tv scraping (works from CF Workers edge network)
 * 4. CDN asset URLs are always accessible (no Cloudflare protection)
 */

import { decodeEntities } from './parser.js';

const FANART_BASE = 'https://fanart.tv';
const FANART_ASSETS = 'https://assets.fanart.tv';
const TVMAZE_API = 'https://api.tvmaze.com';
const WAYBACK_API = 'https://archive.org/wayback/available';
const WAYBACK_CDX = 'https://web.archive.org/cdx/search/cdx';
const WAYBACK_WEB = 'https://web.archive.org/web';

// Browser-like headers
const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

// ============================================================
// STEP 1: Search using TVmaze (free, no API key)
// ============================================================

async function searchShowsTVMaze(query) {
  const url = `${TVMAZE_API}/search/shows?q=${encodeURIComponent(query)}`;
  const response = await fetch(url, {
    headers: { 'Accept': 'application/json' },
  });

  if (!response.ok) {
    throw new Error(`TVmaze search failed: ${response.status}`);
  }

  const results = await response.json();

  return results
    .filter(r => r.show && r.show.externals && r.show.externals.thetvdb)
    .map(r => ({
      name: r.show.name,
      tvdb_id: r.show.externals.thetvdb,
      imdb_id: r.show.externals.imdb || null,
      type: r.show.type || 'TV',
      status: r.show.status,
      premiered: r.show.premiered,
      genres: r.show.genres || [],
      rating: r.show.rating?.average || null,
      image: r.show.image?.medium || null,
      summary: r.show.summary
        ? r.show.summary.replace(/<[^>]*>/g, '').substring(0, 200)
        : null,
      score: r.score,
      fanart_url: `${FANART_BASE}/series/${r.show.externals.thetvdb}/${slugify(r.show.name)}/`,
    }));
}

// ============================================================
// STEP 2: Get logos using multiple strategies
// ============================================================

/**
 * Extract hdtvlogo/hdmovielogo/clearlogo filenames from HTML content
 */
function extractLogoFilenames(html, tvdbId) {
  const filenames = new Set();

  // Pattern 1: Full asset URLs
  const fullUrlRegex = new RegExp(
    `(?:assets\\.fanart\\.tv/(?:fanart|preview)/(?:tv|movies)/${tvdbId}/(?:hdtvlogo|hdmovielogo|hdclearlogo|clearlogo)/([a-zA-Z0-9_\\-]+\\.png))`,
    'gi'
  );
  let match;
  while ((match = fullUrlRegex.exec(html)) !== null) {
    filenames.add(match[1]);
  }

  // Pattern 2: Paths like hdtvlogo/filename.png or clearlogo/filename.png
  const relativeRegex = /(?:hdtvlogo|hdmovielogo|hdclearlogo|clearlogo)\/([a-zA-Z0-9_\-]+\.png)/gi;
  while ((match = relativeRegex.exec(html)) !== null) {
    filenames.add(match[1]);
  }

  // Pattern 3: Look for data attributes with image hashes
  const dataRegex = /data-(?:src|original|lazy)\s*=\s*["']([^"']*?(?:hdtvlogo|hdmovielogo|clearlogo)[^"']*?)["']/gi;
  while ((match = dataRegex.exec(html)) !== null) {
    const fnMatch = match[1].match(/\/([a-zA-Z0-9_\-]+\.png)$/i);
    if (fnMatch) filenames.add(fnMatch[1]);
  }

  return [...filenames];
}

/**
 * Build full logo objects from filenames
 */
function buildLogoObjects(filenames, tvdbId, category = 'tv') {
  const logoType = category === 'movies' ? 'hdmovielogo' : 'hdtvlogo';

  return filenames.map(filename => {
    // Try to detect language from filename pattern
    const langMatch = filename.match(/-([a-z]{2})\.png$/i);

    return {
      full_url: `${FANART_ASSETS}/fanart/${category}/${tvdbId}/${logoType}/${filename}`,
      preview_url: `${FANART_ASSETS}/preview/${category}/${tvdbId}/${logoType}/${filename}`,
      filename,
      language: langMatch ? langMatch[1].toLowerCase() : 'en',
    };
  });
}

/**
 * Strategy A: Fetch from Wayback Machine (most reliable for bypassing Cloudflare)
 */
async function fetchFromWayback(tvdbId, showSlug) {
  console.log(`[scraper] fetchFromWayback tvdbId=${tvdbId} showSlug=${showSlug}`);

  // Query CDX with wildcard on tvdbId so it finds the show regardless of slug variations (e.g. the-office-us)
  const queries = [
    `fanart.tv/series/${tvdbId}/${showSlug}/`,
    `fanart.tv/series/${tvdbId}*`,
  ];

  for (const pattern of queries) {
    try {
      const cdxUrl = `${WAYBACK_CDX}?url=${encodeURIComponent(pattern)}&output=json&limit=6&fl=timestamp,original,statuscode&filter=statuscode:200`;
      console.log(`[scraper] CDX query: ${cdxUrl}`);
      const cdxResponse = await fetch(cdxUrl, {
        headers: {
          'User-Agent': BROWSER_HEADERS['User-Agent'],
          'Accept': 'application/json',
        },
      });
      console.log(`[scraper] CDX status: ${cdxResponse.status}`);
      if (!cdxResponse.ok) {
        const errorText = await cdxResponse.text();
        console.log(`[scraper] CDX request failed with ${cdxResponse.status}: ${errorText.substring(0, 300)}`);
        continue;
      }

      const cdxData = await cdxResponse.json();
      console.log(`[scraper] CDX data type: ${typeof cdxData}, length: ${Array.isArray(cdxData) ? cdxData.length : 'not array'}`);
      if (!Array.isArray(cdxData) || cdxData.length <= 1) continue;

      // cdxData rows: [timestamp, original, statuscode]
      // Iterate snapshots from NEWEST to OLDEST for latest artwork
      for (let i = cdxData.length - 1; i >= 1; i--) {
        const timestamp = cdxData[i][0];
        const originalUrl = cdxData[i][1];
        // Clean original URL
        const cleanUrl = originalUrl.replace(':80', '');
        const archiveUrl = `${WAYBACK_WEB}/${timestamp}/${cleanUrl}`;
        console.log(`[scraper] Checking archive URL: ${archiveUrl}`);

        const result = await fetchAndParseArchive(archiveUrl, tvdbId);
        if (result && result.length > 0) {
          console.log(`[scraper] Found ${result.length} logos in snapshot ${timestamp}`);
          return result;
        }
      }
    } catch (err) {
      console.error(`[scraper] Wayback pattern ${pattern} error:`, err);
    }
  }

  // Fallback: availability API
  try {
    const availUrl = `${WAYBACK_API}?url=${encodeURIComponent(`fanart.tv/series/${tvdbId}/`)}`;
    const availResponse = await fetch(availUrl, {
      headers: {
        'User-Agent': BROWSER_HEADERS['User-Agent'],
        'Accept': 'application/json',
      },
    });
    if (availResponse.ok) {
      const availData = await availResponse.json();
      if (availData.archived_snapshots?.closest?.available) {
        const archiveUrl = availData.archived_snapshots.closest.url;
        const result = await fetchAndParseArchive(archiveUrl, tvdbId);
        if (result && result.length > 0) return result;
      }
    }
  } catch (err) {
    console.error('[scraper] Wayback avail fallback error:', err);
  }

  return null;
}

/**
 * Fetch and parse an archived page
 */
async function fetchAndParseArchive(archiveUrl, tvdbId) {
  try {
    console.log(`[scraper] fetchAndParseArchive fetching ${archiveUrl}`);
    const response = await fetch(archiveUrl, {
      headers: BROWSER_HEADERS,
      redirect: 'follow',
    });
    console.log(`[scraper] fetchAndParseArchive response status: ${response.status}`);

    if (!response.ok) return null;

    const html = await response.text();
    console.log(`[scraper] fetchAndParseArchive html length: ${html.length}`);
    const filenames = extractLogoFilenames(html, tvdbId);
    console.log(`[scraper] extractLogoFilenames found: ${filenames.length}`);
    return filenames;
  } catch (err) {
    console.error('[scraper] Archive parse error:', err);
    return null;
  }
}

/**
 * Strategy B: Direct fetch from fanart.tv (works better from CF edge)
 */
async function fetchFromFanartDirect(tvdbId, showSlug) {
  const urls = [
    `${FANART_BASE}/series/${tvdbId}/${showSlug}/`,
    `${FANART_BASE}/series/${tvdbId}/`,
  ];

  for (const url of urls) {
    try {
      const response = await fetch(url, {
        headers: BROWSER_HEADERS,
        redirect: 'follow',
      });

      if (!response.ok) continue;

      const html = await response.text();

      // Check if we got a Cloudflare challenge instead of real content
      if (html.includes('cf-challenge') || html.includes('Just a moment') || html.includes('cf-turnstile')) {
        continue;
      }

      const filenames = extractLogoFilenames(html, tvdbId);
      if (filenames.length > 0) return { filenames, source: 'fanart.tv_direct' };
    } catch (err) {
      continue;
    }
  }

  return null;
}

/**
 * Verify that logo URLs actually exist on the CDN
 */
async function verifyLogoUrls(logos) {
  const verified = [];

  // Check in parallel (batch of 5 at a time)
  const batchSize = 5;
  for (let i = 0; i < logos.length; i += batchSize) {
    const batch = logos.slice(i, i + batchSize);
    const checks = batch.map(async (logo) => {
      try {
        const response = await fetch(logo.full_url, {
          method: 'HEAD',
          headers: { 'User-Agent': 'Mozilla/5.0' },
        });
        return { ...logo, verified: response.ok, status: response.status };
      } catch {
        return { ...logo, verified: false, status: 0 };
      }
    });

    const results = await Promise.all(checks);
    verified.push(...results);
  }

  return verified;
}

// ============================================================
// MAIN: Get logos by TVDB ID
// ============================================================

async function getLogosByTVDBId(tvdbId, showName = 'Unknown') {
  const slug = slugify(showName);
  const showUrl = `${FANART_BASE}/series/${tvdbId}/${slug}/`;
  console.log(`[scraper] getLogosByTVDBId tvdbId=${tvdbId} showName=${showName} slug=${slug}`);

  let filenames = null;
  let source = 'none';

  // Strategy A: Try direct fanart.tv fetch first (fastest if it works)
  console.log(`[scraper] Trying direct fanart fetch...`);
  const directResult = await fetchFromFanartDirect(tvdbId, slug);
  if (directResult && directResult.filenames.length > 0) {
    filenames = directResult.filenames;
    source = directResult.source;
    console.log(`[scraper] Direct fetch succeeded! Found ${filenames.length} filenames`);
  } else {
    console.log(`[scraper] Direct fetch yielded no filenames.`);
  }

  // Strategy B: Wayback Machine (reliable fallback)
  if (!filenames || filenames.length === 0) {
    console.log(`[scraper] Trying Wayback Machine...`);
    const waybackFilenames = await fetchFromWayback(tvdbId, slug);
    if (waybackFilenames && waybackFilenames.length > 0) {
      filenames = waybackFilenames;
      source = 'wayback_machine';
      console.log(`[scraper] Wayback succeeded! Found ${filenames.length} filenames`);
    } else {
      console.log(`[scraper] Wayback yielded no filenames.`);
    }
  }

  // Build logo objects
  if (filenames && filenames.length > 0) {
    const logos = buildLogoObjects(filenames, tvdbId, 'tv');
    console.log(`[scraper] Verifying ${logos.length} logo URLs...`);
    // Verify which URLs actually work
    const verifiedLogos = await verifyLogoUrls(logos);
    const workingLogos = verifiedLogos.filter(l => l.verified);
    console.log(`[scraper] Verified: ${workingLogos.length}/${logos.length} working`);

    return {
      show_name: showName,
      show_url: showUrl,
      tvdb_id: tvdbId,
      source,
      logo_count: workingLogos.length,
      total_found: filenames.length,
      logos: workingLogos.map(({ verified, status, ...rest }) => rest),
      ...(workingLogos.length < filenames.length ? {
        note: `${filenames.length - workingLogos.length} logo(s) no longer available on CDN (may have been removed).`
      } : {}),
    };
  }

  // No logos found through any strategy
  return {
    show_name: showName,
    show_url: showUrl,
    tvdb_id: tvdbId,
    source: 'none',
    logo_count: 0,
    logos: [],
    note: 'No HDclearlogos could be retrieved. The show might not have any logos on fanart.tv, or the page may not be archived. Try visiting the fanart.tv URL directly.',
    asset_url_pattern: `${FANART_ASSETS}/fanart/tv/${tvdbId}/hdtvlogo/{filename}.png`,
  };
}

/**
 * Get logos by directly scraping a fanart.tv URL
 */
async function getLogosByUrl(url) {
  // Extract TVDB ID from URL
  const idMatch = url.match(/\/(?:series|movie)\/(\d+)/);
  const tvdbId = idMatch ? idMatch[1] : null;

  if (!tvdbId) {
    throw new Error('Could not extract TVDB ID from URL. Expected format: fanart.tv/series/<id>/...');
  }

  // Extract name from URL slug
  const slugMatch = url.match(/\/\d+\/([^/]+)/);
  const name = slugMatch ? slugMatch[1].replace(/-/g, ' ') : 'Unknown';

  return getLogosByTVDBId(tvdbId, name);
}

// ============================================================
// Combined search + logo retrieval
// ============================================================

async function searchAndGetLogos(query) {
  const searchResults = await searchShowsTVMaze(query);

  if (searchResults.length === 0) {
    return {
      query,
      message: 'No TV shows found matching your search.',
      results: [],
    };
  }

  const topResult = searchResults[0];
  const logos = await getLogosByTVDBId(topResult.tvdb_id, topResult.name);

  return {
    query,
    selected_result: topResult,
    all_search_results: searchResults.slice(0, 10),
    logos,
  };
}

// ============================================================
// Utility
// ============================================================

function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .substring(0, 100);
}

export {
  searchShowsTVMaze,
  getLogosByTVDBId,
  getLogosByUrl,
  searchAndGetLogos,
  slugify,
};
