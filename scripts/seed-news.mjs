// Adds (or updates) the items in tools/news-seed.json (or the file named as the first argument) on the site's News page (doc id from brand + title, so re-running doesn't duplicate).
// Run by .github/workflows/seed-news.yml with the Firebase service account.
import { readFileSync, existsSync } from "node:fs";
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore, Timestamp } from "firebase-admin/firestore";

initializeApp({ credential: cert(JSON.parse(readFileSync(process.env.SA_JSON_PATH, "utf8"))) });
const db = getFirestore();
const file = process.argv[2] || "news-seed.json";
const onlyNew = file !== "news-seed.json";
const items = JSON.parse(readFileSync(new URL(`../tools/${file}`, import.meta.url), "utf8"));
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80);
const ok = (u) => /^https?:\/\//.test(u || "") ? u : "";
let n = 0, removed = 0;
// Monthly check: remember which shop listings were handled (notify/newsSeen), so nothing is posted twice.
// The first run only records what's there (those were posted by hand already).
const seenRef = db.doc("notify/newsSeen");
let seen = null;
if (onlyNew) {
  const snap = await seenRef.get();
  if (!snap.exists) {
    await seenRef.set({ keys: items.map(i => i.key).filter(Boolean) });
    console.log(`News: first monthly run, ${items.length} current listings recorded (nothing posted).`);
    process.exit(0);
  }
  seen = new Set(snap.data().keys || []);
}
for (const [i, it] of items.entries()) {
  if (seen && it.key && seen.has(it.key)) continue;
  const id = slug(`${it.brand}-${it.title}`);
  const ref = db.doc(`news/${id}`);
  const old = await ref.get();
  if (onlyNew && old.exists) continue;   // the monthly check never changes posts that are already there
  // No picture, no post: an item without photos is taken down.
  it.photos = (it.photos || []).filter(x => existsSync(new URL(`../public${x}`, import.meta.url)));   // only photos that really downloaded
  if (!(it.photos || []).length) { if (old.exists) { await ref.delete(); removed++; } continue; }
  const data = {
    title: String(it.title).slice(0, 120), brand: String(it.brand).slice(0, 60), model: String(it.model || "").slice(0, 100),
    scale: String(it.scale || "1:64").slice(0, 20), status: ["preorder", "released", "announced"].includes(it.status) ? it.status : "announced",
    releaseDate: String(it.releaseDate || "").slice(0, 40), price: typeof it.price === "number" ? it.price : null,
    link: ok(it.link).slice(0, 500), photos: (it.photos || []).filter(x => /^\/img\/news\/[\w.-]+\.jpg$/.test(x)).slice(0, 6), body: String(it.body || "").slice(0, 3000),
    authorUid: "rcmi", authorName: "RCMI"
  };
  // New items keep the list's order (newest first); existing ones keep their date.
  if (old.exists) await ref.update(data); else { await ref.set({ ...data, createdAt: Timestamp.fromMillis(Date.now() - i * 60000) }); n++; }
}
if (seen) await seenRef.set({ keys: [...new Set([...seen, ...items.map(i => i.key).filter(Boolean)])].slice(-3000) });
console.log(`News: ${n} added, ${removed} taken down (no photo).`);
