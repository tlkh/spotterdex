#!/usr/bin/env python3
"""Render SpotterDex's public page shells and featured photography."""

from __future__ import annotations

import html
import json
import re
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import quote, urljoin

try:
    from build_apple_web_app_assets import LAUNCH_BACKGROUND, render_startup_links
except ImportError:  # Support importing as tools.build_pages.
    from tools.build_apple_web_app_assets import LAUNCH_BACKGROUND, render_startup_links


SITE_URL = "https://tlkh.github.io/spotterdex"
SHARED_IMAGE = f"{SITE_URL}/assets/generated/photos/location-hero-gifu-air-base.jpg"
PORTFOLIO_CONFIG = Path("tools/homepage_selection.json")
PORTFOLIO_HERO_TOKEN = "{{PORTFOLIO_HERO}}"
PORTFOLIO_WORK_TOKEN = "{{PORTFOLIO_WORK}}"

PAGE_DEFINITIONS: Dict[str, Dict[str, str]] = {
    "index.html": {
        "view_id": "homeView",
        "label": "Home",
        "title": "Timothy Liu | Aviation Photographer | SpotterDex",
        "description": "Aviation photography by Timothy Liu. Explore selected work and the SpotterDex archive.",
        "og_title": "Timothy Liu | Aviation Photographer",
        "og_description": "Selected aviation photography by Timothy Liu, from air bases and airports across Asia.",
        "content": "home.html",
    },
    "map.html": {
        "view_id": "mapView",
        "label": "World Map",
        "title": "World Map | SpotterDex",
        "description": "Explore aircraft spotting locations and aviation photographs on the SpotterDex world map.",
        "og_title": "World Map | SpotterDex",
        "og_description": "Explore aircraft spotting locations and aviation photographs on the SpotterDex world map.",
        "content": "map.html",
    },
    "aircraft-dex.html": {
        "view_id": "dexView",
        "label": "Aircraft Dex",
        "title": "Aircraft Dex | SpotterDex",
        "description": "Browse the SpotterDex visual field guide by aircraft type, operator, and location.",
        "og_title": "Aircraft Dex | SpotterDex",
        "og_description": "A visual field guide to aircraft, operators, and spotting locations.",
        "content": "aircraft-dex.html",
    },
    "squadrons.html": {
        "view_id": "squadronsView",
        "label": "Squadrons",
        "title": "Squadrons | SpotterDex",
        "description": "Browse squadron insignia, aircraft, and photographic records in SpotterDex.",
        "og_title": "Squadrons | SpotterDex",
        "og_description": "Squadron insignia, aircraft, and photographic records.",
        "content": "squadrons.html",
    },
    "airshows.html": {
        "view_id": "airshowsView",
        "label": "Airshows",
        "title": "Airshows | SpotterDex",
        "description": "Browse SpotterDex airshow field reports and event photography.",
        "og_title": "Airshows | SpotterDex",
        "og_description": "Chronological field reports from displays, rehearsals, and aviation gatherings.",
        "content": "airshows.html",
    },
    "stats.html": {
        "view_id": "statsView",
        "label": "Stats",
        "title": "Stats | SpotterDex",
        "description": "Explore collection totals and camera metadata from the SpotterDex archive.",
        "og_title": "Stats | SpotterDex",
        "og_description": "Collection totals and camera metadata from the SpotterDex archive.",
        "content": "stats.html",
    },
}

NAV_PAGES = (
    ("index.html", "Home"),
    ("map.html", "Map"),
    ("aircraft-dex.html", "Aircraft"),
    ("airshows.html", "Airshows"),
    ("squadrons.html", "Squadrons"),
    ("stats.html", "Stats"),
)


def page_options(active_file: str) -> str:
    return "\n".join(
        f'          <option value="{filename}"{(" selected" if filename == active_file else "")}>{label}</option>'
        for filename, label in NAV_PAGES
    )


def page_navigation(active_file: str) -> str:
    links = []
    for filename, label in NAV_PAGES:
        active_class = " is-active" if filename == active_file else ""
        current_marker = ' aria-current="page"' if filename == active_file else ""
        links.append(
            f'        <a class="tab-button{active_class}" href="{filename}"'
            f'{current_marker}>{label}</a>'
        )
    return "\n".join(links)


def map_globe_icon() -> str:
    return (
        '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">'
        '<path class="globe-earth-land" d="M21.54 15H17a2 2 0 0 0-2 2v4.54"></path>'
        '<path class="globe-earth-land" d="M7 3.34V5a3 3 0 0 0 3 3 2 2 0 0 1 2 2c0 1.1.9 2 2 2a2 2 0 0 0 2-2c0-1.1.9-2 2-2h3.17"></path>'
        '<path class="globe-earth-land" d="M11 21.95V18a2 2 0 0 0-2-2 2 2 0 0 1-2-2v-1a2 2 0 0 0-2-2H2.05"></path>'
        '<circle class="globe-earth-outline" cx="12" cy="12" r="10"></circle>'
        "</svg>"
    )


def search_icon() -> str:
    return (
        '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">'
        '<circle cx="11" cy="11" r="7"></circle>'
        '<path d="m16.5 16.5 4 4"></path>'
        "</svg>"
    )


def global_search_button() -> str:
    return (
        '<button class="header-global-search-trigger" type="button" '
        'data-global-search-trigger aria-label="Search the SpotterDex archive" '
        'title="Search the archive" aria-keyshortcuts="Control+K Meta+K">'
        f"{search_icon()}"
        "<span>Search archive</span>"
        '<kbd aria-hidden="true">⌘K</kbd>'
        "</button>"
    )


def render_header(active_file: str, is_map: bool) -> str:
    active_options = page_options(active_file)
    navigation = page_navigation(active_file)
    search_button = global_search_button()
    if is_map:
        return f'''    <header class="site-header">
      <div class="brand">
        <button class="brand-mark" id="fitPinsIconButton" type="button" aria-label="Fit all map locations" title="Fit all map locations">
          <img src="assets/icons/spotterdex-ui-icon-64.png" alt="">
        </button>
        <a class="brand-copy" href="index.html" aria-label="SpotterDex home">
          <span class="brand-title">SpotterDex</span>
          <span class="brand-subtitle">Timothy's Logbook</span>
        </a>
      </div>

      <nav class="tab-nav" aria-label="Main views">
{navigation}
      </nav>

      <div class="header-actions">
        {search_button}
        <button class="header-fit-button" type="button" id="fitPinsButton" aria-label="Fit all map locations" title="Fit all map locations">
          {map_globe_icon()}
        </button>
        <select class="nav-select" id="viewSelect" aria-label="Main view">
{active_options}
        </select>
      </div>

      <div class="mobile-map-header" aria-label="Map location controls">
        <button class="mobile-map-brand" type="button" id="mobileMapFitButton" aria-label="Fit all map locations" title="Fit all map locations">
          <span class="mobile-map-location-mark" aria-hidden="true">
            <img src="assets/icons/spotterdex-ui-icon-64.png" alt="">
          </span>
          <span class="mobile-map-brand-copy">
            <strong>SpotterDex</strong>
            <small>Timothy's Logbook</small>
          </span>
        </button>
        <div class="mobile-map-control-group">
          <button class="mobile-map-location-card" type="button" data-map-panel-toggle="locations" aria-controls="mapControlPanel" aria-expanded="false">
            <span class="mobile-map-location-copy">
              <span>Locations</span>
              <strong id="mobileMapLocationTitle">Browse locations</strong>
            </span>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6"></path></svg>
          </button>
          {search_button}
          <button class="header-fit-button mobile-map-fit-button" type="button" id="mobileMapHeaderFitButton" aria-label="Fit all map locations" title="Fit all map locations">
            {map_globe_icon()}
          </button>
        </div>
      </div>
    </header>'''
    return f'''    <header class="site-header">
      <a class="brand" href="index.html" aria-label="SpotterDex home">
        <span class="brand-mark" aria-hidden="true"><img src="assets/icons/spotterdex-ui-icon-64.png" alt=""></span>
        <span><span class="brand-title">SpotterDex</span><span class="brand-subtitle">Timothy's Logbook</span></span>
      </a>
      <nav class="tab-nav" aria-label="Main views">
{navigation}
      </nav>
      <div class="header-actions">
        {search_button}
        <select class="nav-select" id="viewSelect" aria-label="Main view">
{active_options}
        </select>
      </div>
    </header>'''


def _parse_size(value: Any) -> Optional[Tuple[int, int]]:
    match = re.fullmatch(r"\s*(\d+)\s*x\s*(\d+)\s*", str(value or ""), flags=re.IGNORECASE)
    if not match:
        return None
    width, height = int(match.group(1)), int(match.group(2))
    return (width, height) if width > 0 and height > 0 else None


def _read_portfolio(root: Path) -> Tuple[Dict[str, Any], Dict[str, Dict[str, Any]], Dict[str, Any]]:
    config_path = root / PORTFOLIO_CONFIG
    manifest_path = root / "data" / "spotterdex.json"
    try:
        config = json.loads(config_path.read_text(encoding="utf-8"))
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError(f"Could not load homepage photography data: {exc}") from exc

    hero = config.get("hero") if isinstance(config, dict) else None
    selected = config.get("selected") if isinstance(config, dict) else None
    if not isinstance(hero, str) or not hero:
        raise ValueError(f"{config_path} must define a photo ID in 'hero'.")
    if not isinstance(selected, list) or len(selected) != 6 or any(not isinstance(item, str) or not item for item in selected):
        raise ValueError(f"{config_path} must define exactly six photo IDs in 'selected'.")
    chosen = [hero, *selected]
    if len(set(chosen)) != 7:
        raise ValueError(f"{config_path} must contain seven distinct photo IDs.")

    entities = manifest.get("entities", {}) if isinstance(manifest, dict) else {}
    photos = entities.get("photos", {}) if isinstance(entities, dict) else {}
    if not isinstance(photos, dict):
        raise ValueError("data/spotterdex.json has no photo entity index.")
    missing = [photo_id for photo_id in chosen if photo_id not in photos]
    if missing:
        raise ValueError("Homepage photo IDs are missing from data/spotterdex.json: " + ", ".join(missing))
    return config, {photo_id: photos[photo_id] for photo_id in chosen}, entities


def _portfolio_caption(photo: Dict[str, Any], entities: Dict[str, Any]) -> Tuple[str, str, str]:
    subjects = photo.get("subjects") or []
    primary = next((subject for subject in subjects if subject.get("primary")), subjects[0] if subjects else {})
    aircraft = entities.get("aircraft", {})
    locations = entities.get("locations", {})
    events = entities.get("events", {})
    aircraft_name = str(aircraft.get(primary.get("aircraftId"), {}).get("name") or "")
    location = locations.get(photo.get("locationId"), {})
    location_name = str(location.get("name") or "")
    if not location_name and photo.get("eventId"):
        location_name = str(events.get(photo.get("eventId"), {}).get("name") or "")
    year = str(photo.get("year") or "")
    title = aircraft_name or str(photo.get("title") or photo.get("caption") or "Aviation photograph")
    detail = " · ".join(part for part in (location_name, year) if part)
    alt = str(photo.get("caption") or photo.get("title") or title)
    return title, detail, alt


def _render_portfolio_photo(
    photo_id: str,
    photo: Dict[str, Any],
    entities: Dict[str, Any],
    *,
    hero: bool,
) -> str:
    image = str(photo.get("image") or "")
    thumbnail = str(photo.get("thumbnail") or image)
    if not image:
        raise ValueError(f"Homepage photo {photo_id} has no generated image path.")
    title, detail, alt = _portfolio_caption(photo, entities)
    full_size = _parse_size(photo.get("processedSize"))
    thumb_size = _parse_size(photo.get("thumbnailSize")) or full_size
    if hero:
        source = image
        dimensions = full_size
        srcset = ""
        loading = 'loading="eager" fetchpriority="high"'
        modifier = "portfolio-photo--hero"
        sizes = "100vw"
    else:
        source = thumbnail
        dimensions = thumb_size
        modifier = "portfolio-photo--selected"
        loading = 'loading="lazy"'
        sizes = "100vw"
        srcset = ""
        if full_size and thumbnail != image:
            srcset = (
                f' srcset="{html.escape(thumbnail, quote=True)} {thumb_size[0]}w, '
                f'{html.escape(image, quote=True)} {full_size[0]}w" sizes="{sizes}"'
            )
    width_height = f' width="{dimensions[0]}" height="{dimensions[1]}"' if dimensions else ""
    if hero:
        sizes_attr = f' sizes="{sizes}"'
    else:
        sizes_attr = "" if srcset else f' sizes="{sizes}"'
    photo_id_attr = html.escape(photo_id, quote=True)
    alt_attr = html.escape(alt, quote=True)
    href = quote(photo_id, safe="")
    title_attr = html.escape(title)
    detail_markup = f'<span class="portfolio-photo-meta">{html.escape(detail)}</span>' if detail else ""
    return (
        f'<figure class="portfolio-photo {modifier}">'
        f'<a class="portfolio-photo-link" href="#work={href}" data-work-photo="{photo_id_attr}" '
        f'aria-label="View photograph: {alt_attr}">'
        f'<img src="{html.escape(source, quote=True)}"{srcset}{sizes_attr}{width_height} '
        f'alt="{alt_attr}" {loading} decoding="async">'
        "</a>"
        f'<figcaption><span class="portfolio-photo-caption">{title_attr}</span>{detail_markup}</figcaption>'
        "</figure>"
    )


def render_portfolio(root: Path) -> Tuple[str, str, Dict[str, Any]]:
    config, chosen, entities = _read_portfolio(root)
    hero_id = config["hero"]
    hero = _render_portfolio_photo(hero_id, chosen[hero_id], entities, hero=True)
    work = "\n".join(
        _render_portfolio_photo(photo_id, chosen[photo_id], entities, hero=False)
        for photo_id in config["selected"]
    )
    return hero, work, chosen[hero_id]


def render_head(
    filename: str,
    definition: Dict[str, str],
    root: Path,
    hero_photo: Optional[Dict[str, Any]] = None,
) -> str:
    canonical = f"{SITE_URL}/" if filename == "index.html" else f"{SITE_URL}/{filename}"
    is_map = filename == "map.html"
    map_assets = "" if not is_map else '''
    <link rel="preconnect" href="https://unpkg.com" crossorigin>
    <link rel="preconnect" href="https://tiles.openfreemap.org" crossorigin>
    <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" integrity="sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY=" crossorigin="" media="print" onload="this.media='all'">
    <noscript><link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" integrity="sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY=" crossorigin=""></noscript>
    <link rel="stylesheet" href="https://unpkg.com/maplibre-gl@5.6.2/dist/maplibre-gl.css" media="print" onload="this.media='all'">'''
    hero_photo: Optional[Dict[str, Any]] = None
    hero_alt = "Aircraft formation over Gifu Air Base in Japan"
    image_url = SHARED_IMAGE
    if filename == "index.html":
        if hero_photo is None:
            _, _, hero_photo = render_portfolio(root)
        hero_image = str(hero_photo.get("image") or "")
        if hero_image:
            image_url = urljoin(SITE_URL + "/", hero_image)
        hero_alt = str(hero_photo.get("caption") or hero_photo.get("title") or "Aviation photograph by Timothy Liu")

    image_metadata = ""
    if hero_photo:
        image_metadata += f'\n    <meta property="og:image:secure_url" content="{html.escape(image_url, quote=True)}">'
        dimensions = _parse_size(hero_photo.get("processedSize"))
        if dimensions:
            image_metadata += (
                f'\n    <meta property="og:image:width" content="{dimensions[0]}">'
                f'\n    <meta property="og:image:height" content="{dimensions[1]}">'
            )
        image_metadata += f'\n    <meta property="og:image:alt" content="{html.escape(hero_alt, quote=True)}">'
    elif is_map:
        image_metadata = '''
    <meta property="og:image:secure_url" content="https://tlkh.github.io/spotterdex/assets/generated/photos/location-hero-gifu-air-base.jpg">
    <meta property="og:image:width" content="2560">
    <meta property="og:image:height" content="1707">
    <meta property="og:image:alt" content="Aircraft formation over Gifu Air Base in Japan">'''
    twitter_alt = f'\n    <meta name="twitter:image:alt" content="{html.escape(hero_alt, quote=True)}">' if hero_photo else ('\n    <meta name="twitter:image:alt" content="Aircraft formation over Gifu Air Base in Japan">' if is_map else "")
    route_script = {
        "map.html": "map-page.js",
        "airshows.html": "airshows-page.js",
        "stats.html": "stats-page.js",
    }.get(filename)
    route_script_tag = f'\n    <script src="{route_script}" defer></script>' if route_script else ""
    startup_links = render_startup_links()
    return f'''    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
    <meta name="color-scheme" content="dark">
    <meta name="theme-color" content="{LAUNCH_BACKGROUND}">
    <meta name="apple-mobile-web-app-capable" content="yes">
    <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
    <meta name="apple-mobile-web-app-title" content="SpotterDex">
    <title>{html.escape(definition['title'])}</title>
    <meta name="description" content="{html.escape(definition['description'])}">
    <meta property="og:type" content="website">
    <meta property="og:site_name" content="SpotterDex">
    <meta property="og:locale" content="en_SG">
    <meta property="og:title" content="{html.escape(definition['og_title'])}">
    <meta property="og:description" content="{html.escape(definition['og_description'])}">
    <meta property="og:image" content="{image_url}">{image_metadata}
    <meta property="og:url" content="{canonical}">
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:title" content="{html.escape(definition['og_title'])}">
    <meta name="twitter:description" content="{html.escape(definition['og_description'])}">
    <meta name="twitter:image" content="{image_url}">{twitter_alt}
    <link rel="canonical" href="{canonical}">{map_assets}
    <link rel="icon" type="image/png" sizes="32x32" href="assets/icons/spotterdex-favicon-32.png">
    <link rel="apple-touch-icon" sizes="180x180" type="image/png" href="assets/icons/spotterdex-apple-touch-icon-v4.png">
{startup_links}
    <link rel="manifest" href="manifest.webmanifest">
    <link rel="stylesheet" href="tokens.css">
    <link rel="stylesheet" href="styles.css">
    <script src="data/spotterdex-core.js" defer></script>{route_script_tag}
    <script src="script.js" defer></script>'''


def render_page(filename: str, root: Path) -> str:
    definition = PAGE_DEFINITIONS[filename]
    content = (root / "tools" / "page_templates" / definition["content"]).read_text(encoding="utf-8").rstrip()
    hero_photo: Optional[Dict[str, Any]] = None
    if filename == "index.html":
        hero_html, work_html, hero_photo = render_portfolio(root)
        if content.count(PORTFOLIO_HERO_TOKEN) != 1 or content.count(PORTFOLIO_WORK_TOKEN) != 1:
            raise ValueError("tools/page_templates/home.html must contain each portfolio placeholder exactly once.")
        content = content.replace(PORTFOLIO_HERO_TOKEN, hero_html).replace(PORTFOLIO_WORK_TOKEN, work_html)
    is_map = filename == "map.html"
    return "\n".join(
        [
            "<!doctype html>",
            '<html lang="en">',
            "  <head>",
            render_head(filename, definition, root, hero_photo),
            "  </head>",
            f'  <body data-page-view="{definition["view_id"]}">',
            '    <a class="skip-link" href="#main">Skip to content</a>',
            "",
            render_header(filename, is_map),
            "",
            content,
            "  </body>",
            "</html>",
            "",
        ]
    )


def build_pages(root: Path) -> None:
    for filename in PAGE_DEFINITIONS:
        (root / filename).write_text(render_page(filename, root), encoding="utf-8")


if __name__ == "__main__":
    build_pages(Path(__file__).resolve().parents[1])
