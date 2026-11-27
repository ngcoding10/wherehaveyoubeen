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

`e2e-search.js` checks that the search boxes and Quick add forgive typos ("madid", "madird" → Madrid).
It needs no backend: serve this folder on port 8000 and run `node tools/e2e-search.js`.

# Landmarks, their cities and the city sights

- `landmark_places.py` attaches every curated wonder in `js/landmarks.js` to the city it is in (GeoNames id)
  and its state/region, and writes `js/landmark-places.js`. Matches were checked by hand; the overrides are
  at the top of the script. Run it again after adding a wonder.
- `build_sights.py` makes `data/sights.json`, the extra landmarks ("city sights") for the most-visited
  cities, from Wikidata: `python3 tools/build_sights.py fetch WORKDIR` downloads candidates (slow: the public
  query servers allow about one query a minute), `python3 tools/build_sights.py build WORKDIR` applies the
  rules and the hand-checked lists in the script. Sight ids end up in people's logbooks (`l:<id>`), so an id
  that has been published must never be renamed or removed.

`e2e-landmarks.js` checks that ticking a landmark logs its city and country, un-ticking, the city checklist
and the "which cities?" step after stamping a country at phone size. Serve this folder on port 8000 and run
`node tools/e2e-landmarks.js` (`SHOTS=dir` also saves screenshots).

`e2e-quicktick.js` checks one-tap ticking at phone size: a tap on a landmark in the Wonders grid, the city and
country checklists and the City sights list ticks it without leaving the screen, a second tap un-ticks it, the pin
button opens it on the map, a run of taps shares one toast with an undo, and 20 taps in a row save in well under a
second. Serve this folder on port 8000 and run `node tools/e2e-quicktick.js` (`SHOTS=dir` saves two screenshots).
