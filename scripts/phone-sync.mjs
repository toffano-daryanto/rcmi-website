// When a member changes their phone / WhatsApp number on the website, write it back to the
// "RCMI Member List" tab of the membership Google Sheet (matched by member number).
// Run every 10 minutes by .github/workflows/notify.yml.
//
//   SA_JSON_PATH  path to the Firebase service-account JSON
//
// One-time setup: share the membership sheet with the service account's email as Editor.
// The sheet ID is read from Firestore (sources/members, saved by the admin's "Sync members"),
// never from this public repo. Logs show counts only.

import { readFileSync } from "node:fs";
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { JWT } from "google-auth-library";

const sa = JSON.parse(readFileSync(process.env.SA_JSON_PATH, "utf8"));
initializeApp({ credential: cert(sa) });
const db = getFirestore();

const phoneKey = (s) => { let d = String(s || "").replace(/\D/g, ""); if (d.startsWith("0")) d = "62" + d.slice(1); else if (d.startsWith("8")) d = "62" + d; return d; };
const colLetter = (i) => { let s = ""; i++; while (i) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; };

const stateRef = db.doc("notify/phoneSync");
const now = Timestamp.now();
const st = await stateRef.get();
if (!st.exists) { await stateRef.set({ lastCheck: now }); console.log("Phone sync: first run, starting from now."); process.exit(0); }
const since = st.data().lastCheck;

// Members who edited their profile since the last run.
const edited = (await db.collection("users").where("updatedAt", ">", since).where("updatedAt", "<=", now).get())
  .docs.map(d => ({ id: d.id, ...d.data() }))
  .filter(u => u.status === "approved" && u.accountType !== "general" && u.rosterId && u.memberNo && phoneKey(u.whatsapp));

const changes = [];
for (const u of edited) {
  const priv = await db.doc(`rosterPrivate/${u.rosterId}`).get();
  const old = priv.exists ? priv.data().phone || "" : "";
  if (phoneKey(old) !== phoneKey(u.whatsapp)) changes.push({ u, old });
}
console.log(`Phone sync: ${edited.length} profile edits, ${changes.length} phone changes.`);
if (!changes.length) { await stateRef.set({ lastCheck: now }); process.exit(0); }

const src = (await db.doc("sources/members").get()).data();
if (!src?.sheetId) { console.log("::warning::No member sheet saved yet (Admin → Members → Sync members once)."); process.exit(0); }

const jwt = new JWT({ email: sa.client_email, key: sa.private_key, scopes: ["https://www.googleapis.com/auth/spreadsheets"] });
const api = async (path, opts = {}) => {
  const { token } = await jwt.getAccessToken();
  const r = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${src.sheetId}${path}`, { ...opts, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } });
  if (r.status === 403 || r.status === 404) {
    console.log(`::error::The service account can't edit the member sheet. Share the sheet with ${sa.client_email} as Editor.`);
    process.exit(1);
  }
  if (!r.ok) throw new Error(`Sheets API ${r.status}`);
  return r.json();
};

const meta = await api("?fields=sheets.properties.title");
const tab = meta.sheets.map(s => s.properties.title).find(t => t.toLowerCase().includes("member list"));
if (!tab) { console.log("::error::Tab 'RCMI Member List' not found in the sheet."); process.exit(1); }
const q = (r) => encodeURIComponent(`'${tab.replace(/'/g, "''")}'!${r}`);
const rows = (await api(`/values/${q("A1:Z3000")}`)).values || [];

const hi = rows.findIndex(r => r.some(c => String(c).toLowerCase().includes("name")));
if (hi < 0) { console.log("::error::Header row not found."); process.exit(1); }
const head = rows[hi].map(h => String(h).trim().toLowerCase());
const noCol = head.findIndex(h => h.startsWith("no") && h.includes("member")) >= 0
  ? head.findIndex(h => h.startsWith("no") && h.includes("member"))
  : head.findIndex(h => h === "no" || h === "no." || h === "no member");
const phoneCol = head.findIndex(h => ["no telp", "no hp", "telp", "phone", "no. telp", "no. hp", "whatsapp"].some(k => h.startsWith(k)));
if (noCol < 0 || phoneCol < 0) { console.log("::error::Member number or phone column not found."); process.exit(1); }

const data = [];
for (const { u } of changes) {
  const i = rows.findIndex((r, k) => k > hi && Number(String(r[noCol] ?? "").replace(/\D/g, "")) === Number(u.memberNo));
  if (i < 0) continue;
  data.push({ range: `'${tab.replace(/'/g, "''")}'!${colLetter(phoneCol)}${i + 1}`, values: [[u.whatsapp.trim()]] });
}
if (data.length) await api("/values:batchUpdate", { method: "POST", body: JSON.stringify({ valueInputOption: "RAW", data }) });

// Keep the site's admin copy and phone matching in step with the sheet.
const batch = db.batch();
for (const { u, old } of changes) {
  batch.set(db.doc(`rosterPrivate/${u.rosterId}`), { phone: u.whatsapp.trim() }, { merge: true });
  const ok = phoneKey(old), nk = phoneKey(u.whatsapp);
  if (ok) { const inv = await db.doc(`phoneInvites/${ok}`).get(); if (inv.exists && inv.data().rosterId === u.rosterId) batch.delete(inv.ref); }
  batch.set(db.doc(`phoneInvites/${nk}`), { rosterId: u.rosterId, memberNo: u.memberNo, name: u.displayName || "", city: u.city || "" });
}
await batch.commit();
await stateRef.set({ lastCheck: now });
console.log(`Phone sync: updated ${data.length} row(s) in the sheet.`);
