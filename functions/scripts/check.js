// Read-only check before deploying the notification function: billing (Blaze), database location,
// the Google services the function needs, and the deploy account's roles. Changes nothing.
import { readFileSync } from "node:fs";
import { cert } from "firebase-admin/app";
const sa = JSON.parse(readFileSync(process.env.SA_JSON_PATH, "utf8"));
const P = sa.project_id;
const { access_token } = await cert(sa).getAccessToken();
const get = async (url, opt = {}) => { const r = await fetch(url, { ...opt, headers: { Authorization: `Bearer ${access_token}`, "Content-Type": "application/json" } }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
const out = [];
const b = await get(`https://cloudbilling.googleapis.com/v1/projects/${P}/billingInfo`);
out.push(b.status === 200 ? `Billing (Blaze): ${b.body.billingEnabled ? "ON ✅" : "OFF ❌"}` : `Billing: can't read (${b.status} ${b.body.error?.status || ""})`);
const d = await get(`https://firestore.googleapis.com/v1/projects/${P}/databases/(default)`);
out.push(`Database location: ${d.body.locationId || "?"}`);
const need = ["cloudfunctions", "cloudbuild", "artifactregistry", "run", "eventarc", "pubsub", "cloudscheduler", "storage", "firebaseextensions"].slice(0, 8);
for (const s of need) {
  const r = await get(`https://serviceusage.googleapis.com/v1/projects/${P}/services/${s}.googleapis.com`);
  out.push(`Service ${s}: ${r.status === 200 ? (r.body.state === "ENABLED" ? "on" : "off (deploy will switch it on)") : `can't read (${r.status})`}`);
}
const iam = await get(`https://cloudresourcemanager.googleapis.com/v1/projects/${P}:getIamPolicy`, { method: "POST", body: "{}" });
if (iam.status === 200) {
  const me = `serviceAccount:${sa.client_email}`;
  const roles = (iam.body.bindings || []).filter(x => (x.members || []).includes(me)).map(x => x.role);
  out.push(`Deploy account roles: ${roles.join(", ") || "none listed"}`);
} else out.push(`Deploy account roles: can't read (${iam.status})`);
console.log(out.join("\n").replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "<email>"));
