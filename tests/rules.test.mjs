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
test("market: like + comment on listing", async () => {
  await assertSucceeds(updateDoc(doc(as(U.gen), "listings", "lst1"), { likedBy: arrayUnion(U.gen) }));
  await assertSucceeds(addDoc(collection(as(U.gen), "listings", "lst1", "comments"), { uid: U.gen, name: "G", photo: "", text: "Nego?", at: serverTimestamp() }));
});
test("market: war buy — slot taken in a transaction, never above qty", async () => {
  const take = (uid) => runTransaction(as(uid), async (tx) => {
    const db = as(uid), ref = doc(db, "listings", "war1"), d = (await tx.get(ref)).data();
    tx.update(ref, { claimed: (d.claimed || 0) + 1 });
    tx.set(doc(db, "listings", "war1", "claims", uid), { uid, name: uid, photo: "", n: (d.claimed || 0) + 1, at: serverTimestamp() });
  });
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
  const n = await env.withSecurityRulesDisabled(async (ctx) => addDoc(collection(ctx.firestore(), "notices"), { uid: U.m1, kind: "like", read: false, at: Timestamp.now() }));
  await assertSucceeds(getDocs(query(collection(as(U.m1), "notices"), where("uid", "==", U.m1))));
  await assertSucceeds(updateDoc(doc(as(U.m1), "notices", n.id), { read: true }));
});
test("contact form: signed-in user sends; only admins read", async () => {
  await assertSucceeds(addDoc(collection(as(U.gen), "messages"), { name: "G", contact: "0811", topic: "pasar", message: "Hi", status: "new", createdAt: serverTimestamp(), uid: U.gen, email: `${U.gen}@gmail.com`, lang: "en" }));
  await assertFails(getDocs(collection(as(U.m1), "messages")));
  await assertSucceeds(getDocs(query(collection(as(U.admin), "messages"), where("status", "==", "new"))));
});
