# Builds the champion plaques (A5, black only, for metal etching) and certificates (A4 landscape, colour).
# Run: python3 tools/plakat/build.py  → tools/plakat/out/*.html (rendered to PDF/PNG by .github/workflows/render-plakat.yml)
import os
D = os.path.dirname(os.path.abspath(__file__)); OUT = os.path.join(D, "out"); os.makedirs(OUT, exist_ok=True)
FONTS = '<link href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:ital,wght@0,600;0,700;0,800;1,700;1,800&family=Barlow:wght@400;500;600;700&family=Permanent+Marker&family=Great+Vibes&display=swap" rel="stylesheet">'
PLACES = {1: ("1st", "Champion"), 2: ("2nd", "Runner-up"), 3: ("3rd", "Second runner-up")}
JURY = [("diecast-diorama", "Diecast &amp; Diorama"), ("setsudou", "setsudou"), ("ricky", "Ricky Robertus")]
SPONSORS = [("toko-kuning", "Toko Kuning"), ("kepopic", "Kepopic Studio"), ("hellios", "Hellios Studio"), ("arsaka", "Arsaka Toys"), ("bebetoys", "bebetoys"), ("kourin", "Kourin Labs")]
YEAR = "2026"; DATE = "[DATE] 2026"

def plaque(n):
    ordn, title = PLACES[n]
    logo = lambda f, h: f'<img src="../logos/{f}.png" style="height:{h}px;width:auto;display:block">'
    sizes = {"toko-kuning": 50, "arsaka": 48, "hellios": 42, "kepopic": 26, "bebetoys": 30, "kourin": 24, "diecast-diorama": 34, "setsudou": 22, "ricky": 26}
    row = lambda items: "".join(f'<span class="lg">{logo(f, sizes[f])}</span>' for f, _ in items)
    return f'''<!doctype html><html><head><meta charset="utf-8"><title>RCMI Photo Contest plaque — {ordn} place</title>{FONTS}
<style>
@page {{ size: 148mm 210mm; margin: 0 }}
html,body {{ margin:0; }}
.p {{ position:relative; width:148mm; height:210mm; overflow:hidden; background:#fff; color:#000; font-family:Barlow,sans-serif; box-sizing:border-box; padding:14mm 9mm 9mm; text-align:center }}
.c {{ font-family:'Barlow Condensed',sans-serif }}
.rcmi {{ position:absolute; left:7mm; top:6mm; height:13mm }}
.k {{ font-weight:800; font-style:italic; text-transform:uppercase; letter-spacing:.02em; font-size:15px; margin:0 }}
.t {{ position:relative; display:inline-block; margin:2px 0 0; font-weight:800; font-style:italic; text-transform:uppercase; font-size:58px; line-height:.86 }}
.flag {{ position:absolute; right:-6px; top:-16px; display:grid; grid-template-columns:repeat(6,8px); grid-template-rows:repeat(2,6px); transform:skewX(-20deg) }}
.flag i {{ background:#000 }} .flag i:nth-child(even) {{ background:transparent }} .flag i:nth-child(n+7):nth-child(odd) {{ background:transparent }} .flag i:nth-child(n+7):nth-child(even) {{ background:#000 }}
.by {{ margin-top:6px; font-size:11px; font-weight:700; letter-spacing:.18em; text-transform:uppercase }}
.pre {{ margin:16px 0 0; font-size:13px; font-weight:600 }}
.place {{ margin:12px 0 0; font-weight:800; font-style:italic; text-transform:uppercase; font-size:78px; line-height:.85 }}
.place sup {{ font-size:.42em; vertical-align:.95em; margin-left:1px }}
.ttl {{ margin:2px 0 0; font-weight:800; font-style:italic; text-transform:uppercase; letter-spacing:.24em; font-size:15px }}
.name {{ margin:18px 0 0; font-family:'Permanent Marker',cursive; font-size:34px; line-height:1.05 }}
.photo {{ margin:6px 0 0; font-size:13px; font-style:italic; font-weight:600 }}
.msg {{ margin:14px 0 0; font-size:11.5px; line-height:1.45; font-weight:500 }}
.div {{ display:flex; align-items:center; gap:8px; margin:12px 0 7px }}
.div::before,.div::after {{ content:""; flex:1; height:1.4px; background:#000 }}
.div span {{ font-weight:800; font-size:9px; letter-spacing:.12em; text-transform:uppercase }}
.row {{ display:flex; justify-content:center; align-items:center; gap:14px; flex-wrap:wrap }}
.lg {{ display:flex; align-items:center; justify-content:center; height:52px }}
.bottom {{ position:absolute; left:9mm; right:9mm; bottom:8mm }}
</style></head><body><div class="p">
<img class="rcmi" src="../logos/rcmi.png" alt="RCMI">
<p class="k c">RCMI presents</p>
<div class="t c">Photo<br>Contest<span class="flag">{"<i></i>"*12}</span></div>
<div class="by">by Resin Car Model Indonesia · {YEAR}</div>
<p class="pre">Presented to</p>
<p class="name">[Winner Name]</p>
<p class="photo">for the photo “[Photo title]”</p>
<div class="place c">{n}<sup>{ordn[1:].upper()}</sup> Place</div>
<div class="ttl c">{title}</div>
<p class="msg">RCMI Photo Contest {YEAR} · Your best shot of a 1:64 model car<br>{DATE} · rcmi-website.web.app</p>
<div class="bottom">
<div class="div"><span>Jury</span></div>
<div class="row">{row(JURY)}</div>
<div class="div"><span>Sponsored by</span></div>
<div class="row">{row(SPONSORS)}</div>
</div>
</div></body></html>'''

def certificate(n):
    ordn, title = PLACES[n]
    medal = {1: ("#E2B33C", "#B8860B", "#FFF3C4"), 2: ("#C9CDD4", "#8E949C", "#F4F5F7"), 3: ("#CD8B52", "#9A5B2A", "#F6E1CC")}[n]
    sp = "".join(f'<span class="lg"><img src="../../../public/img/sponsors/{f}" alt="{a}"></span>' for f, a in [("toko-kuning.jpg","Toko Kuning"),("kepopic-studio.jpg","Kepopic Studio"),("hellios-studio.png","Hellios Studio"),("arsaka-toys.jpg","Arsaka Toys"),("bebetoys.jpg","bebetoys"),("kourin-labs.jpg","Kourin Labs")])
    jy = "".join(f'<span class="lg"><img src="../../../public/img/jury/{f}" alt="{a}"></span>' for f, a in [("jury-chevron.png","Diecast & Diorama"),("setsudou.png","setsudou"),("ricky.png","Ricky Robertus")])
    return f'''<!doctype html><html><head><meta charset="utf-8"><title>RCMI Photo Contest certificate — {ordn} place</title>{FONTS}
<style>
@page {{ size: 297mm 210mm; margin: 0 }}
html,body {{ margin:0 }}
.p {{ position:relative; width:297mm; height:210mm; overflow:hidden; background:#FBFAF7; color:#12141C; font-family:Barlow,sans-serif; display:grid; grid-template-columns:78mm 1fr }}
.c {{ font-family:'Barlow Condensed',sans-serif }}
.side {{ position:relative; background:#0E0F13; color:#fff; padding:14mm 10mm; display:flex; flex-direction:column; justify-content:space-between; overflow:hidden }}
.side::after {{ content:""; position:absolute; top:0; bottom:0; right:0; width:5px; background:#D6102B }}
.side img.logo {{ width:52mm; height:auto }}
.medal {{ align-self:center; width:52mm; height:52mm; border-radius:50%; display:grid; place-items:center; background:radial-gradient(circle at 35% 30%, {medal[2]}, {medal[0]} 45%, {medal[1]}); box-shadow:0 0 0 5px #0E0F13, 0 0 0 7px {medal[0]}; color:#12141C; text-align:center }}
.medal b {{ display:block; font-family:'Barlow Condensed',sans-serif; font-style:italic; font-weight:800; font-size:64px; line-height:.8 }}
.medal b sup {{ font-size:.4em; vertical-align:1em }}
.medal small {{ display:block; font-weight:800; letter-spacing:.2em; text-transform:uppercase; font-size:12px; margin-top:6px }}
.side .k {{ font-weight:700; letter-spacing:.3em; text-transform:uppercase; font-size:11px; color:#C9CBD3 }}
.side .k b {{ display:block; color:#FFC72C; font-size:22px; letter-spacing:.04em; font-style:italic; font-family:'Barlow Condensed',sans-serif; font-weight:800; margin-top:2px }}
.main {{ position:relative; padding:14mm 16mm 10mm 16mm; display:flex; flex-direction:column }}
.main::before {{ content:""; position:absolute; inset:7mm; border:1.5px solid #12141C; pointer-events:none }}
.main::after {{ content:""; position:absolute; inset:8.6mm; border:.6px solid #D6102B; pointer-events:none }}
.eyebrow {{ font-weight:700; letter-spacing:.34em; text-transform:uppercase; font-size:13px; color:#5B5F6B; margin:4mm 0 0 }}
h1 {{ margin:2px 0 0; font-family:'Barlow Condensed',sans-serif; font-style:italic; font-weight:800; text-transform:uppercase; font-size:60px; line-height:.92 }}
h1 span {{ color:#D6102B }}
.to {{ margin:9mm 0 0; font-size:15px; font-weight:600; color:#3C3F48 }}
.name {{ margin:2mm 0 0; font-family:'Great Vibes',cursive; font-size:64px; line-height:1.05; border-bottom:1.5px solid #12141C; padding-bottom:2mm; max-width:170mm }}
.why {{ margin:5mm 0 0; font-size:16px; line-height:1.5; max-width:175mm }}
.why b {{ font-weight:700 }}
.foot {{ margin-top:auto; display:flex; align-items:flex-end; justify-content:space-between; gap:10mm }}
.sig {{ width:55mm; text-align:center; font-size:12px }}
.sig i {{ display:block; height:14mm }}
.sig b {{ display:block; border-top:1.2px solid #12141C; padding-top:2mm; font-weight:700; font-size:13px }}
.meta {{ font-size:11px; color:#5B5F6B; line-height:1.5; text-align:right }}
.logos {{ margin-top:5mm; display:flex; align-items:center; gap:7mm }}
.logos small {{ font-weight:800; letter-spacing:.16em; text-transform:uppercase; font-size:9px; color:#5B5F6B; writing-mode:horizontal-tb; white-space:nowrap }}
.lg {{ height:11mm; display:flex; align-items:center }}
.lg img {{ max-height:11mm; max-width:22mm; width:auto; border-radius:3px; display:block }}
.grp {{ display:flex; align-items:center; gap:3mm }}
</style></head><body><div class="p">
<aside class="side">
<img class="logo" src="../../../public/img/logo-white.png" alt="RCMI">
<div class="medal"><div><b>{n}<sup>{ordn[1:].upper()}</sup></b><small>{title}</small></div></div>
<div class="k">RCMI Photo Contest<b>{YEAR}</b></div>
</aside>
<main class="main">
<p class="eyebrow">Certificate of achievement</p>
<h1>RCMI Photo <span>Contest {YEAR}</span></h1>
<p class="to">This certificate is proudly presented to</p>
<p class="name">[Winner Name]</p>
<p class="why">for winning <b>{n}{ordn[1:]} place ({title})</b> in the RCMI Photo Contest {YEAR} with the photo <b>“[Photo title]”</b>, judged on lighting &amp; mood, storytelling, craftsmanship, theme and creativity, together with the public vote.</p>
<div class="foot">
<div class="sig"><i></i><b>[Name]</b>Founder, RCMI</div>
<div class="sig"><i></i><b>[Name]</b>Head of the jury</div>
<div class="meta">Registration no. [0000000]<br>{DATE}<br>rcmi-website.web.app</div>
</div>
<div class="logos">
<div class="grp"><small>Jury</small>{jy}</div>
<div class="grp"><small>Sponsored by</small>{sp}</div>
</div>
</main>
</div></body></html>'''

for n in (1, 2, 3):
    open(os.path.join(OUT, f"plaque-{n}.html"), "w").write(plaque(n))
    open(os.path.join(OUT, f"certificate-{n}.html"), "w").write(certificate(n))
print("built", sorted(os.listdir(OUT)))
