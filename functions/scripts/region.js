// Prints the Cloud Functions region that matches the Firestore database location (triggers must live near the database).
import { readFileSync } from "node:fs";
import { cert } from "firebase-admin/app";
const sa = JSON.parse(readFileSync(process.env.SA_JSON_PATH, "utf8"));
const { access_token } = await cert(sa).getAccessToken();
const r = await fetch(`https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)`, { headers: { Authorization: `Bearer ${access_token}` } });
const loc = (await r.json()).locationId || "nam5";
console.log({ nam5: "us-central1", eur3: "europe-west1" }[loc] || loc);
