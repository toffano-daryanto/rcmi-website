// Checks the notification job against the Firestore emulator with a fake mail sender:
// each event is emailed once, never twice, and overlapping runs don't double-send.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { initializeApp } from "firebase-admin/app";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { runAll } from "../lib/run-all.js";

initializeApp({ projectId: "demo-rcmi" });
const db = getFirestore();
const sent = [];
const transport = { sendMail: async (m) => { sent.push(m); return {}; } };
const cfg = { GMAIL_USER: "rcmi@example.com", transport };
const past = Timestamp.fromMillis(Date.now() - 60000);

before(async () => {
  await db.doc("notify/state").set({ lastCheck: past });
  await db.doc("notify/userState").set({ lastCheck: past, chatCheck: past });
  await db.doc("users/u1").set({ displayName: "Member One", email: "u1@example.com", status: "approved", role: "member" });
  await db.doc("users/adm").set({ displayName: "Admin", email: "adm@example.com", status: "approved", role: "member", roles: ["admin"], createdAt: past });
});

test("a new notice is emailed to its owner once", async () => {
  await db.collection("notices").add({ uid: "u1", kind: "comment", fromName: "Two", title: "R34", note: "nice", target: "feed", postId: "p1", at: Timestamp.now(), read: false });
  await runAll(db, cfg, "t1");
  const mine = sent.filter(m => m.to === "u1@example.com");
  assert.equal(mine.length, 1);
  assert.match(mine[0].subject, /commented on your post/);
  await runAll(db, cfg, "t2");
  assert.equal(sent.filter(m => m.to === "u1@example.com").length, 1, "no second email for the same notice");
});

test("admin alert for a contact message reaches an admin (roles list)", async () => {
  sent.length = 0;
  await db.collection("messages").add({ name: "Visitor", topic: "general", contact: "0811", message: "Hi", status: "new", createdAt: Timestamp.now() });
  await runAll(db, cfg, "t3");
  const a = sent.find(m => /message/.test(m.subject));
  assert.ok(a, "admin email sent");
  assert.ok((a.bcc || []).includes("adm@example.com"));
});

test("two runs at the same moment send only one email", async () => {
  sent.length = 0;
  await db.collection("notices").add({ uid: "u1", kind: "like", fromName: "Three", title: "NSX", target: "feed", postId: "p2", at: Timestamp.now(), read: false });
  await Promise.all([runAll(db, cfg, "a"), runAll(db, cfg, "b")]);
  assert.equal(sent.filter(m => m.to === "u1@example.com").length, 1);
});

test("contest registration gets one confirmation email", async () => {
  sent.length = 0;
  await db.doc("contests/c1").set({ title: "Test Contest", status: "open", public: true });
  await db.doc("contests/c1/entries/u1").set({ uid: "u1", regNo: 1, name: "Member One", photo: "", at: Timestamp.now() });
  await runAll(db, cfg, "t5");
  await runAll(db, cfg, "t6");
  const c = sent.filter(m => /registration confirmed/.test(m.subject));
  assert.equal(c.length, 1);
  assert.match(c[0].subject, /0000001/);
  assert.match(c[0].html, /Nomor pendaftaran/, "Bahasa Indonesia included");
});

test("contest news is in English and Bahasa Indonesia", async () => {
  sent.length = 0;
  await db.collection("notices").add({ uid: "u1", kind: "contest_win", title: "Test Contest", note: "1", target: "contest", postId: "c1", at: Timestamp.now(), read: false });
  await runAll(db, cfg, "t7");
  const m = sent.find(x => x.to === "u1@example.com");
  assert.ok(m, "email sent");
  assert.match(m.html, /Congratulations/); assert.match(m.html, /Selamat/);
  assert.doesNotMatch(m.subject, /Selamat/, "subject stays short (English)");
});

test("associate members get a number automatically, once, in order", async () => {
  const { giveGeneralNo, giveMissingGeneralNos } = await import("../lib/numbers.js");
  await db.doc("counters/general").set({ seq: 7 });
  await db.doc("users/g1").set({ displayName: "G1", accountType: "general", status: "approved", createdAt: Timestamp.now() });
  await db.doc("users/g2").set({ displayName: "G2", accountType: "general", status: "pending", createdAt: Timestamp.now() });
  await giveMissingGeneralNos(db);
  assert.equal((await db.doc("users/g1").get()).data().generalNo, 8);
  assert.equal((await db.doc("users/g2").get()).data().generalNo, undefined, "not before approval");
  await Promise.all([giveGeneralNo(db, "g1"), giveGeneralNo(db, "g1")]);
  assert.equal((await db.doc("users/g1").get()).data().generalNo, 8, "never a second number");
  await db.doc("users/g2").update({ status: "approved" });
  await giveGeneralNo(db, "g2");
  assert.equal((await db.doc("users/g2").get()).data().generalNo, 9);
  assert.equal((await db.doc("counters/general").get()).data().seq, 9);
});
