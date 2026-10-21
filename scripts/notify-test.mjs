// Sends one test email to the admins (every admin account's email + NOTIFY_TO), to check the Gmail setup.
// Run from GitHub Actions → "Email notifications & phone sync" → Run workflow → tick "Send a test email".
import { readFileSync } from "node:fs";
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import nodemailer from "nodemailer";

const { SA_JSON_PATH, GMAIL_USER, GMAIL_APP_PASSWORD } = process.env;
if (!GMAIL_USER || !GMAIL_APP_PASSWORD) { console.log("::error::GMAIL_USER / GMAIL_APP_PASSWORD secrets are missing."); process.exit(1); }
initializeApp({ credential: cert(JSON.parse(readFileSync(SA_JSON_PATH, "utf8"))) });
const db = getFirestore();
const admins = (await db.collection("users").where("role", "==", "admin").get()).docs.map(d => d.data())
  .filter(u => u.status === "approved" && u.email).map(u => u.email.toLowerCase());
const to = [...new Set([...String(process.env.NOTIFY_TO || "").split(",").map(x => x.trim().toLowerCase()).filter(Boolean), ...admins])];
console.log(`Test email to ${to.length} admin address(es).`);
const mail = nodemailer.createTransport({ service: "gmail", auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD } });
try { await mail.verify(); } catch (e) {
  // Gmail's own reason (never contains the password), e.g. "534-5.7.9 Application-specific password required".
  const why = String(e.response || e.message || "").replace(/\s+/g, " ").slice(0, 220);
  console.log(`::error::Gmail refused the sign-in (${e.responseCode || e.code || "error"}): ${why}`);
  process.exit(1);
}
await mail.sendMail({ from: `"RCMI website" <${GMAIL_USER}>`, to: GMAIL_USER, bcc: to, subject: "RCMI: test notification ✅",
  html: `<div style="font-family:Arial,sans-serif;max-width:600px;color:#12141C">
    <h2 style="margin:0 0 8px">RCMI website</h2>
    <p>This is a test. Email notifications are working 🎉</p>
    <p style="color:#555">From now on you'll get an email here for new sign-ups, payment proofs, contact messages, delete requests and reported chats. Members get their own emails for comments, replies, messages and likes.</p>
    <p><a href="https://rcmi-website.web.app/#/admin" style="background:#D6102B;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none;font-weight:bold">Open the Admin page</a></p></div>` });
console.log("::notice::Test email sent.");
