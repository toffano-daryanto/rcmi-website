// Read the "RCMI Membership Registration (Responses)" Google Sheet tabs into member records.
// Only what the site needs is taken: number, name, province, join date, phone (admins only) and T-shirt.
// Home addresses and birthdates are deliberately never read.

const PROVINCES = {
  "special capital region of jakarta": "DKI Jakarta", "jakarta": "DKI Jakarta",
  "west java": "Jawa Barat", "central java": "Jawa Tengah", "east java": "Jawa Timur", "banten": "Banten",
  "special region of yogyakarta": "DI Yogyakarta", "yogyakarta": "DI Yogyakarta",
  "bali": "Bali", "riau": "Riau", "riau islands": "Kepulauan Riau", "jambi": "Jambi", "bengkulu": "Bengkulu", "lampung": "Lampung",
  "aceh": "Aceh", "north sumatra": "Sumatera Utara", "west sumatra": "Sumatera Barat", "south sumatra": "Sumatera Selatan",
  "bangka belitung islands": "Kepulauan Bangka Belitung",
  "west kalimantan": "Kalimantan Barat", "central kalimantan": "Kalimantan Tengah", "south kalimantan": "Kalimantan Selatan",
  "east kalimantan": "Kalimantan Timur", "north kalimantan": "Kalimantan Utara",
  "north sulawesi": "Sulawesi Utara", "central sulawesi": "Sulawesi Tengah", "south sulawesi": "Sulawesi Selatan",
  "southeast sulawesi": "Sulawesi Tenggara", "west sulawesi": "Sulawesi Barat", "gorontalo": "Gorontalo",
  "west nusa tenggara": "Nusa Tenggara Barat", "east nusa tenggara": "Nusa Tenggara Timur",
  "maluku": "Maluku", "north maluku": "Maluku Utara", "papua": "Papua", "west papua": "Papua Barat"
};
export const province = (s) => PROVINCES[String(s || "").trim().toLowerCase()] || String(s || "").trim();

export const phoneKey = (s) => { let d = String(s || "").replace(/\D/g, ""); if (d.startsWith("0")) d = "62" + d.slice(1); else if (d.startsWith("8")) d = "62" + d; return d; };
const normName = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
// "DIZA MEVIA ROSALVINO" → "Diza Mevia Rosalvino"; mixed-case names are kept as typed.
export function niceName(s) {
  const n = String(s || "").trim().replace(/\s+/g, " ");
  if (n !== n.toUpperCase() && n !== n.toLowerCase()) return n.replace(/(^|\s)([a-z])/g, (m, a, b) => a + b.toUpperCase());
  return n.toLowerCase().replace(/(^|[\s/(.-])([a-z])/g, (m, a, b) => a + b.toUpperCase());
}
// "18/06/2025 11:19:43" → "2025-06-18"
const dmy = (s) => { const m = String(s || "").match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/); return m ? `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}` : ""; };
const slug = (s) => normName(s).replace(/ /g, "-").slice(0, 40) || "pendaftar";

/** Turn a sheet (array of rows) into objects keyed by lower-case header, using the first row that contains `mustHave`. */
function table(rows, mustHave) {
  const hi = rows.findIndex(r => r.some(c => String(c).toLowerCase().includes(mustHave)));
  if (hi < 0) return [];
  const head = rows[hi].map(h => String(h).trim().toLowerCase());
  return rows.slice(hi + 1).map(r => Object.fromEntries(head.map((h, i) => [h, String(r[i] ?? "").trim()])));
}
const pick = (obj, ...starts) => { for (const s of starts) { const k = Object.keys(obj).find(k => k.startsWith(s)); if (k && obj[k]) return obj[k]; } return ""; };

/**
 * sheets: [{ title, rows: string[][] }] for the whole spreadsheet.
 * Returns { members: [{no, name, phone, province, joined, shirt}], applicants: [{key, name, phone, province, applied}] }.
 */
export function parseMemberSheets(sheets) {
  const find = (word) => sheets.find(s => s.title.toLowerCase().includes(word));
  const listSheet = find("member list"), respSheet = find("response"), shirtSheet = find("kaos");
  if (!listSheet && !respSheet) throw new Error("Tab 'RCMI Member List' / 'Form responses' tidak ditemukan di sheet ini.");

  const responses = respSheet ? table(respSheet.rows, "nama").map(r => ({
    name: niceName(pick(r, "nama")), phone: pick(r, "no telp", "no hp", "telp", "phone"),
    province: province(pick(r, "provinsi", "province")), applied: dmy(pick(r, "timestamp", "cap waktu"))
  })).filter(r => r.name) : [];
  const byPhone = new Map(responses.filter(r => phoneKey(r.phone)).map(r => [phoneKey(r.phone), r]));
  const byName = new Map(responses.map(r => [normName(r.name), r]));

  const shirts = new Map();
  if (shirtSheet) for (const r of table(shirtSheet.rows, "size")) {
    const no = Number(String(pick(r, "id", "no")).replace(/\D/g, ""));
    if (no) shirts.set(no, { size: pick(r, "size"), qty: Number(pick(r, "quantity", "qty")) || 1, paid: /done|lunas|paid|sudah/i.test(pick(r, "payment", "status")) });
  }

  const members = [];
  if (listSheet) for (const r of table(listSheet.rows, "name")) {
    const no = Number(String(pick(r, "no member", "no")).replace(/\D/g, ""));
    const name = niceName(pick(r, "name", "nama"));
    if (!no || !name) continue;
    const phone = pick(r, "no telp", "no hp", "telp", "phone");
    const resp = byPhone.get(phoneKey(phone)) || byName.get(normName(name));
    members.push({ no, name, phone: phone || resp?.phone || "", province: resp?.province || "", joined: resp?.applied || "", shirt: shirts.get(no) || null });
  }

  // Form responses that aren't on the member list yet = new applicants (get a number when an admin approves them).
  const memberPhones = new Set(members.map(m => phoneKey(m.phone)).filter(Boolean));
  const memberNames = new Set(members.map(m => normName(m.name)));
  const applicants = responses
    .filter(r => !(phoneKey(r.phone) && memberPhones.has(phoneKey(r.phone))) && !memberNames.has(normName(r.name)))
    .map(r => ({ key: slug(r.name), name: r.name, phone: r.phone, province: r.province, applied: r.applied }));

  return { members, applicants };
}
