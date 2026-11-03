// Welcome email for a new Exclusive Member, sent the moment an admin approves them (pending → approved).
// It explains what RCMI is and what members get, and carries their virtual member card as a PNG
// (same design as "My card" on the site), shown in the email and attached so they can save it.
import { readFileSync } from "node:fs";
const SITE = "https://rcmi-website.web.app";
const asset = (f) => new URL(`../assets/${f}`, import.meta.url);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const IDR = (n) => "Rp" + Number(n || 0).toLocaleString("id-ID");
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const initials = (n) => String(n || "?").trim().split(/\s+/).slice(0, 2).map(w => w[0] || "").join("").toUpperCase() || "?";
const igHandle = (s) => String(s || "").trim().replace(/^https?:\/\/(www\.)?instagram\.com\//i, "").replace(/^@/, "").replace(/[/?#].*$/, "");

/* ---------- Virtual member card (SVG → PNG), 720 × 1139, matching .mcard in public/css/style.css ---------- */
export function cardSVG({ name, no, city, instagram, since, photo }) {
  const W = 720, H = 1139, PAD = 65, CW = W - 2 * PAD;
  const NAME = String(name || "").toUpperCase();
  // Shrink long names so they stay on one line (Noto Serif Bold capitals ≈ 0.72 em wide).
  const nameSize = Math.max(30, Math.min(51, Math.floor(CW / (0.72 * Math.max(NAME.length, 1)))));
  const sub = [city, instagram ? "@" + igHandle(instagram) : "", since ? `Since ${MONTHS[since.getUTCMonth()]} ${since.getUTCFullYear()}` : ""].filter(Boolean).join("  ·  ");
  const logo = readFileSync(asset("logo-dark.png")).toString("base64");
  const ph = { x: (W - 271) / 2, y: 375, s: 271 };
  const photoEl = photo
    ? `<image href="data:${photo.type};base64,${photo.b64}" x="${ph.x + 10}" y="${ph.y + 10}" width="${ph.s - 20}" height="${ph.s - 20}" preserveAspectRatio="xMidYMid slice" clip-path="url(#pc)"/>`
    : `<rect x="${ph.x + 10}" y="${ph.y + 10}" width="${ph.s - 20}" height="${ph.s - 20}" rx="4" fill="url(#ini)"/>
       <text x="${W / 2}" y="${ph.y + ph.s / 2 + 38}" text-anchor="middle" font-family="Noto Serif" font-weight="700" font-size="108" fill="#3A3A3A">${esc(initials(name))}</text>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <clipPath id="card"><rect width="${W}" height="${H}" rx="32"/></clipPath>
    <clipPath id="pc"><rect x="${ph.x + 10}" y="${ph.y + 10}" width="${ph.s - 20}" height="${ph.s - 20}" rx="4"/></clipPath>
    <linearGradient id="base" x1="0.32" y1="0" x2="0.68" y2="1">
      <stop offset="0" stop-color="#EAF2F6"/><stop offset="0.4" stop-color="#F1ECF6"/><stop offset="0.7" stop-color="#F6F6F8"/><stop offset="1" stop-color="#E8EFF6"/></linearGradient>
    <radialGradient id="g1" gradientUnits="userSpaceOnUse" cx="0" cy="0" r="1" gradientTransform="translate(${0.15 * W} ${0.10 * H}) scale(${1.2 * W} ${0.6 * H})">
      <stop offset="0" stop-color="rgb(214,236,244)" stop-opacity=".95"/><stop offset="0.6" stop-color="rgb(214,236,244)" stop-opacity="0"/></radialGradient>
    <radialGradient id="g2" gradientUnits="userSpaceOnUse" cx="0" cy="0" r="1" gradientTransform="translate(${0.9 * W} ${0.3 * H}) scale(${0.9 * W} ${0.5 * H})">
      <stop offset="0" stop-color="rgb(236,228,246)" stop-opacity=".9"/><stop offset="0.65" stop-color="rgb(236,228,246)" stop-opacity="0"/></radialGradient>
    <radialGradient id="g3" gradientUnits="userSpaceOnUse" cx="0" cy="0" r="1" gradientTransform="translate(${0.3 * W} ${0.75 * H}) scale(${1.1 * W} ${0.6 * H})">
      <stop offset="0" stop-color="rgb(222,238,246)" stop-opacity=".85"/><stop offset="0.65" stop-color="rgb(222,238,246)" stop-opacity="0"/></radialGradient>
    <linearGradient id="sheen" x1="0" y1="0.18" x2="1" y2="0.82">
      <stop offset="0.3" stop-color="#fff" stop-opacity="0"/><stop offset="0.45" stop-color="#fff" stop-opacity=".55"/><stop offset="0.6" stop-color="#fff" stop-opacity="0"/></linearGradient>
    <linearGradient id="ini" x1="0.33" y1="0" x2="0.67" y2="1"><stop offset="0" stop-color="#F4F6F8"/><stop offset="1" stop-color="#E3E8EE"/></linearGradient>
    <filter id="sh" x="-30%" y="-30%" width="160%" height="170%"><feGaussianBlur stdDeviation="12"/></filter>
  </defs>
  <g clip-path="url(#card)">
    <rect width="${W}" height="${H}" fill="url(#base)"/>
    <rect width="${W}" height="${H}" fill="url(#g1)"/><rect width="${W}" height="${H}" fill="url(#g2)"/><rect width="${W}" height="${H}" fill="url(#g3)"/>
    <rect width="${W}" height="${H}" fill="url(#sheen)"/>
    <text x="${W / 2}" y="108" text-anchor="middle" font-family="Noto Serif" font-weight="700" font-size="43" fill="#3A3A3A">EXCLUSIVE MEMBER</text>
    <image href="data:image/png;base64,${logo}" x="${(W - 519) / 2}" y="146" width="519" height="197"/>
    <rect x="${ph.x + 14}" y="${ph.y + 28}" width="${ph.s - 28}" height="${ph.s - 20}" rx="12" fill="rgba(18,20,28,.35)" filter="url(#sh)"/>
    <rect x="${ph.x}" y="${ph.y}" width="${ph.s}" height="${ph.s}" rx="12" fill="#fff"/>
    ${photoEl}
    <text x="${W / 2}" y="${732 - (51 - nameSize) / 2}" text-anchor="middle" font-family="Noto Serif" font-weight="700" font-size="${nameSize}" fill="#3A3A3A">${esc(NAME)}</text>
    <text x="${W / 2}" y="796" text-anchor="middle" font-family="Noto Serif" font-weight="700" font-size="54" fill="#3A3A3A">#${esc(no)}</text>
    ${sub ? `<text x="${W / 2}" y="1078" text-anchor="middle" font-family="Noto Sans" font-size="25" fill="#6B6E78">${esc(sub)}</text>` : ""}
  </g>
  <rect x="1" y="1" width="${W - 2}" height="${H - 2}" rx="31" fill="none" stroke="rgba(255,255,255,.7)" stroke-width="2"/>
</svg>`;
}

export async function cardPNG(info) {
  const { Resvg } = await import("@resvg/resvg-js");
  const fontFiles = ["NotoSerif-Bold.ttf", "NotoSans-Regular.ttf"].map(f => asset(f).pathname);
  return new Resvg(cardSVG(info), { font: { fontFiles, loadSystemFonts: false, defaultFontFamily: "Noto Sans" }, fitTo: { mode: "width", value: 720 } }).render().asPng();
}

// Google profile photo (sharper square version), embedded in the card. No photo / fails → initials.
async function fetchPhoto(url) {
  if (!url) return null;
  try {
    const r = await fetch(String(url).replace(/=s\d+(-c)?$/, "=s400-c"), { signal: AbortSignal.timeout(8000) });
    const type = r.headers.get("content-type") || "";
    if (!r.ok || !/^image\/(jpeg|png|webp|gif)/.test(type)) return null;
    return { type: type.split(";")[0], b64: Buffer.from(await r.arrayBuffer()).toString("base64") };
  } catch { return null; }
}

/* ---------- The email ---------- */
export function welcomeHTML({ name, no, pay }) {
  const first = esc(String(name || "").trim().split(/\s+/)[0] || "");
  const nr = `RCMI-${String(no).padStart(4, "0")}`;
  const amount = IDR(pay?.amount || 50000), day = pay?.dueDay || 10;
  const acct = pay?.bank && pay?.accountNo ? `<b>${esc(pay.bank)} ${esc(pay.accountNo)}</b> a.n. <b>${esc(pay.accountName || "")}</b>` : "";
  const h = (t) => `<h3 style="margin:22px 0 8px;font-size:16px;color:#D6102B;text-transform:uppercase;letter-spacing:.04em">${t}</h3>`;
  const li = (items) => `<ul style="margin:0;padding-left:20px;line-height:1.55">${items.map(i => `<li style="margin:0 0 4px">${i}</li>`).join("")}</ul>`;
  const btn = (href, t) => `<a href="${href}" style="display:inline-block;background:#D6102B;color:#fff;font-weight:bold;text-decoration:none;padding:11px 20px;border-radius:6px">${t}</a>`;
  const sep = `<hr style="border:none;border-top:1px solid #E3E4E8;margin:28px 0">`;
  return `<div style="font-family:Arial,Helvetica,sans-serif;max-width:600px;margin:0 auto;color:#12141C;font-size:15px">
  <div style="background:#12141C;padding:18px 24px;border-radius:8px 8px 0 0"><img src="${SITE}/img/logo-white.png" alt="RCMI" width="150" style="display:block"></div>
  <div style="border:1px solid #E3E4E8;border-top:none;border-radius:0 0 8px 8px;padding:24px">
  <h2 style="margin:0 0 6px;font-size:24px">Welcome to RCMI, ${first}! 🎉</h2>
  <p style="margin:0 0 4px;color:#5B5F6B">Selamat datang di RCMI, ${first}!</p>
  <p style="line-height:1.55">Your membership has been approved. You're now an <b>RCMI Exclusive Member</b> — your member number is <b>${nr}</b>. Here's your virtual member card (it's also attached, so you can save it to your phone):</p>
  <p style="text-align:center;margin:18px 0"><img src="cid:rcmi-card" alt="RCMI member card ${nr}" width="300" style="width:300px;max-width:80%;height:auto"></p>

  ${h("What is RCMI?")}
  <p style="line-height:1.55;margin:0">RCMI (Resin Car Model Indonesia) is Indonesia's community of <b>1:64 resin car model</b> collectors and makers. Resin models are made in small runs, often from hand-made moulds — sharp detail, limited numbers, and every caster has their own style. Together we share our collections, meet up, and trade.</p>

  ${h("Your member benefits")}
  ${li([
    "<b>RCMI member card (Flazz BCA)</b> — your physical card, plus this virtual card any time under <i>Members area › My card</i>",
    "<b>Your logo on the RCMI banner</b> at events",
    "<b>Members-only areas on the site</b> — the collection, the member list, events and the market",
    "<b>Show your collection</b> — upload photos of your cars and see who cast which model",
    "<b>Market</b> — sell, swap or hunt for models, chat with sellers, and build your seller rating",
    "<b>Meetups &amp; events</b> — first to hear about RCMI gatherings",
    "<b>Photo contests</b> with prizes from our sponsors"
  ])}

  ${h("Get started")}
  ${li([
    `Sign in at <a href="${SITE}" style="color:#D6102B">rcmi-website.web.app</a> with the same Google account.`,
    "Check your profile (city, Instagram) and add your first car to <i>My Collection</i>.",
    "Follow us on Instagram: <a href=\"https://instagram.com/resincarmodelindonesia\" style=\"color:#D6102B\">@resincarmodelindonesia</a>."
  ])}

  ${h("Monthly dues")}
  <p style="line-height:1.55;margin:0">Your first month is covered by your joining fee. After that, dues are <b>${amount} per month</b>, paid by the <b>${day}th</b> of each month${acct ? ` by transfer to ${acct}` : ""}. After transferring, upload the receipt under <i>Members area › Dues</i> so an admin can confirm it.</p>

  <p style="margin:24px 0 0">${btn(`${SITE}/#/card`, "Open my member card →")}</p>

  ${sep}
  <h2 style="margin:0 0 6px;font-size:20px">🇮🇩 Selamat datang, ${first}!</h2>
  <p style="line-height:1.55">Keanggotaanmu sudah disetujui. Sekarang kamu resmi <b>RCMI Exclusive Member</b> dengan nomor anggota <b>${nr}</b>. Kartu anggota virtualmu ada di atas (juga terlampir, jadi bisa disimpan di HP).</p>
  ${h("Apa itu RCMI?")}
  <p style="line-height:1.55;margin:0">RCMI (Resin Car Model Indonesia) adalah komunitas kolektor dan pembuat <b>model mobil resin skala 1:64</b> di Indonesia. Model resin dibuat dalam jumlah terbatas, sering dari cetakan buatan tangan — detail tajam, jumlah terbatas, dan setiap caster punya gaya sendiri. Bersama kita berbagi koleksi, kopdar, dan jual-beli.</p>
  ${h("Keuntungan anggota")}
  ${li([
    "<b>Kartu anggota RCMI (Flazz BCA)</b> — kartu fisik, plus kartu virtual ini kapan saja di <i>Area anggota › Kartu saya</i>",
    "<b>Logo kamu di banner RCMI</b> saat acara",
    "<b>Area khusus anggota di situs</b> — koleksi, daftar anggota, acara, dan pasar",
    "<b>Pamerkan koleksimu</b> — unggah foto mobilmu dan lihat siapa caster setiap model",
    "<b>Pasar</b> — jual, tukar, atau cari model, chat dengan penjual, dan bangun rating penjualmu",
    "<b>Kopdar &amp; acara</b> — kabar pertama tentang kumpul-kumpul RCMI",
    "<b>Lomba foto</b> dengan hadiah dari sponsor kami"
  ])}
  ${h("Mulai dari sini")}
  ${li([
    `Masuk di <a href="${SITE}" style="color:#D6102B">rcmi-website.web.app</a> dengan akun Google yang sama.`,
    "Cek profilmu (kota, Instagram) dan tambahkan mobil pertamamu di <i>Koleksiku</i>.",
    "Follow Instagram kami: <a href=\"https://instagram.com/resincarmodelindonesia\" style=\"color:#D6102B\">@resincarmodelindonesia</a>."
  ])}
  ${h("Iuran bulanan")}
  <p style="line-height:1.55;margin:0">Bulan pertama sudah termasuk dalam biaya pendaftaran. Setelah itu iurannya <b>${amount} per bulan</b>, dibayar paling lambat tanggal <b>${day}</b> setiap bulan${acct ? ` dengan transfer ke ${acct}` : ""}. Setelah transfer, unggah bukti transfer di <i>Area anggota › Iuran</i> supaya admin bisa konfirmasi.</p>
  <p style="margin:24px 0 0">${btn(`${SITE}/#/card`, "Buka kartu anggotaku →")}</p>
  ${sep}
  <p style="margin:0;color:#888;font-size:12px">Questions? Reply to the RCMI admins on Instagram @resincarmodelindonesia or use Contact on the site. · Ada pertanyaan? Hubungi admin RCMI di Instagram @resincarmodelindonesia atau lewat menu Kontak di situs.</p>
  </div></div>`;
}

// Sends once per member: welcomedAt is claimed in a transaction first, so a retried trigger never sends twice.
export async function sendWelcome(db, mail, cfg, uid) {
  if (!mail) return "no mail settings";
  const ref = db.doc(`users/${uid}`);
  const p = await db.runTransaction(async (tx) => {
    const s = await tx.get(ref), d = s.data();
    if (!d || d.status !== "approved" || d.accountType === "general" || d.welcomedAt || !d.email || !d.memberNo) return null;
    tx.update(ref, { welcomedAt: new Date() });
    return d;
  });
  if (!p) return "skipped";
  const pay = (await db.doc("settings/payment").get()).data() || {};
  const since = p.approvedAt?.toDate?.() || new Date();
  try {
    const png = await cardPNG({ name: p.displayName, no: p.memberNo, city: p.city, instagram: p.instagram, since, photo: await fetchPhoto(p.photoURL) });
    const file = `RCMI-Member-Card-${String(p.memberNo).padStart(4, "0")}.png`;
    await mail.sendMail({
      from: `"RCMI" <${cfg.GMAIL_USER}>`, to: p.email,
      subject: "Welcome to RCMI! · Selamat datang di RCMI!",
      html: welcomeHTML({ name: p.displayName, no: p.memberNo, pay }),
      // Once inline (shown in the email) and once as a normal attachment (easy to save).
      attachments: [{ filename: file, content: png, contentType: "image/png", cid: "rcmi-card" }, { filename: file, content: png, contentType: "image/png" }]
    });
    return "sent";
  } catch (e) {
    await ref.update({ welcomedAt: null, welcomeError: String(e.code || e.message).slice(0, 200) });
    return "failed";
  }
}
