// Contest registration confirmation email ("you're registered", with the 7-digit number). Same as scripts/contest-mail.mjs.
import { FieldValue } from "firebase-admin/firestore";
const SITE = "https://rcmi-website.web.app";

export async function contestMail(db, mail, cfg) {
  const { GMAIL_USER } = cfg;
  if (!mail) return "email off";
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const regNo = (n) => String(n || 0).padStart(7, "0");
const when = (ts) => ts?.toDate ? ts.toDate().toLocaleString("en-GB", { day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Jakarta" }) + " WIB" : "";

function page(c, e, kind) {
  const link = `${SITE}/#/contest/${encodeURIComponent(c.id)}`;
  const deadline = c.submitEnd ? when(c.submitEnd) : "registration closes";
  const head = "You're registered! ✅";
  const next = e.photo
    ? `<p>Your photo is already in. You can still change it until <b>${esc(deadline)}</b>.</p>`
    : `<p><b>Next step:</b> submit your photo (up to 2 per person) on the contest page before <b>${esc(deadline)}</b>. Registrations without a photo aren't included in voting.</p>`;
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
    if (d.id.endsWith("_2")) continue;   // a second photo, not a registration
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
return `${sent} sent, ${failed} failed`;
}
