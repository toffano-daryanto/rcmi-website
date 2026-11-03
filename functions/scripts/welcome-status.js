// Read-only: members approved in the last 24 h and whether their welcome email went out, plus the
// onApproved function's recent log lines. Prints member numbers only (no names or emails).
import { readFileSync } from "node:fs";
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
const sa = JSON.parse(readFileSync(process.env.SA_JSON_PATH, "utf8"));
initializeApp({ credential: cert(sa) });
const db = getFirestore();
const since = Timestamp.fromMillis(Date.now() - 24 * 3600e3);
const snap = await db.collection("users").where("approvedAt", ">", since).get();
console.log(`Approved in the last 24 h: ${snap.size}`);
for (const d of snap.docs) {
  const u = d.data();
  console.log(`- ${u.accountType === "general" ? "associate" : "member #" + (u.memberNo ?? "?")} | status ${u.status} | email on file: ${u.email ? "yes" : "no"} | welcome: ${u.welcomedAt ? "sent " + u.welcomedAt.toDate().toISOString() : u.welcomeError ? "FAILED (" + u.welcomeError + ")" : "not sent"}`);
}
const { access_token } = await cert(sa).getAccessToken();
const filter = `resource.type="cloud_run_revision" AND resource.labels.service_name="onapproved" AND timestamp>="${new Date(Date.now() - 3 * 3600e3).toISOString()}"`;
const r = await fetch("https://logging.googleapis.com/v2/entries:list", { method: "POST", headers: { Authorization: `Bearer ${access_token}`, "Content-Type": "application/json" },
  body: JSON.stringify({ resourceNames: [`projects/${sa.project_id}`], filter, orderBy: "timestamp desc", pageSize: 30 }) });
const j = await r.json();
console.log(`\nonApproved log (last 3 h, ${r.status}):`);
for (const e of j.entries || []) { const m = e.textPayload || e.jsonPayload?.message || ""; if (m) console.log(e.timestamp, e.severity || "", m.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "<email>").slice(0, 300)); }
