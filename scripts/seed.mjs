// One-time (safe to re-run) import of the RCMI roster and events into Firestore.
//
//   cd scripts && npm install
//   node seed.mjs --key ../service-account.json                       # import roster + events
//   node seed.mjs --key ../service-account.json --make-admin you@gmail.com   # also make that Google account admin, member #1
//
// The --make-admin account must have signed in to the site once first.
// Reads ../data/roster.json (private, not in git) and ../data/events.json.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore, FieldValue, Timestamp } from "firebase-admin/firestore";
import { getAuth } from "firebase-admin/auth";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const arg = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };

const keyPath = arg("--key");
if (!keyPath) { console.error("Usage: node seed.mjs --key <service-account.json> [--make-admin <email>]"); process.exit(1); }
const adminEmail = arg("--make-admin");

initializeApp({ credential: cert(JSON.parse(readFileSync(resolve(keyPath), "utf8"))) });
const db = getFirestore();

const roster = JSON.parse(readFileSync(resolve(here, "../data/roster.json"), "utf8"));
const events = JSON.parse(readFileSync(resolve(here, "../data/events.json"), "utf8"));
const rid = (no) => `m${String(no).padStart(3, "0")}`;
const phoneKey = (p) => { let d = String(p || "").replace(/\D/g, ""); if (d.startsWith("0")) d = "62" + d.slice(1); else if (d.startsWith("8")) d = "62" + d; return d; };

const batch = db.batch();

// Numbered members
for (const m of roster.members) {
  batch.set(db.doc(`roster/${rid(m.no)}`), {
    memberNo: m.no, name: m.name, city: m.city || "", province: m.province || "", joined: m.joined || "", status: "member"
  }, { merge: true });
  batch.set(db.doc(`rosterPrivate/${rid(m.no)}`), {
    phone: m.phone || "", shirtSize: m.shirt?.size || "", shirtQty: m.shirt?.qty || 0, shirtPaid: !!m.shirt?.paid,
    ...(m.email ? { email: m.email.toLowerCase() } : {})
  }, { merge: true });
  // Members with a known Google email activate themselves when they sign in with it.
  if (m.email) batch.set(db.doc(`invites/${m.email.toLowerCase()}`), { rosterId: rid(m.no), memberNo: m.no, name: m.name, city: m.city || "" });
  // Members who sign up with their registered phone number activate automatically.
  const pk = phoneKey(m.phone);
  if (pk) batch.set(db.doc(`phoneInvites/${pk}`), { rosterId: rid(m.no), memberNo: m.no, name: m.name, city: m.city || "" });
}

// Applicants who filled the Google Form but have no number yet
for (const a of roster.applicants || []) {
  batch.set(db.doc(`roster/a-${a.key}`), {
    memberNo: null, name: a.name, city: a.city || "", province: a.province || "", status: "applicant", applied: a.applied || ""
  }, { merge: true });
  batch.set(db.doc(`rosterPrivate/a-${a.key}`), { phone: a.phone || "" }, { merge: true });
}

// Events
for (const e of events.events) {
  batch.set(db.doc(`events/${e.id}`), {
    title: e.title, place: e.place, description: e.description || "",
    date: Timestamp.fromDate(new Date(e.start)), allDay: !!e.allDay, dateLabel: e.dateLabel || null,
    createdBy: "import", createdAt: FieldValue.serverTimestamp()
  }, { merge: true });
}
await batch.commit();

// Dues settings: create with defaults only if missing (admins edit bank details on the site)
const sRef = db.doc("settings/payment");
if (!(await sRef.get()).exists) {
  const now = new Date();
  await sRef.set({ amount: 50000, dueDay: 10, bank: "", accountNo: "", accountName: "",
    trackFrom: "2025-07" });
}

// Member-number counter: never move it backwards
const maxNo = Math.max(...roster.members.map(m => m.no));
const cRef = db.doc("counters/members");
await db.runTransaction(async (tx) => {
  const c = await tx.get(cRef);
  const next = Math.max(c.exists ? c.data().next || 1 : 1, maxNo + 1);
  tx.set(cRef, { next });
});

console.log(`Imported ${roster.members.length} members, ${(roster.applicants || []).length} applicants, ${events.events.length} event(s). Next member number: ${maxNo + 1}.`);

// First admin
if (adminEmail) {
  const user = await getAuth().getUserByEmail(adminEmail).catch(() => null);
  if (!user) {
    console.error(`No account for ${adminEmail} yet. Open the site, sign in with that Google account once, then run this again.`);
    process.exit(1);
  }
  const uref = db.doc(`users/${user.uid}`);
  const snap = await uref.get();
  await uref.set({
    ...(snap.exists ? {} : {
      displayName: user.displayName || "Toffano Daryanto", email: user.email, photoURL: user.photoURL || "",
      city: "Jakarta", instagram: "", whatsapp: "", bio: "", createdAt: FieldValue.serverTimestamp()
    }),
    status: "approved", role: "admin", memberNo: 1, rosterId: rid(1), approvedAt: FieldValue.serverTimestamp()
  }, { merge: true });
  await db.doc(`roster/${rid(1)}`).set({ claimedBy: user.uid }, { merge: true });
  console.log(`${adminEmail} is now admin and linked to member #1.`);
}
