// One-off: creates (or updates, if it already exists) the RCMI Photo Contest 2026 as a draft that opens by itself
// on 1 November 2026 00:00 WIB. Dates in WIB (UTC+7). Prints only ids and dates.
import { readFileSync } from "node:fs";
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore, Timestamp, FieldValue } from "firebase-admin/firestore";
initializeApp({ credential: cert(JSON.parse(readFileSync(process.env.SA_JSON_PATH, "utf8"))) });
const db = getFirestore();
const wib = (s) => Timestamp.fromDate(new Date(s + ":00+07:00"));
const i18n = readFileSync(new URL("../../public/js/i18n.js", import.meta.url), "utf8");
const rules = [...i18n.matchAll(/ct_rules_default: "((?:[^"\\]|\\.)*)"/g)].map(m => JSON.parse(`"${m[1]}"`));   // [Indonesian, English]
const TITLE = "RCMI Photo Contest 2026";
const PRIZES = [
  "🥇 1st place: Certificate + Rp 500.000 cash + prizes from Kepopic Studio & Hellios Studio",
  "🥈 2nd place: Certificate + Rp 300.000 cash + prizes from Kepopic Studio & Hellios Studio",
  "🥉 3rd place: Certificate + Rp 200.000 cash + prizes from Kepopic Studio & Hellios Studio",
  "4th place: Certificate + a miniscale model",
  "5th place: Certificate + a miniscale model",
  "",
  "— Bahasa Indonesia —",
  "🥇 Juara 1: Sertifikat + uang tunai Rp 500.000 + hadiah dari Kepopic Studio & Hellios Studio",
  "🥈 Juara 2: Sertifikat + uang tunai Rp 300.000 + hadiah dari Kepopic Studio & Hellios Studio",
  "🥉 Juara 3: Sertifikat + uang tunai Rp 200.000 + hadiah dari Kepopic Studio & Hellios Studio",
  "Juara 4: Sertifikat + model miniscale",
  "Juara 5: Sertifikat + model miniscale"
].join("\n");
const data = {
  title: TITLE, theme: "", desc: "Your best shot of any 1:64 model car — diecast or resin.\nFoto terbaikmu dari model mobil 1:64 apa saja — diecast atau resin.",
  prizes: PRIZES,
  rules: `${rules[1]}\n\n— Bahasa Indonesia —\n${rules[0]}`,
  opensAt: wib("2026-11-01T00:00"), submitEnd: wib("2026-11-15T23:59"), voteEnd: wib("2026-11-22T23:59"), announceAt: wib("2026-11-23T20:00"),
  autoPhases: true, juryWeight: 70, maxEntries: 100
};
const ex = (await db.collection("contests").where("title", "==", TITLE).get()).docs[0];
if (ex && process.env.ONLY === "redraft") {
  // Back to a hidden draft (only if nobody has registered yet); it opens by itself on opensAt.
  const c0 = ex.data();
  if ((c0.registered || 0) > 0) { console.log("Not changed: people have already registered."); process.exit(1); }
  await ex.ref.update({ status: "draft", public: false, openAt: FieldValue.delete() }); console.log("Back to draft", ex.id);
}
else if (ex) { await ex.ref.update(process.env.ONLY === "prizes" ? { prizes: PRIZES } : data); console.log("Updated", ex.id, process.env.ONLY || "all"); }
else {
  const founder = (await db.collection("users").where("memberNo", "==", 1).get()).docs[0];
  const r = await db.collection("contests").add({ ...data, status: "draft", public: false, registered: 0, regSeq: 0, winners: [], judges: [], createdAt: FieldValue.serverTimestamp(), createdBy: founder?.id || "" });
  console.log("Created", r.id);
}
const c = (await db.collection("contests").where("title", "==", TITLE).get()).docs[0].data();
const t = (x) => x.toDate().toISOString().replace(".000Z", "Z");
console.log("prizes:\n" + c.prizes);
console.log("status:", c.status, "| opensAt:", t(c.opensAt), "| submitEnd:", t(c.submitEnd), "| voteEnd:", t(c.voteEnd), "| autoPhases:", c.autoPhases, "| rules lines:", c.rules.split("\n").length);
