// After the round: reads the test database and checks the results independently of the website's own maths.
import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { readFileSync, writeFileSync } from "node:fs";
initializeApp({ projectId: "demo-rcmi" });
const db = getFirestore();
const cid = readFileSync("e2e-out/contest-id.txt", "utf8").trim();
const c = (await db.doc(`contests/${cid}`).get()).data();
const entries = (await db.collection(`contests/${cid}/entries`).get()).docs.map(d => ({ id: d.id, ...d.data() }));
const votes = (await db.collection(`contests/${cid}/votes`).get()).docs.map(d => ({ id: d.id, ...d.data() }));
const scores = (await db.collection(`contests/${cid}/scores`).get()).docs.map(d => d.data());
const notices = (await db.collection("notices").where("postId", "==", cid).get()).docs.map(d => d.data());
const out = [], ok = (cond, msg) => out.push(`${cond ? "✅" : "❌"} ${msg}`);

ok(c.status === "closed", `contest status is "${c.status}" (expected closed)`);
ok(c.registered === 5, `registered = ${c.registered} (expected 5: 4 with photos + 1 without)`);
const regs = entries.filter(e => !e.id.endsWith("_2")).map(e => e.regNo).sort((a, b) => a - b);
ok(JSON.stringify(regs) === "[1,2,3,4,5]", `registration numbers ${regs.map(r => String(r).padStart(7, "0")).join(", ")}`);
const e2 = entries.find(e => e.id === "m3_2"), e1 = entries.find(e => e.id === "m3");
ok(!!e2 && e2.regNo === e1?.regNo, `Segy's 2nd photo kept his number (${String(e1?.regNo).padStart(7, "0")}) and took no extra spot`);
ok(!entries.find(e => e.id === "m4")?.rank, "Gede (registered, no photo) is not in the ranking");
ok(votes.length === 7, `${votes.length} public votes stored (expected 7)`);
ok(scores.length === 10, `${scores.length} jury scores stored (expected 2 judges × 5 photos = 10)`);

// Expected result, computed here from the raw scores and votes (jury 70%, public 30%).
const w = (c.juryWeight ?? 70) / 100, vc = {};
votes.forEach(v => { vc[v.entry] = (vc[v.entry] || 0) + 1; });
const maxV = Math.max(...Object.values(vc));
const res = entries.filter(e => e.photo).map(e => {
  const s = scores.filter(x => x.entry === e.id), jury = s.reduce((a, x) => a + x.total, 0) / s.length;
  return { id: e.id, uid: e.uid, name: e.name, title: e.title, jury, votes: vc[e.id] || 0, final: w * jury * 10 + (1 - w) * ((vc[e.id] || 0) / maxV * 100) };
}).sort((a, b) => b.final - a.final);
out.push("", "Full ranking (each photo on its own):", ...res.map((r, i) => `  ${i + 1}. ${r.title} — ${r.name}: jury ${r.jury.toFixed(2)}, votes ${r.votes}, final ${r.final.toFixed(1)}`), "");
const seen = new Set(), expect = [];
for (const r of res) { if (seen.has(r.uid)) continue; seen.add(r.uid); expect.push(r); if (expect.length === 5) break; }
const got = c.winners || [];
ok(got.length === expect.length, `${got.length} winners announced (up to 5, one per person; ${expect.length} people had photos)`);
expect.forEach((r, i) => ok(got[i]?.entry === r.id && got[i]?.uid === r.uid, `${["🥇", "🥈", "🥉", "4th", "5th"][i]} expected ${r.name} "${r.title}" (${r.final.toFixed(1)}) — site announced ${got[i]?.name} "${got[i]?.title}" (${got[i]?.final})`));
ok(new Set(got.map(x => x.uid)).size === got.length, "no one won twice (one prize per person)");
for (const g of got) ok(notices.some(x => x.uid === g.uid && x.kind === "contest_win" && x.note === String(g.rank)), `${g.name} got a "you won #${g.rank}" notification`);
const others = [...new Set(entries.filter(e => e.photo).map(e => e.uid))].filter(u => !got.some(g => g.uid === u));
for (const u of others) ok(notices.some(x => x.uid === u && x.kind === "contest_result"), `${u} (not a winner) got a "results are out" notification`);
ok(notices.filter(x => x.kind === "contest_voting").length === 4, `${notices.filter(x => x.kind === "contest_voting").length} "voting started" notifications (expected 4 people with photos, once each)`);
const [bb, ba] = readFileSync("e2e-out/bell.txt", "utf8").trim().split(" ").map(Number);
ok(ba === bb - 1, `tapping a notification in the bell marks it read (unread ${bb} → ${ba})`);
const tapped = notices.filter(x => x.uid === "m3").sort((a, b) => b.at.toMillis() - a.at.toMillis())[0];
ok(tapped?.read === true, `the tapped notification is saved as read in the database`);
writeFileSync("e2e-out/report.txt", out.join("\n"));
console.log(out.join("\n"));
if (out.some(l => l.startsWith("❌"))) process.exitCode = 1;
