#!/usr/bin/env python3
"""Render the five public page shells from one shared static template."""

from __future__ import annotations

import html
from pathlib import Path
from typing import Dict


SITE_URL = "https://tlkh.github.io/spotterdex"
SHARED_IMAGE = f"{SITE_URL}/assets/generated/photos/location-hero-gifu-air-base.jpg"

PAGE_DEFINITIONS: Dict[str, Dict[str, str]] = {
    "index.html": {
        "view_id": "mapView",
        "label": "World Map",
        "title": "SpotterDex",
        "description": "SpotterDex is an aircraft spotting logbook and aviation photography portfolio.",
        "og_title": "SpotterDex - Timothy's Logbook",
        "og_description": "An aircraft spotting logbook and aviation photography field guide.",
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


def page_options(active_file: str) -> str:
    pages = (
        ("index.html", "World Map"),
        ("aircraft-dex.html", "Aircraft Dex"),
        ("squadrons.html", "Squadrons"),
        ("airshows.html", "Airshows"),
        ("stats.html", "Stats"),
    )
    return "\n".join(
        f'          <option value="{filename}"{(" selected" if filename == active_file else "")}>{label}</option>'
        for filename, label in pages
    )


def page_navigation(active_file: str) -> str:
    pages = (
        ("index.html", "World Map"),
        ("aircraft-dex.html", "Aircraft Dex"),
        ("squadrons.html", "Squadrons"),
        ("airshows.html", "Airshows"),
        ("stats.html", "Stats"),
    )
    return "\n".join(
        f'        <a class="tab-button{" is-active" if filename == active_file else ""}" href="{filename}"'
        f'{(" aria-current=\"page\"" if filename == active_file else "")}>{label}</a>'
        for filename, label in pages
    )


def map_globe_icon() -> str:
    return (
        '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">'
        '<path class="globe-earth-land" d="M21.54 15H17a2 2 0 0 0-2 2v4.54"></path>'
        '<path class="globe-earth-land" d="M7 3.34V5a3 3 0 0 0 3 3 2 2 0 0 1 2 2c0 1.1.9 2 2 2a2 2 0 0 0 2-2c0-1.1.9-2 2-2h3.17"></path>'
        '<path class="globe-earth-land" d="M11 21.95V18a2 2 0 0 0-2-2 2 2 0 0 1-2-2v-1a2 2 0 0 0-2-2H2.05"></path>'
        '<circle class="globe-earth-outline" cx="12" cy="12" r="10"></circle>'
        '</svg>'
    )


def render_header(active_file: str, is_map: bool) -> str:
    active_options = page_options(active_file)
    navigation = page_navigation(active_file)
    if is_map:
        return f'''    <header class="site-header">
      <div class="brand">
        <button class="brand-mark" id="fitPinsIconButton" type="button" aria-label="Fit all map locations" title="Fit all map locations">
          <img src="assets/icons/spotterdex-app-icon.png" alt="">
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
            <img src="assets/icons/spotterdex-app-icon.png" alt="">
          </span>
          <span class="mobile-map-brand-copy">
            <strong>SpotterDex</strong>
            <small>Timothy's Logbook</small>
          </span>
        </button>
        <button class="mobile-map-location-card" type="button" data-map-panel-toggle="locations" aria-controls="mapControlPanel" aria-expanded="false">
          <span class="mobile-map-location-copy">
            <span>Locations</span>
            <strong id="mobileMapLocationTitle">Browse locations</strong>
          </span>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6"></path></svg>
        </button>
      </div>
    </header>'''
    return f'''    <header class="site-header">
      <a class="brand" href="index.html" aria-label="SpotterDex home">
        <span class="brand-mark" aria-hidden="true"><img src="assets/icons/spotterdex-app-icon.png" alt=""></span>
        <span><span class="brand-title">SpotterDex</span><span class="brand-subtitle">Timothy's Logbook</span></span>
      </a>
      <nav class="tab-nav" aria-label="Main views">
{navigation}
      </nav>
      <select class="nav-select" id="viewSelect" aria-label="Main view">
{active_options}
      </select>
    </header>'''


def render_head(filename: str, definition: Dict[str, str]) -> str:
    canonical = f"{SITE_URL}/" if filename == "index.html" else f"{SITE_URL}/{filename}"
    map_assets = "" if filename != "index.html" else '''
    <link rel="preconnect" href="https://unpkg.com" crossorigin>
    <link rel="preconnect" href="https://tiles.openfreemap.org" crossorigin>
    <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" integrity="sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY=" crossorigin="" media="print" onload="this.media='all'">
    <noscript><link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" integrity="sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY=" crossorigin=""></noscript>
    <link rel="stylesheet" href="https://unpkg.com/maplibre-gl@5.6.2/dist/maplibre-gl.css" media="print" onload="this.media='all'">'''
    map_image_metadata = "" if filename != "index.html" else f'''
    <meta property="og:image:secure_url" content="{SHARED_IMAGE}">
    <meta property="og:image:width" content="2560">
    <meta property="og:image:height" content="1707">
    <meta property="og:image:alt" content="Aircraft formation over Gifu Air Base in Japan">'''
    map_twitter_alt = "" if filename != "index.html" else '\n    <meta name="twitter:image:alt" content="Aircraft formation over Gifu Air Base in Japan">'
    return f'''    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="color-scheme" content="dark">
    <meta name="theme-color" content="#111416">
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
    <meta property="og:image" content="{SHARED_IMAGE}">{map_image_metadata}
    <meta property="og:url" content="{canonical}">
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:title" content="{html.escape(definition['og_title'])}">
    <meta name="twitter:description" content="{html.escape(definition['og_description'])}">
    <meta name="twitter:image" content="{SHARED_IMAGE}">{map_twitter_alt}
    <link rel="canonical" href="{canonical}">{map_assets}
    <link rel="icon" type="image/png" href="assets/icons/spotterdex-app-icon.png">
    <link rel="apple-touch-icon" sizes="180x180" type="image/png" href="assets/icons/spotterdex-apple-touch-icon-v3.png">
    <link rel="manifest" href="manifest.webmanifest">
    <link rel="stylesheet" href="styles.css">
    <script src="data/spotterdex-core.js" defer></script>
    <script src="script.js" defer></script>'''


def render_page(filename: str, root: Path) -> str:
    definition = PAGE_DEFINITIONS[filename]
    content = (root / "tools" / "page_templates" / definition["content"]).read_text(encoding="utf-8").rstrip()
    is_map = filename == "index.html"
    return "\n".join(
        [
            "<!doctype html>",
            '<html lang="en">',
            "  <head>",
            render_head(filename, definition),
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
