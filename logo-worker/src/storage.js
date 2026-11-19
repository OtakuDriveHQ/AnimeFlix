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
 * Remove any punctuation, symbols, colons, slashes, brackets, hyphens etc.
 */
export function removeAdditionalSymbols(str) {
  if (!str) return '';
  return str
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Extract clean show name from title according to two primary patterns:
 * Pattern 1 (TV/Series): "show name season 1 and suffix words"
 *   -> Extracts the show name that appears BEFORE "season 1" (or "season", "s1", "seacon", etc.)
 * Pattern 2 (Movies): "show name (year) and suffix words"
 *   -> Extracts the show name that appears BEFORE "(year)" (or "[year]" or standalone 4-digit year)
 * Cleans all additional symbols/punctuation from title for accurate search.
 */
export function extractShowIdentificationQuery(raw) {
  if (!raw) return '';
  // 1. Clean URL prefixes and convert hyphens/underscores to spaces
  let text = raw.replace(/https?:\/\/[^\/]+\//g, '').replace(/[-_]+/g, ' ').trim();

  // 2. Identify boundary:
  // Pattern 1: Season indicators (e.g. "final season", "season 1", "season 01", "seacon 1", "s1", "s01", "cour 1", "part 1")
  // Pattern 2: Year indicators (e.g. "(2024)", "[2024]", "(1999)", or standalone "2024")
  const boundaryRegex = /\b(final\s+season|season\s*\d+|seacon\s*\d+|s\d+|cour\s*\d+|\(\s*(?:19|20)\d{2}\s*\)|\[\s*(?:19|20)\d{2}\s*\]|\b(?:19|20)\d{2}\b)/i;

  const match = text.match(boundaryRegex);
  if (match && typeof match.index === 'number' && match.index > 0) {
    const candidate = text.substring(0, match.index).trim();
    if (candidate.length >= 2) {
      text = candidate;
    }
  }

  // 3. Strip common trailing release/quality/audio noise
  text = text.replace(/\b(download|watch online|dual audio|multi audio|hindi dub|hindi|english|japanese|1080p|720p|480p|4k|2160p|hevc|web-dl|webrip|bluray|bd|remux|x264|x265|10bit|uncut|remastered|batch|full)\b/gi, '').trim();

  // 4. Remove all additional symbols and punctuation
  text = removeAdditionalSymbols(text);

  return text || raw;
}

/**
 * Generate smart search candidate variants if a title has colons/subtitles or is long
 */
export function generateSearchCandidates(raw) {
  const cleanFull = extractShowIdentificationQuery(raw);
  const candidates = [cleanFull];

  // If raw has colon/hyphen separating a primary title and subtitle (e.g. "Demon Slayer: Kimetsu no Yaiba")
  if (raw.includes(':') || raw.includes(' - ')) {
    const primaryPart = raw.split(/[:–—]|(\s-\s)/)[0];
    const cleanPrimary = extractShowIdentificationQuery(primaryPart);
    if (cleanPrimary && cleanPrimary !== cleanFull && cleanPrimary.length >= 3 && !candidates.includes(cleanPrimary)) {
      candidates.push(cleanPrimary);
    }
  }

  // If clean title has more than 4 words, add 3-4 word prefix fallback (e.g. "Buzz Lightyear of Star Command")
  const words = cleanFull.split(' ').filter(Boolean);
  if (words.length > 4) {
    const fourWords = words.slice(0, 4).join(' ');
    if (fourWords && !candidates.includes(fourWords)) {
      candidates.push(fourWords);
    }
    const fiveWords = words.slice(0, 5).join(' ');
    if (fiveWords && !candidates.includes(fiveWords)) {
      candidates.push(fiveWords);
    }
  }

  return candidates;
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

      // Also check clean show name key if raw show name had season/year/noise
      const cleanName = extractShowIdentificationQuery(showName);
      const cleanKey = normalizeShowKey(cleanName);
      if (cleanKey && cleanKey !== key) {
        const cleanData = await env.LOGOS_KV.get(cleanKey, 'json');
        if (cleanData) return cleanData;
      }
    } catch (err) {
      console.warn(`[storage] KV get failed for ${key}:`, err.message);
    }
  }

  // 2. In-memory fallback
  if (memoryStore.has(key)) return memoryStore.get(key);
  const cleanKey = normalizeShowKey(extractShowIdentificationQuery(showName));
  if (cleanKey && memoryStore.has(cleanKey)) return memoryStore.get(cleanKey);

  return null;
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
