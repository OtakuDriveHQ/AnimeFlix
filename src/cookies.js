/**
 * cookies.js
 * 
 * Stores the exported browser cookies for gdflix.io / cloudflare.com.
 * Update these values whenever cookies expire or are refreshed.
 * 
 * Cookie format: { name, value, domain, path, expires, secure, httpOnly, sameSite }
 */

export const COOKIES = [
  {
    name: "__cf_logged_in",
    value: "1",
    domain: ".cloudflare.com",
    path: "/",
    expires: "2027-11-02T05:00:42.672Z",
    secure: true,
    httpOnly: false,
    sameSite: "Medium",
  },
  {
    name: "_ga",
    value: "GA1.1.804505032.1782841143",
    domain: ".gdflix.io",
    path: "/",
    expires: "2027-11-06T05:32:16.533Z",
    secure: false,
    httpOnly: false,
    sameSite: "Medium",
  },
  {
    name: "_ga_ZYPDHMSKVK",
    value: "GS2.1.s1790919136$o5$g0$t1790919136$j60$l0$h0",
    domain: ".gdflix.io",
    path: "/",
    expires: "2027-11-06T05:32:16.532Z",
    secure: false,
    httpOnly: false,
    sameSite: "Medium",
  },
  {
    name: "_gid",
    value: "GA1.2.1495193981.1790916683",
    domain: ".gdflix.io",
    path: "/",
    expires: "2027-10-03T05:32:16.000Z",
    secure: false,
    httpOnly: false,
    sameSite: "Medium",
  },
  {
    name: "_twpid",
    value: "tw.1790917227563.892844087969639810",
    domain: ".cloudflare.com",
    path: "/",
    expires: "2027-10-27T05:00:27.573Z",
    secure: true,
    httpOnly: false,
    sameSite: "Strict",
  },
  {
    name: "_twsid",
    value: "1790917227563-473004445.1.1790917227572",
    domain: ".cloudflare.com",
    path: "/",
    expires: "2027-10-27T05:00:27.572Z",
    secure: true,
    httpOnly: false,
    sameSite: "Strict",
  },
  {
    name: "CF_VERIFIED_DEVICE_3451f6525c87eb8830f14aeb83da24bf5fea1b14fc88c622c4426df389193a8c",
    value: "1790917230",
    domain: ".cloudflare.com",
    path: "/",
    expires: "2027-11-06T05:00:42.672Z",
    secure: true,
    httpOnly: true,
    sameSite: "Medium",
  },
  {
    name: "OptanonConsent",
    value: "isGpcEnabled=0&datestamp=Fri+Oct+02+2026+10%3A30%3A43+GMT%2B0530+(India+Standard+Time)&version=202503.1.0&browserGpcFlag=0&isIABGlobal=false&hosts=&consentId=2b0e1106-15f7-4ab1-8ca5-419dc4e76564&interactionCount=1&isAnonUser=1&landingPath=NotLandingPage&groups=C0001%3A1%2CC0003%3A1%2CC0002%3A1%2CC0004%3A1&AwaitingReconsent=false",
    domain: ".cloudflare.com",
    path: "/",
    expires: "2027-10-02T05:00:43.000Z",
    secure: false,
    httpOnly: false,
    sameSite: "Lax",
  },
  {
    name: "zaraz-consent",
    value: '{"Tuku":true,"aMDT":true}',
    domain: ".cloudflare.com",
    path: "/",
    expires: "2027-06-28T18:54:16.534Z",
    secure: false,
    httpOnly: false,
    sameSite: "Strict",
  },
  {
    name: "cf_clearance",
    value: "9qFeSQq3tOasqys6dP3JNEq2wcyYsFOsRh6tRN.4GNQ-1790924127-1.2.1.1-akktr571CM.LBXE.lYiB6mqPm4dgrotcZ657ys_CTBSluQmHswBxfxXmiO1ywpx3ka2EorPvwbeQHWWX.RAxi5tv.R7FrYeiTpEPuZJ37H8dbKmNoRXhpG8uxpoGuL3R2.34vEcZkR.dSytbFv8MPLr7ZS_PfNFgCkfLna2LDBhxtq08xKs.Rwh0SKQqoZo2fbe4tLEnAcFjuqbMcgqPXmY34ScVkWl1_6Jci_OHS7gwNwd9Y0mlRQ.SWT7pkgDvQN1YNls9bA4PQgOab0qNlOCNn_KXuS98gNj3PAlymr6xTu5wq4XiI3pknnY3DxfCaGtsSuBuyuSj4GtRq.cVNxkfjVNMt9bQ_fg.nGzA2Dw",
    domain: ".archive.toonworld4all.me",
    path: "/",
    expires: "2027-10-03T06:55:25.521Z",
    secure: true,
    httpOnly: true,
    sameSite: "None",
  },
  {
    name: "user",
    value: "12091892a567774b7ae554ef97b9d3f561422acbb7d51a805a6f4043ce5d32906e3183dc3e80817cb9367dace72ac756aa8d753502cb398ab471c5eb6941101febd124120ecd6e24310aeb40dc405324b87492b7a01bac5e83f92aed9783ba21c93a10bdb364cb66046132e18dc344cb915427e5be0f0fb6f2ccfee9a226795ec10d6ece4d658a8c4677e24f5eb96deb99ca56f4a4ef608b5add3520cf16301142d678fdc2a753914038494d2e18ad2d20fa895018b5ffc663302c19a1289d738e9f5a452fa74d9cfbd71a8a5899ffd87d846f6742ad71a2648f0853b0d6836d04976dd47a1c737e69683b1f7bdc3c52a456b0449a35aad9f420614e79ad2e5846d823f37d6859aadae51ca417003eb39d21efef983b7693933082b065e959c890f30dea6fe6a11494a5de7014bca56b024304e821f0e77d8452ae3758d608448812396d2e5fa3848abacc48194e56ffb93445b62efba24201ac2f6b2be9c73f548e67ab8eb393c61f90b811700a89dcfa20a25910d070d56c304248b9403f1eea4227d5566fb62c45bb7d2c8f773e204265df51cea61184eacf2662d9e857e5c49fb37fb8996bac7b67c8025a16d872ffeb2bd12929828373e8df873aac348d9b1467b1415e308ecc548af5a8eb00dc4466d63073e8a66cd6ad97ddc837e90115a200fbd4a321c87ac10f569b6447678852369f372045e48201abbf992409aa33f60b6945bd88b172552c9220c2134cd54efbc21da431bbc752858038a8675b7a3213a86a2163731d3fe3564cfecfd26d8da4aff5121861e9fbd8032c4b663adb1e9c421916af8e5197fcf2569cad685712776bb90414bdbaeb0037f2b703",
    domain: ".archive.toonworld4all.me",
    path: "/",
    expires: "2027-10-03T06:55:25.521Z",
    secure: true,
    httpOnly: true,
    sameSite: "Strict",
  },
];

/**
 * Parse arbitrary cookie strings (header format, tab-separated format, or JSON)
 * @param {string|Array|Object} input
 * @returns {Array<{name: string, value: string, domain?: string}>}
 */
export function parseCookieInput(input) {
  if (!input) return [];
  if (Array.isArray(input)) return input;

  if (typeof input === "object") {
    const res = [];
    if (input.cf_clearance) res.push({ name: "cf_clearance", value: input.cf_clearance, domain: ".archive.toonworld4all.me" });
    if (input.user) res.push({ name: "user", value: input.user, domain: ".archive.toonworld4all.me" });
    return res;
  }

  if (typeof input === "string") {
    const trimmed = input.trim();
    if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
      try {
        const obj = JSON.parse(trimmed);
        return parseCookieInput(obj);
      } catch (e) {}
    }
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      try {
        return JSON.parse(trimmed);
      } catch (e) {}
    }

    const lines = trimmed.split(/[\r\n]+/);
    const parsed = [];

    for (const line of lines) {
      const parts = line.split("\t");
      if (parts.length >= 2) {
        // Tab-separated format: name, value, domain, ...
        const name = parts[0].trim();
        const value = parts[1].trim();
        const domain = (parts[2] || "").trim();
        if (name && value) {
          parsed.push({ name, value, domain });
        }
      } else {
        // Semicolon-separated format: key=value; key2=value2
        const pairs = line.split(";");
        for (const pair of pairs) {
          const eqIdx = pair.indexOf("=");
          if (eqIdx !== -1) {
            const name = pair.slice(0, eqIdx).trim();
            const value = pair.slice(eqIdx + 1).trim();
            if (name && value) {
              parsed.push({ name, value });
            }
          }
        }
      }
    }
    return parsed;
  }
  return [];
}

/**
 * Build a Cookie header string for requests to a given hostname.
 *
 * @param {string} hostname
 * @param {string|Array} [extraCookies]
 * @returns {string}
 */
export function buildCookieHeader(hostname, extraCookies = null) {
  const isGdflix = hostname.includes("gdflix");
  const isArchive = hostname.includes("archive.toonworld4all.me") || hostname.includes("toonworld4all");
  const isHubcloud = hostname.includes("hubcloud") || hostname.includes("gamerxyt") || hostname.includes("sportverse");
  const isCloudflareOrProtected = hostname.includes("cloudflare") || isArchive || isGdflix || isHubcloud;

  const extra = parseCookieInput(extraCookies);
  const all = [...COOKIES, ...extra];

  const map = new Map();

  for (const c of all) {
    if (!c.name || !c.value) continue;
    const cookieDomain = c.domain
      ? (c.domain.startsWith(".") ? c.domain.slice(1) : c.domain)
      : "";

    let match = false;
    if (!cookieDomain) {
      // Cookies without specific domain are forwarded to all protected targets
      match = true;
    } else if (hostname === cookieDomain || hostname.endsWith("." + cookieDomain)) {
      match = true;
    } else if (isGdflix && cookieDomain.includes("gdflix")) {
      match = true;
    } else if (isArchive && (cookieDomain.includes("toonworld4all") || cookieDomain.includes("cloudflare"))) {
      match = true;
    } else if (isCloudflareOrProtected && cookieDomain.includes("cloudflare")) {
      match = true;
    }

    if (match) {
      map.set(c.name, c.value);
    }
  }

  return Array.from(map.entries())
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}
