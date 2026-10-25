// Read-only: contests on the site and how many jury accounts exist (titles/status/dates only).
import { readFileSync } from "node:fs";
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
initializeApp({ credential: cert(JSON.parse(readFileSync(process.env.SA_JSON_PATH, "utf8"))) });
const db = getFirestore();
const t = (ts) => ts?.toDate ? ts.toDate().toISOString().slice(0, 16) + "Z" : "-";
const cs = await db.collection("contests").get();
console.log(`Contests: ${cs.size}`);
cs.docs.forEach(d => { const c = d.data(); console.log("  prizes:", JSON.stringify(c.prizes || "")); console.log(" ", d.id, "|", c.title, "|", c.status, "| public:", !!c.public, "| submitEnd", t(c.submitEnd), "| voteEnd", t(c.voteEnd), "| judges:", (c.judges || []).length, "| registered:", c.registered || 0); });
const [a, b] = await Promise.all([db.collection("users").where("role", "==", "jury").get(), db.collection("users").where("roles", "array-contains", "jury").get()]);
const j = new Map([...a.docs, ...b.docs].map(d => [d.id, d.data()]));
console.log(`Jury accounts: ${j.size}`); [...j.values()].forEach(u => console.log("  jury:", u.displayName, "|", u.status));
