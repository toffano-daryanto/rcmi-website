// One-off: give every general user a registration number (#1, #2, …) in the order they joined,
// and set counters/general so new general users continue the sequence. Already-numbered users keep theirs.
import { readFileSync } from "node:fs";
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
initializeApp({ credential: cert(JSON.parse(readFileSync(process.env.SA_JSON_PATH, "utf8"))) });
const db = getFirestore();
const users = (await db.collection("users").where("accountType", "==", "general").get()).docs
  .map(d => ({ ref: d.ref, ...d.data() })).filter(u => ["approved", "deactivated"].includes(u.status))
  .sort((a, b) => (a.createdAt?.toMillis?.() || 0) - (b.createdAt?.toMillis?.() || 0));
let seq = Math.max(0, ...users.map(u => u.generalNo || 0));
const cRef = db.doc("counters/general"); const c = await cRef.get();
seq = Math.max(seq, c.exists ? c.data().seq || 0 : 0);
let n = 0;
for (const u of users) if (!u.generalNo) { seq++; await u.ref.update({ generalNo: seq }); n++; }
await cRef.set({ seq });
console.log(`General users: ${n} numbered, counter at ${seq}.`);
