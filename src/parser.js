/**
 * parser.js
 *
 * XML parsing utilities for sitemap files.
 * Uses simple regex-based extraction (no DOM parser needed in Workers).
 */

/**
 * Extract all <sitemap> entries from a sitemap index XML.
 * Returns only entries whose <loc> matches "post-sitemap*.xml".
 *
 * @param {string} xml
 * @returns {{ loc: string, lastmod: string }[]}
 */
export function parsePostSitemapIndex(xml) {
  const results = [];
  const sitemapRegex = /<sitemap>([\s\S]*?)<\/sitemap>/g;

  let match;
  while ((match = sitemapRegex.exec(xml)) !== null) {
    const block = match[1];
    const loc = extractTag(block, "loc");
    const lastmod = extractTag(block, "lastmod");

    if (loc && /post-sitemap\d*\.xml/.test(loc)) {
      results.push({ loc, lastmod: lastmod ?? "" });
    }
  }
  return results;
}

/**
 * Extract all <url> entries from a post-sitemap XML.
 * Returns { url, lastmod } sorted newest → oldest.
 *
 * @param {string} xml
 * @param {string} sitemapSource  label for which sitemap this came from
 * @returns {{ url: string, lastmod: string, source: string }[]}
 */
export function parsePostSitemap(xml, sitemapSource) {
  const results = [];
  const urlRegex = /<url>([\s\S]*?)<\/url>/g;

  let match;
  while ((match = urlRegex.exec(xml)) !== null) {
    const block = match[1];
    const url = extractTag(block, "loc");
    const lastmod = extractTag(block, "lastmod");

    if (url) {
      results.push({ url, lastmod: lastmod ?? "", source: sitemapSource });
    }
  }
  return results;
}

/**
 * Extract inner text of the first occurrence of <tag>…</tag>.
 *
 * @param {string} text
 * @param {string} tag
 * @returns {string|null}
 */
function extractTag(text, tag) {
  const m = text.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`));
  return m ? m[1].trim() : null;
}

/**
 * Sort an array of post entries newest → oldest by lastmod.
 *
 * @param {{ url: string, lastmod: string, source: string }[]} entries
 * @returns {{ url: string, lastmod: string, source: string }[]}
 */
export function sortNewestFirst(entries) {
  return [...entries].sort((a, b) => {
    const ta = a.lastmod ? new Date(a.lastmod).getTime() : 0;
    const tb = b.lastmod ? new Date(b.lastmod).getTime() : 0;
    return tb - ta;
  });
}

/**
 * Convert a URL slug into a clean, human-readable post title.
 * E.g. "beyblade-vforce-season-1-hindi-jap-dual-audio-720p-hd" -> "Beyblade VForce Season 1 Hindi Jap Dual Audio 720p HD"
 *
 * @param {string} slug
 * @returns {string}
 */
export function slugToTitle(slug) {
  if (!slug) return "";
  const specialWords = {
    vforce: "VForce",
    bluray: "BluRay",
    bdrip: "BDRip",
    webrip: "WEBRip",
    "web-dl": "WEB-DL",
    hd: "HD",
    fhd: "FHD",
    hevc: "HEVC",
    x264: "x264",
    x265: "x265",
    "10bit": "10bit",
    ova: "OVA",
    ona: "ONA",
    tv: "TV",
    jap: "Jap",
    eng: "Eng",
    multi: "Multi",
    audio: "Audio",
    dual: "Dual",
    hindi: "Hindi",
    tamil: "Tamil",
    telugu: "Telugu",
    korean: "Korean",
    japanese: "Japanese",
    chinese: "Chinese",
    dubbed: "Dubbed",
    subbed: "Subbed",
    movie: "Movie",
    season: "Season",
    episode: "Episode",
    episodes: "Episodes",
    part: "Part",
  };

  const words = slug.split("-").filter(Boolean);
  return words
    .map((w) => {
      const lw = w.toLowerCase();
      if (specialWords[lw]) return specialWords[lw];
      if (/^\d+p$/i.test(w)) return w.toLowerCase();
      if (/^(19|20)\d{2}$/.test(w)) return w;
      if (/^(i|ii|iii|iv|v|vi|vii|viii|ix|x)$/i.test(w)) return w.toUpperCase();
      return w.charAt(0).toUpperCase() + w.slice(1);
    })
    .join(" ");
}

