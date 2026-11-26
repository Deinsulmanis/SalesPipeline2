import json, sys, time, urllib.request, urllib.parse, http.cookiejar
out = sys.argv[1]
SEG = {
 "industrial": "industrial", "engineering": "engineering", "cdl": "cdl", "construction": "construction",
 "it": "it", "healthcare": "healthcare", "office": "office",
}
FALLBACK = {"cdl": "driver staffing", "office": "administrative staffing", "it": "it staffing", "engineering": "engineering staffing"}
cj = http.cookiejar.CookieJar(); op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))
op.addheaders = [('User-Agent', 'Mozilla/5.0'), ('Accept-Language', 'en-US')]
def get(u):
    for a in range(5):
        try:
            return op.open(u, timeout=30).read().decode()
        except urllib.error.HTTPError as e:
            if e.code == 429: time.sleep(20 + 20 * a); continue
            raise
    raise RuntimeError('429 persisted')
def series(kws):
    req = {"comparisonItem": [{"keyword": k, "geo": "US", "time": "today 12-m"} for k in kws], "category": 0, "property": ""}
    t = get('https://trends.google.com/trends/api/explore?' + urllib.parse.urlencode({'hl': 'en-US', 'tz': '0', 'req': json.dumps(req)}))
    w = [x for x in json.loads(t[5:])['widgets'] if x['id'] == 'TIMESERIES'][0]
    time.sleep(4)
    t = get('https://trends.google.com/trends/api/widgetdata/multiline?' + urllib.parse.urlencode({'hl': 'en-US', 'tz': '0', 'req': json.dumps(w['request']), 'token': w['token']}))
    tl = json.loads(t[5:])['default']['timelineData']
    return {k: [p['value'][i] for p in tl] for i, k in enumerate(kws)}, [p['formattedTime'] for p in tl]
res = {}
for seg, s in SEG.items():
    kws = [f"{s} staffing clients", f"{s} staffing marketing", FALLBACK.get(seg, f"{s} staffing")]
    if seg in FALLBACK and FALLBACK[seg] != f"{s} staffing": kws.append(f"{s} staffing")
    try:
        data, weeks = series(kws)
    except Exception as e:
        res[seg] = {"error": str(e)}; print(seg, 'ERR', e); continue
    seg_r = {}
    for k, v in data.items():
        last, prev, first = v[-14:-1], v[-27:-14], v[:13]   # drop the partial current week
        m = lambda a: round(sum(a) / len(a), 1) if a else 0
        nz = sum(1 for x in v if x > 0)
        seg_r[k] = {"last13": m(last), "prev13": m(prev), "first13": m(first), "nonzero_weeks": nz, "weeks": len(v)}
    res[seg] = {"keywords": seg_r, "range": [weeks[0], weeks[-1]]}
    print(seg, json.dumps(seg_r))
    time.sleep(8)
json.dump(res, open(out, 'w'), indent=1)
