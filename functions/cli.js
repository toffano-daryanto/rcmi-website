// Same job from the command line (used by the GitHub backup workflow): node functions/cli.js
//   SA_JSON_PATH, GMAIL_USER, GMAIL_APP_PASSWORD, NOTIFY_TO (optional)
import { readFileSync } from "node:fs";
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { runAll } from "./lib/run-all.js";
initializeApp({ credential: cert(JSON.parse(readFileSync(process.env.SA_JSON_PATH, "utf8"))) });
const out = await runAll(getFirestore(), { GMAIL_USER: process.env.GMAIL_USER, GMAIL_APP_PASSWORD: process.env.GMAIL_APP_PASSWORD, NOTIFY_TO: process.env.NOTIFY_TO || "" }, "github");
// Logs are public: the job reports counts only.
console.log(out.replace(/[^\w\s|:,()/.-]/g, ""));
