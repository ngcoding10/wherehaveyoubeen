#!/usr/bin/env python3
"""Build the map + gazetteer data used by the app.

Sources (download into RAW dir first, see tools/README.md):
  - Natural Earth 10m admin-0 countries and admin-1 states/provinces (public domain)
  - GeoNames cities500 + admin1CodesASCII (CC-BY 4.0)

Requires: shapely>=2, and mapshaper on PATH (npm i -g mapshaper) for simplification.
Usage: python3 tools/build_data.py RAW_DIR OUT_DIR
"""
import json, os, sys, subprocess, collections, math
from shapely.geometry import shape, Point
from shapely import STRtree
import numpy as np

RAW, OUT = sys.argv[1], sys.argv[2]
os.makedirs(os.path.join(OUT, 'cities'), exist_ok=True)

def load(p):
    with open(os.path.join(RAW, p), encoding='utf-8') as f:
        return json.load(f)

# ---------------- countries ----------------
adm0 = load('ne_10m_admin_0_countries.geojson')
def cid_of(p):
    a2 = p.get('ISO_A2_EH') or p.get('ISO_A2')
    if a2 and a2 != '-99' and len(a2) == 2:
        return a2
    return p['ADM0_A3']

countries = {}
a3_to_cid = {}
for f in adm0['features']:
    p = f['properties']
    cid = cid_of(p)
    if cid in countries:  # merge duplicates (rare)
        cid = p['ADM0_A3']
    a3_to_cid[p['ADM0_A3']] = cid
    countries[cid] = dict(
        id=cid, name=p['NAME'], long=p.get('NAME_LONG') or p['NAME'], a3=p['ADM0_A3'],
        sov=p['SOVEREIGNT'], type=p['TYPE'], cont=p['CONTINENT'], sub=p['SUBREGION'],
        pop=p.get('POP_EST') or 0, lx=round(p['LABEL_X'], 3), ly=round(p['LABEL_Y'], 3),
        minlabel=p.get('MIN_LABEL', 5), geom=shape(f['geometry']))

# ---------------- states ----------------
adm1 = load('ne_10m_admin_1_states_provinces.geojson')
states = {}
for f in adm1['features']:
    p = f['properties']
    cid = a3_to_cid.get(p['adm0_a3']) or a3_to_cid.get(p['gu_a3'])
    if not cid:
        a2 = p.get('iso_a2')
        cid = a2 if a2 in countries else None
    if not cid:
        continue
    sid = p['adm1_code']
    states[sid] = dict(id=sid, cid=cid, name=p['name'] or p.get('gn_name') or sid,
                       type=p.get('type_en') or '', iso=p.get('iso_3166_2') or '',
                       lx=round(p['longitude'] or 0, 3), ly=round(p['latitude'] or 0, 3),
                       geom=shape(f['geometry']))
print('countries', len(countries), 'states', len(states))

# ---------------- simplified display geometry (mapshaper) ----------------
def write_props_geojson(path, feats):
    with open(path, 'w') as f:
        json.dump({'type': 'FeatureCollection', 'features': feats}, f)

tmp0 = os.path.join(RAW, '_c.geojson'); tmp1 = os.path.join(RAW, '_s.geojson')
write_props_geojson(tmp0, [{'type': 'Feature', 'properties': {'id': c['id'], 'name': c['name']},
                            'geometry': json.loads(json.dumps(c['geom'].__geo_interface__))} for c in countries.values()])
write_props_geojson(tmp1, [{'type': 'Feature', 'properties': {'id': s['id'], 'cid': s['cid'], 'name': s['name']},
                            'geometry': json.loads(json.dumps(s['geom'].__geo_interface__))} for s in states.values()])
subprocess.check_call(['mapshaper', tmp0, '-simplify', '12%', 'keep-shapes', 'planar',
                       '-o', os.path.join(OUT, 'countries.geojson'), 'precision=0.001', 'format=geojson'])
subprocess.check_call(['mapshaper', tmp1, '-simplify', '7%', 'keep-shapes', 'planar',
                       '-o', os.path.join(OUT, 'states.geojson'), 'precision=0.005', 'format=geojson'])
# coarse rounding collapses a few tiny islands (Vatican, Maldives atolls): restore those from full precision
with open(os.path.join(OUT, 'states.geojson')) as f:
    sg = json.load(f)
full = {sid: st['geom'].__geo_interface__ for sid, st in states.items()}
for f in sg['features']:
    if not f['geometry']:
        f['geometry'] = json.loads(json.dumps(full[f['properties']['id']]))
with open(os.path.join(OUT, 'states.geojson'), 'w') as f:
    json.dump(sg, f, separators=(',', ':'))

# ---------------- high-detail borders, one file per country (loaded when zoomed in) ----------------
hd = os.path.join(RAW, '_s_hd.geojson')
subprocess.check_call(['mapshaper', tmp1, '-o', hd, 'precision=0.0001', 'format=geojson'])
with open(hd) as f:
    hd_feats = json.load(f)['features']
os.makedirs(os.path.join(OUT, 'detail'), exist_ok=True)
by_c = collections.defaultdict(list)
for f in hd_feats:
    f['properties'] = {'id': f['properties']['id'], 'cid': f['properties']['cid']}
    by_c[f['properties']['cid']].append(f)
for cid, feats in by_c.items():
    with open(os.path.join(OUT, 'detail', cid + '.json'), 'w') as f:
        json.dump({'type': 'FeatureCollection', 'features': feats}, f, separators=(',', ':'))

# ---------------- cities ----------------
pop_rows = []
with open(os.path.join(RAW, 'cities500.txt'), encoding='utf-8') as f:
    for line in f:
        r = line.rstrip('\n').split('\t')
        gid, name, ascii_, lat, lon, fcl, fcode, cc = r[0], r[1], r[2], float(r[4]), float(r[5]), r[6], r[7], r[8]
        if fcode in ('PPLH', 'PPLQ', 'PPLW', 'PPLX', 'PPLCH'):
            continue  # historical / abandoned / destroyed / city sections
        pop = int(r[14] or 0)
        pop_rows.append((int(gid), name, lat, lon, cc, fcode, pop))
print('cities', len(pop_rows))

cid_list = list(countries)
ctree = STRtree([countries[c]['geom'] for c in cid_list])
pts = [Point(r[3], r[2]) for r in pop_rows]
inp, intree = ctree.query(pts, predicate='intersects')
pip_country = {}
for i, t in zip(inp, intree):
    pip_country.setdefault(int(i), cid_list[int(t)])

# states per country trees
by_c_states = collections.defaultdict(list)
for s in states.values():
    by_c_states[s['cid']].append(s)
stree = {c: (STRtree([s['geom'] for s in L]), L) for c, L in by_c_states.items()}

grouped = collections.defaultdict(list)
for i, r in enumerate(pop_rows):
    gid, name, lat, lon, cc, fcode, pop = r
    cid = cc if cc in countries else pip_country.get(i)
    if cid is None:
        idx = ctree.nearest(pts[i]); cid = cid_list[int(idx)]
    grouped[cid].append((i, r))

total = 0
search = []
for cid, rows in grouped.items():
    tree, L = stree.get(cid, (None, []))
    sidx = {s['id']: k for k, s in enumerate(L)}
    out = []
    if tree is not None:
        P = [pts[i] for i, _ in rows]
        a, b = tree.query(P, predicate='intersects')
        hit = {}
        for x, y in zip(a, b):
            hit.setdefault(int(x), int(y))
    for k, (i, r) in enumerate(rows):
        gid, name, lat, lon, cc, fcode, pop = r
        st = -1
        if tree is not None:
            st = hit.get(k, -1)
            if st == -1:
                st = int(tree.nearest(pts[i]))
        flag = 2 if fcode == 'PPLC' else (1 if fcode in ('PPLA',) else 0)
        out.append([gid, name, round(lat, 4), round(lon, 4), pop, st, flag])
    out.sort(key=lambda c: (-c[6] if c[6] == 2 else 0, -c[4]))
    data = {'id': cid, 'states': [[s['id'], s['name']] for s in L], 'cities': out}
    with open(os.path.join(OUT, 'cities', cid + '.json'), 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, separators=(',', ':'))
    total += len(out)
    for c in out:
        if c[4] >= 15000 or c[6] == 2:
            search.append([c[0], c[1], cid, c[2], c[3], c[4], (data['states'][c[5]][1] if c[5] >= 0 else '')])
print('cities written', total, 'search idx', len(search))
search.sort(key=lambda c: -c[5])
with open(os.path.join(OUT, 'cities_index.json'), 'w', encoding='utf-8') as f:
    json.dump(search, f, ensure_ascii=False, separators=(',', ':'))

# ---------------- meta ----------------
def bbox(g):
    x0, y0, x1, y1 = g.bounds
    return [round(x0, 2), round(y0, 2), round(x1, 2), round(y1, 2)]

def main_bbox(g):
    # bbox of the largest polygon + polys within reasonable distance, avoids e.g. France->French Guiana
    if g.geom_type != 'MultiPolygon':
        return bbox(g)
    polys = sorted(g.geoms, key=lambda p: -p.area)
    big = polys[0]
    keep = [p for p in polys if p is big or p.distance(big) < 4]
    from shapely.ops import unary_union
    b = bbox(unary_union(keep))
    if b[2] - b[0] > 300:  # crosses the antimeridian: shift western hemisphere east
        xs = [x + 360 if x < 0 else x for p in keep for x, _ in p.exterior.coords]
        b = [round(min(xs), 2), b[1], round(max(xs), 2), b[3]]
    return b

def area_km2(g):
    # equal-area approximation: scale x by cos(lat) per ring vertex (good to a few %)
    R = 6371.0088
    def ring(coords):
        a = 0.0
        pts = list(coords)
        for (x1, y1), (x2, y2) in zip(pts, pts[1:]):
            a += math.radians(x2 - x1) * (2 + math.sin(math.radians(y1)) + math.sin(math.radians(y2)))
        return abs(a) * R * R / 2
    polys = g.geoms if g.geom_type == 'MultiPolygon' else [g]
    return round(sum(ring(p.exterior.coords) - sum(ring(i.coords) for i in p.interiors) for p in polys))

major = []
for cid, rows in grouped.items():
    for i, r in rows:
        if r[6] >= 400000 or r[5] == 'PPLC':
            major.append([r[0], r[1], cid, round(r[2], 3), round(r[3], 3), r[6], 1 if r[5] == 'PPLC' else 0])
major.sort(key=lambda c: -c[5])
with open(os.path.join(OUT, 'cities_major.json'), 'w', encoding='utf-8') as f:
    json.dump(major, f, ensure_ascii=False, separators=(',', ':'))
print('major cities', len(major))

meta = {'countries': {}, 'states': {}}
for c in countries.values():
    meta['countries'][c['id']] = dict(name=c['name'], long=c['long'], a3=c['a3'], sov=c['sov'], type=c['type'],
                                      cont=c['cont'], sub=c['sub'], pop=c['pop'], label=[c['lx'], c['ly']],
                                      bbox=main_bbox(c['geom']), ncities=len(grouped.get(c['id'], [])),
                                      nstates=len(by_c_states.get(c['id'], [])), area=area_km2(c['geom']))
for s in states.values():
    meta['states'][s['id']] = dict(cid=s['cid'], name=s['name'], type=s['type'], iso=s['iso'],
                                   label=[s['lx'], s['ly']], bbox=bbox(s['geom']))
with open(os.path.join(OUT, 'meta.json'), 'w', encoding='utf-8') as f:
    json.dump(meta, f, ensure_ascii=False, separators=(',', ':'))
print('done')
