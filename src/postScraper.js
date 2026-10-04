/**
 * postScraper.js
 *
 * Scrapes a single toonworld4all.me post page and returns structured data:
 *  - title
 *  - thumbnail URL
 *  - metadata fields (Genre, Language, Episodes, Quality, etc.)
 *  - synopsis
 *  - seasons → each season has a name + accordion episodes (label + links[])
 */

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Strip all HTML tags from a string */
function stripTags(html) {
  return html.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&")
    .replace(/&#8211;/g, "–").replace(/&#8220;/g, "\u201c")
    .replace(/&#8221;/g, "\u201d").replace(/&nbsp;/g, " ")
    .replace(/&#038;/g, "&").replace(/\s+/g, " ").trim();
}

/** Extract inner HTML of the first occurrence of a regex match group */
function matchInner(html, pattern) {
  const m = html.match(pattern);
  return m ? m[1] : null;
}

// ─── Main extractor ───────────────────────────────────────────────────────────

/**
 * @param {string} html  Raw HTML of the post page
 * @returns {{
 *   title: string,
 *   thumbnail: string|null,
 *   meta: Record<string,string>,
 *   synopsis: string,
 *   seasons: { name: string, episodes: { label: string, links: {text:string, href:string}[] }[] }[]
 * }}
 */
export function scrapePost(html) {
  return {
    title:     extractTitle(html),
    thumbnail: extractThumbnail(html),
    meta:      extractMeta(html),
    synopsis:  extractSynopsis(html),
    seasons:   extractSeasons(html),
  };
}

// ─── 1. Title ─────────────────────────────────────────────────────────────────
function extractTitle(html) {
  const m = html.match(/<h1[^>]*class="[^"]*entry-title[^"]*"[^>]*>([\s\S]*?)<\/h1>/i);
  return m ? stripTags(m[1]) : "";
}

// ─── 2. Thumbnail ─────────────────────────────────────────────────────────────
function extractThumbnail(html) {
  // Find the entry-content div first, then grab the first <img> inside it
  const contentMatch = html.match(/<div[^>]*class="[^"]*entry-content[^"]*"[^>]*>([\s\S]*)/i);
  if (!contentMatch) return null;

  const contentHtml = contentMatch[1];
  const imgMatch = contentHtml.match(/<img[^>]+src="([^"]+)"[^>]*>/i);
  return imgMatch ? imgMatch[1] : null;
}

// ─── 3. Meta fields ───────────────────────────────────────────────────────────
function extractMeta(html) {
  // Find the paragraph that contains the red-coloured field labels
  // Pattern: <span style="color: #ff0000;">LABEL: </span> VALUE <br/>
  const metaFields = {};

  // Grab all field blocks: label in red span, value follows until next <br> or tag
  const fieldPattern = /<span[^>]*color:\s*#ff0000[^>]*>([^<]+)<\/span>\s*([\s\S]*?)(?=<br\s*\/?>|<strong><span[^>]*color:\s*#(?:ff0000|0000ff)[^>]*>|<\/p>)/gi;

  let m;
  while ((m = fieldPattern.exec(html)) !== null) {
    const key = stripTags(m[1]).replace(/:$/, "").trim();
    const value = stripTags(m[2]).trim();
    // Exclude Synopsis — it is extracted separately into its own field
    if (key && value && key.toLowerCase() !== "synopsis") {
      metaFields[key] = value;
    }
  }

  return metaFields;
}

// ─── 4. Synopsis ──────────────────────────────────────────────────────────────
function extractSynopsis(html) {
  // Look for the <p> that has "Synopsis:" in a red span
  const synMatch = html.match(/<span[^>]*color:\s*#ff0000[^>]*>Synopsis:<\/span>\s*([\s\S]*?)<\/p>/i);
  if (!synMatch) return "";
  return stripTags(synMatch[1]).trim();
}

// ─── 5. Seasons + Episodes ────────────────────────────────────────────────────
function extractSeasons(html) {
  const seasons = [];

  // Season headings look like:
  //   <p style="...color: #800000..."><strong>...<span ...>SEASON 1</span>...</strong></p>
  //   then immediately a <div class="mks_accordion">…</div>
  //
  // Strategy: split on season heading pattern, collect accordion blocks after each heading.

  // Find ALL season heading occurrences and their positions
  const seasonHeadingRe = /<p[^>]*>\s*<span[^>]*color:\s*#800000[^>]*>\s*<strong[^>]*>\s*<span[^>]*>(SEASON\s+[\w\d &–-]+?)<\/span>/gi;
  const accordionRe = /<div\s+class="mks_accordion">([\s\S]*?)<\/div>\s*(?=<hr|<h[1-6]|<div class="mks_accordion"|$)/gi;

  // Collect all season heading match positions
  const headings = [];
  let hm;
  while ((hm = seasonHeadingRe.exec(html)) !== null) {
    headings.push({ name: stripTags(hm[1]).trim(), index: hm.index });
  }

  if (headings.length === 0) {
    // Fallback: single season, no heading
    const episodes = extractAccordionEpisodes(html);
    if (episodes.length > 0) {
      seasons.push({ name: "SEASON 1", episodes });
    }
    return seasons;
  }

  // For each heading, extract the accordion that comes right after it
  for (let i = 0; i < headings.length; i++) {
    const start = headings[i].index;
    const end = i + 1 < headings.length ? headings[i + 1].index : html.length;
    const segment = html.slice(start, end);
    const episodes = extractAccordionEpisodes(segment);
    seasons.push({ name: headings[i].name, episodes });
  }

  return seasons;
}

/** Extract episodes from a segment containing mks_accordion markup */
function extractAccordionEpisodes(html) {
  const episodes = [];

  // Each item: <div class="mks_accordion_item"> heading + content </div>
  const itemRe = /<div\s+class="mks_accordion_item">([\s\S]*?)(?=<div\s+class="mks_accordion_item"|<\/div>\s*<hr|<\/div>\s*$)/gi;
  let m;
  while ((m = itemRe.exec(html)) !== null) {
    const block = m[1];

    // Heading text (episode label)
    const headingM = block.match(/<div[^>]*mks_accordion_heading[^>]*>([\s\S]*?)<\/div>/i);
    const label = headingM ? stripTags(headingM[1]).trim() : "";

    // Links inside accordion content
    const links = [];
    const linkRe = /<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    const contentM = block.match(/<div[^>]*mks_accordion_content[^>]*>([\s\S]*)/i);
    if (contentM) {
      let lm;
      while ((lm = linkRe.exec(contentM[1])) !== null) {
        links.push({ text: stripTags(lm[2]).trim(), href: lm[1] });
      }
    }

    if (label) {
      episodes.push({ label, links });
    }
  }

  return episodes;
}
