# SpotterDex

SpotterDex is a static aircraft spotting field guide and aviation photography portfolio. It is designed for GitHub Pages: the browser app is plain HTML, CSS, and JavaScript, while `tools/build_spotterdex.py` converts the source directory structure into static data and web-sized JPEGs. The world map uses Leaflet with OpenStreetMap tiles and visible map attribution.

## Source Structure

```text
map_pins/<country_name>/pins.yaml
aircraft/<aircraft_type>/<squadron>/entry.yaml
raw_assets/aircraft/<aircraft_type>/<squadron>/photos/
assets/logos/
assets/generated/photos/
assets/generated/thumbs/
data/
```

`raw_assets/` is the centralized, gitignored source directory for all original photos to be processed. Keep source files there and mirror each aircraft entry folder under `raw_assets/aircraft/`.

`map_pins/<country_name>/pins.yaml` contains enabled map locations:

```yaml
country: Singapore
pins:
  - id: changi-exhibition-centre
    name: Changi Exhibition Centre
    icao: WSSS
    coordinates: [1.3631, 104.0229]
    hero_photo: photos/changi-showline-hero.jpg
    enabled: true
```

Use `icao: XXXX` for airport and air base pins when a code exists. Broad region pins or non-aerodrome locations can leave `icao` empty; the generated manifest preserves the field, and mobile map labels prefer ICAO codes when available. Use `hero_photo`/`hero_image`/`hero.path` to set a custom location hero image from `raw_assets/`; use `hero_photo_id` to point at an existing generated photo record instead. Custom heroes do not remove the newest location photo from the Recent photos strip.

`aircraft/<type>/<squadron>/entry.yaml` contains the aircraft entry, squadron metadata, and photos:

```yaml
aircraft_type: Boeing F-15SG Strike Eagle
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
```

Photo paths in entry YAML are relative to the matching entry folder. The build script reads them from `raw_assets/` first, mirroring the entry path. For example, `photos/f-15sg-changi.jpg` in `aircraft/boeing-f-15sg-strike-eagle/149-squadron/entry.yaml` is loaded from `raw_assets/aircraft/boeing-f-15sg-strike-eagle/149-squadron/photos/f-15sg-changi.jpg`. The `location` value links photos to map pins by matching the pin name, or you can add `pin_id`. Use `unit_type: organisation` for airline/operator entries that should be labelled Organisation instead of Squadron; those entries remain visible in the Dex and photo viewer but are hidden from the Squadrons page. Use `squadron_hero` or nested `squadron.hero.path` for an optional squadron-specific hero image on the Squadrons page. Use `date` in `YYYY-MM-DD` format when known; the recent locations list is ordered by the newest photo at each location. If `date` is omitted, the build script falls back to EXIF capture date, then `year`.

## Build

Install the script dependencies once:

```bash
python3 -m pip install -r requirements.txt
```

## Local Data Manager

Run the local manager when you want to attach `raw_assets/` images to aircraft entries, add or update location hero images, create new entries or pins, and rebuild the generated site from one browser surface:

```bash
python3 tools/spotterdex_manager.py
```

Open `http://127.0.0.1:8765/`. The manager writes source YAML under `aircraft/` and `map_pins/`, then streams the generator output when you press Build, ending with changed generated files, manifest count deltas, warnings, and commit-scope guidance. Its thumbnail cache lives in `.spotterdex-manager-cache/` and is ignored by git.

### AI caption assistance

The manager's **AI Caption** buttons can write or refine the caption for one selected raw image, an existing photo, or a Missing-fields photo. The source image is resized to 768 px wide in the local server process and sent with the aircraft type, squadron/operator, location, and current caption to Nemotron 3 Omni. Suggestions populate the editor only; review and save them normally. Saving an AI-assisted suggestion adds `caption_ai_assisted: true` to the source YAML; this is intentionally absent from the published manifest.

Use the **Bulk Captions** tab to polish selected existing captions. It proposes one caption at a time with a 0.5 second pause between requests, excludes previously AI-assisted captions by default, and lets you edit then accept or reject each suggestion. Accepted captions are marked as AI-assisted in source YAML.

Set a server-side NVIDIA Inference Hub key before starting the manager. The key is never sent to browser JavaScript:

```bash
export LLM_API_KEY="..."
python3 tools/spotterdex_manager.py
```

`NVIDIA_CAPTION_ENDPOINT` can override the default `https://inference-api.nvidia.com/v1/chat/completions`, and `NVIDIA_CAPTION_MODEL` can override the default `nvidia/nvidia/nemotron-3-nano-omni-30b-a3b-reasoning` deployment. Stop the local manager with `Ctrl+C` when you finish using or testing it.

Build the static data, resize photos to 2048 px wide JPEGs, and generate 1024 px wide thumbnails:

```bash
python3 tools/build_spotterdex.py
```

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
#aircraft=boeing-f-15sg-strike-eagle
```

## Deploy

Commit the generated `data/` files plus `assets/generated/photos/` and `assets/generated/thumbs/`, then enable GitHub Pages from the repository root. Keep original photos in local `raw_assets/`; that directory is gitignored and is not deployed from the repository.
