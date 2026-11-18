# Where Have You Been? 🌍✈️

An interactive world map that works as your travel logbook. Click countries, then
states and cities inside them, and they light up in your colours. Collect 8-bit pixel
landmarks along the way.

## What it does

- **Globe mode and flat Map mode.** Switch at the top. Globe lets you zoom right out and
  spin the planet. Map is a classic flat world map you can zoom into.
- **Countries, states and cities each get their own colour.** Defaults: countries teal,
  states amber, cities raspberry pins, wonders gold. You can change all of them
  (🎨 button). Places you haven't been stay grey.
- **Real map detail when you zoom in.** Coastlines, islands, lakes, rivers, roads,
  parks, buildings and neighbourhood names come from OpenStreetMap, through the free
  OpenFreeMap tiles. Zoom into New York and you'll see Manhattan, the piers and the
  street grid.
- **State and province borders appear as you zoom in.** There are 4,596 of them,
  covering every country. Full-resolution borders load for each country as you get
  close.
- **226,382 cities, towns and villages.** This is every populated place with 500+
  people in GeoNames. They load one country at a time as you zoom in. Bigger cities
  appear first, smaller towns show up as you get closer.
- **469 pixel-art landmarks, each with its own unique 16×16 sprite.** These cover the New 7
  Wonders, the Ancient Wonders, natural wonders, great forests and rainforests, icons like
  the Burj Khalifa and the Statue of Liberty, sacred sites and ruins. No two sprites are the
  same. Look-alike nature spots get a signature animal, plant or building (a panda, a bison,
  the Lake Bled island church…). Collect them in the **Wonders** tab, which works like a
  pokédex: uncollected ones show as silhouettes.
- **Tabs:**
  - **Explore**: details for the selected place. Includes a checklist of its regions and
    cities, a searchable list of all its towns, nearby wonders, and a visit date and
    notes for every place you log.
  - **Logbook**: everything grouped by continent → country → states/cities/wonders.
  - **Passport**: an auto-generated rubber stamp for every country.
  - **Stats**: x/195 countries, % of the world's land, progress per continent and your
    traveller rank.
- **📍 Locate me / check in.** Finds the nearest town to you, logs it in one tap and
  can save it as your 🏠 home base.
- **Quick add:** type a whole list like `London, Beijing, Miami, Paris, Texas, Japan, Eiffel Tower`
  and log everything at once. It matches against the app's own 226k places, and anything not
  in there (a tiny village, "Tuscany") is looked up on OpenStreetMap's free Nominatim
  service. No API key needed. Pick a different match from the dropdown if a name is
  ambiguous.
- **Search** across countries, states, cities and wonders. Press `/` to jump to it.
- **4 map styles:** Midnight, Atlas (vintage paper), Arcade (neon 8-bit) and Daylight.
- **Saving:**
  - Without an account, everything saves in your browser automatically.
  - With **Sign in with Google**, your logbook, home base and settings sync to your
    account live, across devices. You have to set this up once, see below.
  - You can also export or import a JSON backup.

## Run it

It's a static site with no build step. Serve the folder with any web server:

```bash
python3 -m http.server 8000
```

Then open http://localhost:8000. Opening `index.html` directly from disk won't work,
because browsers block loading the data files that way.

### Publish it on GitHub Pages

The site is published with **Settings → Pages → Deploy from a branch → `main` / root**. Every
push to `main` goes live within a minute or two. There's no build step.

## Turn on Google sign-in

Google sign-in uses Firebase (free tier). It is already configured for this site
(`js/firebase-config.js`). If you fork the project, create your own Firebase project like this:

1. Go to <https://console.firebase.google.com/> and create a project. Analytics is optional.
2. Go to **Build → Authentication → Get started → Sign-in method** and enable **Google**.
3. Go to **Build → Firestore Database → Create database** and choose production mode. Then
   open the **Rules** tab, paste in the contents of [`firestore.rules`](firestore.rules)
   and click Publish. These rules only let each signed-in user read and write their own
   logbook.
4. Go to **Project settings (⚙️) → General → Your apps → Web (`</>`)** and register an app.
   Copy the `firebaseConfig` object into [`js/firebase-config.js`](js/firebase-config.js),
   replacing `null`.
5. Go to **Authentication → Settings → Authorized domains** and add the domain the site
   runs on, for example `your-username.github.io`. `localhost` is already allowed.

The Firebase web config is not a secret. It's meant to be public, and the Firestore
rules are what protect the data. When you first sign in, anything you logged while
signed out is merged into your account. Merges are done place by place, with the newest
change winning, and deletions sync too.

## Data & credits

| What | Source | License |
|---|---|---|
| Street-level basemap (coastlines, water, roads, buildings, place names) | [OpenStreetMap](https://www.openstreetmap.org/copyright) via [OpenFreeMap](https://openfreemap.org/) / OpenMapTiles | ODbL |
| Country & state/province borders | [Natural Earth](https://www.naturalearthdata.com/) 1:10m | Public domain |
| Cities, towns, villages | [GeoNames](https://www.geonames.org/) `cities500` | CC BY 4.0 |
| Map engine | [MapLibre GL JS](https://maplibre.org/) 5.23 (vendored) | BSD-3 |
| Map label fonts | Noto Sans via [protomaps basemaps-assets](https://github.com/protomaps/basemaps-assets) | SIL OFL |
| Flags | [flag-icons](https://github.com/lipis/flag-icons) (loaded from jsDelivr) | MIT |
| Landmark list & pixel art | Made for this project | — |

To rebuild the data, for example to pick up a newer GeoNames dump, see
[`tools/README.md`](tools/README.md).

### Known limits

- Coastlines, roads and borders lines at close zoom come from OpenStreetMap and are
  exact. The *coloured fills* for visited countries and states use Natural Earth
  shapes. Along land borders they can sit a little off the exact OSM border line when
  you're zoomed in to street level.
- Cities come from GeoNames' list of places with 500+ people. Tiny hamlets aren't
  included. Population figures come from GeoNames and some are out of date.
- The "195 countries" count is the 193 UN members plus Vatican City and Palestine. You
  can still log territories like Greenland, Puerto Rico or Hong Kong. They're counted
  separately.
- Some borders are disputed. They follow Natural Earth's default de-facto view.
- Landmark coordinates were checked against the country borders. They're accurate to a
  site or park, not to an exact entrance.
