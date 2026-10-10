export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    
    // Serve as a CORS proxy for the video stream so WASM can read the bytes
    if (url.pathname === "/proxy") {
      const target = url.searchParams.get("url");
      if (!target) return new Response("Missing URL", { status: 400 });
      
      const reqHeaders = new Headers(request.headers);
      reqHeaders.delete("Origin");
      reqHeaders.delete("Referer");
      
      const response = await fetch(target, {
        method: request.method,
        headers: reqHeaders,
        redirect: "follow"
      });
      
      const newResponse = new Response(response.body, response);
      newResponse.headers.set("Access-Control-Allow-Origin", "*");
      newResponse.headers.set("Cross-Origin-Resource-Policy", "cross-origin");
      return newResponse;
    }

    const videoUrl = url.searchParams.get("url") || url.searchParams.get("v");

    if (!videoUrl) {
      return new Response(getLandingHtml(), {
        headers: { "Content-Type": "text/html;charset=UTF-8" }
      });
    }

    const html = getPlayerHtml(videoUrl);
    return new Response(html, {
      headers: { 
        "Content-Type": "text/html;charset=UTF-8",
        // Enable SharedArrayBuffer fast-path for WASM
        "Cross-Origin-Opener-Policy": "same-origin",
        "Cross-Origin-Embedder-Policy": "require-corp"
      }
    });
  }
};

function getLandingHtml() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>AnimeFlix Web Player</title>
    <style>
        body { margin: 0; padding: 0; background-color: #0f172a; color: #f8fafc; font-family: system-ui, -apple-system, sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; text-align: center; }
        h1 { font-size: 2rem; margin-bottom: 1rem; color: #38bdf8; }
        p { color: #94a3b8; max-width: 400px; margin-bottom: 2rem; }
        .input-group { display: flex; width: 100%; max-width: 500px; gap: 8px; padding: 0 16px; box-sizing: border-box; }
        input { flex: 1; padding: 12px 16px; border-radius: 8px; border: 1px solid #334155; background: #1e293b; color: white; font-size: 1rem; outline: none; }
        input:focus { border-color: #38bdf8; }
        button { padding: 12px 24px; border-radius: 8px; border: none; background: #38bdf8; color: #0f172a; font-size: 1rem; font-weight: bold; cursor: pointer; transition: background 0.2s; }
        button:hover { background: #7dd3fc; }
    </style>
</head>
<body>
    <h1>AnimeFlix Player</h1>
    <p>Provide a direct video link to start streaming using Movi Player (MKV supported!).</p>
    <div class="input-group">
        <input type="text" id="vUrl" placeholder="https://video-downloads...">
        <button onclick="playVideo()">Play</button>
    </div>
    <script>
        function playVideo() {
            const val = document.getElementById("vUrl").value.trim();
            if (val) {
                window.location.href = "/?url=" + encodeURIComponent(val);
            }
        }
    </script>
</body>
</html>`;
}

function getPlayerHtml(videoUrl) {
  const safeUrl = videoUrl.replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  // Use our worker as a CORS proxy so the WASM engine can fetch byte ranges
  const proxyUrl = "/proxy?url=" + encodeURIComponent(videoUrl);
  
  return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Playing Video - AnimeFlix Player</title>
    <style>
        body { 
            margin: 0; 
            padding: 0; 
            background-color: #000; 
            width: 100vw; 
            height: 100vh; 
            display: flex; 
            align-items: center; 
            justify-content: center; 
            overflow: hidden;
        }
        movi-player {
            width: 100%;
            height: 100%;
            --movi-theme-primary: #38bdf8;
        }
    </style>
</head>
<body>
    <movi-player src="${proxyUrl}" fallback="native" controls autoplay></movi-player>
    
    <script type="module" src="https://cdn.jsdelivr.net/npm/movi-player/dist/element.js"></script>
    <script>
        const player = document.querySelector('movi-player');
        player.addEventListener('nativefallback', () => {
            console.warn('Movi Player fell back to native browser decoding (likely unsupported format or CORS issue).');
        });
    </script>
</body>
</html>`;
}
