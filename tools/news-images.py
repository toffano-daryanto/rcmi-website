# Downloads the photos listed in tools/news-seed.json ("imgSrc") into public/img/news/ at the paths in "photos".
# Resized to max 1200 px, JPEG. Skips files that already exist. Run by .github/workflows/seed-news.yml.
import json, io, os, sys, urllib.request
from PIL import Image
items = json.load(open(sys.argv[1] if len(sys.argv) > 1 else "tools/news-seed.json"))
os.makedirs("public/img/news", exist_ok=True)
n = 0
for it in items:
    for src, dst in zip(it.get("imgSrc", []), it.get("photos", [])):
        path = "public" + dst
        if os.path.exists(path): continue
        req = urllib.request.Request(src if src.startswith("http") else "https:" + src, headers={"User-Agent": "Mozilla/5.0"})
        try: im = Image.open(io.BytesIO(urllib.request.urlopen(req, timeout=60).read())).convert("RGB")
        except Exception as e: print("skip", src, e); continue
        im.thumbnail((1200, 1200))
        im.save(path, "JPEG", quality=85, optimize=True); n += 1
print(f"News photos: {n} downloaded")
