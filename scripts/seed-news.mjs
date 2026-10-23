// Adds (or updates) the items in tools/news-seed.json on the site's News page (doc id from brand + title, so re-running doesn't duplicate).
// Run by .github/workflows/seed-news.yml with the Firebase service account.
import { readFileSync } from "node:fs";
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore, Timestamp } from "firebase-admin/firestore";

initializeApp({ credential: cert(JSON.parse(readFileSync(process.env.SA_JSON_PATH, "utf8"))) });
const db = getFirestore();
const items = JSON.parse(readFileSync(new URL("../tools/news-seed.json", import.meta.url), "utf8"));
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80);
const ok = (u) => /^https?:\/\//.test(u || "") ? u : "";
let n = 0;
for (const [i, it] of items.entries()) {
  const id = slug(`${it.brand}-${it.title}`);
  const ref = db.doc(`news/${id}`);
  const old = await ref.get();
  const data = {
    title: String(it.title).slice(0, 120), brand: String(it.brand).slice(0, 60), model: String(it.model || "").slice(0, 100),
    scale: String(it.scale || "1:64").slice(0, 20), status: ["preorder", "released", "announced"].includes(it.status) ? it.status : "announced",
    releaseDate: String(it.releaseDate || "").slice(0, 40), price: typeof it.price === "number" ? it.price : null,
    link: ok(it.link).slice(0, 500), photos: [], body: String(it.body || "").slice(0, 3000),
    authorUid: "rcmi", authorName: "RCMI"
  };
  // New items keep the list's order (newest first); existing ones keep their date.
  if (old.exists) await ref.update(data); else { await ref.set({ ...data, createdAt: Timestamp.fromMillis(Date.now() - i * 60000) }); n++; }
}
console.log(`News: ${n} added, ${items.length - n} updated.`);
