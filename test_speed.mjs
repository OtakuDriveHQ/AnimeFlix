// Test redirect: "manual" on busycdn vs redirect: "follow"
async function test() {
  const foxcloudUrl = "https://quick.foxcloud.rest/upload?url=1d287a1dfaf9130042ecdcfc67a5babfc59209327d72a78e57c3946a99d7d22f388540abea5bd4cabaa7964abaa28f9e14f23687edfa350938b7a20a0ec67be0f7dc44942256b9a6e9833d1073558a0e::05c46863052aa420e3ac22deae58d9bc";

  console.log("Testing foxcloud manual vs follow...");
  const t0 = Date.now();
  const res = await fetch(foxcloudUrl, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
      "Accept": "text/html,*/*;q=0.8",
      "Referer": "https://new4.gdflix.io/",
    },
    redirect: "manual",
  });
  console.log("Foxcloud status:", res.status, "took", Date.now() - t0, "ms");
  const loc = res.headers.get("location");
  console.log("Location:", loc);
  if (res.status === 200) {
    const t1 = Date.now();
    const html = await res.text();
    console.log("HTML length:", html.length, "read took", Date.now() - t1, "ms");
    const m = html.match(/https?:\/\/video-downloads\.googleusercontent\.com\/[^\s"'<>]+/i);
    console.log("Extracted:", m ? m[0].slice(0, 60) + "..." : "NONE");
  }
}

test();
