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
const data = {
  title: TITLE, theme: "", desc: "Your best shot of any 1:64 model car — diecast or resin.\nFoto terbaikmu dari model mobil 1:64 apa saja — diecast atau resin.",
  prizes: "Big cash prizes for the top 5 (1st – 5th place). Details coming soon.\nHadiah uang tunai untuk 5 besar (juara 1 – 5). Detail segera diumumkan.",
  rules: `${rules[1]}\n\n— Bahasa Indonesia —\n${rules[0]}`,
  opensAt: wib("2026-11-01T00:00"), submitEnd: wib("2026-11-15T23:59"), voteEnd: wib("2026-11-22T23:59"), announceAt: wib("2026-11-23T20:00"),
  autoPhases: true, juryWeight: 70, maxEntries: 100
};
const ex = (await db.collection("contests").where("title", "==", TITLE).get()).docs[0];
if (ex) { await ex.ref.update(data); console.log("Updated", ex.id); }
else {
  const founder = (await db.collection("users").where("memberNo", "==", 1).get()).docs[0];
  const r = await db.collection("contests").add({ ...data, status: "draft", public: false, registered: 0, regSeq: 0, winners: [], judges: [], createdAt: FieldValue.serverTimestamp(), createdBy: founder?.id || "" });
  console.log("Created", r.id);
}
const c = (await db.collection("contests").where("title", "==", TITLE).get()).docs[0].data();
const t = (x) => x.toDate().toISOString().replace(".000Z", "Z");
console.log("status:", c.status, "| opensAt:", t(c.opensAt), "| submitEnd:", t(c.submitEnd), "| voteEnd:", t(c.voteEnd), "| autoPhases:", c.autoPhases, "| rules lines:", c.rules.split("\n").length);
