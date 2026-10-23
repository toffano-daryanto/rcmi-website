// Test-only: makes a COPY of the site talk to the local Firebase emulators instead of the live database.
// Used by .github/workflows/contest-e2e.yml on a throwaway checkout; never committed or deployed.
import { readFileSync, writeFileSync } from "node:fs";
const f = "public/js/app.js";
let s = readFileSync(f, "utf8");
s = s.replace("onAuthStateChanged, signOut, reauthenticateWithPopup", "onAuthStateChanged, signOut, reauthenticateWithPopup, connectAuthEmulator, signInWithEmailAndPassword");
s = s.replace("startAfter, arrayUnion, arrayRemove, getCountFromServer", "startAfter, arrayUnion, arrayRemove, getCountFromServer, connectFirestoreEmulator");
s = s.replace("const db = getFirestore(fbApp);", `const db = getFirestore(fbApp);
connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true }); connectFirestoreEmulator(db, "127.0.0.1", 8080);
window.__signIn = (e, p) => signInWithEmailAndPassword(auth, e, p);`);
if (!s.includes("connectFirestoreEmulator(db")) throw new Error("patch failed");
writeFileSync(f, s);
// No uploads to the real Google Drive: photos are stored inside the test database instead.
writeFileSync("public/js/config.js", `export const firebaseConfig = { apiKey: "demo-key", authDomain: "demo-rcmi.firebaseapp.com", projectId: "demo-rcmi", appId: "1:1:web:1" };\nexport const uploadUrl = "";\n`);
console.log("site patched for emulators");
// Turn on the sign-in and database emulators for this throwaway copy.
const fb = JSON.parse(readFileSync("firebase.json", "utf8"));
fb.emulators = { auth: { port: 9099 }, firestore: { port: 8080 }, ui: { enabled: false }, singleProjectMode: true };
writeFileSync("firebase.json", JSON.stringify(fb, null, 2));
