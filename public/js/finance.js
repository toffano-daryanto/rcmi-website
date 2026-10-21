// RCMI finance: parse the KEUANGAN RCMI sheet (CSV export) and build a Profit & Loss (Laba Rugi).
// No financial data lives in this file — the ledger is stored in Firestore (finance/ledger, admins only).

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, mei: 5, may: 5, jun: 6, jul: 7, agu: 8, agt: 8, aug: 8, sep: 9, okt: 10, oct: 10, nov: 11, des: 12, dec: 12 };

export const rupiah = (s) => {
  const n = String(s ?? "").replace(/rp/i, "").replace(/\s/g, "").replace(/,\d{1,2}$/, "").replace(/[.,]/g, "");
  return n ? Number(n) || 0 : 0;
};

function parseDate(s) {
  const m = String(s || "").trim().match(/^(\d{1,2})\s+([A-Za-z]{3})[a-z]*\s+(\d{4})$/);
  if (m && MONTHS[m[2].toLowerCase()]) return `${m[3]}-${String(MONTHS[m[2].toLowerCase()]).padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  const d = new Date(s); return isNaN(d) ? "" : d.toISOString().slice(0, 10);
}

// Minimal CSV parser (quoted fields, commas inside quotes, CRLF).
function csvRows(text) {
  const out = []; let row = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; }
    else if (c === '"') q = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; row.push(cell); out.push(row); row = []; cell = ""; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); out.push(row); }
  return out;
}

/** CSV text (No,Tanggal,Deskripsi,Keterangan,Pemasukan,Pengeluaran,SALDO) → ledger rows. */
export function parseLedgerCSV(text) {
  return parseLedgerTable(csvRows(text.replace(/^﻿/, "")));
}

/** Rows straight from Google Sheets (array of arrays; header row may sit below a title) → ledger rows. */
export function parseLedgerTable(input) {
  const rows = input.map(r => r.map(c => String(c ?? "")));
  const hi = rows.findIndex(r => r.some(c => c.trim().toLowerCase().startsWith("tanggal")));
  if (hi < 0) throw new Error("Kolom Tanggal / Pemasukan / Pengeluaran tidak ditemukan.");
  rows.splice(0, hi);
  const head = rows.shift().map(h => h.trim().toLowerCase());
  const col = (name) => head.findIndex(h => h.startsWith(name));
  const ci = { no: col("no"), date: col("tanggal"), desc: col("deskripsi"), note: col("keterangan"), inc: col("pemasukan"), exp: col("pengeluaran"), bal: col("saldo") };
  if (ci.date < 0 || ci.inc < 0 || ci.exp < 0) throw new Error("Kolom Tanggal / Pemasukan / Pengeluaran tidak ditemukan.");
  return rows
    .filter(r => (r[ci.date] || "").trim())
    .map(r => ({
      no: Number(r[ci.no]) || null,
      date: parseDate(r[ci.date]),
      desc: (r[ci.desc] || "").trim(),
      note: (r[ci.note] || "").trim(),
      income: rupiah(r[ci.inc]),
      expense: rupiah(r[ci.exp]),
      saldo: ci.bal >= 0 && (r[ci.bal] || "").trim() ? rupiah(r[ci.bal]) : null
    }))
    .filter(r => r.date && (r.income || r.expense));
}

// ---- Categories -------------------------------------------------------------------------------
// Income lines
export const INCOME = {
  dues: "Pendaftaran & iuran kas anggota",
  ids: "Iuran anggota untuk IDS 2025",
  sponsor: "Sponsor IDS 2025",
  support: "Dukungan / donasi",
  rims: "Penjualan velg RCMI x Hellios",
  reward: "Hadiah diterima",
  other: "Pemasukan lain-lain"
};
// Expense groups → lines
export const EXPENSE = {
  "Event IDS 2025 — 64 Fitment Contest": {
    prizes: "Hadiah pemenang & doorprize",
    fees: "Fee juri, dokumentasi & tim",
    production: "Produksi, cetak & box",
    tmcp: "Transfer kebutuhan TMCP",
    venue: "Sewa meja & lemari",
    logistics: "Transport & loading",
    food: "Konsumsi juri & tim",
    eventOther: "Lain-lain event"
  },
  "Velg RCMI x Hellios": { rimsCost: "Pembelian velg (HPP)" },
  "Keanggotaan": { kta: "Kartu anggota (KTA) & ongkir" },
  "Branding & perlengkapan": { branding: "Banner, plakat, stiker, kain", inventory: "Inventaris (Qline)" },
  "Kegiatan komunitas": { kopdar: "Kopdar", social: "Sosial (uang duka)" },
  "Operasional": { bank: "Biaya admin bank", opsOther: "Lain-lain" }
};
const LINE_GROUP = Object.fromEntries(Object.entries(EXPENSE).flatMap(([g, lines]) => Object.keys(lines).map(k => [k, g])));
export const IDS_INCOME = ["ids", "sponsor"];

const has = (s, ...words) => words.some(w => s.includes(w));

/** One ledger row → one or more { kind, key, amount } parts. */
export function categorize(r) {
  const s = `${r.desc} ${r.note}`.toUpperCase();
  if (r.income) {
    const amt = r.income;
    // Combined payments, e.g. "IURAN/VELG/KAS" or "VELG … & KAS": velg Rp175.000 per set, kas Rp50.000, rest = IDS contribution.
    const tags = { rims: has(s, "VELG", "VELH"), dues: has(s, "KAS", "PENDAFTARAN"), ids: has(s, "IURAN IDS") || (has(s, "IURAN") && has(s, "VELG")) };
    if (tags.rims && (tags.dues || tags.ids)) {
      const parts = []; let left = amt;
      const rims = Math.min(left, 175000); parts.push({ kind: "income", key: "rims", amount: rims }); left -= rims;
      if (tags.dues && left > 0) { const k = Math.min(left, 50000); parts.push({ kind: "income", key: "dues", amount: k }); left -= k; }
      if (left > 0) parts.push({ kind: "income", key: tags.ids ? "ids" : "dues", amount: left });
      return parts;
    }
    let key = "other";
    if (has(s, "SPONSOR")) key = "sponsor";
    else if (has(s, "SUPPORT", "DONASI")) key = "support";
    else if (has(s, "IURAN IDS")) key = "ids";
    else if (tags.rims) key = "rims";
    else if (tags.dues) key = "dues";
    else if (has(s, "REWARD", "HADIAH")) key = "reward";
    return [{ kind: "income", key, amount: amt }];
  }
  let key = "opsOther";
  if (has(s, "ADMIN BANK")) key = "bank";
  else if (has(s, "KTA")) key = "kta";
  else if (has(s, "INVENTARIS", "QLINE")) key = "inventory";
  else if (has(s, "REWARD PEMENANG", "KAOS", "AKSESORIS GIFT", "HADIAH")) key = "prizes";
  else if (has(s, "FEE JURI", "FEE DOKUMENTASI", "FEE SUPPORT")) key = "fees";
  else if (has(s, "TRANSFER") && has(s, "TMCP")) key = "tmcp";
  else if (has(s, "VELG", "HELLIOS")) key = "rimsCost";
  else if (has(s, "SEWA")) key = "venue";
  else if (has(s, "LOADING", "BENSIN")) key = "logistics";
  else if (has(s, "KONSUMSI")) key = "food";
  else if (has(s, "FITMENT", "CETAK", "BOX MASTER", "BASE KARTON")) key = "production";
  else if (has(s, "FUELME", "TIKET", "IDS")) key = "eventOther";
  else if (has(s, "BANNER", "PLAKAT", "STIKER", "KAIN")) key = "branding";
  else if (has(s, "KOPDAR")) key = "kopdar";
  else if (has(s, "DUKA")) key = "social";
  return [{ kind: "expense", key, amount: r.expense }];
}

/** Build the P&L for rows within [from, to] (YYYY-MM-DD, inclusive). */
export function buildPL(rows, from = "", to = "9999-12-31") {
  const inRange = rows.filter(r => r.date >= from && r.date <= to);
  const income = Object.fromEntries(Object.keys(INCOME).map(k => [k, 0]));
  const expense = Object.fromEntries(Object.keys(LINE_GROUP).map(k => [k, 0]));
  const detail = [];
  for (const r of inRange) for (const p of categorize(r)) {
    (p.kind === "income" ? income : expense)[p.key] += p.amount;
    detail.push({ ...r, ...p, group: p.kind === "income" ? "Pemasukan" : LINE_GROUP[p.key], line: p.kind === "income" ? INCOME[p.key] : EXPENSE[LINE_GROUP[p.key]][p.key] });
  }
  const totalIncome = Object.values(income).reduce((a, b) => a + b, 0);
  const groups = Object.entries(EXPENSE).map(([g, lines]) => ({
    name: g, lines: Object.entries(lines).map(([k, label]) => ({ key: k, label, amount: expense[k] })).filter(l => l.amount),
  })).map(g => ({ ...g, total: g.lines.reduce((a, l) => a + l.amount, 0) })).filter(g => g.total);
  const totalExpense = groups.reduce((a, g) => a + g.total, 0);

  // Opening balance = everything before the period; closing = opening + net.
  const opening = rows.filter(r => r.date < from).reduce((a, r) => a + r.income - r.expense, 0);
  const net = totalIncome - totalExpense;

  // IDS 2025 event result: sponsor + member contributions vs event costs.
  const eventGroup = groups.find(g => g.name.startsWith("Event IDS"));
  const ids = { income: IDS_INCOME.reduce((a, k) => a + income[k], 0), expense: eventGroup?.total || 0 };
  ids.net = ids.income - ids.expense;
  // Rims project: sales vs purchase cost.
  const rims = { sales: income.rims, cost: expense.rimsCost, sets: Math.round(income.rims / 175000) };
  rims.net = rims.sales - rims.cost;

  // Month by month with running cash balance.
  const months = {};
  let bal = opening;
  for (const r of [...inRange].sort((a, b) => a.date.localeCompare(b.date) || (a.no || 0) - (b.no || 0))) {
    const m = r.date.slice(0, 7);
    months[m] ??= { month: m, income: 0, expense: 0 };
    months[m].income += r.income; months[m].expense += r.expense;
  }
  const monthly = Object.values(months).sort((a, b) => a.month.localeCompare(b.month)).map(m => ({ ...m, net: m.income - m.expense, balance: (bal += m.income - m.expense) }));

  return {
    income: Object.entries(INCOME).map(([k, label]) => ({ key: k, label, amount: income[k] })).filter(l => l.amount),
    totalIncome, groups, totalExpense, net, opening, closing: opening + net, ids, rims, monthly, detail, count: inRange.length
  };
}

/** Rows where the sheet's own SALDO column disagrees with the running total (in sheet order). */
export function balanceIssues(rows) {
  const out = []; let bal = 0;
  for (const r of [...rows].sort((a, b) => (a.no || 0) - (b.no || 0))) {
    bal += r.income - r.expense;
    if (r.saldo != null && r.saldo !== bal) out.push({ ...r, calc: bal, diff: r.saldo - bal });
  }
  return out;
}
