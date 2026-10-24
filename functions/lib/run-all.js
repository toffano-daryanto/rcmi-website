// Runs the three email/push jobs once. A lock in notify/lock makes sure two runs never overlap
// (a burst of site activity, or the backup schedule firing at the same moment): a run that finds the lock
// taken just asks the running one to go round again, so nothing is missed and nothing is sent twice.
import { Timestamp } from "firebase-admin/firestore";
import nodemailer from "nodemailer";
import { adminNotify } from "./admin-mail.js";
import { userNotify } from "./user-mail.js";
import { contestMail } from "./contest-mail.js";

export async function runAll(db, cfg, why = "") {
  const lockRef = db.doc("notify/lock");
  const mine = await db.runTransaction(async (tx) => {
    const s = await tx.get(lockRef);
    if ((s.exists ? s.data().until?.toMillis() || 0 : 0) > Date.now()) { tx.set(lockRef, { again: true }, { merge: true }); return false; }
    tx.set(lockRef, { until: Timestamp.fromMillis(Date.now() + 3 * 60000), again: false, by: why });
    return true;
  });
  if (!mine) return "busy: the running job will pick this up";
  const mail = cfg.transport || (cfg.GMAIL_USER && cfg.GMAIL_APP_PASSWORD
    ? nodemailer.createTransport({ service: "gmail", auth: { user: cfg.GMAIL_USER, pass: String(cfg.GMAIL_APP_PASSWORD).replace(/\s+/g, "") } })
    : null);
  const out = [];
  try {
    for (let round = 0; round < 5; round++) {
      await lockRef.set({ again: false }, { merge: true });
      for (const [name, job] of [["admin", adminNotify], ["users", userNotify], ["contest", contestMail]]) {
        try { out.push(`${name}: ${await job(db, mail, cfg)}`); } catch (e) { out.push(`${name}: failed (${e.code || e.message})`); }
      }
      if (!(await lockRef.get()).data()?.again) break;
    }
  } finally {
    await lockRef.set({ until: Timestamp.fromMillis(0), again: false }, { merge: true });
  }
  return out.join(" | ");
}
