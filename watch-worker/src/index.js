export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const videoUrl = url.searchParams.get("url") || url.searchParams.get("v");

    if (!videoUrl) {
      return new Response(getLandingHtml(), {
        headers: { "Content-Type": "text/html;charset=UTF-8" }
      });
    }

    return new Response(getPlayerHtml(videoUrl), {
      headers: { "Content-Type": "text/html;charset=UTF-8" }
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
    <p>Provide a direct video link (Google CDN, GDFlix, etc.) to start streaming.</p>
    <div class="input-group">
        <input type="text" id="vUrl" placeholder="https://video-downloads.googleusercontent.com/...">
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
  // Sanitize the URL to prevent XSS
  const safeUrl = videoUrl.replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  
  return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Playing Video - AnimeFlix Player</title>
    <!-- Video.js CSS -->
    <link href="https://vjs.zencdn.net/8.10.0/video-js.css" rel="stylesheet" />
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
            font-family: system-ui, -apple-system, sans-serif;
        }
        .player-container {
            width: 100%;
            height: 100%;
            max-width: 100vw;
            max-height: 100vh;
        }
        /* Make Video.js player fill the screen and customize color */
        .video-js {
            width: 100% !important;
            height: 100% !important;
        }
        .vjs-theme-animeflix {
            --vjs-theme-fantasy--primary: #38bdf8;
        }
        .video-js .vjs-control-bar,
        .video-js .vjs-big-play-button {
            background-color: rgba(15, 23, 42, 0.7);
        }
        .video-js .vjs-play-progress,
        .video-js .vjs-volume-level {
            background-color: #38bdf8;
        }
        .error-overlay {
            position: absolute;
            top: 0; left: 0; right: 0; bottom: 0;
            background: rgba(0,0,0,0.8);
            color: #f87171;
            display: none;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            z-index: 99;
            text-align: center;
            padding: 20px;
        }
        .error-overlay h2 { margin-top: 0; }
        .error-overlay a { color: #38bdf8; text-decoration: none; margin-top: 15px; display: inline-block; padding: 10px 20px; border: 1px solid #38bdf8; border-radius: 6px; }
    </style>
</head>
<body>
    <div class="player-container">
        <video
            id="player"
            class="video-js vjs-default-skin vjs-big-play-centered"
            controls
            preload="auto"
            autoplay
            data-setup='{"fluid": false}'
        >
            <source src="${safeUrl}" type="video/mp4" />
            <p class="vjs-no-js">
              To view this video please enable JavaScript, and consider upgrading to a web browser that supports HTML5 video.
            </p>
        </video>
    </div>
    
    <div class="error-overlay" id="error-box">
        <h2>Video Failed to Load</h2>
        <p>The link might be expired, IP-locked, or the video format (.mkv) is unsupported by your browser.</p>
        <p style="font-size: 0.9em; color: #94a3b8; max-width: 500px; word-wrap: break-word;">${safeUrl}</p>
        <a href="${safeUrl}" target="_blank">Try Downloading Directly</a>
        <a href="/" style="margin-left: 10px; border-color: #94a3b8; color: #94a3b8;">Go Back</a>
    </div>

    <!-- Video.js JS -->
    <script src="https://vjs.zencdn.net/8.10.0/video.min.js"></script>
    <script>
        document.addEventListener('DOMContentLoaded', () => {
            const player = videojs('player');
            
            // Handle native video errors
            player.on('error', function() {
                console.error("Video error:", player.error());
                document.getElementById('error-box').style.display = 'flex';
            });
        });
    </script>
</body>
</html>`;
}
