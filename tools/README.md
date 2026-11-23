# Rebuilding the map data

`build_data.py` turns the raw Natural Earth + GeoNames downloads into the files in `data/`:

- `countries.geojson`, `states.geojson`: simplified borders used for drawing.
- `meta.json`: names, continents, label points, bounding boxes and areas.
- `cities/<COUNTRY>.json`: every populated place in that country. Each city is
  assigned to its state/province by testing which border it falls inside.
- `cities_index.json`: cities with 15k+ people, used for global search.
- `cities_major.json`: big cities and capitals, shown on the world view.

Set up:

```bash
mkdir raw
cd raw
curl -LO https://download.geonames.org/export/dump/cities500.zip
unzip cities500.zip
curl -LO https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_admin_0_countries.geojson
curl -LO https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_admin_1_states_provinces.geojson
cd ..
pip install shapely
npm i -g mapshaper
```

Then rebuild:

```bash
python3 tools/build_data.py raw data
```

# Checking sign-in, sync and friends end to end

`e2e-emulator.js` drives the site in a headless browser against the Firebase emulators of the
backend ([backend-combination](https://github.com/ngcoding10/backend-combination)): sign-in,
cloud save, usernames, friend requests, rename, delete-my-data and the signed-out mode.
Start the emulators from the backend repo, serve this folder on port 8000, then run
`node tools/e2e-emulator.js` (needs `npm i playwright`).
