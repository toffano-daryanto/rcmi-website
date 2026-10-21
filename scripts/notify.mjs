// Email the RCMI admin about new sign-ups, joining-fee proofs and contact messages.
// Run every few minutes by .github/workflows/notify.yml (free on GitHub Actions; no paid Firebase plan needed).
//
//   SA_JSON_PATH        path to the Firebase service-account JSON
//   GMAIL_USER          Gmail address that sends the email
//   GMAIL_APP_PASSWORD  16-character Google app password for that address
//   NOTIFY_TO           where to send (optional, defaults to GMAIL_USER; comma-separated for several)
//
// The repo is public, so this script never prints names, emails or phone numbers — only counts.

import { readFileSync } from "node:fs";
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import nodemailer from "nodemailer";

const { SA_JSON_PATH, GMAIL_USER, GMAIL_APP_PASSWORD } = process.env;
const NOTIFY_TO = process.env.NOTIFY_TO || GMAIL_USER;
const SITE = "https://rcmi-website.web.app";

if (!SA_JSON_PATH || !GMAIL_USER || !GMAIL_APP_PASSWORD) {
  console.log("::notice::Email notifications are off: add the GMAIL_USER and GMAIL_APP_PASSWORD secrets.");
  process.exit(0);
}

initializeApp({ credential: cert(JSON.parse(readFileSync(SA_JSON_PATH, "utf8"))) });
const db = getFirestore();
const stateRef = db.doc("notify/state");

const now = Timestamp.now();
const st = await stateRef.get();
if (!st.exists) {
  // First run: start from now, so the admin isn't emailed about everyone who signed up before.
  await stateRef.set({ lastCheck: now });
  console.log("First run: notifications start from now.");
  process.exit(0);
}
const since = st.data().lastCheck;

const newer = async (col) =>
  (await db.collection(col).where("createdAt", ">", since).where("createdAt", "<=", now).get()).docs.map(d => ({ id: d.id, ...d.data() }));

const [users, proofs, messages] = await Promise.all([newer("users"), newer("joinPayments"), newer("messages")]);
console.log(`New: ${users.length} sign-ups, ${proofs.length} payment proofs, ${messages.length} messages.`);
if (!users.length && !proofs.length && !messages.length) { await stateRef.set({ lastCheck: now }); process.exit(0); }

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const no = (n) => `RCMI-${String(n).padStart(4, "0")}`;
const kind = (u) =>
  u.accountType === "general" ? "General user — active" :
  u.status === "approved" ? `Member — activated by phone as ${no(u.memberNo)}` :
  "New member — waiting for payment &amp; your approval";
const nameOf = async (uid) => { const s = await db.doc(`users/${uid}`).get(); return s.exists ? s.data().displayName : uid; };

const section = (title, rows) => rows.length ? `<h3 style="margin:20px 0 8px">${title}</h3>${rows.join("")}` : "";
const card = (inner) => `<div style="border:1px solid #ddd;border-left:4px solid #D6102B;border-radius:6px;padding:10px 14px;margin:0 0 8px">${inner}</div>`;

const userRows = users.map(u => card(`<strong>${esc(u.displayName)}</strong><br>
  <span style="color:#D6102B">${kind(u)}</span><br>
  <span style="color:#555">${[u.city, u.instagram && "@" + u.instagram, u.whatsapp, u.email].filter(Boolean).map(esc).join(" · ")}</span>`));
const proofRows = await Promise.all(proofs.map(async p => card(`<strong>${esc(await nameOf(p.id))}</strong> uploaded the joining-fee payment proof.`)));
const msgRows = messages.map(m => card(`<strong>${esc(m.name)}</strong> · ${esc(m.topic)}<br>
  <span style="color:#555">${esc(m.contact)}${m.email && m.email !== m.contact ? " · " + esc(m.email) : ""}</span>
  <p style="white-space:pre-wrap;margin:6px 0 0">${esc(m.message)}</p>`));

const parts = [
  users.length && `${users.length} new sign-up${users.length > 1 ? "s" : ""}`,
  proofs.length && `${proofs.length} payment proof${proofs.length > 1 ? "s" : ""}`,
  messages.length && `${messages.length} message${messages.length > 1 ? "s" : ""}`
].filter(Boolean);

const html = `<div style="font-family:Arial,sans-serif;max-width:600px;color:#12141C">
  <h2 style="margin:0 0 4px">RCMI website</h2>
  <p style="margin:0;color:#555">${parts.join(", ")}</p>
  ${section("New accounts", userRows)}
  ${section("Joining-fee payment proofs", proofRows)}
  ${section("Contact messages", msgRows)}
  <p style="margin-top:20px"><a href="${SITE}/#/admin" style="background:#D6102B;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none;font-weight:bold">Open the Admin page</a></p>
</div>`;

const mail = nodemailer.createTransport({ service: "gmail", auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD } });
await mail.sendMail({ from: `"RCMI website" <${GMAIL_USER}>`, to: NOTIFY_TO, subject: `RCMI: ${parts.join(", ")}`, html });
// Only move forward once the email has gone out, so nothing is missed if sending fails.
await stateRef.set({ lastCheck: now });
console.log("Email sent.");
