// Phone push notifications through Firebase Cloud Messaging (uses the same service account as the rest).
// Tokens live under users/{uid}/push/{token}; dead tokens (app removed, permission revoked) are cleaned up.
import { getMessaging } from "firebase-admin/messaging";

const DEAD = new Set(["messaging/registration-token-not-registered", "messaging/invalid-registration-token", "messaging/invalid-argument"]);
const plain = (s) => String(s ?? "").replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;/g, "'").replace(/\s+/g, " ").trim();

// Send one notification to every device of each uid. Returns { sent, devices }.
export async function pushTo(db, uids, { title, body, link, tag }) {
  let sent = 0, devices = 0;
  for (const uid of new Set(uids)) {
    const snap = await db.collection(`users/${uid}/push`).get();
    const tokens = snap.docs.map(d => d.id);
    if (!tokens.length) continue;
    devices += tokens.length;
    const res = await getMessaging().sendEachForMulticast({
      tokens,
      data: { title: plain(title).slice(0, 100), body: plain(body).slice(0, 240), link: link || "/", tag: tag || "" },
      webpush: { headers: { Urgency: "high", TTL: "86400" } }
    });
    sent += res.successCount;
    await Promise.all(res.responses.map((r, i) => !r.success && DEAD.has(r.error?.code) ? snap.docs[i].ref.delete() : null));
  }
  return { sent, devices };
}
export { plain };
