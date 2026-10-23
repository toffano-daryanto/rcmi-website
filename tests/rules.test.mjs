// Database security-rule checks for the RCMI site, run against the Firestore emulator
// (GitHub Actions → "Test database rules"). Each test does what the website does for one feature
// and checks the rules allow it — and that the things that must be refused are refused.
import { test, before, after, beforeEach } from "node:test";
import { readFileSync } from "node:fs";
import { initializeTestEnvironment, assertSucceeds, assertFails } from "@firebase/rules-unit-testing";
import {
  doc, getDoc, setDoc, updateDoc, deleteDoc, addDoc, collection, getDocs, query, where, orderBy, limit,
  serverTimestamp, writeBatch, arrayUnion, runTransaction, Timestamp
} from "firebase/firestore";

let env;
const U = { admin: "uAdmin", mod: "uMod", m1: "uMember1", m2: "uMember2", gen: "uGeneral", pend: "uPending", out: "uOutsider" };
const user = (uid, extra = {}) => ({ displayName: uid, email: `${uid}@gmail.com`, city: "Jakarta", status: "approved", role: "member", accountType: "member", ...extra });
const as = (uid) => env.authenticatedContext(uid, { email: `${uid}@gmail.com` }).firestore();
const anon = () => env.unauthenticatedContext().firestore();

before(async () => {
  env = await initializeTestEnvironment({ projectId: "demo-rcmi", firestore: { rules: readFileSync("firestore.rules", "utf8"), host: "127.0.0.1", port: 8080 } });
});
after(async () => { await env?.cleanup(); });
beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, "users", U.admin), user(U.admin, { role: "admin", memberNo: 1, rosterId: "m001" }));
    await setDoc(doc(db, "users", U.mod), user(U.mod, { role: "moderator", memberNo: 2 }));
    await setDoc(doc(db, "users", U.m1), user(U.m1, { memberNo: 3, rosterId: "m003" }));
    await setDoc(doc(db, "users", U.m2), user(U.m2, { memberNo: 4 }));
    await setDoc(doc(db, "users", U.gen), user(U.gen, { accountType: "general" }));
    await setDoc(doc(db, "users", U.pend), user(U.pend, { accountType: "general", status: "pending" }));
    await setDoc(doc(db, "cars", "car1"), { name: "R34", ownerUid: U.m1, ownerName: "M1", photos: [], createdAt: Timestamp.now(), likedBy: [] });
    await setDoc(doc(db, "listings", "lst1"), { type: "sell", title: "R34", price: 350000, ownerUid: U.m1, ownerName: "M1", photos: [], status: "open", likedBy: [], createdAt: Timestamp.now() });
    await setDoc(doc(db, "listings", "war1"), { type: "sell", title: "GR86", price: 300000, ownerUid: U.m1, ownerName: "M1", photos: [], status: "open", war: true, qty: 2, claimed: 0, warStart: null, createdAt: Timestamp.now() });
    await setDoc(doc(db, "users", "uJury1"), user("uJury1", { role: "jury", accountType: "general" }));
    await setDoc(doc(db, "users", "uJury2"), user("uJury2", { role: "jury", memberNo: 9 }));
    await setDoc(doc(db, "contests", "c1"), { title: "Best diorama", status: "open", public: true, judges: ["uJury1", "uJury2"], juryWeight: 70, createdAt: Timestamp.now() });
    await setDoc(doc(db, "contests", "cDraft"), { title: "Draft", status: "draft", public: false, judges: [], createdAt: Timestamp.now() });
    await setDoc(doc(db, "contacts", U.m1), { name: "M1", whatsapp: "0811", instagram: "m1" });
  });
});

// ---------- Profiles & addresses ----------
test("sign-up: general user is active right away", async () => {
  const db = as("uNew");
  await assertSucceeds(setDoc(doc(db, "users", "uNew"), { displayName: "New", email: "uNew@gmail.com", photoURL: "", city: "Depok", instagram: "x", whatsapp: "0811", bio: "",
    role: "member", accountType: "general", createdAt: serverTimestamp(), status: "approved", approvedAt: serverTimestamp() }));
});
test("address: owner writes & reads; others can't read; admin can", async () => {
  const a = { recipient: "M1", phone: "0811", street: "Jl. A 1", village: "Beji", district: "Beji", city: "Kota Depok", province: "Jawa Barat", postal: "16421", note: "", updatedAt: serverTimestamp() };
  await assertSucceeds(setDoc(doc(as(U.m1), "addresses", U.m1), a));
  await assertSucceeds(getDoc(doc(as(U.m1), "addresses", U.m1)));
  await assertFails(getDoc(doc(as(U.m2), "addresses", U.m1)));
  await assertSucceeds(getDoc(doc(as(U.admin), "addresses", U.m1)));
});
test("profile update by owner", async () => {
  await assertSucceeds(updateDoc(doc(as(U.m1), "users", U.m1), { city: "Bogor", updatedAt: serverTimestamp() }));
  await assertSucceeds(updateDoc(doc(as(U.m1), "users", U.m1), { emailOff: true }));
  await assertFails(updateDoc(doc(as(U.m2), "users", U.m1), { emailOff: false }));
  await assertSucceeds(setDoc(doc(as(U.m1), "users", U.m1, "push", "tokA"), { at: serverTimestamp(), ua: "test" }));
  await assertFails(getDoc(doc(as(U.m2), "users", U.m1, "push", "tokA")));
  await assertFails(setDoc(doc(as(U.m2), "users", U.m1, "push", "tokB"), { at: serverTimestamp(), ua: "x" }));
  await assertSucceeds(deleteDoc(doc(as(U.m1), "users", U.m1, "push", "tokA")));
});

// ---------- Collection ----------
test("collection: general user can post; anyone can read", async () => {
  await assertSucceeds(addDoc(collection(as(U.gen), "cars"), { name: "NSX", maker: "", notes: "", photos: [], ownerUid: U.gen, ownerName: "G", ownerPhoto: "", ownerCity: "", createdAt: serverTimestamp() }));
  await assertSucceeds(getDocs(query(collection(anon(), "cars"), orderBy("createdAt", "desc"), limit(6))));
});
test("collection: like (own uid only) + like notice", async () => {
  await assertSucceeds(updateDoc(doc(as(U.m2), "cars", "car1"), { likedBy: arrayUnion(U.m2) }));
  await assertFails(updateDoc(doc(as(U.m2), "cars", "car1"), { likedBy: arrayUnion("someoneElse") }));
  await assertSucceeds(addDoc(collection(as(U.m2), "notices"), { uid: U.m1, kind: "like", target: "collection", postId: "car1", title: "R34", note: "", from: U.m2, fromName: "M2", at: serverTimestamp(), read: false }));
});
test("collection: comment, reply, notices", async () => {
  const c = await assertSucceeds(addDoc(collection(as(U.m2), "cars", "car1", "comments"), { uid: U.m2, name: "M2", photo: "", text: "Nice", at: serverTimestamp() }));
  await assertSucceeds(addDoc(collection(as(U.m2), "notices"), { uid: U.m1, kind: "comment", target: "collection", postId: "car1", title: "R34", note: "Nice", from: U.m2, fromName: "M2", at: serverTimestamp(), read: false }));
  await assertSucceeds(addDoc(collection(as(U.m1), "cars", "car1", "comments"), { uid: U.m1, name: "M1", photo: "", text: "Thanks", parent: c.id, replyToName: "M2", at: serverTimestamp() }));
  await assertSucceeds(addDoc(collection(as(U.m1), "notices"), { uid: U.m2, kind: "reply", target: "collection", postId: "car1", parentId: c.id, title: "R34", note: "Thanks", from: U.m1, fromName: "M1", at: serverTimestamp(), read: false }));
  await assertSucceeds(getDocs(query(collection(anon(), "cars", "car1", "comments"), orderBy("at", "desc"), limit(2))));
});
test("collection: owner deletes with a reason (log + delete)", async () => {
  const db = as(U.m1), b = writeBatch(db);
  b.set(doc(collection(db, "deleteLog")), { uid: U.m1, name: "M1", target: "collection", postId: "car1", title: "R34", reason: "Sold it already", at: serverTimestamp() });
  b.delete(doc(db, "cars", "car1"));
  await assertSucceeds(b.commit());
});
test("moderator deletes a post and notifies the owner", async () => {
  const db = as(U.mod), b = writeBatch(db);
  b.delete(doc(db, "cars", "car1"));
  b.set(doc(collection(db, "notices")), { uid: U.m1, kind: "deleted", target: "collection", postId: "car1", title: "R34", note: "Not 1:64", by: U.mod, at: serverTimestamp(), read: false });
  await assertSucceeds(b.commit());
});

// ---------- Market ----------
test("market: create listing (price required), war listing", async () => {
  const base = { title: "X", condition: "", description: "", photos: [], status: "open", ownerUid: U.m2, ownerName: "M2", ownerInstagram: "", createdAt: serverTimestamp() };
  await assertSucceeds(addDoc(collection(as(U.m2), "listings"), { ...base, type: "sell", price: 100000 }));
  await assertFails(addDoc(collection(as(U.m2), "listings"), { ...base, type: "sell", price: null }));
  await assertSucceeds(addDoc(collection(as(U.m2), "listings"), { ...base, type: "sell", price: 100000, war: true, qty: 5, claimed: 0, warStart: null }));
});
test("edit post: owner edits collection post and listing; others can't; market rules kept", async () => {
  await assertSucceeds(updateDoc(doc(as(U.m1), "cars", "car1"), { name: "R34 V-Spec", maker: "Tarmac", notes: "new", photos: ["a"], editedAt: serverTimestamp() }));
  await assertFails(updateDoc(doc(as(U.m2), "cars", "car1"), { name: "hacked" }));
  await assertFails(updateDoc(doc(as(U.m1), "cars", "car1"), { name: "second edit", editedAt: serverTimestamp() }));   // only one edit
  await assertSucceeds(updateDoc(doc(as(U.m1), "cars", "car1"), { likedBy: arrayUnion(U.m1) }));                    // likes still fine
  await assertSucceeds(updateDoc(doc(as(U.m1), "listings", "lst1"), { title: "R34 GT-R", price: 400000, type: "trade", condition: "Mint", description: "", photos: [], editedAt: serverTimestamp() }));
  await assertFails(updateDoc(doc(as(U.m1), "listings", "lst1"), { price: 500000, editedAt: serverTimestamp() }));   // only one edit
  await assertSucceeds(updateDoc(doc(as(U.m1), "listings", "lst1"), { status: "sold", soldAt: serverTimestamp() }));  // marking sold still works
  await assertFails(updateDoc(doc(as(U.m2), "listings", "lst1"), { title: "hacked" }));
  await assertFails(updateDoc(doc(as(U.m1), "listings", "war1"), { price: 0, editedAt: serverTimestamp() }));
  await assertFails(updateDoc(doc(as(U.m1), "listings", "war1"), { qty: 501, editedAt: serverTimestamp() }));
  await assertFails(updateDoc(doc(as(U.m1), "listings", "war1"), { type: "wanted", editedAt: serverTimestamp() }));
  await assertFails(updateDoc(doc(as(U.m1), "listings", "war1"), { title: "no stamp" }));   // an edit must be stamped
  await assertSucceeds(updateDoc(doc(as(U.m1), "listings", "war1"), { qty: 5, title: "GR86 Pandem", editedAt: serverTimestamp() }));
  await assertFails(updateDoc(doc(as(U.m1), "listings", "war1"), { war: false }));
  await assertFails(updateDoc(doc(as(U.m1), "listings", "war1"), { claimed: 3 }));
});
test("market: like + comment on listing", async () => {
  await assertSucceeds(updateDoc(doc(as(U.gen), "listings", "lst1"), { likedBy: arrayUnion(U.gen) }));
  await assertSucceeds(addDoc(collection(as(U.gen), "listings", "lst1", "comments"), { uid: U.gen, name: "G", photo: "", text: "Nego?", at: serverTimestamp() }));
});
test("market: war buy — slot taken in a transaction, never above qty", async () => {
  const take = (uid) => { const db = as(uid); return runTransaction(db, async (tx) => {
    const ref = doc(db, "listings", "war1"), d = (await tx.get(ref)).data();
    tx.update(ref, { claimed: (d.claimed || 0) + 1 });
    tx.set(doc(db, "listings", "war1", "claims", uid), { uid, name: uid, photo: "", n: (d.claimed || 0) + 1, at: serverTimestamp() });
  }); };
  await assertSucceeds(take(U.m2));
  await assertSucceeds(take(U.gen));
  await assertFails(take(U.admin));   // qty 2: third buyer refused
  await assertFails(take(U.m1));      // seller can't buy own item
});
test("market: sold to a buyer, buyer reviews, seller replies", async () => {
  await assertSucceeds(updateDoc(doc(as(U.m1), "listings", "lst1"), { status: "sold", soldAt: serverTimestamp(), buyerUid: U.m2, buyerName: "M2" }));
  await assertSucceeds(addDoc(collection(as(U.m1), "notices"), { uid: U.m2, kind: "rate", target: "market", postId: "lst1", title: "R34", note: "", from: U.m1, fromName: "M1", at: serverTimestamp(), read: false }));
  await assertSucceeds(setDoc(doc(as(U.m2), "reviews", `lst1_${U.m2}`), { listingId: "lst1", sellerUid: U.m1, sellerName: "M1", title: "R34", reviewerUid: U.m2, reviewerName: "M2", stars: 5, asDescribed: true, text: "Mantap", at: serverTimestamp() }));
  await assertFails(setDoc(doc(as(U.gen), "reviews", `lst1_${U.gen}`), { listingId: "lst1", sellerUid: U.m1, sellerName: "M1", title: "R34", reviewerUid: U.gen, reviewerName: "G", stars: 1, asDescribed: false, text: "x", at: serverTimestamp() }));
  await assertSucceeds(updateDoc(doc(as(U.m1), "reviews", `lst1_${U.m2}`), { reply: "Thanks!", replyAt: serverTimestamp() }));
  await assertSucceeds(addDoc(collection(as(U.m2), "notices"), { uid: U.m1, kind: "review", target: "market", postId: "lst1", title: "R34", note: "5", from: U.m2, fromName: "M2", at: serverTimestamp(), read: false }));
  await assertFails(addDoc(collection(as(U.gen), "listings", "lst1", "comments"), { uid: U.gen, name: "G", photo: "", text: "still there?", at: serverTimestamp() }));  // sold: comments closed
});
test("market: seller asks to delete, moderator approves", async () => {
  await assertSucceeds(updateDoc(doc(as(U.m1), "listings", "lst1"), { delReq: true, delReason: "Changed my mind", delReqAt: serverTimestamp() }));
  await assertFails(deleteDoc(doc(as(U.m1), "listings", "lst1")));
  await assertSucceeds(getDocs(query(collection(as(U.mod), "listings"), where("delReq", "==", true))));
  const db = as(U.mod), b = writeBatch(db);
  b.delete(doc(db, "listings", "lst1"));
  b.set(doc(collection(db, "notices")), { uid: U.m1, kind: "delapproved", target: "market", postId: "lst1", title: "R34", note: "", by: U.mod, at: serverTimestamp(), read: false });
  await assertSucceeds(b.commit());
});
test("market: seller contacts readable by active accounts only", async () => {
  await assertSucceeds(getDocs(collection(as(U.m2), "contacts")));
  await assertFails(getDocs(collection(anon(), "contacts")));
});

// ---------- Direct messages ----------
const cid = [U.m1, U.m2].sort().join("_");
const newChat = (me, other) => ({ members: [me, other].sort(), names: { [me]: me, [other]: other }, photos: { [me]: "", [other]: "" },
  createdAt: serverTimestamp(), lastAt: serverTimestamp(), lastText: "", lastFrom: "", readAt: {}, blockedBy: [] });
test("DM: check-if-exists, start, send, read; outsiders can't", async () => {
  await assertSucceeds(getDoc(doc(as(U.m1), "chats", cid)));               // doesn't exist yet
  await assertSucceeds(setDoc(doc(as(U.m1), "chats", cid), newChat(U.m1, U.m2)));
  await assertSucceeds(getDoc(doc(as(U.m1), "chats", cid)));               // exists now
  const db = as(U.m1), b = writeBatch(db);
  b.set(doc(collection(db, "chats", cid, "messages")), { from: U.m1, text: "Halo", photo: "", at: serverTimestamp() });
  b.update(doc(db, "chats", cid), { lastText: "Halo", lastAt: serverTimestamp(), lastFrom: U.m1 });
  await assertSucceeds(b.commit());
  await assertSucceeds(getDocs(query(collection(as(U.m2), "chats"), where("members", "array-contains", U.m2))));
  await assertSucceeds(getDocs(query(collection(as(U.m2), "chats", cid, "messages"), orderBy("at", "asc"), limit(500))));
  await assertSucceeds(updateDoc(doc(as(U.m2), "chats", cid), { [`readAt.${U.m2}`]: serverTimestamp() }));
  await assertFails(getDoc(doc(as(U.out), "chats", cid)));
  await assertFails(getDocs(query(collection(as(U.gen), "chats", cid, "messages"))));
});
test("DM: block stops messages; report lets staff read", async () => {
  await env.withSecurityRulesDisabled(async (ctx) => { await setDoc(doc(ctx.firestore(), "chats", cid), { ...newChat(U.m1, U.m2), createdAt: Timestamp.now(), lastAt: Timestamp.now() }); });
  await assertSucceeds(updateDoc(doc(as(U.m2), "chats", cid), { blockedBy: arrayUnion(U.m2) }));
  await assertFails(addDoc(collection(as(U.m1), "chats", cid, "messages"), { from: U.m1, text: "hi", photo: "", at: serverTimestamp() }));
  await assertSucceeds(updateDoc(doc(as(U.m2), "chats", cid), { reported: true, reportedBy: U.m2, reportNote: "Scam", reportedAt: serverTimestamp() }));
  await assertSucceeds(getDocs(query(collection(as(U.mod), "chats"), where("reported", "==", true))));
  await assertSucceeds(getDocs(query(collection(as(U.mod), "chats", cid, "messages"), orderBy("at", "asc"))));
  await assertSucceeds(updateDoc(doc(as(U.mod), "chats", cid), { reported: false }));
});

// ---------- Moderator ----------
test("moderator: approve a pending general user; deactivate a member (posts hidden)", async () => {
  await assertSucceeds(getDocs(query(collection(as(U.mod), "users"), where("status", "==", "pending"))));
  await assertSucceeds(updateDoc(doc(as(U.mod), "users", U.pend), { status: "approved", approvedAt: serverTimestamp() }));
  const db = as(U.mod), b = writeBatch(db);
  b.update(doc(db, "users", U.m2), { status: "deactivated", deactivatedAt: serverTimestamp() });
  await assertSucceeds(b.commit());
  await assertSucceeds(updateDoc(doc(as(U.mod), "cars", "car1"), { hidden: true }));
  await assertFails(updateDoc(doc(as(U.mod), "users", U.admin), { status: "deactivated", deactivatedAt: serverTimestamp() }));
});
test("admin: hide a post with a reason and notify", async () => {
  const db = as(U.admin), b = writeBatch(db);
  b.update(doc(db, "cars", "car1"), { modHidden: true, modNote: "x", modBy: U.admin, modAt: serverTimestamp() });
  b.set(doc(collection(db, "notices")), { uid: U.m1, kind: "hidden", target: "collection", postId: "car1", title: "R34", note: "x", by: U.admin, at: serverTimestamp(), read: false });
  await assertSucceeds(b.commit());
});
test("notices: owner reads own and marks read", async () => {
  await env.withSecurityRulesDisabled(async (ctx) => { await setDoc(doc(ctx.firestore(), "notices", "n1"), { uid: U.m1, kind: "like", read: false, at: Timestamp.now() }); });
  await assertSucceeds(getDocs(query(collection(as(U.m1), "notices"), where("uid", "==", U.m1))));
  await assertSucceeds(updateDoc(doc(as(U.m1), "notices", "n1"), { read: true }));
  await assertFails(getDoc(doc(as(U.m2), "notices", "n1")));
});
test("contact form: signed-in user sends; only admins read", async () => {
  await assertSucceeds(addDoc(collection(as(U.gen), "messages"), { name: "G", contact: "0811", topic: "pasar", message: "Hi", status: "new", createdAt: serverTimestamp(), uid: U.gen, email: `${U.gen}@gmail.com`, lang: "en" }));
  await assertFails(getDocs(collection(as(U.m1), "messages")));
  await assertSucceeds(getDocs(query(collection(as(U.admin), "messages"), where("status", "==", "new"))));
});

// ---------- Photo contest ----------
const entry = (uid, extra = {}) => ({ uid, name: uid, avatar: "", title: "My R34", caption: "", photo: "https://drive.google.com/thumbnail?id=x", at: serverTimestamp(), ...extra });
// Register = in one transaction: take a spot (registered + 1) and create the entry.
const reg = (uid, extra = {}) => { const db = as(uid); return runTransaction(db, async (tx) => {
  const cref = doc(db, "contests", "c1"), c = (await tx.get(cref)).data();
  const no = (c.regSeq || 0) + 1;
  tx.update(cref, { registered: (c.registered || 0) + 1, regSeq: no });
  tx.set(doc(db, "contests", "c1", "entries", uid), entry(uid, { regNo: no, ...extra }));
}); };
const setPhase = (status) => env.withSecurityRulesDisabled(ctx => updateDoc(doc(ctx.firestore(), "contests", "c1"), { status }));
test("contest: drafts hidden; entry while open (1 per person, hidden from others); jury can't enter", async () => {
  await assertFails(getDoc(doc(anon(), "contests", "cDraft")));
  await assertSucceeds(getDoc(doc(anon(), "contests", "c1")));
  await assertSucceeds(getDocs(query(collection(anon(), "contests"), where("public", "==", true))));
  await assertSucceeds(reg(U.m1, { title: "", photo: "" }));                                                          // register (takes a spot)
  await assertFails(setDoc(doc(as(U.m2), "contests", "c1", "entries", U.m2), entry(U.m2)));                             // can't skip the spot counter
  await assertFails(setDoc(doc(anon(), "contests", "c1", "entries", U.out), entry(U.out)));                              // needs an account
  await assertFails(reg(U.pend));                                                                                       // account not active yet
  await assertSucceeds(setDoc(doc(as(U.m1), "contests", "c1", "entries", U.m1), entry(U.m1, { regNo: 1 })));            // then submit the photo
  await assertFails(setDoc(doc(as(U.m1), "contests", "c1", "entries", U.m1), entry(U.m1, { regNo: 99 })));              // number can't change
  await assertSucceeds(reg(U.gen));
  await assertFails(setDoc(doc(as(U.m1), "contests", "c1", "entries", U.m2), entry(U.m2)));          // not for someone else
  await assertFails(reg("uJury1"));                                                                     // jury can't enter
  await assertFails(setDoc(doc(as(U.m2), "contests", "c1", "entries", U.m2), entry(U.m2, { status: "ok" })));
  await assertFails(getDoc(doc(as(U.m2), "contests", "c1", "entries", U.m1)));                        // hidden while open
  await assertSucceeds(getDoc(doc(as(U.m1), "contests", "c1", "entries", U.m1)));
  await assertFails(setDoc(doc(as(U.m1), "contests", "c1", "votes", U.m1), { entry: U.gen, at: serverTimestamp() })); // no voting yet
  await assertFails(updateDoc(doc(as(U.m2), "contests", "c1"), { registered: 0 }));                   // can't fiddle with the counter
});
test("contest: participant limit (maxEntries) and withdrawing frees the spot", async () => {
  await env.withSecurityRulesDisabled(ctx => updateDoc(doc(ctx.firestore(), "contests", "c1"), { maxEntries: 2, registered: 0 }));
  await assertSucceeds(reg(U.m1));
  await assertSucceeds(reg(U.m2));
  await assertFails(reg(U.gen));                                                                        // full (2 of 2)
  const leave = (uid) => { const db = as(uid); return runTransaction(db, async (tx) => {
    const cref = doc(db, "contests", "c1"), c = (await tx.get(cref)).data();
    tx.update(cref, { registered: c.registered - 1 }); tx.delete(doc(db, "contests", "c1", "entries", uid));
  }); };
  await assertSucceeds(leave(U.m2));
  await assertSucceeds(reg(U.gen));                                                                     // spot free again
  await assertSucceeds(getDoc(doc(as(U.gen), "contests", "c1", "entries", U.gen)).then(d => { if (d.data().regNo !== 3) throw new Error("regNo should be 3 (numbers never reused), got " + d.data().regNo); }));
});
test("contest: voting (one vote, not own, private) + jury scoring + admin results", async () => {
  await env.withSecurityRulesDisabled(async ctx => {
    const db = ctx.firestore();
    await setDoc(doc(db, "contests", "c1", "entries", U.m1), entry(U.m1, { at: Timestamp.now() }));
    await setDoc(doc(db, "contests", "c1", "entries", U.gen), entry(U.gen, { at: Timestamp.now() }));
  });
  await setPhase("voting");
  await assertFails(setDoc(doc(as(U.m2), "contests", "c1", "entries", U.m2), entry(U.m2)));          // entries closed
  await assertSucceeds(getDocs(collection(as(U.m2), "contests", "c1", "entries")));                  // everyone sees entries now
  await assertSucceeds(setDoc(doc(as(U.m2), "contests", "c1", "votes", U.m2), { entry: U.m1, at: serverTimestamp() }));
  await assertSucceeds(setDoc(doc(as(U.m2), "contests", "c1", "votes", U.m2), { entry: U.gen, at: serverTimestamp() })); // move vote
  await assertFails(setDoc(doc(as(U.m1), "contests", "c1", "votes", U.m1), { entry: U.m1, at: serverTimestamp() }));    // own entry
  await assertFails(getDoc(doc(as(U.m1), "contests", "c1", "votes", U.m2)));                          // votes private
  await assertSucceeds(getDoc(doc(as(U.m2), "contests", "c1", "votes", U.m2)));
  const sc = (j, e, total) => setDoc(doc(as(j), "contests", "c1", "scores", `${j}_${e}`), { judge: j, entry: e, crit: { comp: total }, total, note: "", at: serverTimestamp() });
  await assertSucceeds(sc("uJury1", U.m1, 8));
  await assertSucceeds(sc("uJury2", U.m1, 9));
  await assertFails(sc(U.m2, U.m1, 10));                                                              // not jury
  await assertFails(sc("uJury1", U.m1, 11));                                                          // out of range
  await assertFails(getDoc(doc(as("uJury1"), "contests", "c1", "scores", `uJury2_${U.m1}`)));         // other judge's score
  await assertSucceeds(getDocs(query(collection(as("uJury1"), "contests", "c1", "scores"), where("judge", "==", "uJury1"))));
  await setPhase("judging");
  await assertFails(setDoc(doc(as(U.m2), "contests", "c1", "votes", U.m2), { entry: U.m1, at: serverTimestamp() })); // voting closed
  await assertSucceeds(sc("uJury1", U.gen, 7));                                                       // jury can still score
  await assertSucceeds(getDocs(collection(as(U.admin), "contests", "c1", "scores")));
  await assertSucceeds(getDocs(collection(as(U.admin), "contests", "c1", "votes")));
  await assertSucceeds(updateDoc(doc(as(U.admin), "contests", "c1", "entries", U.m1), { votes: 0, jury: 8.5, final: 59.5, rank: 1 }));
  await assertFails(updateDoc(doc(as(U.m1), "contests", "c1", "entries", U.m1), { rank: 1 }));
  await assertSucceeds(updateDoc(doc(as(U.admin), "contests", "c1"), { status: "closed", winners: [] }));
  await assertSucceeds(setDoc(doc(as(U.admin), "notices", "nc1"), { uid: U.m1, kind: "contest_win", target: "contest", postId: "c1", title: "Best diorama", note: "1", at: serverTimestamp(), read: false }));
});
test("jury role: only admins assign it", async () => {
  await assertFails(updateDoc(doc(as(U.m1), "users", U.m1), { role: "jury" }));
  await assertSucceeds(updateDoc(doc(as(U.admin), "users", U.m2), { role: "jury" }));
});

test("founder (RCMI-0001) can't be demoted, deactivated or deleted by anyone else", async () => {
  await env.withSecurityRulesDisabled(async ctx => {
    await setDoc(doc(ctx.firestore(), "users", "uFounder"), user("uFounder", { role: "admin", memberNo: 1 }));
    await setDoc(doc(ctx.firestore(), "users", "uAdmin2"), user("uAdmin2", { role: "admin", memberNo: 50 }));
  });
  await assertFails(updateDoc(doc(as(U.admin), "users", "uFounder"), { role: "member" }));
  await assertFails(updateDoc(doc(as(U.admin), "users", "uFounder"), { status: "deactivated" }));
  await assertFails(updateDoc(doc(as(U.admin), "users", "uFounder"), { memberNo: 2 }));
  await assertFails(updateDoc(doc(as(U.mod), "users", "uFounder"), { status: "deactivated" }));
  await assertFails(deleteDoc(doc(as(U.admin), "users", "uFounder")));
  await assertSucceeds(updateDoc(doc(as("uFounder"), "users", "uFounder"), { city: "Riyadh" }));     // own profile still editable
  await assertSucceeds(updateDoc(doc(as("uFounder"), "users", "uAdmin2"), { role: "member" }));       // founder can still manage others
  await assertSucceeds(updateDoc(doc(as(U.admin), "users", U.m2), { role: "moderator" }));            // admins manage everyone else
});

test("news: staff post, everyone reads, members can't post", async () => {
  const n = { title: "Tarmac R34 Z-Tune", brand: "Tarmac Works", model: "Nissan Skyline R34", scale: "1:64", status: "preorder", releaseDate: "2026-12", price: 350000, link: "https://example.com/r34", photos: [], body: "Pre-order now", createdAt: serverTimestamp(), authorUid: U.mod, authorName: "Mod" };
  await assertSucceeds(setDoc(doc(as(U.mod), "news", "n1"), n));
  await assertSucceeds(setDoc(doc(as(U.admin), "news", "n2"), { ...n, price: null, link: "" }));
  await assertFails(setDoc(doc(as(U.m1), "news", "n3"), n));
  await assertFails(setDoc(doc(as(U.admin), "news", "n4"), { ...n, link: "javascript:alert(1)" }));
  await assertFails(setDoc(doc(as(U.admin), "news", "n5"), { ...n, status: "rumour" }));
  await assertSucceeds(getDocs(query(collection(anon(), "news"), orderBy("createdAt", "desc"), limit(50))));
  await assertFails(deleteDoc(doc(as(U.m1), "news", "n1")));
  await assertFails(deleteDoc(doc(as(U.mod), "news", "n1")));     // moderators can't delete news
  await assertSucceeds(deleteDoc(doc(as(U.admin), "news", "n1")));
});
