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
    enabled: true
```

Use `icao: XXXX` for airport and air base pins when a code exists. Broad region pins or non-aerodrome locations can leave `icao` empty; the generated manifest preserves the field, and mobile map labels prefer ICAO codes when available.

`aircraft/<type>/<squadron>/entry.yaml` contains the aircraft entry, squadron metadata, and photos:

```yaml
aircraft_type: Boeing F-15SG Strike Eagle
squadron_name: 149 Squadron
unit_type: squadron
country: Singapore
squadron_logo: ../../../assets/logos/149-squadron.svg
photos:
  - path: photos/f-15sg-changi.jpg
    date: 2024-02-24
    year: 2024
    location: Changi Exhibition Centre
```

Photo paths in entry YAML are relative to the matching entry folder. The build script reads them from `raw_assets/` first, mirroring the entry path. For example, `photos/f-15sg-changi.jpg` in `aircraft/boeing-f-15sg-strike-eagle/149-squadron/entry.yaml` is loaded from `raw_assets/aircraft/boeing-f-15sg-strike-eagle/149-squadron/photos/f-15sg-changi.jpg`. The `location` value links photos to map pins by matching the pin name, or you can add `pin_id`. Use `unit_type: organisation` for airline/operator entries that should be labelled Organisation instead of Squadron; those entries remain visible in the Dex and photo viewer but are hidden from the Squadrons page. Use `date` in `YYYY-MM-DD` format when known; the recent locations list is ordered by the newest photo at each location. If `date` is omitted, the build script falls back to EXIF capture date, then `year`.

## Build

Install the script dependencies once:

```bash
python3 -m pip install -r requirements.txt
```

Build the static data, resize photos to 2048 px wide JPEGs, and generate 1024 px wide thumbnails:

```bash
python3 tools/build_spotterdex.py
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
