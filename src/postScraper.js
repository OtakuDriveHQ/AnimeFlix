/**
 * postScraper.js
 *
 * Scrapes a single toonworld4all.me post page and returns structured data:
 *  - title
 *  - thumbnail URL (vertical poster inside entry-content)
 *  - banner URL (wide landscape banner from Yoast ImageObject schema / og:image)
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
 *   banner: string|null,
 *   meta: Record<string,string>,
 *   synopsis: string,
 *   seasons: { name: string, episodes: { label: string, links: {text:string, href:string}[] }[] }[]
 * }}
 */
export function scrapePost(html) {
  const banner = extractBanner(html);
  const thumbnail = extractThumbnail(html) || banner;

  return {
    title:     extractTitle(html),
    thumbnail: thumbnail,
    banner:    banner || thumbnail,
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

// ─── 2. Banner (Yoast ImageObject / og:image) ─────────────────────────────────
function extractBanner(html) {
  // 1. Check Yoast JSON-LD ImageObject schema: {"@type":"ImageObject", ... "url":"..."}
  const regex = /"@type"\s*:\s*"ImageObject"[^}]*?"url"\s*:\s*"([^"]+)"/g;
  let m;
  while ((m = regex.exec(html)) !== null) {
    const url = m[1].replace(/&amp;/g, "&");
    if (!url.includes("logo") && !url.includes("gravatar") && !url.includes("default")) {
      return url;
    }
  }

  // 2. Check OpenGraph image tag
  const ogMatch = html.match(/<meta\s+property="og:image"\s+content="([^"]+)"/i);
  if (ogMatch && !ogMatch[1].includes("logo")) {
    return ogMatch[1].replace(/&amp;/g, "&");
  }

  return null;
}

// ─── 3. Thumbnail (Poster image) ──────────────────────────────────────────────
function extractThumbnail(html) {
  // Find the entry-content div first, then grab the first <img> inside it
  const contentMatch = html.match(/<div[^>]*class="[^"]*entry-content[^"]*"[^>]*>([\s\S]*)/i);
  if (!contentMatch) return null;

  const contentHtml = contentMatch[1];
  const imgMatch = contentHtml.match(/<img[^>]+src="([^"]+)"[^>]*>/i);
  return imgMatch ? imgMatch[1] : null;
}

// ─── 4. Meta fields ───────────────────────────────────────────────────────────
function extractMeta(html) {
  const metaFields = {};

  const fieldPattern = /<span[^>]*color:\s*#ff0000[^>]*>([^<]+)<\/span>\s*([\s\S]*?)(?=<br\s*\/?>|<strong><span[^>]*color:\s*#(?:ff0000|0000ff)[^>]*>|<\/p>)/gi;

  let m;
  while ((m = fieldPattern.exec(html)) !== null) {
    const key = stripTags(m[1]).replace(/:$/, "").trim();
    const value = stripTags(m[2]).trim();
    if (key && value && key.toLowerCase() !== "synopsis") {
      metaFields[key] = value;
    }
  }

  return metaFields;
}

// ─── 5. Synopsis ──────────────────────────────────────────────────────────────
function extractSynopsis(html) {
  const synMatch = html.match(/<span[^>]*color:\s*#ff0000[^>]*>Synopsis:<\/span>\s*([\s\S]*?)<\/p>/i);
  if (!synMatch) return "";
  return stripTags(synMatch[1]).trim();
}

// ─── 6. Seasons + Episodes ────────────────────────────────────────────────────
function extractAccordionEpisodes(blockHtml) {
  const episodes = [];
  const itemRe = /<div\s+class="mks_accordion_item">([\s\S]*?)(?=<div\s+class="mks_accordion_item"|<\/div>\s*<\/div>|<\/div>\s*<hr|<\/div>\s*$)/gi;
  let m;
  while ((m = itemRe.exec(blockHtml)) !== null) {
    const block = m[1];
    const headingM = block.match(/<div[^>]*mks_accordion_heading[^>]*>([\s\S]*?)<\/div>/i);
    const label = headingM ? stripTags(headingM[1]).trim() : "";

    const links = [];
    const linkRe = /<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    const contentM = block.match(/<div[^>]*mks_accordion_content[^>]*>([\s\S]*)/i);
    if (contentM) {
      let lm;
      while ((lm = linkRe.exec(contentM[1])) !== null) {
        const href = lm[1].trim();
        const text = stripTags(lm[2]).trim();
        if (href && !href.startsWith("#")) {
          links.push({ text, href });
        }
      }
    }

    if (label && links.length > 0) {
      episodes.push({ label, links });
    }
  }
  return episodes;
}

function extractSeasons(html) {
  const contentMatch = html.match(/<div[^>]*class="[^"]*entry-content[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<!-- \.entry-content -->/i)
    || html.match(/<div[^>]*class="[^"]*entry-content[^"]*"[^>]*>([\s\S]*)/i);

  const contentHtml = contentMatch ? contentMatch[1] : html;

  const accPositions = [];
  const accRegex = /<div\s+class="mks_accordion">/gi;
  let am;
  while ((am = accRegex.exec(contentHtml)) !== null) {
    accPositions.push(am.index);
  }

  if (accPositions.length === 0) {
    // Fallback 1: check schema-faq-section
    const seasonRegex = /<div class="schema-faq-section"[\s\S]*?<strong class="schema-faq-question">([\s\S]*?)<\/strong>([\s\S]*?)(?=<div class="schema-faq-section"|$)/gi;
    let seasonMatch;
    const faqSeasons = [];
    while ((seasonMatch = seasonRegex.exec(contentHtml)) !== null) {
      const seasonName = stripTags(seasonMatch[1]).trim();
      const seasonBody = seasonMatch[2];
      const episodes = [];
      const pRegex = /<p[^>]*>([\s\S]*?)<\/p>/gi;
      let pMatch;
      while ((pMatch = pRegex.exec(seasonBody)) !== null) {
        const pContent = pMatch[1];
        const aRegex = /<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
        const links = [];
        let aMatch;
        while ((aMatch = aRegex.exec(pContent)) !== null) {
          const href = aMatch[1].trim();
          const text = stripTags(aMatch[2]).trim();
          if (href && !href.startsWith("#")) links.push({ text, href });
        }
        if (links.length > 0) {
          const labelText = stripTags(pContent.replace(/<a[\s\S]*?<\/a>/gi, "")).trim();
          const label = labelText.replace(/[:\-\s]+$/, "").trim() || links[0].text;
          episodes.push({ label, links });
        }
      }
      if (episodes.length > 0) {
        faqSeasons.push({ name: seasonName, episodes });
      }
    }
    if (faqSeasons.length > 0) return faqSeasons;

    // Fallback 2: Direct download buttons in entry-content (e.g. some movies)
    const directButtons = [];
    const btnRe = /<a[^>]+(?:class="[^"]*(?:mks_button|btn_download|download-btn)[^"]*"|href="https:\/\/archive\.toonworld4all\.me\/[^"]+")[^>]*>([\s\S]*?)<\/a>/gi;
    let bm;
    while ((bm = btnRe.exec(contentHtml)) !== null) {
      const hrefMatch = bm[0].match(/href="([^"]+)"/i);
      if (hrefMatch && !hrefMatch[1].startsWith("#")) {
        directButtons.push({ text: stripTags(bm[1]).trim() || "Download", href: hrefMatch[1].trim() });
      }
    }
    if (directButtons.length > 0) {
      return [{
        name: "MOVIE",
        episodes: [{ label: "Full Movie", links: directButtons }]
      }];
    }

    return [];
  }

  const seasons = [];
  for (let i = 0; i < accPositions.length; i++) {
    const start = accPositions[i];
    const end = i + 1 < accPositions.length ? accPositions[i + 1] : contentHtml.length;
    const block = contentHtml.slice(start, end);

    const beforeBlock = contentHtml.slice(Math.max(0, start - 800), start);
    // Find headings or paragraphs with SEASON
    const headingMatches = [...beforeBlock.matchAll(/(?:<p[^>]*>|<h[1-6][^>]*>|<div[^>]*>)([\s\S]*?)(?:<\/p>|<\/h[1-6]>|<\/div>)/gi)];
    let seasonName = "";
    if (headingMatches.length > 0) {
      for (let j = headingMatches.length - 1; j >= 0; j--) {
        const raw = stripTags(headingMatches[j][1]).replace(/^[|–—\s]+|[|–—\s]+$/g, "").trim();
        // Avoid NOTE paragraphs or generic text
        if (/^NOTE\s*:/i.test(raw)) continue;
        if (/DOWNLOAD\s+[\w\s:]+EPISODES/i.test(raw)) continue;
        if (/SEASON\s*[\dIVXLCDM\w]+/i.test(raw) && raw.length <= 80) {
          seasonName = raw;
          break;
        }
      }
    }

    if (!seasonName) {
      seasonName = accPositions.length > 1 ? `SEASON ${i + 1}` : "SEASON 1";
    }

    const episodes = extractAccordionEpisodes(block);
    if (episodes.length > 0) {
      seasons.push({ name: seasonName, episodes });
    }
  }

  return seasons;
}
