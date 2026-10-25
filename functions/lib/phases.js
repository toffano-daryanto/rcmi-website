// Moves contests through their phases on the dates set by the admin (only contests with autoPhases on):
//   draft  → open     at opensAt   (registration opens)
//   open   → voting   at submitEnd (registration closes; everyone with a photo is told voting is open)
//   voting → judging  at voteEnd   (public voting closes; the jury finishes)
// Announcing the winners stays a manual step for the admin (they check the results first).
import { FieldValue } from "firebase-admin/firestore";
const ms = (x) => x?.toMillis ? x.toMillis() : 0;

export async function autoPhases(db) {
  const now = Date.now(), out = [];
  const snap = await db.collection("contests").where("autoPhases", "==", true).get();
  for (const d of snap.docs) {
    const c = d.data();
    if (c.status === "draft" && ms(c.opensAt) && ms(c.opensAt) <= now) {
      await d.ref.update({ status: "open", public: true, openAt: FieldValue.serverTimestamp() });
      out.push(`${d.id}: registration opened`);
    } else if (c.status === "open" && ms(c.submitEnd) && ms(c.submitEnd) <= now) {
      await d.ref.update({ status: "voting", public: true, votingAt: FieldValue.serverTimestamp() });
      const entries = await d.ref.collection("entries").get();
      const uids = [...new Set(entries.docs.map(e => e.data()).filter(e => e.photo && (e.status || "ok") === "ok").map(e => e.uid))];
      for (let i = 0; i < uids.length; i += 400) {
        const b = db.batch();
        uids.slice(i, i + 400).forEach(u => b.set(db.collection("notices").doc(), { uid: u, kind: "contest_voting", target: "contest", postId: d.id, title: String(c.title || "").slice(0, 100), note: "", at: FieldValue.serverTimestamp(), read: false }));
        await b.commit();
      }
      out.push(`${d.id}: voting started (${uids.length} told)`);
    } else if (c.status === "voting" && ms(c.voteEnd) && ms(c.voteEnd) <= now) {
      await d.ref.update({ status: "judging", public: true, judgingAt: FieldValue.serverTimestamp() });
      out.push(`${d.id}: voting closed, judging`);
    }
  }
  return out.join("; ") || "no phase changes";
}
