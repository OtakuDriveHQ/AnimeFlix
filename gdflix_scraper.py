"""
GDFlix Direct Link Extractor
=============================
Flow:
  1. Input:  https://gdflix.dev/file/<ID>
  2. Follow redirect → https://new4.gdflix.io/file/<ID>
  3. Parse page → find "Instant DL" button href (busycdn link)
  4. Follow that href → redirects to https://fastdl-one.pages.dev/?url=<FINAL>
  5. Extract & print the `url` query parameter (the real download link)

Dependencies:
  pip install requests beautifulsoup4
"""

import sys
import argparse
from urllib.parse import urlparse, parse_qs
import requests
from bs4 import BeautifulSoup


# ── Browser-like headers to avoid bot detection ──────────────────────────────
HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept": (
        "text/html,application/xhtml+xml,application/xml;"
        "q=0.9,image/avif,image/webp,*/*;q=0.8"
    ),
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    "Connection": "keep-alive",
    "Upgrade-Insecure-Requests": "1",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Sec-Fetch-User": "?1",
}


def make_session() -> requests.Session:
    """Create a requests Session with browser-like headers and redirect support."""
    session = requests.Session()
    session.headers.update(HEADERS)
    return session


def step1_follow_gdflix_redirect(session: requests.Session, url: str) -> str:
    """
    Follow the redirect from gdflix.dev → new4.gdflix.io (or similar).
    Returns the final landing URL after all redirects.
    """
    print(f"[1] Requesting: {url}")
    resp = session.get(url, timeout=30, allow_redirects=True)
    resp.raise_for_status()
    final_url = resp.url
    print(f"[1] Landed on:  {final_url}")
    return final_url, resp.text


def step2_find_instant_dl_link(html: str, page_url: str) -> str:
    """
    Parse the gdflix mirror page HTML and extract the href from the
    'Instant DL [10GBPS]' button (busycdn link).
    """
    soup = BeautifulSoup(html, "html.parser")

    # Strategy 1: look for the exact button text
    for anchor in soup.find_all("a", href=True):
        text = anchor.get_text(" ", strip=True)
        href = anchor["href"]
        if "instant" in text.lower() or "10gbps" in text.lower():
            print(f"[2] Found Instant DL link: {href[:80]}...")
            return href

    # Strategy 2: look for busycdn in href
    for anchor in soup.find_all("a", href=True):
        if "busycdn" in anchor["href"]:
            href = anchor["href"]
            print(f"[2] Found busycdn link:     {href[:80]}...")
            return href

    # Strategy 3: look for btn-danger class (same styling as example)
    for anchor in soup.find_all("a", class_=lambda c: c and "btn-danger" in c, href=True):
        href = anchor["href"]
        print(f"[2] Found btn-danger link:  {href[:80]}...")
        return href

    raise RuntimeError(
        "Could not find the 'Instant DL' button on the page.\n"
        f"Page URL was: {page_url}\n"
        "The site may have changed its layout."
    )


def step3_resolve_busycdn(session: requests.Session, busycdn_url: str) -> str:
    """
    Hit the busycdn link; it will redirect (possibly via JS or HTTP 302)
    to https://fastdl-one.pages.dev/?url=<FINAL_LINK>.
    Returns the final URL after all redirects.
    """
    print(f"[3] Following busycdn URL...")
    resp = session.get(busycdn_url, timeout=30, allow_redirects=True)
    # Even if it's a 200, check if we landed on fastdl-one
    final_url = resp.url
    print(f"[3] Landed on: {final_url[:100]}...")

    # If the redirect already gave us the fastdl URL, we're done
    if "fastdl" in final_url or "url=" in final_url:
        return final_url

    # Sometimes the page itself contains a meta-refresh or JS redirect.
    # Check for meta refresh:
    soup = BeautifulSoup(resp.text, "html.parser")
    meta = soup.find("meta", attrs={"http-equiv": lambda v: v and v.lower() == "refresh"})
    if meta and meta.get("content"):
        content = meta["content"]
        # content is like "0; url=https://..."
        if "url=" in content.lower():
            redirect_url = content.split("url=", 1)[-1].strip().strip("'\"")
            print(f"[3] Meta-refresh → {redirect_url[:100]}...")
            return step3_resolve_busycdn(session, redirect_url)

    # Check for a redirect link in the body
    for anchor in soup.find_all("a", href=True):
        href = anchor["href"]
        if "fastdl" in href or "googleusercontent" in href:
            print(f"[3] Found redirect link in body: {href[:100]}...")
            return href

    # Return whatever we have
    return final_url


def step4_extract_final_url(fastdl_url: str) -> str:
    """
    From https://fastdl-one.pages.dev/?url=<FINAL>
    extract and return the value of the `url` query parameter.
    """
    parsed = urlparse(fastdl_url)
    params = parse_qs(parsed.query)

    if "url" in params:
        direct_url = params["url"][0]
        print(f"[4] Final direct URL extracted ✓")
        return direct_url

    # Maybe the entire URL is already the direct link (no wrapper)
    if "googleusercontent" in fastdl_url or fastdl_url.startswith("https://"):
        print(f"[4] URL appears to be direct already.")
        return fastdl_url

    raise RuntimeError(
        f"Could not extract 'url' parameter from: {fastdl_url}"
    )


def extract_direct_link(gdflix_url: str) -> str:
    """
    Full pipeline: GDFlix URL → direct download link.
    """
    session = make_session()

    # Step 1: Follow redirect to mirror
    landing_url, html = step1_follow_gdflix_redirect(session, gdflix_url)

    # Step 2: Find the Instant DL button
    busycdn_url = step2_find_instant_dl_link(html, landing_url)

    # Step 3: Follow busycdn → fastdl wrapper
    fastdl_url = step3_resolve_busycdn(session, busycdn_url)

    # Step 4: Pull the real URL from the wrapper
    direct_url = step4_extract_final_url(fastdl_url)

    return direct_url


# ── CLI entry point ───────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="Extract a direct download URL from a GDFlix share link."
    )
    parser.add_argument(
        "url",
        nargs="?",
        help="GDFlix URL (e.g. https://gdflix.dev/file/YWuUFO909JnpyN3)",
    )
    args = parser.parse_args()

    if args.url:
        gdflix_url = args.url.strip()
    else:
        gdflix_url = input("Enter GDFlix URL: ").strip()

    if not gdflix_url:
        print("Error: No URL provided.", file=sys.stderr)
        sys.exit(1)

    print("\n" + "=" * 60)
    print("GDFlix Direct Link Extractor")
    print("=" * 60)

    try:
        direct_url = extract_direct_link(gdflix_url)
        print("\n" + "=" * 60)
        print("✅  DIRECT DOWNLOAD URL:")
        print("=" * 60)
        print(direct_url)
        print("=" * 60 + "\n")
    except requests.RequestException as e:
        print(f"\n❌  Network error: {e}", file=sys.stderr)
        sys.exit(1)
    except RuntimeError as e:
        print(f"\n❌  Scraping error: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
