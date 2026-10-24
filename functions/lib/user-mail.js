// Each member's own notifications (comments, replies, likes, war-sell slots, sales, reviews, admin notices,
// contest news, unread private messages): email + phone push. Same content as scripts/user-notify.mjs.
import { Timestamp } from "firebase-admin/firestore";
import { pushTo, plain } from "./push.js";
const SITE = "https://rcmi-website.web.app";

export async function userNotify(db, mail, cfg) {
  const { GMAIL_USER } = cfg;
  const stateRef = db.doc("notify/userState");
  const now = Timestamp.now(), chatUntil = Timestamp.fromMillis(now.toMillis() - 3 * 60000);
  const st = await stateRef.get();
  if (!st.exists) { await stateRef.set({ lastCheck: now, chatCheck: chatUntil }); return "first run"; }
  const since = st.data().lastCheck, chatSince = st.data().chatCheck || since;
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const ms = (ts) => ts?.toMillis ? ts.toMillis() : 0;
const where = (n) => n.target === "market" ? "Market" : "Collection";
const link = (n) => n.target === "contest" ? `${SITE}/#/contest/${encodeURIComponent(n.postId || "")}` : n.target === "market" ? `${SITE}/#/market/${encodeURIComponent(n.postId || "")}` : `${SITE}/#/feed/p/${encodeURIComponent(n.postId || "")}`;
const TEXT = {
  comment: (n) => `<b>${esc(n.fromName)}</b> commented on your post <b>${esc(n.title)}</b>: “${esc(n.note)}”`,
  reply: (n) => `<b>${esc(n.fromName)}</b> replied to your comment on <b>${esc(n.title)}</b>: “${esc(n.note)}”`,
  like: (n) => `<b>${esc(n.fromName)}</b> liked your ${n.target === "market" ? "listing" : "post"} <b>${esc(n.title)}</b>`,
  claim: (n) => `<b>${esc(n.fromName)}</b> got slot ${esc(n.note)} in your war sell <b>${esc(n.title)}</b>`,
  rate: (n) => `Please rate <b>${esc(n.fromName)}</b> for <b>${esc(n.title)}</b>`,
  review: (n) => `<b>${esc(n.fromName)}</b> left a ${esc(n.note)} review for <b>${esc(n.title)}</b>`,
  hidden: (n) => `Your post <b>${esc(n.title)}</b> in ${where(n)} was hidden by an admin.`,
  deleted: (n) => `Your post <b>${esc(n.title)}</b> in ${where(n)} was removed by an admin.`,
  unhidden: (n) => `Your post <b>${esc(n.title)}</b> in ${where(n)} is visible again.`,
  delapproved: (n) => `Your request to delete <b>${esc(n.title)}</b> was approved.`,
  delrejected: (n) => `Your request to delete <b>${esc(n.title)}</b> was rejected by an admin.`,
  contest_win: (n) => `🏆 Congratulations! You won <b>#${esc(n.note)}</b> in the photo contest <b>${esc(n.title)}</b>!`,
  contest_result: (n) => `The results of the photo contest <b>${esc(n.title)}</b> are out.`,
  contest_voting: (n) => `Voting is open for <b>${esc(n.title)}</b> — share your entry and get votes!`,
  contest_disq: (n) => `Your entry in <b>${esc(n.title)}</b> was disqualified.`
};

// What happened since the last run.
const [noticeSnap, chatSnap] = await Promise.all([
  db.collection("notices").where("at", ">", since).where("at", "<=", now).get(),
  // Private messages wait 3 minutes: if the person reads them on the site meanwhile, no email.
  db.collection("chats").where("lastAt", ">", chatSince).where("lastAt", "<=", chatUntil).get()
]);
const withRead = (path, items) => { const ids = items.map(i => i.nid).filter(Boolean).slice(0, 30); if (!ids.length) return path; const [p, h = ""] = path.split("#"); return `${p || "/"}?nr=${ids.join(",")}${h ? "#" + h : ""}`; };
const per = new Map();   // uid → [{ at, html, href }]
const add = (uid, item) => { if (!uid) return; if (!per.has(uid)) per.set(uid, []); per.get(uid).push(item); };
for (const d of noticeSnap.docs) {
  const n = d.data();
  if (n.read || !TEXT[n.kind]) continue;
  const note = n.note && !["comment", "reply", "claim", "review", "contest_win"].includes(n.kind) ? `<br><span style="color:#555">Reason: ${esc(n.note)}</span>` : "";
  add(n.uid, { nid: d.id, at: ms(n.at), html: TEXT[n.kind](n) + note, href: ["delapproved", "deleted"].includes(n.kind) ? `${SITE}/#/activity` : link(n) });
}
for (const d of chatSnap.docs) {
  const c = d.data();
  if ((c.blockedBy || []).length) continue;
  const to = (c.members || []).find(m => m !== c.lastFrom);
  if (!to || ms(c.readAt?.[to]) >= ms(c.lastAt)) continue;   // already read on the site
  add(to, { at: ms(c.lastAt), html: `✉️ New message from <b>${esc(c.names?.[c.lastFrom] || "a member")}</b>: “${esc(String(c.lastText || "").slice(0, 120))}”`, href: `${SITE}/#/dm/${encodeURIComponent(d.id)}` });
}
if (!per.size) { await stateRef.set({ lastCheck: now, chatCheck: chatUntil }); return "nothing new"; }

const users = await db.getAll(...[...per.keys()].map(uid => db.doc(`users/${uid}`)));
let sent = 0, skipped = 0, failed = 0, pushed = 0;
for (const u of users) {
  const p = u.exists ? u.data() : null;
  if (!p || p.status !== "approved") { skipped++; continue; }
  const items = per.get(u.id).sort((a, b) => b.at - a.at).slice(0, 30);
  // Phone notification (devices where the person turned it on).
  try {
    const first = plain(items[0].html);
    const r = await pushTo(db, [u.id], {
      title: items.length === 1 ? "RCMI" : `RCMI · ${items.length} new`,
      body: items.length === 1 ? first : `${first} (+${items.length - 1} more)`,
      // ?nr=<notice ids>: opening the notification marks those as read on the site.
      link: withRead(items.length === 1 ? items[0].href.replace(SITE, "") : "/#/activity", items), tag: "rcmi-activity"
    });
    pushed += r.sent;
  } catch (e) { console.warn("push failed", e.code || ""); }
  if (!mail || p.emailOff || !p.email) { skipped++; continue; }
  const rows = items.map(i => `<div style="border:1px solid #ddd;border-left:4px solid #D6102B;border-radius:6px;padding:10px 14px;margin:0 0 8px">${i.html}<br><a href="${i.href}" style="color:#D6102B;font-weight:bold;text-decoration:none">Open →</a></div>`).join("");
  const html = `<div style="font-family:Arial,sans-serif;max-width:600px;color:#12141C">
    <h2 style="margin:0 0 4px">RCMI</h2>
    <p style="margin:0 0 16px;color:#555">Hi ${esc(p.displayName || "")}, here's what's new for you.</p>
    ${rows}
    <p style="margin-top:20px;color:#888;font-size:12px">You get these emails because you have an account on ${SITE}. To stop them, open Members area → My profile and untick "Email me my notifications".</p>
  </div>`;
  const subject = items.length === 1 ? `RCMI: ${items[0].html.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").slice(0, 90)}` : `RCMI: ${items.length} new notifications`;
  try { await mail.sendMail({ from: `"RCMI" <${GMAIL_USER}>`, to: p.email, subject, html }); sent++; }
  catch (e) { failed++; }
}
await stateRef.set({ lastCheck: now, chatCheck: chatUntil });
return `${sent} emails, ${pushed} phone notifications, ${failed} failed`;
}
