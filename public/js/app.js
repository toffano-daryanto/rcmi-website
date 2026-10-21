import { initializeApp } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect, getRedirectResult,
  onAuthStateChanged, signOut
} from "https://www.gstatic.com/firebasejs/11.0.2/firebase-auth.js";
import {
  getFirestore, doc, getDoc, setDoc, updateDoc, deleteDoc, addDoc, collection, query, where,
  orderBy, limit, getDocs, onSnapshot, serverTimestamp, runTransaction, Timestamp
} from "https://www.gstatic.com/firebasejs/11.0.2/firebase-firestore.js";
import { firebaseConfig } from "./config.js";
import { t, getLang, setLang, applyStatic } from "./i18n.js";

/* ---------------- helpers ---------------- */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const memberNo = (n) => n ? `RCMI-${String(n).padStart(4, "0")}` : "—";
const locale = () => (getLang() === "id" ? "id-ID" : "en-GB");
const toDate = (ts) => (ts && ts.toDate ? ts.toDate() : ts ? new Date(ts) : null);
const fmtDate = (ts, opts) => { const d = toDate(ts); return d ? d.toLocaleDateString(locale(), opts) : ""; };
const fmtIDR = (n) => "Rp " + Number(n).toLocaleString("id-ID");
const igHandle = (s) => String(s || "").trim().replace(/^@/, "").replace(/^https?:\/\/(www\.)?instagram\.com\//, "").replace(/\/.*$/, "");
const waNumber = (s) => { let d = String(s || "").replace(/\D/g, ""); if (d.startsWith("0")) d = "62" + d.slice(1); return d; };

let toastTimer;
function toast(msg) {
  const el = $("#toast"); el.textContent = msg; el.classList.add("show");
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove("show"), 3200);
}
function fail(e) { console.error(e); toast(t("err_generic", { msg: e.code || e.message || e })); }

const modal = $("#modal");
function openModal(html) { $("#modal-body").innerHTML = html; applyStatic($("#modal-body")); modal.showModal(); }
function closeModal() { modal.close(); }
modal.addEventListener("click", (e) => { if (e.target === modal) closeModal(); });

/* Resize a photo in the browser so it fits inside a Firestore document (free Spark plan, no Storage needed). */
function compressPhoto(file, maxSide = 1000, maxChars = 280000) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
      const c = document.createElement("canvas");
      c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      for (let q = 0.8; q >= 0.4; q -= 0.1) {
        const data = c.toDataURL("image/jpeg", q);
        if (data.length <= maxChars) return resolve(data);
      }
      reject(new Error(t("err_photo")));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error(t("err_photo"))); };
    img.src = url;
  });
}
async function readPhotos(input) {
  const files = [...(input.files || [])].slice(0, 3);
  const out = [];
  for (const f of files) out.push(await compressPhoto(f));
  return out;
}
function bindPhotoPreview(form) {
  const input = form.querySelector('input[type="file"]');
  const box = form.querySelector(".thumbs");
  if (!input || !box) return;
  input.addEventListener("change", () => {
    box.innerHTML = "";
    [...input.files].slice(0, 3).forEach(f => {
      const img = document.createElement("img"); img.alt = ""; img.src = URL.createObjectURL(f); box.appendChild(img);
    });
  });
}

/* ---------------- language + scale ruler (work without Firebase) ---------------- */
$$("[data-lang]").forEach(b => b.addEventListener("click", () => { setLang(b.dataset.lang); updateRuler(); rerender(); }));

const range = $("#real-length");
function updateRuler() {
  const m = parseFloat(range.value);
  const mm = (m * 1000) / 64;
  $("#real-length-out").textContent = `${m.toFixed(2)} m`;
  $("#ruler-bar").style.width = `${Math.min(mm, 100)}%`;
  $("#ruler-out").textContent = t("ruler_result", { mm: mm.toFixed(1).replace(".", getLang() === "id" ? "," : ".") });
}
range.addEventListener("input", updateRuler);
applyStatic(); updateRuler();

/* ---------------- Firebase ---------------- */
const configured = firebaseConfig.apiKey && !firebaseConfig.apiKey.startsWith("PASTE");
if (!configured) {
  $("#setup-banner").hidden = false;
  $$("#btn-signin, .js-signin").forEach(b => b.addEventListener("click", () => toast(t("setup_missing"))));
  throw new Error("Firebase config missing — see public/js/config.js");
}

const fbApp = initializeApp(firebaseConfig);
const auth = getAuth(fbApp);
const db = getFirestore(fbApp);
const provider = new GoogleAuthProvider();
provider.setCustomParameters({ prompt: "select_account" });

async function signIn() {
  try { await signInWithPopup(auth, provider); }
  catch (e) {
    if (["auth/popup-blocked", "auth/operation-not-supported-in-environment", "auth/cancelled-popup-request"].includes(e.code)) {
      await signInWithRedirect(auth, provider);
    } else if (e.code !== "auth/popup-closed-by-user") fail(e);
  }
}
$$("#btn-signin, .js-signin").forEach(b => b.addEventListener("click", signIn));
$("#btn-signout").addEventListener("click", () => signOut(auth));
getRedirectResult(auth).catch(fail);

/* ---------------- state + screens ---------------- */
const state = { user: null, profile: null, tab: "collection", carFilter: "all", marketFilter: "all", cars: [], listings: [], events: [] };
let unsubProfile = null;

function show(screen) {
  $("#landing").hidden = screen !== "landing";
  $("#landing-nav").hidden = screen !== "landing";
  $("#gate").hidden = screen !== "gate";
  $("#app").hidden = screen !== "app";
}
function showGate(which) {
  show("gate");
  ["onboarding", "pending", "rejected"].forEach(w => { $(`#gate-${w}`).hidden = w !== which; });
}

onAuthStateChanged(auth, (user) => {
  state.user = user;
  if (unsubProfile) { unsubProfile(); unsubProfile = null; }
  $("#btn-signin").hidden = !!user;
  $("#user-chip").hidden = !user;
  if (!user) { state.profile = null; show("landing"); return; }
  $("#user-avatar").src = user.photoURL || "";

  // Live listener on the member's own record: moves them from pending to approved automatically.
  unsubProfile = onSnapshot(doc(db, "users", user.uid), (snap) => {
    if (!snap.exists()) {
      const f = $("#form-onboarding");
      if (!f.displayName.value) f.displayName.value = user.displayName || "";
      showGate("onboarding"); return;
    }
    state.profile = { id: snap.id, ...snap.data() };
    if (state.profile.status === "pending") return showGate("pending");
    if (state.profile.status === "rejected") return showGate("rejected");
    $("#tab-admin").hidden = state.profile.role !== "admin";
    $("#btn-add-event").hidden = state.profile.role !== "admin";
    show("app");
    route();
  }, fail);
});

$("#form-onboarding").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target; const u = state.user;
  try {
    await setDoc(doc(db, "users", u.uid), {
      displayName: f.displayName.value.trim(),
      email: u.email,
      photoURL: u.photoURL || "",
      city: f.city.value.trim(),
      instagram: igHandle(f.instagram.value),
      whatsapp: f.whatsapp.value.trim(),
      bio: f.bio.value.trim(),
      status: "pending",
      role: "member",
      createdAt: serverTimestamp()
    });
  } catch (err) { fail(err); }
});

/* ---------------- routing ---------------- */
const TABS = ["collection", "events", "market", "card", "admin"];
window.addEventListener("hashchange", route);
function route() {
  if (!state.profile || state.profile.status !== "approved") return;
  const h = location.hash.replace(/^#\/?/, "");
  let tab = TABS.includes(h) ? h : "collection";
  if (tab === "admin" && state.profile.role !== "admin") tab = "collection";
  state.tab = tab;
  $$(".tabs a").forEach(a => { if (a.dataset.tab === tab) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current"); });
  TABS.forEach(n => { $(`#view-${n}`).hidden = n !== tab; });
  ({ collection: loadCars, events: loadEvents, market: loadListings, card: renderCard, admin: loadAdmin })[tab]();
}
function rerender() {
  if ($("#app").hidden) return;
  ({ collection: renderCars, events: renderEvents, market: renderListings, card: renderCard, admin: loadAdmin })[state.tab]();
}
const isAdmin = () => state.profile?.role === "admin";
const canEdit = (ownerUid) => ownerUid === state.user?.uid || isAdmin();

/* ================= Collection ================= */
async function loadCars() {
  try {
    const snap = await getDocs(query(collection(db, "cars"), orderBy("createdAt", "desc"), limit(120)));
    state.cars = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderCars();
  } catch (e) { fail(e); }
}
function renderCars() {
  const list = state.carFilter === "mine" ? state.cars.filter(c => c.ownerUid === state.user.uid) : state.cars;
  $("#cars").innerHTML = list.length ? list.map(c => `
    <button type="button" class="item" data-car="${esc(c.id)}">
      ${c.photos?.[0] ? `<img class="ph" src="${c.photos[0]}" alt="" loading="lazy">` : `<div class="ph ph-empty">1:64</div>`}
      <div class="meta"><h3>${esc(c.name)}</h3><p>${esc(c.maker || "")}${c.maker ? " · " : ""}${t("by")} ${esc(c.ownerName)}</p></div>
    </button>`).join("") : `<p class="empty">${t("empty_collection")}</p>`;
}
$$("[data-filter]").forEach(b => b.addEventListener("click", () => {
  state.carFilter = b.dataset.filter;
  $$("[data-filter]").forEach(x => x.setAttribute("aria-pressed", String(x === b)));
  renderCars();
}));
$("#cars").addEventListener("click", (e) => {
  const el = e.target.closest("[data-car]"); if (!el) return;
  const c = state.cars.find(x => x.id === el.dataset.car); if (!c) return;
  openModal(`
    ${c.photos?.length ? `<div class="detail-photos">${c.photos.map(p => `<img src="${p}" alt="">`).join("")}</div>` : ""}
    <h2>${esc(c.name)}</h2>
    ${c.maker ? `<p><strong>${t("car_maker")}:</strong> ${esc(c.maker)}</p>` : ""}
    ${c.notes ? `<p>${esc(c.notes)}</p>` : ""}
    <p class="muted">${t("by")} ${esc(c.ownerName)} · ${fmtDate(c.createdAt, { day: "numeric", month: "short", year: "numeric" })}</p>
    <div class="form-actions">
      ${canEdit(c.ownerUid) ? `<button class="btn btn-danger" data-act="del">${t("delete")}</button>` : ""}
      <button class="btn btn-ghost" data-act="close">${t("cancel")}</button>
    </div>`);
  $("#modal-body").onclick = async (ev) => {
    const act = ev.target.dataset.act;
    if (act === "close") closeModal();
    if (act === "del" && confirm(t("confirm_delete"))) {
      try { await deleteDoc(doc(db, "cars", c.id)); closeModal(); toast(t("deleted")); loadCars(); } catch (e2) { fail(e2); }
    }
  };
});
$("#btn-add-car").addEventListener("click", () => {
  openModal(`
    <h2>${t("add_car")}</h2>
    <form class="form" id="f-car">
      <label><span>${t("car_name")}</span><input name="name" required maxlength="100" placeholder="Toyota Celica GT-Four ST185"></label>
      <label><span>${t("car_maker")}</span><input name="maker" maxlength="80"></label>
      <label><span>${t("car_notes")}</span><textarea name="notes" rows="3" maxlength="600"></textarea></label>
      <label><span>${t("photos")}</span><input type="file" name="photos" accept="image/*" multiple></label>
      <div class="thumbs"></div>
      <div class="form-actions">
        <button type="button" class="btn btn-ghost" data-act="close">${t("cancel")}</button>
        <button class="btn btn-mat" type="submit">${t("save")}</button>
      </div>
    </form>`);
  const f = $("#f-car"); bindPhotoPreview(f);
  $("#modal-body").onclick = (ev) => { if (ev.target.dataset.act === "close") closeModal(); };
  f.addEventListener("submit", async (e) => {
    e.preventDefault(); const btn = f.querySelector('[type="submit"]'); btn.disabled = true;
    try {
      const photos = await readPhotos(f.photos);
      await addDoc(collection(db, "cars"), {
        name: f.name.value.trim(), maker: f.maker.value.trim(), notes: f.notes.value.trim(), photos,
        ownerUid: state.user.uid, ownerName: state.profile.displayName, createdAt: serverTimestamp()
      });
      closeModal(); toast(t("saved")); loadCars();
    } catch (err) { fail(err); btn.disabled = false; }
  });
});

/* ================= Events ================= */
async function loadEvents() {
  try {
    const snap = await getDocs(query(collection(db, "events"), orderBy("date", "asc"), limit(100)));
    state.events = await Promise.all(snap.docs.map(async d => {
      const r = await getDocs(collection(db, "events", d.id, "rsvps"));
      return { id: d.id, ...d.data(), rsvps: r.docs.map(x => ({ uid: x.id, ...x.data() })) };
    }));
    renderEvents();
  } catch (e) { fail(e); }
}
function eventHTML(ev, upcoming) {
  const d = toDate(ev.date);
  const going = ev.rsvps.some(r => r.uid === state.user.uid);
  const names = ev.rsvps.map(r => esc(r.name)).slice(0, 8).join(", ");
  return `<article class="event">
    <div class="event-date"><b>${d ? d.getDate() : ""}</b><span>${fmtDate(ev.date, { month: "short", year: "2-digit" })}</span></div>
    <div>
      <h3>${esc(ev.title)}</h3>
      <p>${d ? d.toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit" }) : ""} · ${esc(ev.place)}</p>
      ${ev.description ? `<p>${esc(ev.description)}</p>` : ""}
      <p class="who"><strong>${t("attending", { n: ev.rsvps.length })}</strong>${names ? ` — ${names}` : ""}</p>
    </div>
    <div class="event-act">
      ${upcoming ? `<button class="btn btn-sm ${going ? "btn-ghost" : "btn-mat"}" data-rsvp="${esc(ev.id)}" data-going="${going}">${going ? t("not_going") : t("going")}</button>` : ""}
      ${isAdmin() ? `<button class="btn btn-sm btn-danger" data-delev="${esc(ev.id)}">${t("delete")}</button>` : ""}
    </div>
  </article>`;
}
function renderEvents() {
  const now = Date.now();
  const up = state.events.filter(e => toDate(e.date)?.getTime() >= now - 6 * 3600e3);
  const past = state.events.filter(e => !up.includes(e)).reverse();
  $("#events-upcoming").innerHTML = up.length ? up.map(e => eventHTML(e, true)).join("") : `<p class="empty">${t("empty_events")}</p>`;
  $("#events-past").innerHTML = past.map(e => eventHTML(e, false)).join("");
  $(".past").hidden = !past.length;
}
$("#view-events").addEventListener("click", async (e) => {
  const r = e.target.closest("[data-rsvp]"); const del = e.target.closest("[data-delev]");
  try {
    if (r) {
      r.disabled = true;
      const ref = doc(db, "events", r.dataset.rsvp, "rsvps", state.user.uid);
      if (r.dataset.going === "true") await deleteDoc(ref);
      else await setDoc(ref, { name: state.profile.displayName, at: serverTimestamp() });
      loadEvents();
    }
    if (del && confirm(t("confirm_delete"))) { await deleteDoc(doc(db, "events", del.dataset.delev)); toast(t("deleted")); loadEvents(); }
  } catch (err) { fail(err); }
});
$("#btn-add-event").addEventListener("click", () => {
  openModal(`
    <h2>${t("add_event")}</h2>
    <form class="form" id="f-ev">
      <label><span>${t("ev_title")}</span><input name="title" required maxlength="120"></label>
      <div class="row2">
        <label><span>${t("ev_date")}</span><input name="date" type="datetime-local" required></label>
        <label><span>${t("ev_place")}</span><input name="place" required maxlength="120"></label>
      </div>
      <label><span>${t("ev_desc")}</span><textarea name="description" rows="3" maxlength="800"></textarea></label>
      <div class="form-actions">
        <button type="button" class="btn btn-ghost" data-act="close">${t("cancel")}</button>
        <button class="btn btn-mat" type="submit">${t("save")}</button>
      </div>
    </form>`);
  const f = $("#f-ev");
  $("#modal-body").onclick = (ev) => { if (ev.target.dataset.act === "close") closeModal(); };
  f.addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      await addDoc(collection(db, "events"), {
        title: f.title.value.trim(), place: f.place.value.trim(), description: f.description.value.trim(),
        date: Timestamp.fromDate(new Date(f.date.value)), createdBy: state.user.uid, createdAt: serverTimestamp()
      });
      closeModal(); toast(t("saved")); loadEvents();
    } catch (err) { fail(err); }
  });
});

/* ================= Marketplace ================= */
async function loadListings() {
  try {
    const snap = await getDocs(query(collection(db, "listings"), orderBy("createdAt", "desc"), limit(120)));
    state.listings = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderListings();
  } catch (e) { fail(e); }
}
const typeLabel = (ty) => t({ sell: "t_sell", trade: "t_trade", wanted: "t_wanted" }[ty] || "t_sell");
function renderListings() {
  const f = state.marketFilter;
  const list = f === "all" ? state.listings : state.listings.filter(l => l.type === f);
  $("#listings").innerHTML = list.length ? list.map(l => `
    <button type="button" class="item" data-listing="${esc(l.id)}">
      ${l.photos?.[0] ? `<img class="ph" src="${l.photos[0]}" alt="" loading="lazy">` : `<div class="ph ph-empty">1:64</div>`}
      <div class="meta">
        <span class="tag ${l.status === "sold" ? "tag-sold" : "tag-" + esc(l.type)}">${l.status === "sold" ? t("sold") : typeLabel(l.type)}</span>
        <h3>${esc(l.title)}</h3>
        <p>${l.price ? `<span class="price">${fmtIDR(l.price)}</span> · ` : ""}${esc(l.ownerName)}</p>
      </div>
    </button>`).join("") : `<p class="empty">${t("empty_market")}</p>`;
}
$$("[data-mfilter]").forEach(b => b.addEventListener("click", () => {
  state.marketFilter = b.dataset.mfilter;
  $$("[data-mfilter]").forEach(x => x.setAttribute("aria-pressed", String(x === b)));
  renderListings();
}));
$("#listings").addEventListener("click", (e) => {
  const el = e.target.closest("[data-listing]"); if (!el) return;
  const l = state.listings.find(x => x.id === el.dataset.listing); if (!l) return;
  const ig = igHandle(l.ownerInstagram); const wa = waNumber(l.ownerWhatsapp);
  openModal(`
    ${l.photos?.length ? `<div class="detail-photos">${l.photos.map(p => `<img src="${p}" alt="">`).join("")}</div>` : ""}
    <span class="tag tag-${esc(l.type)}">${typeLabel(l.type)}</span>
    <h2>${esc(l.title)}</h2>
    ${l.price ? `<p class="price">${fmtIDR(l.price)}</p>` : ""}
    ${l.condition ? `<p><strong>${t("l_condition")}:</strong> ${esc(l.condition)}</p>` : ""}
    ${l.description ? `<p>${esc(l.description)}</p>` : ""}
    <p class="muted">${esc(l.ownerName)} · ${fmtDate(l.createdAt, { day: "numeric", month: "short" })}</p>
    <div class="form-actions">
      ${ig ? `<a class="btn btn-ghost" target="_blank" rel="noopener" href="https://instagram.com/${encodeURIComponent(ig)}">Instagram</a>` : ""}
      ${wa ? `<a class="btn btn-mat" target="_blank" rel="noopener" href="https://wa.me/${wa}">${t("contact")} WhatsApp</a>` : ""}
      ${canEdit(l.ownerUid) && l.status !== "sold" ? `<button class="btn btn-ghost" data-act="sold">${t("mark_sold")}</button>` : ""}
      ${canEdit(l.ownerUid) ? `<button class="btn btn-danger" data-act="del">${t("delete")}</button>` : ""}
    </div>`);
  $("#modal-body").onclick = async (ev) => {
    const act = ev.target.dataset.act;
    try {
      if (act === "sold") { await updateDoc(doc(db, "listings", l.id), { status: "sold" }); closeModal(); toast(t("saved")); loadListings(); }
      if (act === "del" && confirm(t("confirm_delete"))) { await deleteDoc(doc(db, "listings", l.id)); closeModal(); toast(t("deleted")); loadListings(); }
    } catch (e2) { fail(e2); }
  };
});
$("#btn-add-listing").addEventListener("click", () => {
  openModal(`
    <h2>${t("add_listing")}</h2>
    <form class="form" id="f-l">
      <div class="row2">
        <label><span>${t("l_type")}</span>
          <select name="type"><option value="sell">${t("t_sell")}</option><option value="trade">${t("t_trade")}</option><option value="wanted">${t("t_wanted")}</option></select>
        </label>
        <label><span>${t("l_price")}</span><input name="price" type="number" min="0" step="1000" inputmode="numeric"></label>
      </div>
      <label><span>${t("l_title")}</span><input name="title" required maxlength="100"></label>
      <label><span>${t("l_condition")}</span><input name="condition" maxlength="80"></label>
      <label><span>${t("l_desc")}</span><textarea name="description" rows="3" maxlength="800"></textarea></label>
      <label><span>${t("photos")}</span><input type="file" name="photos" accept="image/*" multiple></label>
      <div class="thumbs"></div>
      <div class="form-actions">
        <button type="button" class="btn btn-ghost" data-act="close">${t("cancel")}</button>
        <button class="btn btn-mat" type="submit">${t("save")}</button>
      </div>
    </form>`);
  const f = $("#f-l"); bindPhotoPreview(f);
  $("#modal-body").onclick = (ev) => { if (ev.target.dataset.act === "close") closeModal(); };
  f.addEventListener("submit", async (e) => {
    e.preventDefault(); const btn = f.querySelector('[type="submit"]'); btn.disabled = true;
    try {
      const photos = await readPhotos(f.photos);
      await addDoc(collection(db, "listings"), {
        type: f.type.value, title: f.title.value.trim(), price: f.price.value ? Number(f.price.value) : null,
        condition: f.condition.value.trim(), description: f.description.value.trim(), photos, status: "open",
        ownerUid: state.user.uid, ownerName: state.profile.displayName,
        ownerInstagram: state.profile.instagram || "", ownerWhatsapp: state.profile.whatsapp || "",
        createdAt: serverTimestamp()
      });
      closeModal(); toast(t("saved")); loadListings();
    } catch (err) { fail(err); btn.disabled = false; }
  });
});

/* ================= Member card + profile ================= */
function renderCard() {
  const p = state.profile;
  $("#member-card").innerHTML = `
    <div class="mcard">
      <div class="mcard-top">
        <div><span class="wm-main">RCMI</span><div class="mcard-sub">Resin Car Model Indonesia · 1:64</div></div>
        ${p.photoURL ? `<img src="${esc(p.photoURL)}" alt="" referrerpolicy="no-referrer">` : ""}
      </div>
      <div>
        <div class="mcard-no">${memberNo(p.memberNo)}</div>
        <div class="mcard-name">${esc(p.displayName)}</div>
        <div class="mcard-sub">${esc(p.city)}${p.instagram ? " · @" + esc(igHandle(p.instagram)) : ""} · ${t("card_since")} ${fmtDate(p.approvedAt || p.createdAt, { month: "short", year: "numeric" })}</div>
      </div>
    </div>`;
  const f = $("#form-profile");
  ["displayName", "city", "instagram", "whatsapp", "bio"].forEach(k => { if (document.activeElement !== f[k]) f[k].value = p[k] || ""; });
}
$("#form-profile").addEventListener("submit", async (e) => {
  e.preventDefault(); const f = e.target;
  try {
    await updateDoc(doc(db, "users", state.user.uid), {
      displayName: f.displayName.value.trim(), city: f.city.value.trim(), instagram: igHandle(f.instagram.value),
      whatsapp: f.whatsapp.value.trim(), bio: f.bio.value.trim(), updatedAt: serverTimestamp()
    });
    toast(t("profile_saved"));
  } catch (err) { fail(err); }
});

/* ================= Admin ================= */
async function loadAdmin() {
  if (!isAdmin()) return;
  try {
    const [pend, mem] = await Promise.all([
      getDocs(query(collection(db, "users"), where("status", "==", "pending"))),
      getDocs(query(collection(db, "users"), where("status", "==", "approved")))
    ]);
    const pending = pend.docs.map(d => ({ id: d.id, ...d.data() }));
    const members = state.members = mem.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (a.memberNo || 0) - (b.memberNo || 0));
    $("#admin-pending").innerHTML = pending.length ? pending.map(u => `
      <div class="row">
        <img src="${esc(u.photoURL)}" alt="" referrerpolicy="no-referrer">
        <div class="grow"><strong>${esc(u.displayName)}</strong>
          <small>${esc(u.city)} · ${u.instagram ? "@" + esc(u.instagram) : ""} · ${esc(u.email)}</small>
          ${u.bio ? `<small>${esc(u.bio)}</small>` : ""}</div>
        <div class="actions">
          <button class="btn btn-sm btn-mat" data-approve="${esc(u.id)}">${t("approve")}</button>
          <button class="btn btn-sm btn-danger" data-reject="${esc(u.id)}">${t("reject")}</button>
        </div>
      </div>`).join("") : `<p class="muted">${t("no_pending")}</p>`;
    $("#admin-members").innerHTML = members.map(u => `
      <div class="row">
        <img src="${esc(u.photoURL)}" alt="" referrerpolicy="no-referrer">
        <div class="grow"><strong>${memberNo(u.memberNo)} · ${esc(u.displayName)}</strong>
          <small>${esc(u.city)} · ${u.instagram ? "@" + esc(u.instagram) : ""}${u.role === "admin" ? " · admin" : ""}</small></div>
        ${u.role !== "admin" ? `<div class="actions"><button class="btn btn-sm btn-ghost" data-mkadmin="${esc(u.id)}">${t("make_admin")}</button></div>` : ""}
      </div>`).join("");
  } catch (e) { fail(e); }
}
$("#view-admin").addEventListener("click", async (e) => {
  const a = e.target.closest("[data-approve]"), r = e.target.closest("[data-reject]"), m = e.target.closest("[data-mkadmin]");
  try {
    if (a) {
      a.disabled = true;
      const no = await runTransaction(db, async (tx) => {
        const cRef = doc(db, "counters", "members");
        const c = await tx.get(cRef);
        const next = c.exists() ? c.data().next : Math.max(0, ...(state.members || []).map(u => u.memberNo || 0)) + 1;
        tx.set(cRef, { next: next + 1 });
        tx.update(doc(db, "users", a.dataset.approve), { status: "approved", memberNo: next, approvedAt: serverTimestamp() });
        return next;
      });
      toast(t("approved_msg", { no: memberNo(no) })); loadAdmin();
    }
    if (r && confirm(`${t("reject")}?`)) { await updateDoc(doc(db, "users", r.dataset.reject), { status: "rejected" }); loadAdmin(); }
    if (m) { await updateDoc(doc(db, "users", m.dataset.mkadmin), { role: "admin" }); toast(t("saved")); loadAdmin(); }
  } catch (err) { fail(err); }
});
