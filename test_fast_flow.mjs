// Benchmark fast path extraction
const GOOGLE_RE = /https?:\/\/video-downloads\.googleusercontent\.com\/[^\s"'<>]+/i;

async function fastFollowInstantUrl(instantUrl) {
  const t0 = Date.now();
  // 1. Fast manual redirect check (1 hop)
  try {
    const res = await fetch(instantUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
        "Accept": "text/html,*/*;q=0.8",
        "Referer": "https://new4.gdflix.io/",
      },
      redirect: "manual",
      signal: AbortSignal.timeout(4000),
    });

    // Check location header
    const loc = res.headers.get("location");
    if (loc) {
      console.log(`[Manual 302 in ${Date.now() - t0}ms] Location:`, loc.slice(0, 80));
      // Location has direct link
      if (GOOGLE_RE.test(loc)) return loc.match(GOOGLE_RE)[0];

      // Location has ?url=
      const p = new URL(loc, instantUrl).searchParams.get("url");
      if (p && GOOGLE_RE.test(p)) {
        console.log(`[Extracted from ?url= in ${Date.now() - t0}ms]`);
        return p.match(GOOGLE_RE)[0];
      }

      // Location is foxcloud
      if (loc.includes("foxcloud.rest")) {
        console.log(`[Jump to Foxcloud in ${Date.now() - t0}ms]`);
        return await fastExtractFoxcloud(loc);
      }
    }

    if (res.status === 200) {
      const ct = res.headers.get("content-type") || "";
      if (ct.includes("video/") || ct.includes("octet-stream")) {
        return res.url;
      }
      const html = await res.text();
      const m = html.match(GOOGLE_RE);
      if (m) return m[0];
    }
  } catch (e) {
    console.warn("Fast manual hop error:", e.message);
  }

  return null;
}

async function fastExtractFoxcloud(foxcloudUrl) {
  const t0 = Date.now();
  try {
    const res = await fetch(foxcloudUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Referer": "https://new4.gdflix.io/",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const html = await res.text();
    const m = html.match(GOOGLE_RE);
    if (m) {
      console.log(`[Foxcloud extracted in ${Date.now() - t0}ms]`);
      return m[0];
    }
  } catch (e) {
    console.warn("fastExtractFoxcloud error:", e.message);
  }
  return null;
}

const foxcloudUrl = "https://quick.foxcloud.rest/upload?url=1d287a1dfaf9130042ecdcfc67a5babfc59209327d72a78e57c3946a99d7d22f388540abea5bd4cabaa7964abaa28f9e14f23687edfa350938b7a20a0ec67be0f7dc44942256b9a6e9833d1073558a0e::05c46863052aa420e3ac22deae58d9bc";

console.log("Running fastFoxcloud test...");
fastExtractFoxcloud(foxcloudUrl).then(res => {
  console.log("Result:", res ? res.slice(0, 60) + "..." : "NULL");
});
