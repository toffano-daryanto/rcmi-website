// Creates the test accounts in the emulators (never the live project: projectId demo-rcmi).
import { initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { PEOPLE, PW } from "./people.mjs";
if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_AUTH_EMULATOR_HOST) throw new Error("emulators only");
initializeApp({ projectId: "demo-rcmi" });
const auth = getAuth(), db = getFirestore();
for (const p of PEOPLE) {
  const u = await auth.createUser({ uid: p.key, email: p.email, password: PW, displayName: p.name });
  await db.doc(`users/${u.uid}`).set({
    displayName: p.name, email: p.email, city: "Jakarta", province: "DKI Jakarta", status: "approved",
    role: p.role || "member", ...(p.roles ? { roles: p.roles } : {}), accountType: p.type,
    ...(p.memberNo ? { memberNo: p.memberNo } : {}), ...(p.generalNo ? { generalNo: p.generalNo } : {}),
    createdAt: FieldValue.serverTimestamp(), approvedAt: FieldValue.serverTimestamp()
  });
}
await db.doc("counters/general").set({ seq: 2 });
console.log("seeded", PEOPLE.length, "test accounts");
