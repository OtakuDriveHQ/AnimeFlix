/**
 * Server-Side Logo Storage Module for Cloudflare Worker
 *
 * Supports Cloudflare KV (LOGOS_KV) and in-memory fallback.
 * Allows saving, retrieving, listing, and deleting transparent logos per show.
 */

// In-memory fallback if KV namespace is not bound
const memoryStore = new Map();

/**
 * Normalize show name into a consistent storage key
 * e.g. "Death Note" -> "death-note"
 *      "Attack on Titan: Final Season" -> "attack-on-titan-final-season"
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
 * Get saved logo data for a show
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
 * Save logo data for a show to server side
 */
export async function saveLogo(env, showName, logoInfo) {
  const key = normalizeShowKey(showName);
  if (!key) return null;

  const payload = {
    show: showName,
    key,
    logo_url: logoInfo.full_url || logoInfo.logo_url || logoInfo.url,
    preview_url: logoInfo.preview_url || logoInfo.full_url || logoInfo.logo_url || logoInfo.url,
    filename: logoInfo.filename || null,
    tvdb_id: logoInfo.tvdb_id || null,
    language: logoInfo.language || 'en',
    source: logoInfo.source || 'fanart.tv',
    saved_at: new Date().toISOString(),
  };

  // 1. Persist to Cloudflare KV
  if (env && env.LOGOS_KV) {
    try {
      await env.LOGOS_KV.put(key, JSON.stringify(payload));
      // Store index pointer so we can list all saved logos efficiently
      await env.LOGOS_KV.put(`__idx__:${key}`, showName);
      console.log(`[storage] Saved logo to KV: ${key} -> ${payload.logo_url}`);
    } catch (err) {
      console.warn(`[storage] KV put failed for ${key}:`, err.message);
    }
  }

  // 2. Persist to memory
  memoryStore.set(key, payload);
  return payload;
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
