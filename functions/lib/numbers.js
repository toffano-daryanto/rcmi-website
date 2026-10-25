// Associate Members get their number (A-0001, A-0002, …) as soon as their account is active,
// even if they never open their card. Same counter as the website (counters/general), in a transaction,
// so two sign-ups at once never get the same number and nobody gets two.
export async function giveGeneralNo(db, uid) {
  return db.runTransaction(async (tx) => {
    const uref = db.doc(`users/${uid}`), cref = db.doc("counters/general");
    const [u, c] = await Promise.all([tx.get(uref), tx.get(cref)]);
    const d = u.data();
    if (!d || d.accountType !== "general" || d.status !== "approved" || d.generalNo) return null;
    const next = (c.data()?.seq || 0) + 1;
    tx.set(cref, { seq: next }, { merge: true }); tx.update(uref, { generalNo: next });
    return next;
  });
}
// Sweep: anyone active without a number yet (run by the 5-minute schedule).
export async function giveMissingGeneralNos(db) {
  const snap = await db.collection("users").where("accountType", "==", "general").where("status", "==", "approved").get();
  const missing = snap.docs.filter(d => !d.data().generalNo).sort((a, b) => (a.data().approvedAt?.toMillis?.() || a.data().createdAt?.toMillis?.() || 0) - (b.data().approvedAt?.toMillis?.() || b.data().createdAt?.toMillis?.() || 0));
  let n = 0;
  for (const d of missing) if (await giveGeneralNo(db, d.id)) n++;
  return `${n} associate number(s) given`;
}
