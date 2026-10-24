// Read-only: did the notification job run recently? Prints times and kinds only (no names, no addresses).
import { readFileSync } from "node:fs";
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
initializeApp({ credential: cert(JSON.parse(readFileSync(process.env.SA_JSON_PATH, "utf8"))) });
const db = getFirestore();
const t = (ts) => ts?.toDate ? ts.toDate().toISOString().replace("T", " ").slice(0, 19) + " UTC" : "-";
const [lock, us, as, notices, comments] = await Promise.all([
  db.doc("notify/lock").get(), db.doc("notify/userState").get(), db.doc("notify/state").get(),
  db.collection("notices").orderBy("at", "desc").limit(5).get(),
  db.collectionGroup("comments").orderBy("createdAt", "desc").limit(3).get().catch(() => null)
]);
console.log("Now:", t({ toDate: () => new Date() }));
console.log("Last job run by:", lock.data()?.by || "-", "| user check:", t(us.data()?.lastCheck), "| admin check:", t(as.data()?.lastCheck));
console.log("Latest notifications:"); notices.docs.forEach(d => { const n = d.data(); console.log(" ", t(n.at), n.kind, n.read ? "(read)" : "", n.uid === n.fromUid ? "(self)" : ""); });
if (comments) { console.log("Latest comments:"); comments.docs.forEach(d => { const c = d.data(); console.log(" ", t(c.createdAt), "on", d.ref.parent.parent?.path.split("/")[0]); }); }
// Recent function log lines (needs log-reading permission; prints messages only).
try {
  const { access_token } = await cert(JSON.parse(readFileSync(process.env.SA_JSON_PATH, "utf8"))).getAccessToken();
  const r = await fetch("https://logging.googleapis.com/v2/entries:list", { method: "POST", headers: { Authorization: `Bearer ${access_token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ resourceNames: ["projects/rcmi-website"], filter: `resource.type="cloud_run_revision" AND timestamp>="${new Date(Date.now() - 30 * 60000).toISOString()}"`, orderBy: "timestamp desc", pageSize: 25 }) });
  const j = await r.json();
  console.log(`Function logs (last 30 min, ${r.status}):`);
  (j.entries || []).forEach(e => console.log(" ", e.timestamp?.slice(11, 19), e.resource?.labels?.service_name || "", e.severity || "", String(e.textPayload || e.jsonPayload?.message || e.httpRequest?.status || "").replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "<email>").slice(0, 160)));
  if (j.error) console.log("  ", j.error.status);
} catch (e) { console.log("logs: error", e.message); }
