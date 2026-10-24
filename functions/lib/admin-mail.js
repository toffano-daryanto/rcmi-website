// Admin alerts: new sign-ups, joining-fee proofs, Contact messages, delete requests, chat reports, deleted posts.
// Same email as scripts/notify.mjs; called instantly by the cloud function (and by the 5-minute backup).
import { Timestamp } from "firebase-admin/firestore";
import { pushTo } from "./push.js";
const SITE = "https://rcmi-website.web.app";

export async function adminNotify(db, mail, cfg) {
  const { GMAIL_USER, NOTIFY_TO = "" } = cfg;
  const stateRef = db.doc("notify/state");
  const now = Timestamp.now();
  const st = await stateRef.get();
  if (!st.exists) { await stateRef.set({ lastCheck: now }); return "first run"; }
  const since = st.data().lastCheck;
  const newer = async (col, field = "createdAt") =>
    (await db.collection(col).where(field, ">", since).where(field, "<=", now).get()).docs.map(d => ({ id: d.id, ...d.data() }));
  const [users, proofs, messages, delReqs0, reports, ownerDels] = await Promise.all([
    newer("users"), newer("joinPayments"), newer("messages"),
    newer("listings", "delReqAt"), newer("chats", "reportedAt"), newer("deleteLog", "at")
  ]);
  const delReqs = delReqs0.filter(l => l.delReq === true);
  if (!users.length && !proofs.length && !messages.length && !delReqs.length && !reports.length && !ownerDels.length) { await stateRef.set({ lastCheck: now }); return "nothing new"; }
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const no = (n) => `RCMI-${String(n).padStart(4, "0")}`;
const kind = (u) =>
  u.accountType === "general" ? "Associate member — active" :
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

const delRows = delReqs.map(l => card(`<strong>${esc(l.ownerName)}</strong> asks to delete the market listing <strong>${esc(l.title)}</strong><br>
  <span style="color:#555">Reason: ${esc(l.delReason)}</span>`));
const repRows = reports.map(c => card(`<strong>${esc(c.names?.[c.reportedBy] || "A member")}</strong> reported a private chat${c.reportNote ? `<br><span style="color:#555">Reason: ${esc(c.reportNote)}</span>` : ""}`));
const ownDelRows = ownerDels.map(x => card(`<strong>${esc(x.name)}</strong> deleted their Collection post <strong>${esc(x.title)}</strong><br>
  <span style="color:#555">Reason: ${esc(x.reason)}</span>`));

const parts = [
  users.length && `${users.length} new sign-up${users.length > 1 ? "s" : ""}`,
  proofs.length && `${proofs.length} payment proof${proofs.length > 1 ? "s" : ""}`,
  messages.length && `${messages.length} message${messages.length > 1 ? "s" : ""}`,
  delReqs.length && `${delReqs.length} delete request${delReqs.length > 1 ? "s" : ""}`,
  reports.length && `${reports.length} chat report${reports.length > 1 ? "s" : ""}`,
  ownerDels.length && `${ownerDels.length} deleted post${ownerDels.length > 1 ? "s" : ""}`
].filter(Boolean);

const html = `<div style="font-family:Arial,sans-serif;max-width:600px;color:#12141C">
  <h2 style="margin:0 0 4px">RCMI website</h2>
  <p style="margin:0;color:#555">${parts.join(", ")}</p>
  ${section("New accounts", userRows)}
  ${section("Joining-fee payment proofs", proofRows)}
  ${section("Contact messages", msgRows)}
  ${section("Market delete requests (need your approval)", delRows)}
  ${section("Reported chats", repRows)}
  ${section("Collection posts deleted by their owners", ownDelRows)}
  <p style="margin-top:20px"><a href="${SITE}/#/admin" style="background:#D6102B;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none;font-weight:bold">Open the Admin page</a></p>
</div>`;

// Admin alerts go to every admin account's email, plus any extra address in NOTIFY_TO.
const [byRole, byRoles] = await Promise.all([db.collection("users").where("role", "==", "admin").get(), db.collection("users").where("roles", "array-contains", "admin").get()]);
  const adminDocs = [...new Map([...byRole.docs, ...byRoles.docs].map(d => [d.id, d])).values()].filter(d => d.data().status === "approved");
const admins = adminDocs.map(d => d.data()).filter(u => u.email).map(u => u.email.toLowerCase());
// Phone notification to the admins' devices too.
try {
  const r = await pushTo(db, adminDocs.map(d => d.id), { title: "RCMI admin", body: parts.join(", "), link: "/#/admin", tag: "rcmi-admin" });
  
} catch (e) { console.warn("admin push failed", e.code || ""); }
const to = [...new Set([...String(NOTIFY_TO || "").split(",").map(x => x.trim().toLowerCase()).filter(Boolean), ...admins])];
if (mail) await mail.sendMail({ from: `"RCMI website" <${GMAIL_USER}>`, to: GMAIL_USER, bcc: to, subject: `RCMI: ${parts.join(", ")}`, html });
// Only move forward once the email has gone out, so nothing is missed if sending fails.
await stateRef.set({ lastCheck: now });
return parts.join(", ");
}
