# Builds the champion plaques (A5, black only, for metal etching) and certificates (A4 landscape, colour).
# Run: python3 tools/plakat/build.py  → tools/plakat/out/*.html (rendered to PDF/PNG by .github/workflows/render-plakat.yml)
import os
D = os.path.dirname(os.path.abspath(__file__)); OUT = os.path.join(D, "out"); os.makedirs(OUT, exist_ok=True)
FONTS = '<link href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:ital,wght@0,600;0,700;0,800;1,700;1,800&family=Barlow:wght@400;500;600;700&family=Permanent+Marker&family=Great+Vibes&display=swap" rel="stylesheet">'
PLACES = {1: ("1st", "Champion"), 2: ("2nd", "Runner-up"), 3: ("3rd", "Second runner-up"), 4: ("4th", "Third runner-up"), 5: ("5th", "Fourth runner-up")}
JURY = [("diecast-diorama", "Diecast &amp; Diorama"), ("setsudou", "setsudou"), ("ricky", "Ricky Robertus")]
SPONSORS = [("toko-kuning", "Toko Kuning"), ("kepopic", "Kepopic Studio"), ("hellios", "Hellios Studio"), ("arsaka", "Arsaka Toys"), ("bebetoys", "bebetoys"), ("kourin", "Kourin Labs")]
YEAR = "2026"; DATE = "[DATE] 2026"

def plaque(n):
    ordn, title = PLACES[n]
    logo = lambda f, h: f'<img src="../logos/{f}.png" style="height:{h}px;width:auto;display:block">'
    sizes = {"toko-kuning": 50, "arsaka": 48, "hellios": 42, "kepopic": 26, "bebetoys": 30, "kourin": 24, "diecast-diorama": 34, "setsudou": 22, "ricky": 26}
    row = lambda items, k=1: "".join(f'<span class="lg{" sm" if k < 1 else ""}">{logo(f, round(sizes[f] * k))}<em>{a}</em></span>' for f, a in items)
    return f'''<!doctype html><html><head><meta charset="utf-8"><title>RCMI Photo Contest plaque — {ordn} place</title>{FONTS}
<style>
@page {{ size: 148mm 210mm; margin: 0 }}
html,body {{ margin:0; }}
.p {{ position:relative; width:148mm; height:210mm; overflow:hidden; background:#fff; color:#000; font-family:Barlow,sans-serif; box-sizing:border-box; padding:13mm 9mm 8mm; text-align:center; display:flex; flex-direction:column; justify-content:space-between }}
.blk {{ display:flex; flex-direction:column; align-items:center }}
.c {{ font-family:'Barlow Condensed',sans-serif }}
.rcmi {{ position:absolute; left:7mm; top:6mm; height:13mm }}
.k {{ font-weight:800; font-style:italic; text-transform:uppercase; letter-spacing:.02em; font-size:15px; margin:0 }}
.t {{ position:relative; display:inline-block; margin:2px 0 0; font-weight:800; font-style:italic; text-transform:uppercase; font-size:58px; line-height:.86 }}
.flag {{ position:absolute; right:-6px; top:-16px; display:grid; grid-template-columns:repeat(6,8px); grid-template-rows:repeat(2,6px); transform:skewX(-20deg) }}
.flag i {{ background:#000 }} .flag i:nth-child(even) {{ background:transparent }} .flag i:nth-child(n+7):nth-child(odd) {{ background:transparent }} .flag i:nth-child(n+7):nth-child(even) {{ background:#000 }}
.by {{ margin-top:6px; font-size:11px; font-weight:700; letter-spacing:.18em; text-transform:uppercase }}
.pre {{ margin:0; font-size:13px; font-weight:600 }}
.place {{ margin:0; font-weight:800; font-style:italic; text-transform:uppercase; font-size:86px; line-height:.85 }}
.place sup {{ font-size:.42em; vertical-align:.95em; margin-left:1px }}
.ttl {{ margin:2px 0 0; font-weight:800; font-style:italic; text-transform:uppercase; letter-spacing:.24em; font-size:15px }}
.name {{ margin:4px 0 0; font-family:'Permanent Marker',cursive; font-size:36px; line-height:1.05 }}
.photo {{ margin:6px 0 0; font-size:13px; font-style:italic; font-weight:600 }}
.msg {{ margin:0; font-size:11.5px; line-height:1.45; font-weight:500 }}
.div {{ display:flex; align-items:center; gap:8px; margin:12px 0 7px }}
.div::before,.div::after {{ content:""; flex:1; height:1.4px; background:#000 }}
.div span {{ font-weight:800; font-size:9px; letter-spacing:.12em; text-transform:uppercase }}
.row {{ display:flex; justify-content:center; align-items:flex-end; gap:12px; flex-wrap:wrap }}
.lg {{ display:flex; flex-direction:column; align-items:center; justify-content:flex-end; gap:3px; height:64px }}
.lg em {{ font-style:normal; font-weight:700; font-size:7.5px; letter-spacing:.06em; text-transform:uppercase; white-space:nowrap }}
.lg.sm {{ height:40px }} .lg.sm em {{ font-size:6.5px }}
.bottom {{ align-self:stretch }}
</style></head><body><div class="p">
<img class="rcmi" src="../logos/rcmi.png" alt="RCMI">
<div class="blk"><p class="k c">RCMI presents</p>
<div class="t c">Photo<br>Contest<span class="flag">{"<i></i>"*12}</span></div>
<div class="by">by Resin Car Model Indonesia · {YEAR}</div></div>
<div class="blk"><div class="place c">{n}<sup>{ordn[1:].upper()}</sup> Place</div>
<div class="ttl c">{title}</div></div>
<div class="blk"><p class="pre">Presented to</p>
<p class="name">[Winner Name]</p>
<p class="photo">for the photo “[Photo title]”</p></div>
<p class="msg">RCMI Photo Contest {YEAR} · Your best shot of a 1:64 model car<br>{DATE} · rcmi-website.web.app</p>
<div class="bottom">
<div class="div"><span>Sponsored by</span></div>
<div class="row">{row(SPONSORS)}</div>
<div class="div"><span>Jury</span></div>
<div class="row">{row(JURY, .62)}</div>
</div>
</div></body></html>'''

def certificate(n):
    ordn, title = PLACES[n]
    medal = {1: ("#E2B33C", "#B8860B", "#FFF3C4"), 2: ("#C9CDD4", "#8E949C", "#F4F5F7"), 3: ("#CD8B52", "#9A5B2A", "#F6E1CC"), 4: ("#E2546A", "#A50E24", "#FFD9DF"), 5: ("#E2546A", "#A50E24", "#FFD9DF")}[n]
    sp = "".join(f'<span class="lg"><img src="../../../public/img/sponsors/{f}" alt="{a}"><em>{a}</em></span>' for f, a in [("toko-kuning.jpg","Toko Kuning"),("kepopic-studio.jpg","Kepopic Studio"),("hellios-studio.png","Hellios Studio"),("arsaka-toys.jpg","Arsaka Toys"),("bebetoys.jpg","bebetoys"),("kourin-labs.jpg","Kourin Labs")])
    jy = "".join(f'<span class="lg sm"><img src="../../../public/img/jury/{f}" alt="{a}"><em>{a}</em></span>' for f, a in [("jury-chevron.png","Diecast & Diorama"),("setsudou.png","setsudou"),("ricky.png","Ricky Robertus")])
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
.name {{ margin:3mm 0 0; font-family:'Great Vibes',cursive; font-size:70px; line-height:1.05; border-bottom:1.5px solid #12141C; padding-bottom:2mm; max-width:170mm }}
.why {{ margin:7mm 0 0; font-size:16px; line-height:1.5; max-width:175mm }}
.why b {{ font-weight:700 }}
.foot {{ margin-top:auto; display:flex; align-items:flex-end; justify-content:space-between; gap:10mm }}
.sig {{ width:55mm; text-align:center; font-size:12px }}
.sig i {{ display:block; height:14mm }}
.sig b {{ display:block; border-top:1.2px solid #12141C; padding-top:2mm; font-weight:700; font-size:13px }}
.meta {{ font-size:11px; color:#5B5F6B; line-height:1.5; text-align:right }}
.logos {{ margin-top:5mm; display:flex; flex-direction:column; align-items:center; gap:3mm; padding-top:3mm; border-top:.6px solid #C9CBD3 }}
.logos small {{ font-weight:800; letter-spacing:.16em; text-transform:uppercase; font-size:9px; color:#5B5F6B; writing-mode:horizontal-tb; white-space:nowrap }}
.lg {{ width:21mm; display:flex; flex-direction:column; align-items:center; justify-content:flex-end; gap:1mm }}
.lg img {{ max-height:10mm; max-width:20mm; width:auto; border-radius:3px; display:block }}
.lg em {{ font-style:normal; font-weight:700; font-size:8px; letter-spacing:.04em; text-transform:uppercase; white-space:nowrap; color:#3C3F48 }}
.lg.sm {{ width:17mm }} .lg.sm img {{ max-height:6.5mm; max-width:15mm }} .lg.sm em {{ font-size:7px }}
.grp {{ display:flex; align-items:flex-end; gap:2mm }}
.grp small {{ width:24mm; text-align:right }}
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
<div class="grp"><small>Sponsored by</small>{sp}</div>
<div class="grp"><small>Jury</small>{jy}</div>
</div>
</main>
</div></body></html>'''

SPONSOR_FILES = [("toko-kuning.jpg", "Toko Kuning", "round"), ("kepopic-studio.jpg", "Kepopic Studio", ""), ("hellios-studio.png", "Hellios Studio", ""),
                 ("arsaka-toys.jpg", "Arsaka Toys", "square"), ("bebetoys.jpg", "bebetoys", ""), ("kourin-labs.jpg", "Kourin Labs", "")]
def sponsor_certificate(f, name, shape):
    c = certificate(1)
    # Side panel: the sponsor's logo instead of a medal.
    c = c[:c.index('<div class="medal">')] + f'<div class="spl {shape}"><img src="../../../public/img/sponsors/{f}" alt="{name}"><small>Official sponsor</small></div>' + c[c.index('<div class="k">'):]
    c = c.replace("<title>RCMI Photo Contest certificate — 1st place</title>", f"<title>RCMI Photo Contest — sponsor certificate — {name}</title>")
    c = c.replace('<p class="eyebrow">Certificate of achievement</p>', '<p class="eyebrow">Certificate of appreciation</p>')
    c = c.replace('<p class="to">This certificate is proudly presented to</p>', '<p class="to">Presented with appreciation to</p>')
    c = c.replace('<p class="name">[Winner Name]</p>', f'<p class="name sp">{name}</p>')
    a0 = c.index('<p class="why">'); a1 = c.index('</p>', a0) + 4
    c = c[:a0] + f'<p class="why">For your valued support as an <b>official sponsor</b> of the <b>RCMI Photo Contest {YEAR}</b>, helping our community celebrate the art of 1:64 model car photography. Thank you for being part of our journey.</p>' + c[a1:]
    c = c.replace('<div class="meta">Registration no. [0000000]<br>', '<div class="meta">')
    c = c.replace("</style>", """.spl {{ align-self:center; display:flex; flex-direction:column; align-items:center; gap:5mm }}
.spl img {{ display:block; max-width:52mm; max-height:40mm; width:auto; height:auto; border-radius:6px; background:#fff; padding:4mm; box-shadow:0 0 0 2px #FFC72C }}
.spl.round img {{ width:46mm; height:46mm; max-height:none; border-radius:50%; padding:0 }}
.spl.square img {{ width:44mm; height:44mm; max-height:none; padding:0 }}
.spl small {{ font-weight:800; letter-spacing:.24em; text-transform:uppercase; font-size:12px; color:#FFC72C }}
.name.sp {{ font-family:'Barlow Condensed',sans-serif; font-style:italic; font-weight:800; text-transform:uppercase; font-size:64px; line-height:1 }}
</style>""".replace("{{", "{").replace("}}", "}"))
    return c
for i, (f, name, shape) in enumerate(SPONSOR_FILES, 1):
    open(os.path.join(OUT, f"sponsor-{i}.html"), "w").write(sponsor_certificate(f, name, shape))
for n in (1, 2, 3, 4, 5):
    open(os.path.join(OUT, f"plaque-{n}.html"), "w").write(plaque(n))
    open(os.path.join(OUT, f"certificate-{n}.html"), "w").write(certificate(n))
print("built", sorted(os.listdir(OUT)))
