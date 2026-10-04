# GDFlix Direct Link Extractor

Extracts the final direct download URL from a GDFlix share link by following the full redirect chain.

## How It Works

```
gdflix.dev/file/<ID>
      ↓  (HTTP redirect)
new4.gdflix.io/file/<ID>
      ↓  (parse page HTML → find "Instant DL [10GBPS]" button)
instant.busycdn.xyz/...
      ↓  (HTTP redirect)
fastdl-one.pages.dev/?url=<FINAL>
      ↓  (extract ?url= param)
✅ Direct download URL
```

## Setup

1. **Install Python** (if not already): https://www.python.org/downloads/
2. **Install dependencies:**
   ```bat
   cd C:\Users\Pradhan\.gemini\antigravity\scratch\gdflix-scraper
   pip install -r requirements.txt
   ```

## Usage

**Pass URL as argument:**
```bat
python gdflix_scraper.py https://gdflix.dev/file/YWuUFO909JnpyN3
```

**Interactive prompt:**
```bat
python gdflix_scraper.py
# then paste the URL when prompted
```

## Example Output

```
============================================================
GDFlix Direct Link Extractor
============================================================
[1] Requesting: https://gdflix.dev/file/YWuUFO909JnpyN3
[1] Landed on:  https://new4.gdflix.io/file/YWuUFO909JnpyN3
[2] Found Instant DL link: https://instant.busycdn.xyz/aba1d4c0...
[3] Following busycdn URL...
[3] Landed on: https://fastdl-one.pages.dev/?url=https://video-d...
[4] Final direct URL extracted ✓

============================================================
✅  DIRECT DOWNLOAD URL:
============================================================
https://video-downloads.googleusercontent.com/ADGPM2...
============================================================
```

## Notes

- The script uses `requests` with browser-like headers — **no real browser needed**, no JavaScript execution.
- Popup ads are irrelevant since we skip the browser entirely and scrape raw HTML.
- The busycdn link has a short TTL — run the script and download immediately.
- If the site changes layout, the script tries 3 fallback strategies to find the button.
