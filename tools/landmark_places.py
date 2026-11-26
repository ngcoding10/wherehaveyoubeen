"""Attach every curated landmark in js/landmarks.js to its city (GeoNames id) and state/region.

    python3 tools/landmark_places.py        # writes js/landmark-places.js

Rule: the city whose "radius" (1.5 km + 2.5 km x sqrt(population / 100k)) holds the landmark,
nearest relative to that radius wins. Natural wonders and remote sites are then checked by hand:
NO_CITY drops a match, CITY forces one (sub-districts such as "Paris 16 Passy" -> Paris).
The state is the Natural Earth region the point falls in (same simplified borders the app uses).
"""
import json, math, re, sys, os
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')

# hand-checked: the landmark is in or at this city (GeoNames id)
CITY = {
    'eiffel': 2988507, 'sacre-coeur': 2988507,            # Paris, not its arrondissement entries
    'belem-tower': 2267057,                               # Lisbon (Belém parish)
    'the-bund': 1796236, 'shanghai-tower': 1796236,       # Shanghai, not Pudong
    'tokyo-tower': 1850147,                               # Tokyo, not Minato
    'arashiyama': 1857910,                                # Kyoto
    'petronas': 1735161,                                  # Kuala Lumpur, not Bukit Bintang
    'diamond-head': 5856195,                              # Honolulu
    'riga': 456172,                                       # Riga, not Vecrīga
    'palm-jumeirah': 292223,                              # Dubai
    'sultan-qaboos': 287286,                              # Muscat (Bawshar wilayat)
    'las-vegas-strip': 5506956,                           # Las Vegas (the Strip itself is in Paradise, NV)
    'kuwait-towers': 285787,                              # Kuwait City
    'angkor-wat': 1822214,                                # Siem Reap
    'cristo-rei': 1645457,                                # Dili
    'terracotta-army': 1790630,                           # Xi'an (Lintong district)
    'bulguksa': 1841603,                                  # Gyeongju
    'petra': 246008,                                      # Wadi Musa
    'machu-picchu': 3935636,                              # Machupicchu (Aguas Calientes)
    'tulum': 3515040,                                     # Tulum
}
# hand-checked: natural areas, islands, regions and sites outside towns get no city
NO_CITY = {
    'chichen-itza', 'teotihuacan', 'galapagos', 'sherwood', 'amalfi', 'cinque-terre', 'lake-como', 'meteora',
    'bialowieza', 'kotor', 'cappadocia', 'kerala', 'maldives', 'raja-ampat', 'phi-phi', 'golden-bridge',
    'blue-mountains', 'bora-bora',
}

def hav(a, b, c, d):
    t = math.pi / 180
    x = math.sin((c - a) * t / 2) ** 2 + math.cos(a * t) * math.cos(c * t) * math.sin((d - b) * t / 2) ** 2
    return 2 * 6371 * math.asin(math.sqrt(x))

def in_ring(x, y, ring):
    inside, j = False, len(ring) - 1
    for i in range(len(ring)):
        xi, yi = ring[i][:2]; xj, yj = ring[j][:2]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi: inside = not inside
        j = i
    return inside

class States:
    def __init__(self):
        g = json.load(open(os.path.join(ROOT, 'data/states.geojson')))
        self.feats = []
        for f in g['features']:
            if not f.get('geometry'): continue
            polys = [f['geometry']['coordinates']] if f['geometry']['type'] == 'Polygon' else f['geometry']['coordinates']
            polys = [p for p in polys if p and p[0]]
            if not polys: continue
            xs = [p[0] for poly in polys for p in poly[0]]; ys = [p[1] for poly in polys for p in poly[0]]
            self.feats.append((f['properties']['id'], f['properties'].get('cid'), polys, (min(xs), min(ys), max(xs), max(ys))))
    def at(self, lon, lat, cid):
        for sid, c, polys, b in self.feats:
            if cid and c != cid: continue
            if not (b[0] <= lon <= b[2] and b[1] <= lat <= b[3]): continue
            if any(in_ring(lon, lat, p[0]) and not any(in_ring(lon, lat, h) for h in p[1:]) for p in polys): return sid
        return ''

_cities = {}
def country_cities(cc):
    if cc not in _cities:
        p = os.path.join(ROOT, f'data/cities/{cc}.json')
        _cities[cc] = json.load(open(p)) if os.path.exists(p) else {'cities': [], 'states': []}
    return _cities[cc]

def city_row(cc, gid):
    d = country_cities(cc)
    for r in d['cities']:
        if r[0] == gid: return r, (d['states'][r[5]][0] if r[5] >= 0 else '')
    return None, ''

def nearest_city(cc, lat, lon):
    best = None
    for r in country_cities(cc)['cities']:
        d = hav(lat, lon, r[2], r[3])
        if d > 60: continue
        rad = 1.5 + 2.5 * math.sqrt(r[4] / 1e5)
        if d <= rad and (best is None or d / rad < best[0]): best = (d / rad, r[0])
    return best and best[1]

def core_rows():
    s = open(os.path.join(ROOT, 'js/landmarks.js'), encoding='utf-8').read()
    return [(m[0], m[2], float(m[3]), float(m[4])) for m in
            re.findall(r"^\['([^']+)','((?:[^'\\]|\\.)*)','(\w+)',([-\d.]+),([-\d.]+),", s, re.M)]

def main():
    st = States()
    out, n_city = {}, 0
    for lid, cc, lat, lon in core_rows():
        gid = CITY.get(lid) or (None if lid in NO_CITY else nearest_city(cc, lat, lon))
        sid = ''
        if gid:
            row, sid = city_row(cc, gid)
            if not row: sys.exit(f'{lid}: city {gid} not in data/cities/{cc}.json')
            n_city += 1
        sid = sid or st.at(lon, lat, cc)
        out[lid] = [gid or 0, sid]
    body = ',\n'.join(f"'{k}':[{v[0]},'{v[1]}']" for k, v in out.items())
    open(os.path.join(ROOT, 'js/landmark-places.js'), 'w', encoding='utf-8').write(
        '// Generated by tools/landmark_places.py: landmark id -> [city GeoNames id (0 = none), state/region id]\n'
        f'export const LANDMARK_PLACES = {{\n{body},\n}};\n')
    print(f'{len(out)} landmarks, {n_city} attached to a city, {sum(1 for v in out.values() if v[1])} with a region')

if __name__ == '__main__':
    main()
