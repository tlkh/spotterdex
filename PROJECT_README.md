# SpotterDex

SpotterDex is a static aircraft spotting field guide and aviation photography portfolio. It is designed for GitHub Pages: the browser app is plain HTML, CSS, and JavaScript, while `tools/build_spotterdex.py` converts the source directory structure into static data and web-sized JPEGs. The world map uses Leaflet with OpenStreetMap tiles and visible map attribution.

## Source Structure

```text
map_pins/<country_name>/pins.yaml
aircraft/<aircraft_type>/<squadron>/entry.yaml
squadrons/<squadron>/entry.yaml
raw_assets/aircraft/<aircraft_type>/<squadron>/photos/
raw_assets/squadrons/<squadron>/photos/
raw_assets/map_pins/<country_name>/photos/
assets/logos/
assets/generated/photos/
assets/generated/thumbs/
data/
```

`raw_assets/` is the centralized, gitignored source directory for all original photos to be processed. Mirror the source YAML layout below it: `aircraft/`, `squadrons/`, or `map_pins/`.

`map_pins/<country_name>/pins.yaml` contains enabled map locations:

```yaml
country: Singapore
pins:
  - id: changi-exhibition-centre
    name: Changi Exhibition Centre
    icao: WSSS
    coordinates: [1.3631, 104.0229]
    hero_photo: photos/changi-showline-hero.jpg
    photos:
      - path: photos/ramp-overview.jpg
        date: 2024-02-24
        caption: Morning activity on the Changi ramp.
    enabled: true
```

Use `icao: XXXX` for airport and air base pins when a code exists. Broad region pins or non-aerodrome locations can leave `icao` empty; the generated manifest preserves the field, and mobile map labels prefer ICAO codes when available. `photos:` on a pin creates location-level images: the builder assigns that pin's location and does not require an aircraft or squadron. Use `hero_photo`/`hero_image`/`hero.path` to set a custom location hero image from `raw_assets/`; use `hero_photo_id` to point at an existing generated photo record instead. Custom heroes do not remove the newest location photo from the Recent photos strip.

`aircraft/<type>/<squadron>/entry.yaml` contains the aircraft entry, squadron metadata, and photos:

```yaml
aircraft_type: Boeing F-15SG Strike Eagle
aircraft_family: fighter
squadron_name: 149 Squadron
unit_type: squadron
country: Singapore
squadron_logo: ../../../assets/logos/149-squadron.svg
squadron_hero: photos/149-squadron-hero.jpg
photos:
  - path: photos/f-15sg-changi.jpg
    date: 2024-02-24
    year: 2024
    location: Changi Exhibition Centre
    airshow: Singapore Airshow 2024
    livery: RSAF standard grey
```

Photo paths in entry YAML are relative to the matching entry folder. The build script reads them from `raw_assets/` first, mirroring the entry path. For example, `photos/f-15sg-changi.jpg` in `aircraft/boeing-f-15sg-strike-eagle/149-squadron/entry.yaml` is loaded from `raw_assets/aircraft/boeing-f-15sg-strike-eagle/149-squadron/photos/f-15sg-changi.jpg`. The `location` value links photos to map pins by matching the pin name, or you can add `pin_id`. Add `airshow: <event name>` when the frame was taken at an airshow; it is optional, works at every photo tag level, and is displayed in the viewer metadata. Add optional `livery` for a standard, retro, commemorative, camouflage, or other identifiable paint scheme; it is published in the manifest and shown on photo cards and in the viewer. Use `unit_type: organisation` for airline/operator entries that should be labelled Organisation instead of Squadron; those entries remain visible in the Dex and photo viewer but are hidden from the Squadrons page. Use `squadron_hero` or nested `squadron.hero.path` for an optional squadron-specific hero image on the Squadrons page. Use `date` in `YYYY-MM-DD` format when known; the recent locations list is ordered by the newest photo at each location. If `date` is omitted, the build script falls back to EXIF capture date, then `year`.

Every aircraft entry must set `aircraft_family` to one of `fighter`, `helicopter`, `light` (single-engine propeller), `medium` (twin-engine narrow-body airliners, business jets, and regional or commuter turboprops), or `heavy` (large aircraft in the four-engine size class and up, including wide-body jets and large twin-engine transports and tankers such as the Kawasaki C-2, Boeing KC-46/KC-767, and Airbus A330 MRTT). Size, not engine count, decides `heavy`: narrow-body airliners like the Boeing 737 and Airbus A320 stay `medium`.

## Airshows

The Airshows tab is a newest-to-oldest event timeline built from photo-level `airshow` tags. An event can optionally feature one of its tagged frames as its hero image. The manager writes that source reference to `airshows/events.yaml`; it never duplicates a photo or points at generated output:

```yaml
events:
  - name: Singapore Airshow 2026
    hero_photo:
      scope: aircraft
      entry_path: aircraft/boeing-f-15sg-strike-eagle/149-squadron/entry.yaml
      index: 0
```

When an event is expanded, the timeline shows its remaining frames oldest-to-newest. Use the manager's **Airshows** tab to tag all photos from a capture date, choose the optional hero frame, and find newly added photos whose capture date matches a known event day.

Use `squadrons/<squadron>/entry.yaml` when an image belongs to a squadron or organisation but not to one aircraft type. It supports the same squadron metadata and `photos:` list, but omits `aircraft_type`:

```yaml
squadron_name: 149 Squadron
unit_type: squadron
country: Singapore
photos:
  - path: photos/squadron-lineup.jpg
    location: Changi Exhibition Centre
    date: 2024-02-24
    caption: 149 Squadron aircraft lined up before the display.
```

The source image above resolves from `raw_assets/squadrons/149-squadron/photos/squadron-lineup.jpg`. Squadron-level photos remain available in the map, viewer, statistics, and aggregate Squadrons page, but deliberately do not create an Aircraft Dex card. A pin-level `photos:` item resolves from the mirrored `raw_assets/map_pins/<country>/` folder and is displayed as a location-level image.

## Build

Install the script dependencies once:

```bash
python3 -m pip install -r requirements.txt
```

## Local Data Manager

Run the local manager when you want to tag `raw_assets/` images to an aircraft, a squadron, or a location, add or update location hero images, create new sources or pins, and rebuild the generated site from one browser surface:

```bash
python3 tools/spotterdex_manager.py
```

Open `http://127.0.0.1:8765/`. The **Tag Images To** selector includes aircraft sources, squadron-only sources, and every location. Use the optional **Airshow Event** and **Livery** fields to apply event and paint-scheme metadata to selected images. The **Airshows** tab groups existing photos by capture date for mass event tagging, identifies events without a selected hero, and surfaces untagged photos that share a capture date with a known event. The manager writes source YAML under `aircraft/`, `squadrons/`, `map_pins/`, and `airshows/events.yaml`, then streams the generator output when you press Build, ending with changed generated files, manifest count deltas, warnings, and commit-scope guidance. Its thumbnail cache lives in `.spotterdex-manager-cache/` and is ignored by git.

### AI caption assistance

The manager's **AI Caption** buttons can write or refine the caption for one selected raw image, an existing photo, or a Missing-fields photo. The source image is resized to 768 px wide in the local server process and sent with the aircraft type, squadron/operator, location, airshow event, and current caption to Nemotron 3 Omni. Suggestions populate the editor only; review and save them normally. Saving an AI-assisted suggestion adds `caption_ai_assisted: true` to the source YAML; this is intentionally absent from the published manifest.

Use the **Bulk Captions** tab to polish selected existing captions. It proposes one caption at a time with a 0.5 second pause between requests, excludes previously AI-assisted captions by default, and lets you edit then accept or reject each suggestion. Accepted captions are marked as AI-assisted in source YAML.

Set a server-side NVIDIA Inference Hub key before starting the manager. The key is never sent to browser JavaScript:

```bash
export LLM_API_KEY="..."
python3 tools/spotterdex_manager.py
```

`NVIDIA_CAPTION_ENDPOINT` can override the default `https://inference-api.nvidia.com/v1/chat/completions`, and `NVIDIA_CAPTION_MODEL` can override the default `nvidia/nvidia/nemotron-3-nano-omni-30b-a3b-reasoning` deployment. Stop the local manager with `Ctrl+C` when you finish using or testing it.

Build the static data, resize photos to 2560 px wide high-quality JPEGs, and generate 1024 px wide thumbnails:

```bash
python3 tools/build_spotterdex.py
```

The same build generates entity-specific social preview pages under `share/` for photos, aircraft, locations, squadrons, and airshows. Use `--site-url` when publishing from a different public base URL.

`data/spotterdex-data.js` is the compact directory bundle used by Aircraft Dex, Squadrons, and Airshows. Camera EXIF is kept out of that bundle; the Stats page loads `data/spotterdex-exif.js` only when its page is opened. Share pages reference the shared cached stylesheet at `share/share.css`. Squadron logos are published once per normalized country/unit identity and reused across aircraft entries.

Generated photo records retain camera EXIF used by the photography dashboard, including actual and camera-reported 35mm-equivalent focal length, aperture, shutter speed, ISO, and exposure compensation. The Stats page can compare actual versus equivalent focal lengths and links its distribution and extreme-setting cards back to the matching frames.

Full-size JPEGs use quality 70 with 4:2:0 chroma for web delivery; 1024 px thumbnails use quality 55 with 4:2:0 chroma for faster grids. Original sources remain untouched in `raw_assets/`.

Photo processing uses multiprocessing by default with one fewer worker than the number of CPU cores. Override it when needed:

```bash
python3 tools/build_spotterdex.py --workers 4
```

The included sample YAML references demo photo paths. To create stylized placeholder source images for the sample dataset, run:

```bash
python3 tools/build_spotterdex.py --make-demo-images
```

Demo images are written into the matching `raw_assets/` entry folders.

## Preview

Serve the folder locally:

```bash
python3 -m http.server 8000
```

Open `http://127.0.0.1:8000/`.

Avoid adding map-tile prefetching or offline tile downloads. Keep OpenStreetMap attribution visible on the map. On the Squadrons page, click a squadron logo to show the squadron's aircraft photos in the detail grid.

Useful deep links:

```text
#location=changi-exhibition-centre
#location=changi-exhibition-centre&detail=1
#aircraft=boeing-f-15sg-strike-eagle
#squadron=singapore-149-squadron
#airshow=singapore-airshow-2024
#photo=<generated-photo-id>
```

## Deploy

Commit the generated `data/` files (including `spotterdex-exif.js`), `share/` preview pages and `share/share.css`, `assets/generated/photos/`, `assets/generated/thumbs/`, and canonical assets under `assets/logos/`, then enable GitHub Pages from the repository root. Keep original photos in local `raw_assets/`; that directory is gitignored and is not deployed from the repository.
