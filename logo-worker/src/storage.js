/**
 * Server-Side Logo Storage Module for Cloudflare Worker
 *
 * Supports Cloudflare KV (LOGOS_KV) and in-memory fallback.
 * Allows saving all logo variants, setting/switching the main logo,
 * listing, and deleting transparent logos per show.
 */

// In-memory fallback if KV namespace is not bound
const memoryStore = new Map();

/**
 * Normalize show name into a consistent storage key
 * e.g. "Death Note" -> "death-note"
 *      "Solo Leveling Season 2" -> "solo-leveling"
 */
export function normalizeShowKey(name) {
  if (!name) return '';
  return name
    .toLowerCase()
    .trim()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // remove diacritics
    .replace(/[^\w\s-]/g, '')        // remove special chars
    .replace(/\s+/g, '-')            // spaces to hyphens
    .replace(/-+/g, '-');            // collapse multiple hyphens
}

/**
 * Extract first 3-4 keywords from show title for auto-fetch identification
 * e.g. "Solo Leveling Season 2: Arise from the Shadow (2025) Dual Audio 1080p Web-DL" -> "Solo Leveling"
 *      "Attack on Titan Final Season Part 3 Dual Audio HEVC" -> "Attack on Titan Final"
 *      "Bleach: Thousand-Year Blood War - The Conflict Part 3" -> "Bleach Thousand Year Blood"
 */
export function extractShowIdentificationQuery(raw) {
  if (!raw) return '';
  let title = raw.replace(/https?:\/\/[^\/]+\//g, '').replace(/[-_]+/g, ' ');

  // 1. Split at season/part/cour/year boundaries if present
  const splitMatch = title.split(/\b(season\s*\d+|s\d+|part\s*\d+|cour\s*\d+|\(\d{4}\)|\[\d{4}\]|:\s*season|:\s*part)\b/i);
  if (splitMatch && splitMatch[0] && splitMatch[0].trim().length >= 3) {
    title = splitMatch[0];
  }

  // 2. Remove common SEO, release years, quality and audio tags
  title = title
    .replace(/\b\d{4}\b/g, '')
    .replace(/\b(download|watch online|full series|complete series|dual audio|multi audio|hindi dub|hindi|english|1080p|720p|480p|4k|2160p|hevc|web-dl|webrip|bluray|bd|remux|x264|x265|10bit|uncut|remastered|batch|full)\b/gi, '')
    .replace(/[\(\)\[\]\{\}:;!?,.]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // 3. Take first 3-4 words to identify the show accurately on TVmaze/Fanart.tv
  const words = title.split(' ').filter(Boolean);
  const targetWords = words.slice(0, Math.min(words.length, 4)).join(' ');
  return targetWords || title;
}

/**
 * Get saved logo record for a show
 */
export async function getSavedLogo(env, showName) {
  const key = normalizeShowKey(showName);
  if (!key) return null;

  // 1. Try Cloudflare KV
  if (env && env.LOGOS_KV) {
    try {
      const data = await env.LOGOS_KV.get(key, 'json');
      if (data) return data;
    } catch (err) {
      console.warn(`[storage] KV get failed for ${key}:`, err.message);
    }
  }

  // 2. In-memory fallback
  return memoryStore.get(key) || null;
}

/**
 * Save ALL logo variants for a show to server side, setting the first logo as main logo
 */
export async function saveShowLogos(env, showName, { logos = [], mainLogoUrl = null, tvdbId = null, source = 'fanart.tv' }) {
  const key = normalizeShowKey(showName);
  if (!key) return null;

  // Format all available logo variants
  const formattedLogos = (logos || []).map((l, idx) => ({
    full_url: l.full_url || l.logo_url || l.url,
    preview_url: l.preview_url || l.full_url || l.logo_url || l.url,
    filename: l.filename || null,
    language: l.language || 'en',
    id: idx + 1,
  }));

  const first = formattedLogos[0];
  const chosenMain = mainLogoUrl || first?.full_url || first?.preview_url || null;
  const chosenPreview =
    formattedLogos.find((l) => l.full_url === chosenMain)?.preview_url ||
    first?.preview_url ||
    chosenMain;

  const payload = {
    show: showName,
    key,
    main_logo: chosenMain,
    main_preview: chosenPreview,
    logo_url: chosenMain, // alias for backwards compatibility
    preview_url: chosenPreview, // alias for backwards compatibility
    tvdb_id: tvdbId,
    logos: formattedLogos,
    logo_count: formattedLogos.length,
    source,
    saved_at: new Date().toISOString(),
  };

  // 1. Persist to Cloudflare KV
  if (env && env.LOGOS_KV) {
    try {
      await env.LOGOS_KV.put(key, JSON.stringify(payload));
      // Store index pointer so we can list all saved logos efficiently
      await env.LOGOS_KV.put(`__idx__:${key}`, showName);
      console.log(`[storage] Saved ${formattedLogos.length} logos for ${key}. Main logo: ${chosenMain}`);
    } catch (err) {
      console.warn(`[storage] KV put failed for ${key}:`, err.message);
    }
  }

  // 2. Persist to memory
  memoryStore.set(key, payload);
  return payload;
}

/**
 * Change / switch the main logo of a show to another available logo (or custom URL)
 */
export async function setMainLogo(env, showName, newLogoUrl) {
  const key = normalizeShowKey(showName);
  if (!key || !newLogoUrl) return null;

  let existing = await getSavedLogo(env, showName);
  if (!existing) {
    existing = {
      show: showName,
      key,
      tvdb_id: null,
      logos: [],
      source: 'custom',
      saved_at: new Date().toISOString(),
    };
  }

  const cleanUrl = newLogoUrl.trim();
  const matchedLogo = existing.logos?.find(
    (l) => l.full_url === cleanUrl || l.preview_url === cleanUrl
  );
  const previewUrl = matchedLogo?.preview_url || cleanUrl;

  existing.main_logo = cleanUrl;
  existing.main_preview = previewUrl;
  existing.logo_url = cleanUrl;
  existing.preview_url = previewUrl;
  existing.updated_at = new Date().toISOString();

  // If new logo was not in the existing logos list, prepend it
  if (!matchedLogo && existing.logos) {
    existing.logos.unshift({
      full_url: cleanUrl,
      preview_url: cleanUrl,
      language: 'custom',
      id: existing.logos.length + 1,
    });
    existing.logo_count = existing.logos.length;
  }

  // Save updated record to KV
  if (env && env.LOGOS_KV) {
    try {
      await env.LOGOS_KV.put(key, JSON.stringify(existing));
      await env.LOGOS_KV.put(`__idx__:${key}`, existing.show || showName);
      console.log(`[storage] Updated main logo for ${key} -> ${cleanUrl}`);
    } catch (err) {
      console.warn(`[storage] KV update main logo failed for ${key}:`, err.message);
    }
  }

  memoryStore.set(key, existing);
  return existing;
}

/**
 * Backward compatibility alias for single logo save
 */
export async function saveLogo(env, showName, logoInfo) {
  const logoUrl = logoInfo.full_url || logoInfo.logo_url || logoInfo.url;
  return await saveShowLogos(env, showName, {
    logos: [logoInfo],
    mainLogoUrl: logoUrl,
    tvdbId: logoInfo.tvdb_id || null,
    source: logoInfo.source || 'fanart.tv',
  });
}

/**
 * List all saved logos from server side
 */
export async function getAllSavedLogos(env) {
  const result = {};

  if (env && env.LOGOS_KV) {
    try {
      const list = await env.LOGOS_KV.list({ prefix: '__idx__:' });
      if (list && list.keys) {
        for (const item of list.keys) {
          const key = item.name.replace('__idx__:', '');
          const data = await env.LOGOS_KV.get(key, 'json');
          if (data) {
            result[key] = data;
          }
        }
      }
      return result;
    } catch (err) {
      console.warn('[storage] KV list failed:', err.message);
    }
  }

  // Fallback to memory
  for (const [k, v] of memoryStore.entries()) {
    result[k] = v;
  }
  return result;
}

/**
 * Delete a saved logo from server side
 */
export async function deleteSavedLogo(env, showName) {
  const key = normalizeShowKey(showName);
  if (!key) return false;

  if (env && env.LOGOS_KV) {
    try {
      await env.LOGOS_KV.delete(key);
      await env.LOGOS_KV.delete(`__idx__:${key}`);
      console.log(`[storage] Deleted logo from KV: ${key}`);
    } catch (err) {
      console.warn(`[storage] KV delete failed for ${key}:`, err.message);
    }
  }

  memoryStore.delete(key);
  return true;
}
