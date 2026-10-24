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
