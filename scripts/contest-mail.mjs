// Contest registration confirmation email: "you're registered" with the 7-digit registration number.
// One email per registration. Runs every 10 minutes from notify.yml.
// What was already sent is kept in contests/{id}/mail/{uid} (server-only; the website can't read or write it),
// so each email goes out once. These are confirmations, so they're sent even when someone turned off notification emails.
//
//   SA_JSON_PATH, GMAIL_USER, GMAIL_APP_PASSWORD
// Logs show counts only.

import { readFileSync } from "node:fs";
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import nodemailer from "nodemailer";

const { SA_JSON_PATH, GMAIL_USER, GMAIL_APP_PASSWORD } = process.env;
const SITE = "https://rcmi-website.web.app";
if (!SA_JSON_PATH || !GMAIL_USER || !GMAIL_APP_PASSWORD) { console.log("Contest emails are off (no Gmail secrets)."); process.exit(0); }
initializeApp({ credential: cert(JSON.parse(readFileSync(SA_JSON_PATH, "utf8"))) });
const db = getFirestore();
const mail = nodemailer.createTransport({ service: "gmail", auth: { user: GMAIL_USER, pass: String(GMAIL_APP_PASSWORD).replace(/\s+/g, "") } });

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const regNo = (n) => String(n || 0).padStart(7, "0");
const when = (ts) => ts?.toDate ? ts.toDate().toLocaleString("en-GB", { day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Jakarta" }) + " WIB" : "";

function page(c, e, kind) {
  const link = `${SITE}/#/contest/${encodeURIComponent(c.id)}`;
  const deadline = c.submitEnd ? when(c.submitEnd) : "registration closes";
  const head = "You're registered! ✅";
  const next = e.photo
    ? `<p>Your photo is already in. You can still change it until <b>${esc(deadline)}</b>.</p>`
    : `<p><b>Next step:</b> submit your photo (1 per person) on the contest page before <b>${esc(deadline)}</b>. Registrations without a photo aren't included in voting.</p>`;
  return `<div style="font-family:Arial,sans-serif;max-width:600px;color:#12141C">
    <div style="background:#12141C;color:#fff;padding:18px 22px;border-bottom:4px solid #D6102B">
      <div style="font-size:12px;letter-spacing:2px;text-transform:uppercase;color:#FFC72C;font-weight:bold">RCMI Photo Contest</div>
      <div style="font-size:22px;font-weight:bold;margin-top:4px">${esc(c.title)}</div>
    </div>
    <div style="padding:20px 22px;border:1px solid #ddd;border-top:0">
      <h2 style="margin:0 0 10px;font-size:20px">${head}</h2>
      <p style="margin:0 0 14px">Hi ${esc(e.name)},</p>
      <table role="presentation" style="border-collapse:collapse;margin:0 0 14px"><tr>
        <td style="padding:10px 16px;background:#F3F3F0;border-left:4px solid #D6102B">
          <div style="font-size:12px;text-transform:uppercase;letter-spacing:1px;color:#5B5F6B">Registration number</div>
          <div style="font-size:28px;font-weight:bold;letter-spacing:3px;color:#D6102B">${regNo(e.regNo)}</div>
        </td></tr></table>
      ${next}
      <p style="margin:18px 0"><a href="${link}" style="background:#D6102B;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none;font-weight:bold">Open the contest page</a></p>
      <p style="color:#888;font-size:12px;margin:18px 0 0">Keep this email: your registration number identifies your entry. Questions? DM @resincarmodelindonesia on Instagram.</p>
    </div>
  </div>`;
}

const contests = (await db.collection("contests").where("status", "==", "open").get()).docs.map(d => ({ id: d.id, ...d.data() }));
let sent = 0, failed = 0;
for (const c of contests) {
  const [entries, log] = await Promise.all([db.collection(`contests/${c.id}/entries`).get(), db.collection(`contests/${c.id}/mail`).get()]);
  const done = Object.fromEntries(log.docs.map(d => [d.id, d.data()]));
  for (const d of entries.docs) {
    const e = d.data(), m = done[d.id] || {};
    if (m.reg) continue;   // already confirmed
    const kind = "reg";
    const u = await db.doc(`users/${d.id}`).get();
    const to = u.exists ? u.data().email : "";
    if (!to) continue;
    try {
      await mail.sendMail({ from: `"RCMI" <${GMAIL_USER}>`, to, subject: `RCMI Photo Contest — registration confirmed (#${regNo(e.regNo)})`, html: page(c, { ...e, name: e.name || u.data().displayName }, kind) });
      await db.doc(`contests/${c.id}/mail/${d.id}`).set({ reg: true, at: FieldValue.serverTimestamp() }, { merge: true });
      sent++;
    } catch (err) { failed++; }
  }
}
console.log(`Contest emails: ${sent} sent, ${failed} failed (${contests.length} running contests).`);
