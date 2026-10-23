# Monthly news check: new 1:64 RESIN model cars listed by Horizon Diecast in the last ~month.
# Writes tools/news-auto.json (same shape as news-seed.json, with photos); news-images.py then downloads the photos.
# Rules the RCMI admin asked for: list item + description + release date only (no prices, no shop links); no photo = no post.
import json, re, html, urllib.request, datetime, sys
SHOP = "https://horizondiecast.com"
DAYS = int(sys.argv[1]) if len(sys.argv) > 1 else 35
since = (datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=DAYS)).isoformat()
NAMES = {"MINICRAFTSMAN": "Mini Craftsman", "MOTORHELIX": "MotorHelix", "TRON": "TRON", "PSM": "PSM", "DMY": "DMY", "HH Model": "HH Model"}
def get(url):
    return json.loads(urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"}), timeout=60).read())
def slug(s): return re.sub(r"^-|-$", "", re.sub(r"[^a-z0-9]+", "-", s.lower()))
products = []
for page in range(1, 6):
    ps = get(f"{SHOP}/products.json?limit=250&page={page}")["products"]
    products += ps
    if not ps or min(p["published_at"] for p in ps) < since: break
items = []
for p in products:
    if p["published_at"] < since: continue
    t = p["title"]
    if "1:64" not in t or re.search(r"figure|doll|girl|personnel|uniform|rider|diorama|garage|display case|decal", t, re.I): continue
    if any("Diorama" in x for x in p["tags"]): continue
    body = re.sub(r"\s+", " ", re.sub("<[^>]+>", " ", html.unescape(p.get("body_html") or "")))
    if not re.search(r"Material:\s*Resin", body, re.I): continue
    if not p.get("images"): continue                                   # no photo, no post
    pre = t.startswith("[Preorder]")
    name = t.replace("[Preorder]", "").strip()
    brand, model = [x.strip() for x in name.split("1:64", 1)]
    brand = NAMES.get(brand, brand)
    model = re.sub(r"\s+[A-Z]{2,}[\w-]*\d{3,}\w*$", "", model)           # drop the SKU
    colors = re.search(r"Color:\s*(.+?)\s+(Display|Packaging|Car Size|Opening|Manufacturer|Highly|Scale|Material|$)", body)
    eta = re.search(r"Estimated Release:\s*(Q[1-4])(?:\s*(20\d\d))?", body)
    pub = datetime.datetime.fromisoformat(p["published_at"])
    if pre and eta:
        q = eta.group(1); yr = eta.group(2) or str(pub.year + (1 if int(q[1]) < (pub.month - 1) // 3 + 1 else 0))
        when = f"{q} {yr}"
    elif pre: when = "TBA"
    else: when = f"Out now ({pub.strftime('%b %Y')})"
    text = f"New 1:64 resin model from {brand}" + (", now open for pre-order." if pre else f", released {pub.strftime('%B %Y')}.")
    if colors: text += f"\nColours: {colors.group(1).strip().replace('Sliver', 'Silver')}."
    if pre and when != "TBA": text += f"\nEstimated release: {when}."
    text += "\nPhotos: Horizon Diecast."
    s = slug(f"{brand}-{model}")[:60]
    srcs = [im["src"] for im in p["images"][:3]]
    items.append({"brand": brand, "title": model[:120], "model": model[:100], "scale": "1:64", "status": "preorder" if pre else "released",
                  "releaseDate": when, "price": None, "link": "", "body": text, "imgSrc": srcs, "key": p["handle"],
                  "photos": [f"/img/news/{s}-{k + 1}.jpg" for k in range(len(srcs))]})
json.dump(items, open("tools/news-auto.json", "w"), indent=1, ensure_ascii=False)
print(f"Monthly news: {len(items)} new 1:64 resin items since {since[:10]}")
