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
- **State and province borders appear as you zoom in.** There are 4,596 of them,
  covering every country.
- **226,382 cities, towns and villages.** This is every populated place with 500+
  people in GeoNames. They load one country at a time as you zoom in. Bigger cities
  appear first, smaller towns show up as you get closer.
- **469 pixel-art landmarks.** These cover the New 7 Wonders, the Ancient Wonders,
  natural wonders, great forests and rainforests, icons like the Burj Khalifa and the
  Statue of Liberty, sacred sites and ruins. There are 56 hand-made 16×16 sprites plus
  colour variants. Collect them in the **Wonders** tab, which works like a pokédex:
  uncollected ones show as silhouettes.
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

### Publish it free on GitHub Pages

The workflow in `.github/workflows/pages.yml` deploys the site whenever `main` is
updated. Turn it on in the repo under **Settings → Pages → Source: GitHub Actions**.
The site will then be at `https://<your-username>.github.io/wherehaveyoubeen/`.

## Turn on Google sign-in

Google sign-in uses Firebase (free tier). It needs a project that **you** own, so it
can't ship pre-configured. It takes about 5 minutes:

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
| Country & state/province borders | [Natural Earth](https://www.naturalearthdata.com/) 1:10m (simplified) | Public domain |
| Cities, towns, villages | [GeoNames](https://www.geonames.org/) `cities500` | CC BY 4.0 |
| Map engine | [MapLibre GL JS](https://maplibre.org/) 5.23 (vendored) | BSD-3 |
| Map label fonts | Noto Sans via [protomaps basemaps-assets](https://github.com/protomaps/basemaps-assets) | SIL OFL |
| Flags | [flag-icons](https://github.com/lipis/flag-icons) (loaded from jsDelivr) | MIT |
| Landmark list & pixel art | Made for this project | — |

To rebuild the data, for example to pick up a newer GeoNames dump, see
[`tools/README.md`](tools/README.md).

### Known limits

- Borders are simplified so the whole world loads quickly. Coastlines are approximate
  when you're zoomed in very close.
- Cities come from GeoNames' list of places with 500+ people. Tiny hamlets aren't
  included. Population figures come from GeoNames and some are out of date.
- The "195 countries" count is the 193 UN members plus Vatican City and Palestine. You
  can still log territories like Greenland, Puerto Rico or Hong Kong. They're counted
  separately.
- Some borders are disputed. They follow Natural Earth's default de-facto view.
- Landmark coordinates were checked against the country borders. They're accurate to a
  site or park, not to an exact entrance.
