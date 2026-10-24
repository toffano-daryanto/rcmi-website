// RCMI notifications, sent the moment something happens on the site (Firebase Cloud Functions).
// Every trigger runs the same job (lib/run-all.js): admin alerts, each member's own notifications
// (email + phone push) and contest registration confirmations. A 5-minute schedule is the backup.
// Gmail settings come from functions/.env, written at deploy time from the GitHub secrets (never committed).
import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { setGlobalOptions } from "firebase-functions/v2";
import { onDocumentCreated, onDocumentWritten } from "firebase-functions/v2/firestore";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { runAll } from "./lib/run-all.js";

initializeApp();
const db = getFirestore();
setGlobalOptions({ region: process.env.FN_REGION || "us-central1", maxInstances: 2, memory: "256MiB", timeoutSeconds: 120 });
const cfg = () => ({ GMAIL_USER: process.env.GMAIL_USER, GMAIL_APP_PASSWORD: process.env.GMAIL_APP_PASSWORD, NOTIFY_TO: process.env.NOTIFY_TO || "" });
const run = (why) => async () => { console.log(why, "→", await runAll(db, cfg(), why)); };

// Members' own notifications, contest news, admin notices.
export const onNotice = onDocumentCreated("notices/{id}", run("notice"));
// Admin alerts.
export const onSignup = onDocumentCreated("users/{id}", run("signup"));
export const onMessage = onDocumentCreated("messages/{id}", run("message"));
export const onPaymentProof = onDocumentWritten("joinPayments/{id}", run("payment"));
export const onDeleteLog = onDocumentCreated("deleteLog/{id}", run("deletelog"));
export const onListing = onDocumentWritten("listings/{id}", async (e) => {
  const a = e.data?.before?.data() || {}, b = e.data?.after?.data() || {};
  if (b.delReq === true && a.delReq !== true) await run("delete request")();
});
export const onChat = onDocumentWritten("chats/{id}", async (e) => {
  const a = e.data?.before?.data() || {}, b = e.data?.after?.data() || {};
  if (b.reportedAt && !a.reportedAt) await run("chat report")();   // private messages themselves are emailed by the schedule after 3 minutes unread
});
// Contest registration confirmation.
export const onContestEntry = onDocumentCreated("contests/{cid}/entries/{eid}", run("contest entry"));
// Backup: catches anything missed, and unread private messages (after 3 minutes).
export const notifyEvery5min = onSchedule({ schedule: "every 5 minutes", timeZone: "Asia/Jakarta" }, run("schedule"));
