"""City sights for the most-visited cities: data/sights.json.

    python3 tools/build_sights.py fetch WORKDIR    # Wikidata (QLever mirror) -> WORKDIR/raw/<geonameId>.json
    python3 tools/build_sights.py build WORKDIR    # rules below -> data/sights.json

Fetch: for each city in CITIES (GeoNames id via data/cities/<CC>.json, Wikidata item via its GeoNames id),
the 150 Wikidata items with the most Wikipedia sitelinks (6+) within a radius of the centre, with their
English label and description, and whether each is administratively inside the city (P131+).

Build: keep the famous places a visitor goes to see (museums, churches, palaces, towers, bridges, squares,
monuments...) and drop everything else (districts, stations, universities, companies, events...), judged
from the English description, ranked by sitelink count (stadiums, office towers and road bridges count less). A sight must be inside the city (P131+), or inside the city's core radius and in the same
country. Places that are already curated wonders are skipped. Up to 15 sights per top city, 10 / 7 for
the others (wonders in the city count toward that). The blurb is the Wikidata description, tidied.
Everything that is listed by hand below was checked by hand.

Row: [id, name, country, lat, lon, sprite, city GeoNames id, state id, blurb]. Ids are stored in people's
logbooks (l:<id>): once published, never rename or remove one.
"""
import json, math, os, re, sys, time, hashlib, unicodedata, urllib.request, urllib.parse

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from landmark_places import hav, in_ring, States, country_cities, core_rows  # noqa: E402

# name in data/cities/<CC>.json, country, tier (1: up to 15 landmarks, 2: 10, 3: 7)
CITIES = """
London GB 1|Paris FR 1|Istanbul TR 1|Antalya TR 3|Rome IT 1|Prague CZ 1|Amsterdam NL 1|Barcelona ES 1|Madrid ES 1|Milan IT 2|Vienna AT 1
|Berlin DE 1|Munich DE 2|Venice IT 1|Florence IT 1|Naples IT 2|Athens GR 1|Lisbon PT 1|Porto PT 2|Dublin IE 2|Edinburgh GB 2|Budapest HU 1
|Brussels BE 2|Copenhagen DK 2|Stockholm SE 2|Oslo NO 2|Helsinki FI 2|Reykjavík IS 3|Warsaw PL 2|Kraków PL 2|Saint Petersburg RU 1
|Moscow RU 1|Kyiv UA 2|Sevilla ES 2|Valencia ES 2|Granada ES 3|Nice FR 2|Lyon FR 2|Marseille FR 2|Zürich CH 2|Geneva CH 2|Salzburg AT 3
|Brugge BE 3|Dubrovnik HR 3|Split HR 3|Tallinn EE 3|Riga LV 3|Vilnius LT 3|Bucharest RO 2|Sofia BG 3|Belgrade RS 3|Frankfurt am Main DE 3
|Hamburg DE 2|Köln DE 2|Manchester GB 3|Liverpool GB 3|Valletta MT 3|Ljubljana SI 3|Bratislava SK 3|Monaco MC 3|Vatican City VA 2|Palma ES 3
|Málaga ES 3|Bologna IT 3|Verona IT 3|Pisa IT 3|Bordeaux FR 3|Strasbourg FR 3|Glasgow GB 3|Oxford GB 3|Cambridge GB 3|Luzern CH 3|Toledo ES 3
|Córdoba ES 3|Dresden DE 3
|Bangkok TH 1|Hong Kong HK 1|Singapore SG 1|Macau MO 2|Dubai AE 1|Abu Dhabi AE 2|Kuala Lumpur MY 1|Tokyo JP 1|Kyoto JP 1|Osaka JP 2|Seoul KR 1
|Busan KR 3|Taipei TW 2|Shanghai CN 1|Beijing CN 1|Guangzhou CN 3|Shenzhen CN 3|Xi’an CN 2|Chengdu CN 3|Hangzhou CN 3|Delhi IN 1|Mumbai IN 2
|Agra IN 2|Jaipur IN 2|Kolkata IN 3|Chennai IN 3|Bengaluru IN 3|Ho Chi Minh City VN 2|Hanoi VN 2|Phuket TH 3|Chiang Mai TH 3|Pattaya TH 3
|Denpasar ID 3|Jakarta ID 3|Yogyakarta ID 3|Manila PH 2|Cebu City PH 3|Phnom Penh KH 3|Siem Reap KH 3|Kathmandu NP 3|Colombo LK 3|Doha QA 3
|Riyadh SA 3|Makkah SA 3|Madinah SA 3|Jerusalem IL 1|Tel Aviv IL 3|Amman JO 3|Muscat OM 3|Tehran IR 3|Isfahan IR 3|Baku AZ 3|Tbilisi GE 3
|Yerevan AM 3|Tashkent UZ 3|Samarkand UZ 3|Ulan Bator MN 3|Hiroshima JP 3|Nara-shi JP 3|Lahore PK 3|Yangon MM 3|Luang Prabang LA 3|Almaty KZ 3
|Beirut LB 3|Da Nang VN 3|Hyderabad IN 3
|Cairo EG 1|Giza EG 3|Luxor EG 3|Marrakesh MA 2|Fes MA 3|Casablanca MA 3|Cape Town ZA 2|Johannesburg ZA 3|Nairobi KE 3|Zanzibar TZ 3|Tunis TN 3
|Lagos NG 3|Accra GH 3|Dakar SN 3|Addis Ababa ET 3|Kigali RW 3|Alexandria EG 3
|New York City US 1|Los Angeles US 1|Las Vegas US 2|San Francisco US 1|Miami US 2|Orlando US 3|Washington US 1|Chicago US 1|Boston US 2
|Honolulu US 3|Seattle US 2|New Orleans US 2|Philadelphia US 2|San Diego US 3|Toronto CA 2|Vancouver CA 2|Montréal CA 2|Québec CA 3
|Mexico City MX 1|Cancún MX 3|Havana CU 2|San Juan PR 3|Panama City PA 3
|Rio de Janeiro BR 1|São Paulo BR 2|Buenos Aires AR 1|Lima PE 2|Cusco PE 3|Santiago CL 2|Bogotá CO 2|Cartagena CO 3|Medellín CO 3|Quito EC 3
|La Paz BO 3|Montevideo UY 3|Salvador BR 3
|Sydney AU 1|Melbourne AU 2|Brisbane AU 3|Perth AU 3|Auckland NZ 2|Wellington NZ 3|Queenstown NZ 3
"""
CAP = {1: 15, 2: 10, 3: 7}
# Wikidata item for a city where looking it up by GeoNames id finds the wrong item, or none
CITY_QID = {
    'Barcelona': 'Q1492', 'Florence': 'Q2044', 'Oslo': 'Q585', 'Zürich': 'Q72', 'Salzburg': 'Q34713', 'Split': 'Q1663', 'Köln': 'Q365',
    'Palma': 'Q8826', 'Verona': 'Q2028', 'Hong Kong': 'Q8646', 'Cebu City': 'Q1467', 'Da Nang': 'Q25282', 'Rio de Janeiro': 'Q8678',
    'São Paulo': 'Q174', 'Milan': 'Q490', 'Marseille': 'Q23482', 'Kuala Lumpur': 'Q1865', 'Busan': 'Q16520', 'Shanghai': 'Q8686',
    'Beijing': 'Q956', 'Phuket': 'Q844430', 'Phnom Penh': 'Q1850', 'Ulan Bator': 'Q23430', 'Fes': 'Q80985', 'Madrid': 'Q2807',
    'Venice': 'Q641', 'Naples': 'Q2634', 'Porto': 'Q36433', 'Sevilla': 'Q8717', 'Valencia': 'Q8818', 'Granada': 'Q8810', 'Geneva': 'Q71',
    'Valletta': 'Q23800', 'Monaco': 'Q235', 'Vatican City': 'Q237', 'Málaga': 'Q8851', 'Bologna': 'Q1891', 'Pisa': 'Q13375',
    'Toledo': 'Q5836', 'Córdoba': 'Q5818', 'Singapore': 'Q334', 'Shenzhen': 'Q15174', 'Baku': 'Q9248', 'Yerevan': 'Q1953',
    'Nara-shi': 'Q169134', 'Medellín': 'Q48278', 'Salvador': 'Q36947', 'Cartagena': 'Q657461',
}

def radius(pop): return min(30, 4 + 6 * math.sqrt(pop / 1e6))   # km searched around the centre
def core_radius(pop): return 0.45 * radius(pop)                   # inside this, a same-country place counts as in the city

# ───────────────────────── fetch ─────────────────────────
PRE = '''PREFIX wd: <http://www.wikidata.org/entity/> PREFIX wdt: <http://www.wikidata.org/prop/direct/> PREFIX wikibase: <http://wikiba.se/ontology#>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#> PREFIX schema: <http://schema.org/>
PREFIX geof: <http://www.opengis.net/def/function/geosparql/> PREFIX geo: <http://www.opengis.net/ont/geosparql#>
'''
def sparql(work, query, gap=25):
    """QLever's Wikidata mirror (the main query service was rate-limited to 1 request a minute). Cached on disk."""
    os.makedirs(os.path.join(work, 'qcache'), exist_ok=True)
    h = os.path.join(work, 'qcache', hashlib.sha1(query.encode()).hexdigest() + '.json')
    if os.path.exists(h): return json.load(open(h))
    data = urllib.parse.urlencode({'query': PRE + query}).encode()
    for i in range(12):
        try:
            req = urllib.request.Request('https://qlever.dev/api/wikidata', data=data,
                                         headers={'User-Agent': 'whyb-landmark-builder/1.0', 'Accept': 'application/sparql-results+json'})
            res = json.load(urllib.request.urlopen(req, timeout=180))['results']['bindings']
            out = [{k: v['value'].replace('http://www.wikidata.org/entity/', '') for k, v in r.items()} for r in res]
            json.dump(out, open(h, 'w')); time.sleep(gap)
            return out
        except Exception as e:
            print('  retry', i, e, file=sys.stderr); time.sleep(90)
    raise RuntimeError('query failed')

def city_list():
    out = []
    for part in CITIES.replace('\n', '').split('|'):
        part = part.strip()
        if not part: continue
        name, cc, tier = re.match(r'(.+) (\w\w) (\d)$', part).groups()
        rows = [c for c in country_cities(cc)['cities'] if c[1] == name]
        if not rows: sys.exit(f'{name} not in data/cities/{cc}.json')
        c = max(rows, key=lambda c: c[4])
        d = country_cities(cc)
        out.append(dict(gid=c[0], name=name, cc=cc, lat=c[2], lon=c[3], pop=c[4], tier=int(tier), sid=d['states'][c[5]][0] if c[5] >= 0 else ''))
    return out

def fetch(work):
    cs = city_list()
    vals = ' '.join(f'"{c["gid"]}"' for c in cs)
    found = {}
    for r in sparql(work, f'SELECT ?gn ?city WHERE {{ VALUES ?gn {{ {vals} }} ?city wdt:P1566 ?gn . }}'):
        found.setdefault(r['gn'], r['city'])
    for c in cs: c['qid'] = CITY_QID.get(c['name']) or found.get(str(c['gid']))
    json.dump(cs, open(os.path.join(work, 'cities.json'), 'w'), ensure_ascii=False, indent=0)
    os.makedirs(os.path.join(work, 'raw'), exist_ok=True)
    todo = [c for c in cs if not os.path.exists(os.path.join(work, 'raw', f'{c["gid"]}.json'))]
    for bi in range(0, len(todo), 10):
        batch = todo[bi:bi + 10]
        vals = ' '.join(f'(wd:{c["qid"]} "POINT({c["lon"]} {c["lat"]})"^^geo:wktLiteral {radius(c["pop"]):.1f})' for c in batch)
        geo = sparql(work, f'''SELECT ?city ?item ?sl (SAMPLE(?co) AS ?coord) WHERE {{ VALUES (?city ?pt ?r) {{ {vals} }}
            ?item wdt:P625 ?co . ?item wikibase:sitelinks ?sl FILTER(?sl >= 6) FILTER(geof:distance(?co, ?pt) < ?r) }} GROUP BY ?city ?item ?sl''')
        keep = set()
        for c in batch:
            rows = sorted([g for g in geo if g['city'] == c['qid'] and g['item'].startswith('Q')], key=lambda g: -int(g['sl']))[:150]
            keep |= {g['item'] for g in rows}
        items, D = sorted(keep), {}
        for k in range(0, len(items), 700):
            chunk = ' '.join('wd:' + i for i in items[k:k + 700])
            for d in sparql(work, f'''SELECT ?item ?l ?d WHERE {{ VALUES ?item {{ {chunk} }}
                OPTIONAL {{ ?item rdfs:label ?l FILTER(lang(?l)="en") }} OPTIONAL {{ ?item schema:description ?d FILTER(lang(?d)="en") }} }}'''):
                D[d['item']] = d
        cv = ' '.join('wd:' + c['qid'] for c in batch)
        M = set()
        for k in range(0, len(items), 700):   # which candidates are administratively inside which city
            chunk = ' '.join('wd:' + i for i in items[k:k + 700])
            M |= {(m['city'], m['item']) for m in sparql(work, f'SELECT DISTINCT ?city ?item WHERE {{ VALUES ?city {{ {cv} }} VALUES ?item {{ {chunk} }} ?item wdt:P131+ ?city . }}')}
        for c in batch:
            out = [{**g, **D[g['item']], 'inCity': (c['qid'], g['item']) in M} for g in geo if g['city'] == c['qid'] and D.get(g['item'], {}).get('l')]
            out.sort(key=lambda r: -int(r['sl']))
            json.dump(out, open(os.path.join(work, 'raw', f'{c["gid"]}.json'), 'w'), ensure_ascii=False)
            print(c['name'], len(out), sum(r['inCity'] for r in out), flush=True)

# ───────────────────────── build ─────────────────────────
# What a sight is, from its Wikidata description (checked against the top results of every city by hand).
# First match wins; the sprite is the generic pixel icon used on the map and in lists.
KINDS = [
    (r'\bferris wheel|observation wheel', 'wheel'),
    (r'\blighthouse', 'lighthouse'),
    (r'\bmosque|masjid', 'mosque'),
    (r'\bstupa\b|\bdagoba', 'stupa'),
    (r'\bshinto shrine|\bjinja\b', 'torii'),
    (r'\bbuddhist temple|\bpagoda|\bwat\b|buddhist monastery', 'pagoda'),
    (r'\bcathedral|\bbasilica|\bchurch|\babbey|\bchapel|\bminster\b|\bmonastery|\bconvent\b|\bpriory', 'cathedral'),
    (r'\bsynagogue|\bhindu temple|\btemple\b|\bgurdwara|\bshrine\b|\bconfucian', 'temple'),
    (r'\bmuseum|\bgallery\b|art gallery|\bplanetarium|science cent|cultural cent|arts cent|\bobservatory', 'museum'),
    (r'\bpalace\b|\bchâteau|\bchateau|\bresidence\b|stately home|\bmansion\b|\bmanor\b|\bvilla\b', 'palace'),
    (r'\bcastle\b|\bfortress|\bfort\b|\bcitadel|\bkremlin\b|\bcity walls?\b|\bfortification|\bbastion', 'castle'),
    (r'\bskyscraper|\bhigh-rise|\btallest building', 'skyscraper'),
    (r'\btower\b|\bminaret|\bcampanile|\bbelfry', 'tower'),
    (r'\bbridge\b', 'bridge'),
    (r'triumphal arch|\barch\b', 'arch'),
    (r'\bcity gate|\bgate\b|\bgateway\b', 'gate'),
    (r'\bobelisk|\bcolumn\b', 'obelisk'),
    (r'\bopera house|\btheatre\b|\btheater\b|\bconcert hall|\bopera\b|\bcabaret', 'opera'),
    (r'\bstadium|\barena\b|\bbullring|\bvelodrome|sports venue', 'stadium'),
    (r'\bamphitheatre|\bamphitheater|\barchaeological|\bruins?\b|\bancient\b|\bthermae|\bforum\b|\bacropolis', 'ruins'),
    (r'\bmausoleum|\btomb\b|\bnecropolis', 'temple'),
    (r'\bmarket\b|\bbazaar|\bsouk|\bsouq|market hall', 'market'),
    (r'\bfountain', 'fountain'),
    (r'\bsquare\b|\bplaza\b|\bpiazza|public space|\bzócalo', 'fountain'),
    (r'\bavenue\b|\bstreet\b|\bboulevard|\bpromenade|\besplanade|\bpedestrian|\bboardwalk|\bwaterfront|\broad\b', 'street'),
    (r'\bcemetery', 'statue'),
    (r'\bmonument\b|\bmemorial\b|\bstatue\b|\bsculpture\b', 'statue'),
    (r'\bbotanical garden|\bgardens?\b|\bpark\b|\bzoo\b|\baquarium|green space', 'tree'),
    (r'\bhills?\b', 'mountain'),
    (r'\bstairs\b|\bsteps\b|\bstaircase', 'street'),
    (r'\bcistern|\bbaths\b|\baqueduct', 'ruins'),
    (r'\bbeach\b', 'island'),
    (r'\bcanal\b', 'bridge'),
    (r'\btown hall|\bcity hall|\bparliament building|\blegislative building|\bcapitol\b|\bcourthouse|\bopera\b|\bhall\b', 'palace'),
    (r'\blandmark\b|tourist attraction|visitor attraction|\bcathedral', 'museum'),
]
# never a sight, whatever else the description says
DENY = re.compile(r'''\b(commune|municipality|department|region|district|borough|neighbou?rhood|suburb|quarter|ward|arrondissement|
  county|province|prefecture|language|organi[sz]ation|agency|company|corporation|enterprise|club|team|university|college|school|
  institute|hospital|station|airport|metro|subway|railway|rail\b|tram|bus\b|newspaper|broadcaster|magazine|attack|bombing|massacre|
  battle|siege|revolution|riot|protest|uprising|treaty|agreement|conference|summit|olympic|games|championship|tournament|festival|
  exhibition|expo\b|election|empire|republic|kingdom|dynasty|government|ministry|court\b|record label|album|film|song|novel|
  stock exchange|bank\b|society|academy|diocese|parish\b|river|lake|lagoon|sea\b|ocean|island|peninsula|hotel|restaurant|shopping|
  department store|mall\b|brand|software|website|award|human settlement|census|unincorporated|former\b|demolished|destroyed|
  defunct|historical\s(country|state|period)|consulate|embassy|headquarters|office\b|business|financial|research|laboratory|
  residential|apartment|housing|campus|seminary|airline|race\b|marathon|parade|event|disaster|fire\b|earthquake|flood|
  constituency|electoral|police|prison|military|barracks|naval|army|air\sbase|power\sstation|plant\b|factory|brewery|
  port\b|harbou?r\b|highway|motorway|expressway|ring\sroad|tunnel|interchange|junction|square\skilomet|area\sof|locality|
  village|town\b|city\b\s+(in|of)|capital|federal|state\sof|territory|archipelago|mountain\srange|valley|national\spark|
  nature\sreserve|forest|watercourse|tributary|journal|television|radio|channel|operator|network|system|series|season|
  incident|scandal|crime|feast|procession|pilgrimage\b|murder|assassination|strike\b|movement|party\b|group\b|band\b|orchestra|choir|ballet\scompany|
  hydroelectric|reservoir|dam\b|stock|index|exchange|market\sindex|trading)''', re.X | re.I)
# checked by hand: famous places the rules above would drop (description too vague), and places they keep wrongly
# tools/sights-hand.txt, one line per Wikidata item:  Qid keep <sprite> | Qid drop | Qid name <English name>  # comment
HAND = open(os.path.join(ROOT, 'tools/sights-hand.txt'), encoding='utf-8').read() if os.path.exists(os.path.join(ROOT, 'tools/sights-hand.txt')) else ''
FORCE_KEEP, FORCE_DROP, FORCE_KIND, RENAME, FORCE_CITY, BLURB = set(), set(), {}, {}, {}, {}
def _hand():
    for line in HAND.splitlines():
        line = line.split('#')[0].strip()
        if not line: continue
        q, act, *rest = line.split(None, 2)
        if act == 'keep': FORCE_KEEP.add(q); FORCE_KIND[q] = rest[0] if rest else 'museum'
        elif act == 'drop': FORCE_DROP.add(q)
        elif act == 'name': RENAME[q] = rest[0].strip()
        elif act == 'blurb': BLURB[q] = rest[0].strip()
        elif act == 'city': FORCE_CITY[q] = int(rest[0].split()[0])


def slug(s):
    s = unicodedata.normalize('NFKD', s).encode('ascii', 'ignore').decode().lower()
    return re.sub(r'[^a-z0-9]+', '-', s).strip('-')[:40].strip('-')

class Countries:
    def __init__(self):
        g = json.load(open(os.path.join(ROOT, 'data/countries.geojson')))
        self.f = {}
        for f in g['features']:
            if not f.get('geometry'): continue
            polys = [f['geometry']['coordinates']] if f['geometry']['type'] == 'Polygon' else f['geometry']['coordinates']
            self.f.setdefault(f['properties']['id'], []).extend(p for p in polys if p and p[0])
        self.bb = {cc: [(min(x for x, y in p[0]), min(y for x, y in p[0]), max(x for x, y in p[0]), max(y for x, y in p[0])) for p in ps] for cc, ps in self.f.items()}
    def which(self, lon, lat):
        """The country this point is in, or None (the borders are simplified: points by the water can fall outside)."""
        for cc, ps in self.f.items():
            for p, b in zip(ps, self.bb[cc]):
                if b[0] <= lon <= b[2] and b[1] <= lat <= b[3] and in_ring(lon, lat, p[0]) and not any(in_ring(lon, lat, h) for h in p[1:]): return cc
        return None

STOP = {'the', 'of', 'de', 'la', 'le', 'du', 'des', 'and', 'st', 'saint', 'san', 'santa', 'church', 'museum', 'palace', 'tower', 'park',
        'square', 'bridge', 'cathedral', 'old', 'new', 'national', 'royal', 'grand', 'great', 'city', 'house', 'gate', 'temple', 'mosque', ''}
GONE = re.compile(r'\b(former|formerly a|demolished|destroyed|defunct|no longer|ruined in|which stood|that stood)\b', re.I)
# a whole town, country or era rather than a place in it
PLACE = re.compile(r'(\b(city|town|settlement|country|civilization|civilisation|period|polis|colony)$)|^(ancient )?(greek |roman )?(city|town|country|state|empire|kingdom|nation|polity)\b', re.I)
# works of art inside a museum, and libraries: the museum or building is the sight
ARTWORK = re.compile(r'\b(sculpture|painting|fresco|mosaic|artwork|tapestry|manuscript|mascaron|library|statue (from|of a))\b', re.I)

def head(desc):
    """'art museum in Paris, France' -> 'art museum': the kind of place, without where it is."""
    desc = re.sub(r'^(one|any|part|each) of (the )?(\w+ )?', '', desc)
    return re.split(r'\s(?:in|of|on|at|located|near|for|from|by|between|within|across|overlooking)\s|,|;|\(', desc, maxsplit=1)[0]

def core_names():
    src = open(os.path.join(ROOT, 'js/landmarks.js'), encoding='utf-8').read()
    return [(m[0], m[1], float(m[3]), float(m[4])) for m in re.findall(r"^\['([^']+)','((?:[^'\\]|\\.)*)','(\w+)',([-\d.]+),([-\d.]+),", src, re.M)]

def kind_of(desc):
    for rx, sprite in KINDS:
        if re.search(rx, desc, re.I): return sprite
    return None

def blurb(desc, kind_word=''):
    d = (desc or '').strip()
    d = re.sub(r'\s+', ' ', d)
    if len(d) > 95:
        d = d[:95]
        d = d.rsplit(',', 1)[0] if ',' in d else d.rsplit(' ', 1)[0]
    d = d[:1].upper() + d[1:]
    return d.rstrip('.') + '.' if d else ''

def candidates(work):
    cs = json.load(open(os.path.join(work, 'cities.json')))
    co = Countries()
    core = core_names()
    out = {}
    for c in cs:
        if 'sid' not in c:
            d = country_cities(c['cc']); row = next(r for r in d['cities'] if r[0] == c['gid'])
            c['sid'] = d['states'][row[5]][0] if row[5] >= 0 else ''
        p = os.path.join(work, 'raw', f'{c["gid"]}.json')
        if not os.path.exists(p): continue
        rows = []
        for r in json.load(open(p)):
            lon, lat = map(float, r['coord'][6:-1].split())
            d = hav(c['lat'], c['lon'], lat, lon)
            name, desc = r['l'], r.get('d', '')
            why = ''
            if r['item'] in FORCE_DROP: why = 'hand'
            elif not (r['inCity'] or d <= core_radius(c['pop'])): why = 'outside'
            elif not r['inCity'] and co.which(lon, lat) not in (None, c['cc']): why = 'country'
            elif int(r['sl']) < 8 and r['item'] not in FORCE_KEEP: why = 'obscure'
            elif r['item'] not in FORCE_KEEP and (not desc or DENY.search(head(desc)) or GONE.search(desc) or ARTWORK.search(head(desc))
                                                   or PLACE.search(head(desc))): why = 'deny'
            kind = FORCE_KIND.get(r['item']) or kind_of(head(desc)) or kind_of(name) or ('museum' if r['item'] in FORCE_KEEP else None)
            if not why and not kind: why = 'kind'
            # already a curated wonder: the same place (very close), or close with a shared name word
            words = set(slug(name).split('-')) - STOP
            near = [lid for lid, nm, la, lo in core if hav(lat, lon, la, lo) < 0.08 or (hav(lat, lon, la, lo) < 0.6 and words & (set(slug(nm).split('-')) - STOP))]
            if not why and near: why = 'wonder:' + near[0]
            rows.append(dict(qid=r['item'], name=name, desc=desc, sl=int(r['sl']), lat=lat, lon=lon, d=d, inCity=r['inCity'], kind=kind, why=why))
        out[c['gid']] = (c, rows)
    return out

# per-city limits on kinds that would otherwise crowd out the sights (big cities have many stadiums and towers)
KIND_CAP = {'stadium': 1, 'skyscraper': 2, 'street': 2, 'opera': 2, 'tree': 3, 'mountain': 2}
MIN_SL_KIND = {'stadium': 50}
# what a visitor goes to see ranks ahead of what merely has many Wikipedia articles (stadiums, office towers, road bridges)
WEIGHT = {'stadium': 0.45, 'skyscraper': 0.7, 'bridge': 0.7, 'street': 0.8, 'mountain': 0.9, 'palace': 0.95}

def build(work, report=False):
    _hand()
    picked, per_city = {}, {}
    C = candidates(work)
    # a place near two cities belongs to the one it is administratively in, else the nearer centre
    owner = {}
    for gid, (c, rows) in C.items():
        for r in rows:
            if r['why']: continue
            if r['qid'] in FORCE_CITY: owner[r['qid']] = (FORCE_CITY[r['qid']], True, 0); continue
            o = owner.get(r['qid'])
            if not o or (r['inCity'] and not o[1]) or (r['inCity'] == o[1] and r['d'] < o[2]): owner[r['qid']] = (gid, r['inCity'], r['d'])
    wonder_city = {}
    for lid, gid_sid in core_city_map().items():
        if gid_sid: wonder_city[gid_sid] = wonder_city.get(gid_sid, 0) + 1
    used_ids = {lid for lid, *_ in core_names()}
    out = []
    for gid, (c, rows) in C.items():
        cap = max(0, CAP[c['tier']] - wonder_city.get(gid, 0))
        kinds, n = {}, 0
        mine = [r for r in rows if not r['why'] and owner.get(r['qid'], (None,))[0] == gid]
        mine.sort(key=lambda r: -r['sl'] * WEIGHT.get(r['kind'], 1) - (1e5 if r['qid'] in FORCE_KEEP else 0))
        for r in mine:
            if n >= cap: r['why'] = 'cap'; continue
            k = r['kind']
            if r['qid'] not in FORCE_KEEP and (kinds.get(k, 0) >= KIND_CAP.get(k, 99) or r['sl'] < MIN_SL_KIND.get(k, 0)): r['why'] = 'kindcap'; continue
            kinds[k] = kinds.get(k, 0) + 1; n += 1
            name = RENAME.get(r['qid'], r['name'])
            name = name[:1].upper() + name[1:]
            sid = slug(name) or r['qid'].lower()
            if sid in used_ids: sid = slug(name + ' ' + c['name'])
            if sid in used_ids: sid = sid + '-' + r['qid'].lower()
            used_ids.add(sid)
            r['id'] = sid
            b = BLURB.get(r['qid']) or blurb(r['desc'])
            if len(b.split()) <= 2: b = b.rstrip('.') + ' in ' + DISPLAY.get(c['name'], c['name']) + '.'   # 'Cathedral.' -> 'Cathedral in Porto.'
            out.append([sid, name, c['cc'], round(r['lat'], 4), round(r['lon'], 4), k, c['gid'], c['sid'], b, r['qid']])
        per_city[gid] = (c, rows)
    if report: return out, per_city
    rows = out   # the 10th field is the Wikidata item, for checking and rebuilding
    with open(os.path.join(ROOT, 'data/sights.json'), 'w', encoding='utf-8') as f:
        f.write('[\n' + ',\n'.join(json.dumps(r, ensure_ascii=False, separators=(',', ':')) for r in rows) + '\n]\n')
    print(f'{len(rows)} sights in {len({r[6] for r in rows})} cities -> data/sights.json')
    return out, per_city

# English names for cities whose GeoNames name differs
DISPLAY = {'Köln': 'Cologne', 'Sevilla': 'Seville', 'Nara-shi': 'Nara', 'Brugge': 'Bruges', 'Luzern': 'Lucerne', 'Makkah': 'Mecca',
           'Madinah': 'Medina', 'Ulan Bator': 'Ulaanbaatar', 'Washington': 'Washington, D.C.', 'Québec': 'Quebec City', 'Fes': 'Fez',
           'Xi’an': "Xi'an", 'Frankfurt am Main': 'Frankfurt', 'Zürich': 'Zurich', 'Montréal': 'Montreal'}

def core_city_map():
    src = open(os.path.join(ROOT, 'js/landmark-places.js'), encoding='utf-8').read()
    return {m[0]: int(m[1]) for m in re.findall(r"^'([^']+)':\[(\d+),", src, re.M)}

if __name__ == '__main__':
    if len(sys.argv) < 3 or sys.argv[1] not in ('fetch', 'build'): sys.exit(__doc__)
    fetch(sys.argv[2]) if sys.argv[1] == 'fetch' else build(sys.argv[2])
