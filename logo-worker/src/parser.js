/**
 * HTML Parser - lightweight regex-based HTML parser for Cloudflare Workers
 * No external dependencies needed - works in the Workers runtime
 */

/**
 * Extract all matching elements by tag and optional class/attribute
 */
function extractElements(html, tag, attrName, attrValue) {
  const results = [];
  // Build a regex to find opening tags
  const tagRegex = new RegExp(
    `<${tag}([^>]*?)>([\\s\\S]*?)(?:<\\/${tag}>)`,
    'gi'
  );

  let match;
  while ((match = tagRegex.exec(html)) !== null) {
    const attrs = match[1];
    const content = match[2];

    if (attrName && attrValue) {
      // Check if the attribute matches
      const attrRegex = new RegExp(`${attrName}\\s*=\\s*["']([^"']*)["']`);
      const attrMatch = attrs.match(attrRegex);
      if (attrMatch && attrMatch[1].includes(attrValue)) {
        results.push({ attrs, content, fullMatch: match[0] });
      }
    } else {
      results.push({ attrs, content, fullMatch: match[0] });
    }
  }

  return results;
}

/**
 * Extract attribute value from an HTML tag string
 */
function getAttr(tagStr, attrName) {
  const regex = new RegExp(`${attrName}\\s*=\\s*["']([^"']*)["']`);
  const match = tagStr.match(regex);
  return match ? match[1] : null;
}

/**
 * Extract all <a> tags with their href
 */
function extractLinks(html) {
  const links = [];
  const linkRegex = /<a\s+([^>]*?)>([\s\S]*?)(?:<\/a>)/gi;
  let match;
  while ((match = linkRegex.exec(html)) !== null) {
    const href = getAttr(match[0], 'href');
    const title = getAttr(match[0], 'title');
    const content = match[2].replace(/<[^>]*>/g, '').trim();
    links.push({ href, title, content, fullMatch: match[0] });
  }
  return links;
}

/**
 * Extract all <img> tags with their src
 */
function extractImages(html) {
  const images = [];
  const imgRegex = /<img\s+([^>]*?)\/?>/gi;
  let match;
  while ((match = imgRegex.exec(html)) !== null) {
    const src = getAttr(match[0], 'src');
    const alt = getAttr(match[0], 'alt');
    const dataSrc = getAttr(match[0], 'data-src');
    images.push({ src: src || dataSrc, alt, fullMatch: match[0] });
  }
  return images;
}

/**
 * Decode HTML entities
 */
function decodeEntities(str) {
  if (!str) return '';
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(code));
}

export { extractElements, getAttr, extractLinks, extractImages, decodeEntities };
