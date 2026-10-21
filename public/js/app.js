import { initializeApp } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect, getRedirectResult,
  onAuthStateChanged, signOut
} from "https://www.gstatic.com/firebasejs/11.0.2/firebase-auth.js";
import {
  getFirestore, doc, getDoc, setDoc, updateDoc, deleteDoc, addDoc, collection, query, where,
  orderBy, limit, getDocs, onSnapshot, serverTimestamp, runTransaction, Timestamp, writeBatch
} from "https://www.gstatic.com/firebasejs/11.0.2/firebase-firestore.js";
import { firebaseConfig } from "./config.js";
import { t, getLang, setLang, applyStatic } from "./i18n.js";
import { GALLERY } from "./gallery-data.js";
import { SEED_EVENTS } from "./seed-events.js";

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
$$("[data-lang]").forEach(b => b.addEventListener("click", () => { setLang(b.dataset.lang); updateRuler(); renderGallery(); rerender(); }));

const range = $("#real-length");
function updateRuler() {
  const m = parseFloat(range.value);
  const mm = (m * 1000) / 64;
  $("#real-length-out").textContent = `${m.toFixed(2)} m`;
  $("#ruler-bar").style.width = `${Math.min(mm, 100)}%`;
  $("#ruler-out").textContent = t("ruler_result", { mm: mm.toFixed(1).replace(".", getLang() === "id" ? "," : ".") });
}
range.addEventListener("input", updateRuler);

/* ---------------- gallery (public, served from Google Drive) ---------------- */
const driveThumb = (id, w) => `https://drive.google.com/thumbnail?id=${encodeURIComponent(id)}&sz=w${w}`;
const GALLERY_PREVIEW = 12;
const galleryOpen = new Set();
function renderGallery() {
  const box = $("#gallery-groups"); if (!box) return;
  const lang = getLang();
  box.innerHTML = GALLERY.map(g => {
    const photos = g.items.filter(i => i.kind === "photo").length, videos = g.items.length - photos;
    const counts = [photos ? t("count_photos", { n: photos }) : "", videos ? t("count_videos", { n: videos }) : ""].filter(Boolean).join(", ");
    const expanded = galleryOpen.has(g.key);
    const shown = expanded ? g.items : g.items.slice(0, GALLERY_PREVIEW);
    return `<section class="g-group">
      <div class="g-head"><h3>${esc(g.title[lang] || g.title.id)}</h3><small>${counts}</small></div>
      <div class="g-grid">${shown.map((it, i) => `
        <button type="button" class="g-tile" data-g="${g.key}" data-i="${i}" aria-label="${it.kind === "video" ? "Video" : "Foto"} ${i + 1}">
          <img src="${driveThumb(it.id, 400)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.parentNode.classList.add('broken')">
          ${it.kind === "video" ? '<span class="g-play" aria-hidden="true"></span>' : ""}
        </button>`).join("")}</div>
      ${g.items.length > GALLERY_PREVIEW ? `<button type="button" class="btn btn-ghost g-more" data-more="${g.key}">${expanded ? t("show_less") : t("show_all", { n: g.items.length })}</button>` : ""}
    </section>`;
  }).join("");
}
const lb = $("#lightbox");
const lbState = { group: null, i: 0 };
function lbShow() {
  const g = GALLERY.find(x => x.key === lbState.group); if (!g) return;
  const it = g.items[lbState.i];
  $("#lb-stage").innerHTML = it.kind === "video"
    ? `<iframe src="https://drive.google.com/file/d/${encodeURIComponent(it.id)}/preview" allow="autoplay; fullscreen" allowfullscreen title="Video"></iframe>`
    : `<img src="${driveThumb(it.id, 1600)}" alt="" referrerpolicy="no-referrer">`;
  $("#lb-count").textContent = `${lbState.i + 1} / ${g.items.length}`;
  $("#lb-drive").href = `https://drive.google.com/file/d/${encodeURIComponent(it.id)}/view`;
  $("#lb-prev").disabled = lbState.i === 0;
  $("#lb-next").disabled = lbState.i === g.items.length - 1;
}
$("#gallery-groups").addEventListener("click", (e) => {
  const more = e.target.closest("[data-more]");
  if (more) { const k = more.dataset.more; galleryOpen.has(k) ? galleryOpen.delete(k) : galleryOpen.add(k); renderGallery(); return; }
  const tile = e.target.closest(".g-tile"); if (!tile) return;
  lbState.group = tile.dataset.g; lbState.i = Number(tile.dataset.i); lbShow(); lb.showModal();
});
const lbStep = (d) => { const g = GALLERY.find(x => x.key === lbState.group); const n = lbState.i + d; if (g && n >= 0 && n < g.items.length) { lbState.i = n; lbShow(); } };
$("#lb-prev").addEventListener("click", () => lbStep(-1));
$("#lb-next").addEventListener("click", () => lbStep(1));
$("#lb-close").addEventListener("click", () => lb.close());
lb.addEventListener("close", () => { $("#lb-stage").innerHTML = ""; });
lb.addEventListener("keydown", (e) => { if (e.key === "ArrowLeft") lbStep(-1); if (e.key === "ArrowRight") lbStep(1); });
lb.addEventListener("click", (e) => { if (e.target === lb) lb.close(); });

// Photo strip under the hero: the first photos from the most recent event. Hidden until they load.
function renderPitlane() {
  const g = GALLERY[0]; const track = $("#pitlane-track"); if (!g || !track) return;
  const shots = g.items.map((it, i) => ({ ...it, i })).filter(it => it.kind === "photo").slice(1, 11);
  let loaded = 0;
  track.innerHTML = shots.map(it => `<button type="button" data-g="${g.key}" data-i="${it.i}" aria-label="Foto ${it.i + 1}"><img src="${driveThumb(it.id, 640)}" alt="" loading="lazy" referrerpolicy="no-referrer"></button>`).join("");
  track.querySelectorAll("img").forEach(img => {
    img.addEventListener("load", () => { loaded++; $("#pitlane").hidden = false; });
    img.addEventListener("error", () => img.parentNode.remove());
  });
}
$("#pitlane-track").addEventListener("click", (e) => {
  const b = e.target.closest("[data-g]"); if (!b) return;
  lbState.group = b.dataset.g; lbState.i = Number(b.dataset.i); lbShow(); lb.showModal();
});

applyStatic(); updateRuler(); renderGallery(); renderPitlane();

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
const state = { user: null, profile: null, tab: "collection", sub: "", carFilter: "all", marketFilter: "all", cars: [], listings: [], events: [], roster: null, rosterPrivate: {}, siteUsers: {}, memberSearch: "" };
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
  $("#user-avatar").hidden = !user.photoURL;

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
const TABS = ["collection", "events", "market", "members", "dues", "card", "admin"];
window.addEventListener("hashchange", route);
function route() {
  if (!state.profile || state.profile.status !== "approved") return;
  const [h, sub = ""] = location.hash.replace(/^#\/?/, "").split("/");
  let tab = TABS.includes(h) ? h : "collection";
  state.sub = decodeURIComponent(sub);
  if (tab === "admin" && state.profile.role !== "admin") tab = "collection";
  state.tab = tab;
  $$(".tabs a").forEach(a => { if (a.dataset.tab === tab) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current"); });
  TABS.forEach(n => { $(`#view-${n}`).hidden = n !== tab; });
  ({ collection: loadCars, events: loadEvents, market: loadListings, members: loadMembers, dues: loadDues, card: () => fetchRoster().catch(() => {}).then(renderCard), admin: loadAdmin })[tab]();
}
function rerender() {
  if ($("#app").hidden) return;
  ({ collection: renderCars, events: renderEvents, market: renderListings, members: showMembers, dues: renderDues, card: renderCard, admin: loadAdmin })[state.tab]();
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
      <p>${ev.dateLabel ? esc(ev.dateLabel[getLang()] || ev.dateLabel.id) : ev.allDay ? fmtDate(ev.date, { day: "numeric", month: "long", year: "numeric" }) : d ? d.toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit" }) : ""}${ev.place ? " · " + esc(ev.place) : ""}</p>
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
  const up = state.events.filter(e => toDate(e.date)?.getTime() >= now - (e.allDay ? 2 * 86400e3 : 6 * 3600e3));
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

/* ================= Members (roster from the Google Form + people who joined on the site) ================= */
const initials = (n) => String(n || "").split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join("");
const norm = (x) => String(x || "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
async function fetchRoster(force = false) {
  if (state.roster && !force) return;
  const [rs, us] = await Promise.all([
    getDocs(collection(db, "roster")),
    getDocs(query(collection(db, "users"), where("status", "==", "approved")))
  ]);
  state.siteUsers = Object.fromEntries(us.docs.map(d => [d.id, { id: d.id, ...d.data() }]));
  const roster = rs.docs.map(d => ({ id: d.id, ...d.data() }));
  // Members who joined on the site without a roster record still get a profile.
  const linked = new Set(roster.map(r => r.claimedBy).filter(Boolean));
  Object.values(state.siteUsers).forEach(u => {
    if (!linked.has(u.id)) roster.push({ id: "u-" + u.id, memberNo: u.memberNo || null, name: u.displayName, city: u.city, province: "", status: "member", claimedBy: u.id, joined: "" });
  });
  roster.sort((a, b) => (a.memberNo ?? 1e9) - (b.memberNo ?? 1e9) || String(a.name).localeCompare(b.name));
  state.roster = roster;
  if (isAdmin()) {
    const ps = await getDocs(collection(db, "rosterPrivate"));
    state.rosterPrivate = Object.fromEntries(ps.docs.map(d => [d.id, d.data()]));
  }
}
async function loadMembers() {
  try { await fetchRoster(); showMembers(); } catch (e) { fail(e); }
}
function showMembers() {
  const id = state.sub;
  $("#members-list").hidden = !!id;
  $("#member-profile").hidden = !id;
  if (id) renderProfile(id); else renderRoster();
}
function renderRoster() {
  const q = norm(state.memberSearch);
  const list = (state.roster || [])
    .filter(r => isAdmin() || r.status !== "applicant")
    .filter(r => !q || norm(`${r.name} ${r.city} ${r.province} ${r.memberNo ?? ""}`).includes(q));
  $("#roster").innerHTML = list.map(r => {
    const u = r.claimedBy && state.siteUsers[r.claimedBy];
    const place = [u?.city || r.city, r.province].filter(Boolean).join(", ");
    return `<button type="button" class="r-item ${r.status === "applicant" ? "r-applicant" : ""}" data-member="${esc(r.id)}">
      <span class="r-no">${u?.photoURL ? `<img src="${esc(u.photoURL)}" alt="" referrerpolicy="no-referrer">` : r.memberNo ? "#" + r.memberNo : esc(initials(r.name))}</span>
      <span><strong>${esc(u?.displayName || r.name)}</strong>
        <small>${r.memberNo ? memberNo(r.memberNo) : esc(t("applicant"))} · ${esc(place || "—")}</small>
        ${u ? `<small class="r-on">✓ ${t("on_site")}</small>` : ""}</span>
    </button>`;
  }).join("") || `<p class="empty">—</p>`;
}
$("#member-search").addEventListener("input", (e) => { state.memberSearch = e.target.value; renderRoster(); });
$("#roster").addEventListener("click", (e) => {
  const b = e.target.closest("[data-member]"); if (b) location.hash = `#/members/${encodeURIComponent(b.dataset.member)}`;
});

async function renderProfile(id) {
  const box = $("#member-profile");
  const r = (state.roster || []).find(x => x.id === id);
  if (!r || (r.status === "applicant" && !isAdmin())) {
    box.innerHTML = `<a class="btn btn-ghost profile-back" href="#/members">← ${t("back_members")}</a><p class="empty">${t("member_not_found")}</p>`;
    return;
  }
  const u = r.claimedBy ? state.siteUsers[r.claimedBy] : null;
  const name = u?.displayName || r.name;
  const city = u?.city || r.city;
  const place = [city, r.province].filter(Boolean).join(", ");
  const since = r.joined ? new Date(r.joined) : (u?.approvedAt || u?.createdAt);
  const ig = igHandle(u?.instagram), wa = waNumber(u?.whatsapp);
  const priv = isAdmin() ? state.rosterPrivate[r.id] : null;
  box.innerHTML = `
    <a class="btn btn-ghost profile-back" href="#/members">← ${t("back_members")}</a>
    <div class="profile">
      <div>${cardHTML({ no: r.memberNo, name, city, instagram: u?.instagram, photoURL: u?.photoURL, since })}</div>
      <div>
        <h1>${esc(name)}</h1>
        ${u?.bio ? `<p class="bio">${esc(u.bio)}</p>` : ""}
        <dl>
          ${r.memberNo ? `<dt>${t("card_member")}</dt><dd>${memberNo(r.memberNo)}</dd>` : ""}
          ${place ? `<dt>${t("f_city")}</dt><dd>${esc(place)}</dd>` : ""}
          ${since ? `<dt>${t("registered")}</dt><dd>${fmtDate(since, { day: "numeric", month: "long", year: "numeric" })}</dd>` : ""}
          ${ig ? `<dt>Instagram</dt><dd><a href="https://instagram.com/${encodeURIComponent(ig)}" target="_blank" rel="noopener">@${esc(ig)}</a></dd>` : ""}
          ${wa ? `<dt>WhatsApp</dt><dd><a href="https://wa.me/${wa}" target="_blank" rel="noopener">${esc(u.whatsapp)}</a></dd>` : ""}
          <dt>Status</dt><dd>${u ? "✓ " + t("on_site") : t("not_on_site")}</dd>
        </dl>
        ${priv ? `<div class="admin-box"><small>${t("admin_only")}</small>
          ${priv.phone ? `${t("phone")}: <a href="https://wa.me/${waNumber(priv.phone)}" target="_blank" rel="noopener">${esc(priv.phone)}</a><br>` : ""}
          ${priv.shirtSize ? `${t("shirt")}: ${esc(priv.shirtSize)} × ${priv.shirtQty || 1} — ${priv.shirtPaid ? t("paid") : t("unpaid")}<br>` : ""}
          <span id="profile-dues"></span>
        </div>` : ""}
        <div id="profile-extra"></div>
      </div>
    </div>`;
  if (isAdmin() && r.memberNo) {
    loadPaySettings().then(() => getDoc(doc(db, "dues", `${r.id}_${ym()}`))).then(snap => {
      const el = $("#profile-dues"); if (!el || state.sub !== id) return;
      const st = dueStatus(ym(), r.joined ? r.joined.slice(0, 7) : "", snap.exists() ? snap.data() : null);
      el.innerHTML = `${t("dues_status_admin")}: ${chip(st)}`;
    }).catch(() => {});
  }
  if (!u) return;
  try {
    const [cs, ls] = await Promise.all([
      getDocs(query(collection(db, "cars"), where("ownerUid", "==", u.id))),
      getDocs(query(collection(db, "listings"), where("ownerUid", "==", u.id)))
    ]);
    if (state.sub !== id) return;
    const cars = cs.docs.map(d => ({ id: d.id, ...d.data() }));
    const listings = ls.docs.map(d => ({ id: d.id, ...d.data() })).filter(l => l.status !== "sold");
    const tile = (x, title) => `<div class="item">${x.photos?.[0] ? `<img class="ph" src="${x.photos[0]}" alt="" loading="lazy">` : `<div class="ph ph-empty">1:64</div>`}<div class="meta"><h3>${esc(title)}</h3>${x.price ? `<p class="price">${fmtIDR(x.price)}</p>` : x.maker ? `<p>${esc(x.maker)}</p>` : ""}</div></div>`;
    $("#profile-extra").innerHTML = `
      <h2>${t("their_cars")}</h2>
      ${cars.length ? `<div class="mini-grid">${cars.map(c => tile(c, c.name)).join("")}</div>` : `<p class="muted">${t("no_cars_yet")}</p>`}
      ${listings.length ? `<h2>${t("their_listings")}</h2><div class="mini-grid">${listings.map(l => tile(l, l.title)).join("")}</div>` : ""}`;
  } catch (e) { fail(e); }
}

/* ================= Monthly dues ================= */
const ym = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
const addMonth = (m, n) => { const [y, mo] = m.split("-").map(Number); return ym(new Date(y, mo - 1 + n, 1)); };
const monthRange = (from, to) => { const out = []; for (let m = from, i = 0; m <= to && i < 240; m = addMonth(m, 1), i++) out.push(m); return out; };
const monthLabel = (m) => { const [y, mo] = m.split("-").map(Number); return new Date(y, mo - 1, 1).toLocaleDateString(locale(), { month: "long", year: "numeric" }); };
const PAY_DEFAULTS = { amount: 50000, dueDay: 10, bank: "", accountNo: "", accountName: "", trackFrom: ym() };
const ST_KEY = { paid: "st_paid", pending: "st_pending", overdue: "st_overdue", due: "st_due", reg: "st_reg", waived: "st_waived", rejected: "st_rejected" };
const chip = (st) => `<span class="chip chip-${st}">${t(ST_KEY[st])}</span>`;
state.duesMode = "mine"; state.duesMonth = ym();

async function loadPaySettings(force = false) {
  if (state.pay && !force) return;
  try {
    const snap = await getDoc(doc(db, "settings", "payment"));
    state.pay = { ...PAY_DEFAULTS, ...(snap.exists() ? snap.data() : {}) };
  } catch (e) { state.pay = { ...PAY_DEFAULTS }; }
}
// Status of one member for one month. The joining month is covered by the Rp150.000 registration fee.
function dueStatus(month, joinedYm, d) {
  if (d && ["paid", "waived", "pending", "rejected"].includes(d.status)) return d.status;
  if (joinedYm && month === joinedYm) return "reg";
  const cur = ym();
  return (month < cur || (month === cur && new Date().getDate() > Number(state.pay?.dueDay || 10))) ? "overdue" : "due";
}
const myJoinedYm = () => {
  const r = (state.roster || []).find(x => x.id === state.profile.rosterId);
  return r?.joined ? r.joined.slice(0, 7) : ym(toDate(state.profile.approvedAt) || new Date());
};

async function loadDues() {
  try {
    await Promise.all([loadPaySettings(true), fetchRoster().catch(() => {})]);
    renderDues();
  } catch (e) { fail(e); }
}
function renderDues() {
  const admin = isAdmin();
  $("#dues-mode-bar").hidden = !admin;
  if (!admin) state.duesMode = "mine";
  $$("[data-dmode]").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.dmode === state.duesMode)));
  $("#dues-mine").hidden = state.duesMode !== "mine";
  $("#dues-all").hidden = state.duesMode !== "all";
  if (state.duesMode === "mine") renderDuesMine(); else renderDuesAll();
}
$$("[data-dmode]").forEach(b => b.addEventListener("click", () => { state.duesMode = b.dataset.dmode; renderDues(); }));

function payInfoHTML() {
  const p = state.pay;
  const hasBank = p.bank && p.accountNo;
  const qris = typeof p.qris === "string" && p.qris.startsWith("data:image/") ? p.qris : "";
  return `<div class="dues-how">
    <h3>${qris ? t("qris_title") : t("dues_how")}</h3>
    <p>${t("dues_amount_line", { amount: fmtIDR(p.amount), day: p.dueDay })}</p>
    ${qris ? `
      <div class="qris">
        <img src="${qris}" alt="QRIS RCMI">
        <div>
          <p>${t("qris_hint", { amount: `<strong>${fmtIDR(p.amount)}</strong>` })}</p>
          <p class="muted">${t("qris_mobile")}</p>
          <a class="btn btn-ghost btn-sm" href="${qris}" download="QRIS-RCMI.png">${t("qris_save")}</a>
          <p class="muted qris-then">${t("qris_then")}</p>
        </div>
      </div>` : ""}
    ${hasBank ? `<p class="muted">${qris ? t("or_transfer") : t("dues_transfer_to")}</p>
      <p class="acct"><strong>${esc(p.bank)} ${esc(p.accountNo)}</strong><br>${esc(p.accountName)}</p>` : ""}
    ${!qris && !hasBank ? `<p class="muted">${t("dues_bank_missing")}</p>` : ""}
  </div>`;
}

/* QR codes are flat images: keep them sharp as PNG, fall back to high-quality JPEG if large. */
function compressQR(file, maxSide = 900) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file); const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
      const c = document.createElement("canvas");
      c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
      const ctx = c.getContext("2d"); ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(url);
      let data = c.toDataURL("image/png");
      if (data.length > 700000) data = c.toDataURL("image/jpeg", 0.92);
      data.length > 900000 ? reject(new Error(t("err_photo"))) : resolve(data);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error(t("err_photo"))); };
    img.src = url;
  });
}

async function renderDuesMine() {
  const box = $("#dues-mine");
  const rosterId = state.profile.rosterId;
  if (!rosterId) { box.innerHTML = `<div class="dues-top"><p class="empty">${t("dues_not_linked")}</p>${payInfoHTML()}</div>`; return; }
  let byMonth = {};
  try {
    const snap = await getDocs(query(collection(db, "dues"), where("rosterId", "==", rosterId)));
    snap.docs.forEach(d => { byMonth[d.data().month] = { id: d.id, ...d.data() }; });
  } catch (e) { fail(e); }
  const joined = myJoinedYm();
  const from = [state.pay.trackFrom, joined].sort().pop();
  const months = monthRange(from, ym()).reverse();
  const cur = ym();
  const stCur = dueStatus(cur, joined, byMonth[cur]);
  const open = months.filter(m => ["due", "overdue", "rejected"].includes(dueStatus(m, joined, byMonth[m])));
  box.innerHTML = `
    <div class="dues-top">
      <div class="dues-now">
        <p class="muted">${t("dues_this_month")}</p>
        <h2>${monthLabel(cur)}</h2>
        <p>${chip(stCur)}</p>
        <p class="fee-amt">${fmtIDR(byMonth[cur]?.amount || state.pay.amount)}</p>
      </div>
      ${payInfoHTML()}
    </div>
    ${open.length ? `
    <form class="form panel-flat dues-form" id="f-dues">
      <h2>${t("dues_upload")}</h2>
      <label><span>${t("dues_for_month")}</span>
        <select name="month">${open.map(m => `<option value="${m}">${monthLabel(m)} — ${t(ST_KEY[dueStatus(m, joined, byMonth[m])])}</option>`).join("")}</select>
      </label>
      <label><span>${t("dues_proof")}</span><input type="file" name="photos" accept="image/*" required></label>
      <div class="thumbs"></div>
      <label><span>${t("dues_note")}</span><input name="note" maxlength="200"></label>
      <div class="form-actions"><button class="btn btn-mat" type="submit">${t("dues_send")}</button></div>
    </form>` : `<p class="empty">${t("dues_all_clear")}</p>`}
    <h2>${t("dues_history")}</h2>
    <div class="rows">${months.map(m => {
      const d = byMonth[m]; const st = dueStatus(m, joined, d);
      return `<div class="row"><div class="grow"><strong>${monthLabel(m)}</strong>
        ${d?.paidAt ? `<small>${t("paid_on", { date: fmtDate(d.paidAt, { day: "numeric", month: "short", year: "numeric" }) })}</small>` : ""}
        ${st === "rejected" && d?.rejectReason ? `<small>${esc(d.rejectReason)}</small>` : ""}</div>${chip(st)}</div>`;
    }).join("")}</div>`;
  const f = $("#f-dues");
  if (!f) return;
  bindPhotoPreview(f);
  f.addEventListener("submit", async (e) => {
    e.preventDefault(); const btn = f.querySelector('[type="submit"]'); btn.disabled = true;
    try {
      const file = f.photos.files[0];
      const proof = await compressPhoto(file, 1200, 380000);
      const month = f.month.value;
      await setDoc(doc(db, "dues", `${rosterId}_${month}`), {
        rosterId, month, uid: state.user.uid, amount: state.pay.amount, status: "pending",
        proof, note: f.note.value.trim(), submittedAt: serverTimestamp(),
        name: state.profile.displayName, memberNo: state.profile.memberNo || null
      }, { merge: true });
      toast(t("dues_sent")); renderDuesMine();
    } catch (err) { fail(err); btn.disabled = false; }
  });
}

async function renderDuesAll() {
  const box = $("#dues-all");
  const M = state.duesMonth;
  let byRoster = {};
  try {
    const snap = await getDocs(query(collection(db, "dues"), where("month", "==", M)));
    snap.docs.forEach(d => { byRoster[d.data().rosterId] = { id: d.id, ...d.data() }; });
  } catch (e) { fail(e); }
  const members = (state.roster || []).filter(r => r.memberNo && r.status !== "applicant" && !r.id.startsWith("u-")
    && (!r.joined || r.joined.slice(0, 7) <= M));
  const rows = members.map(r => ({ r, d: byRoster[r.id], st: dueStatus(M, r.joined ? r.joined.slice(0, 7) : "", byRoster[r.id]) }));
  state.duesRows = rows;
  const count = (f) => rows.filter(x => f(x.st)).length;
  const collected = rows.filter(x => x.st === "paid").reduce((a, x) => a + Number(x.d?.amount || state.pay.amount), 0);
  const months = monthRange(addMonth(ym(), -23), ym()).reverse();
  const p = state.pay;
  box.innerHTML = `
    <div class="view-head">
      <label class="inline-label">${t("dues_for_month")}
        <select id="dues-month" class="search">${months.map(m => `<option value="${m}" ${m === M ? "selected" : ""}>${monthLabel(m)}</option>`).join("")}</select>
      </label>
      <button type="button" class="btn btn-ghost" id="dues-csv">${t("export_csv")}</button>
    </div>
    <div class="dues-sum">
      <div><p class="muted">${t("dues_summary", { paid: count(s => s === "paid" || s === "reg" || s === "waived"), pending: count(s => s === "pending"), unpaid: count(s => ["due", "overdue", "rejected"].includes(s)) })}</p></div>
      <div><p class="muted">${t("dues_collected")}</p><p class="fee-amt">${fmtIDR(collected)}</p></div>
    </div>
    <div class="rows">${rows.map(({ r, d, st }) => `
      <div class="row">
        <span class="r-no small">#${r.memberNo}</span>
        <div class="grow"><strong>${esc(r.name)}</strong>
          <small>${d?.paidAt ? t("paid_on", { date: fmtDate(d.paidAt, { day: "numeric", month: "short" }) }) : esc(r.city || "")}${d?.note ? " · " + esc(d.note) : ""}</small></div>
        ${chip(st)}
        <div class="actions">
          ${d?.proof ? `<button class="btn btn-sm btn-ghost" data-dact="proof" data-r="${esc(r.id)}">${t("view_proof")}</button>` : ""}
          ${st === "pending" ? `<button class="btn btn-sm btn-mat" data-dact="paid" data-r="${esc(r.id)}">${t("confirm_paid")}</button>
            <button class="btn btn-sm btn-danger" data-dact="reject" data-r="${esc(r.id)}">${t("reject_proof")}</button>` : ""}
          ${["due", "overdue", "rejected"].includes(st) ? `<button class="btn btn-sm btn-mat" data-dact="paid" data-r="${esc(r.id)}">${t("mark_paid")}</button>
            <button class="btn btn-sm btn-ghost" data-dact="waive" data-r="${esc(r.id)}">${t("mark_waived")}</button>` : ""}
          ${["paid", "waived"].includes(st) ? `<button class="btn btn-sm btn-ghost" data-dact="undo" data-r="${esc(r.id)}">${t("mark_unpaid")}</button>` : ""}
        </div>
      </div>`).join("")}</div>
    <details class="panel-flat dues-settings">
      <summary><strong>${t("pay_settings")}</strong></summary>
      <form class="form" id="f-pay">
        <div class="row2">
          <label><span>${t("ps_bank")}</span><input name="bank" maxlength="40" value="${esc(p.bank)}" placeholder="BCA"></label>
          <label><span>${t("ps_accno")}</span><input name="accountNo" maxlength="30" value="${esc(p.accountNo)}" inputmode="numeric"></label>
        </div>
        <label><span>${t("ps_accname")}</span><input name="accountName" maxlength="80" value="${esc(p.accountName)}"></label>
        <div class="row2">
          <label><span>${t("ps_amount")}</span><input name="amount" type="number" min="0" step="1000" value="${Number(p.amount)}"></label>
          <label><span>${t("ps_dueday")}</span><input name="dueDay" type="number" min="1" max="28" value="${Number(p.dueDay)}"></label>
        </div>
        <label><span>${t("ps_from")}</span><input name="trackFrom" type="month" value="${esc(p.trackFrom)}"><small class="muted">${t("ps_from_hint")}</small></label>
        <label><span>${t("ps_qris")}</span><input type="file" name="qris" accept="image/*"><small class="muted">${t("ps_qris_hint")}</small></label>
        <div class="thumbs qris-preview">${p.qris ? `<img src="${p.qris}" alt="">` : ""}</div>
        ${p.qris ? `<label class="check"><input type="checkbox" name="qrisRemove"> ${t("ps_qris_remove")}</label>` : ""}
        <div class="form-actions"><button class="btn btn-mat" type="submit">${t("save")}</button></div>
      </form>
    </details>`;
  $("#dues-month").addEventListener("change", (e) => { state.duesMonth = e.target.value; renderDuesAll(); });
  $("#dues-csv").addEventListener("click", () => {
    const lines = [["No", "Nama", "Bulan", "Status", "Jumlah", "Tanggal bayar", "Catatan"]].concat(rows.map(({ r, d, st }) => [
      memberNo(r.memberNo), r.name, M, t(ST_KEY[st]), ["paid", "reg"].includes(st) ? (d?.amount || p.amount) : "",
      d?.paidAt ? fmtDate(d.paidAt, { year: "numeric", month: "2-digit", day: "2-digit" }) : "", d?.note || d?.rejectReason || ""]));
    const csv = lines.map(l => l.map(v => `"${String(v ?? "").replace(/"/g, '""')}"`).join(",")).join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob(["﻿" + csv], { type: "text/csv" }));
    a.download = `iuran-rcmi-${M}.csv`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  });
  bindPhotoPreview($("#f-pay"));
  $("#f-pay").addEventListener("submit", async (e) => {
    e.preventDefault(); const f = e.target; const btn = f.querySelector('[type="submit"]'); btn.disabled = true;
    try {
      const extra = {};
      if (f.qris.files[0]) extra.qris = await compressQR(f.qris.files[0]);
      else if (f.qrisRemove?.checked) extra.qris = "";
      await setDoc(doc(db, "settings", "payment"), {
        ...extra,
        bank: f.bank.value.trim(), accountNo: f.accountNo.value.trim(), accountName: f.accountName.value.trim(),
        amount: Number(f.amount.value) || 0, dueDay: Math.min(28, Math.max(1, Number(f.dueDay.value) || 10)),
        trackFrom: f.trackFrom.value || ym()
      }, { merge: true });
      await loadPaySettings(true); toast(t("saved")); renderDuesAll();
    } catch (err) { fail(err); btn.disabled = false; }
  });
}

$("#dues-all").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-dact]"); if (!b) return;
  const row = (state.duesRows || []).find(x => x.r.id === b.dataset.r); if (!row) return;
  const { r, d } = row; const M = state.duesMonth;
  const ref = doc(db, "dues", `${r.id}_${M}`);
  const base = { rosterId: r.id, month: M, memberNo: r.memberNo, name: r.name, uid: d?.uid || r.claimedBy || null, amount: d?.amount || state.pay.amount };
  try {
    if (b.dataset.dact === "proof") {
      openModal(`<h2>${esc(r.name)} — ${monthLabel(M)}</h2><img src="${d.proof}" alt="" style="width:100%;border-radius:8px">
        ${d.note ? `<p>${esc(d.note)}</p>` : ""}<div class="form-actions"><button class="btn btn-ghost" data-act="close">${t("close")}</button></div>`);
      $("#modal-body").onclick = (ev) => { if (ev.target.dataset.act === "close") closeModal(); };
      return;
    }
    b.disabled = true;
    if (b.dataset.dact === "paid") await setDoc(ref, { ...base, status: "paid", paidAt: serverTimestamp(), confirmedBy: state.user.uid }, { merge: true });
    if (b.dataset.dact === "waive") await setDoc(ref, { ...base, status: "waived", confirmedBy: state.user.uid }, { merge: true });
    if (b.dataset.dact === "reject") {
      const reason = prompt(t("reject_reason")); if (reason === null) { b.disabled = false; return; }
      await updateDoc(ref, { status: "rejected", rejectReason: reason.trim(), confirmedBy: state.user.uid });
    }
    if (b.dataset.dact === "undo") {
      if (d?.proof) await updateDoc(ref, { status: "pending", paidAt: null });
      else await deleteDoc(ref);
    }
    toast(t("saved")); renderDuesAll();
  } catch (err) { fail(err); b.disabled = false; }
});

/* ================= Member card + profile ================= */
// Digital version of the printed RCMI member card: pearl card, EXCLUSIVE MEMBER, logo, RCMI QR, name and number.
function cardHTML({ no, name, city, instagram, photoURL, since }) {
  const sub = [city, instagram ? "@" + igHandle(instagram) : "", since ? `${t("card_since")} ${fmtDate(since, { month: "short", year: "numeric" })}` : ""].filter(Boolean).map(esc).join(" · ");
  return `
    <div class="mcard" role="img" aria-label="RCMI ${esc(name)} ${no ? "#" + no : ""}">
      <p class="mcard-kicker">Exclusive Member</p>
      <img class="mcard-logo" src="/img/logo-dark.png" alt="">
      <img class="mcard-qr" src="/img/card-qr.png" alt="">
      <p class="mcard-name">${esc(name)}</p>
      <p class="mcard-no">${no ? "#" + no : esc(t("applicant"))}</p>
      ${sub ? `<p class="mcard-sub">${sub}</p>` : ""}
    </div>`;
}
function renderCard() {
  const p = state.profile;
  const r = (state.roster || []).find(x => x.id === p.rosterId);
  $("#member-card").innerHTML = cardHTML({
    no: p.memberNo, name: p.displayName, city: p.city, instagram: p.instagram, photoURL: p.photoURL,
    since: r?.joined ? new Date(r.joined) : (p.approvedAt || p.createdAt)
  });
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
    const [pend] = await Promise.all([
      getDocs(query(collection(db, "users"), where("status", "==", "pending"))),
      fetchRoster(true)
    ]);
    const pending = state.pending = pend.docs.map(d => ({ id: d.id, ...d.data() }));
    const members = state.members = Object.values(state.siteUsers).sort((a, b) => (a.memberNo || 0) - (b.memberNo || 0));
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
    $("#admin-import").innerHTML = `
      <details class="panel-flat dues-settings" ${state.roster?.some(r => r.id === "m001") ? "" : "open"}>
        <summary><strong>${t("import_title")}</strong></summary>
        <p class="muted">${t("import_lead")}</p>
        <form class="form" id="f-import">
          <label><span>roster.json</span><input type="file" name="file" accept=".json,application/json" required></label>
          <div class="form-actions"><button class="btn btn-mat" type="submit">${t("import_btn")}</button></div>
        </form>
      </details>`;
    $("#f-import").addEventListener("submit", async (ev) => {
      ev.preventDefault(); const btn = ev.target.querySelector('[type="submit"]'); btn.disabled = true;
      try {
        const r = await importRoster(ev.target.file.files[0]);
        toast(t("import_done", r)); state.roster = null; loadAdmin();
      } catch (err) { fail(err); btn.disabled = false; }
    });
  } catch (e) { fail(e); }
}

/* Import the Google Form roster from the browser (no terminal needed). Admin only; safe to run again. */
async function importRoster(file) {
  const data = JSON.parse(await file.text());
  if (!Array.isArray(data.members)) throw new Error("roster.json: 'members' list not found");
  const rid = (no) => `m${String(no).padStart(3, "0")}`;
  const batch = writeBatch(db);
  for (const m of data.members) {
    batch.set(doc(db, "roster", rid(m.no)), { memberNo: m.no, name: m.name, city: m.city || "", province: m.province || "", joined: m.joined || "", status: "member" }, { merge: true });
    batch.set(doc(db, "rosterPrivate", rid(m.no)), { phone: m.phone || "", shirtSize: m.shirt?.size || "", shirtQty: m.shirt?.qty || 0, shirtPaid: !!m.shirt?.paid }, { merge: true });
  }
  for (const a of data.applicants || []) {
    batch.set(doc(db, "roster", `a-${a.key}`), { memberNo: null, name: a.name, city: a.city || "", province: a.province || "", status: "applicant", applied: a.applied || "" }, { merge: true });
    batch.set(doc(db, "rosterPrivate", `a-${a.key}`), { phone: a.phone || "" }, { merge: true });
  }
  for (const e of SEED_EVENTS) {
    batch.set(doc(db, "events", e.id), { title: e.title, place: e.place, description: e.description || "", date: Timestamp.fromDate(new Date(e.start)),
      allDay: !!e.allDay, dateLabel: e.dateLabel || null, createdBy: "import" }, { merge: true });
  }
  await batch.commit();
  // Counter never moves backwards; the signed-in admin who is member #1 gets linked to that record.
  const maxNo = Math.max(...data.members.map(m => m.no));
  await runTransaction(db, async (tx) => {
    const cRef = doc(db, "counters", "members");
    const c = await tx.get(cRef);
    tx.set(cRef, { next: Math.max(c.exists() ? c.data().next || 1 : 1, maxNo + 1) });
  });
  if (state.profile.memberNo === 1) {
    await setDoc(doc(db, "roster", rid(1)), { claimedBy: state.user.uid }, { merge: true });
    if (state.profile.rosterId !== rid(1)) await updateDoc(doc(db, "users", state.user.uid), { rosterId: rid(1) });
  }
  const pay = await getDoc(doc(db, "settings", "payment"));
  if (!pay.exists()) await setDoc(doc(db, "settings", "payment"), { ...PAY_DEFAULTS });
  return { members: data.members.length, applicants: (data.applicants || []).length, events: SEED_EVENTS.length };
}

// Suggest the roster record whose name best matches the person signing up.
function bestRosterMatch(name) {
  const words = new Set(norm(name).split(" ").filter(w => w.length > 2));
  let best = null, score = 0;
  for (const r of state.roster || []) {
    if (r.claimedBy || r.id.startsWith("u-")) continue;
    const sc = norm(r.name).split(" ").filter(w => words.has(w)).length;
    if (sc > score) { best = r; score = sc; }
  }
  return best;
}

function openApprove(uid) {
  const u = (state.pending || []).find(x => x.id === uid); if (!u) return;
  const free = (state.roster || []).filter(r => !r.claimedBy && !r.id.startsWith("u-"));
  const match = bestRosterMatch(u.displayName);
  openModal(`
    <h2>${t("link_title", { name: esc(u.displayName) })}</h2>
    <p class="muted">${esc(u.city)}${u.instagram ? " · @" + esc(u.instagram) : ""} · ${esc(u.email)}</p>
    <form class="form" id="f-approve">
      <label><span>${t("link_label")}</span>
        <select name="rosterId">
          ${free.map(r => `<option value="${esc(r.id)}" ${match?.id === r.id ? "selected" : ""}>${r.memberNo ? memberNo(r.memberNo) : t("applicant")} — ${esc(r.name)}${r.city ? " (" + esc(r.city) + ")" : ""}</option>`).join("")}
          <option value="" ${match ? "" : "selected"}>${t("link_new")}</option>
        </select>
      </label>
      <div class="form-actions">
        <button type="button" class="btn btn-ghost" data-act="close">${t("cancel")}</button>
        <button class="btn btn-mat" type="submit">${t("approve")}</button>
      </div>
    </form>`);
  $("#modal-body").onclick = (ev) => { if (ev.target.dataset.act === "close") closeModal(); };
  $("#f-approve").addEventListener("submit", async (e) => {
    e.preventDefault(); const btn = e.target.querySelector('[type="submit"]'); btn.disabled = true;
    const rosterId = e.target.rosterId.value;
    try {
      const no = await runTransaction(db, async (tx) => {
        const cRef = doc(db, "counters", "members");
        const rRef = rosterId ? doc(db, "roster", rosterId) : null;
        const c = await tx.get(cRef);
        const rSnap = rRef ? await tx.get(rRef) : null;
        if (rSnap && rSnap.exists() && rSnap.data().claimedBy) throw new Error("Roster record already linked");
        let no = rSnap?.exists() ? rSnap.data().memberNo : null;
        if (!no) {
          no = c.exists() ? c.data().next : Math.max(0, ...(state.roster || []).map(r => r.memberNo || 0)) + 1;
          tx.set(cRef, { next: no + 1 });
        }
        const finalId = rRef ? rosterId : `m${String(no).padStart(3, "0")}`;
        if (rRef) tx.update(rRef, { memberNo: no, status: "member", claimedBy: uid });
        else tx.set(doc(db, "roster", finalId), { memberNo: no, name: u.displayName, city: u.city || "", province: "", status: "member", joined: new Date().toISOString().slice(0, 10), claimedBy: uid });
        tx.update(doc(db, "users", uid), { status: "approved", memberNo: no, rosterId: finalId, approvedAt: serverTimestamp() });
        return no;
      });
      closeModal(); toast(t("approved_msg", { no: memberNo(no) })); loadAdmin();
    } catch (err) { fail(err); btn.disabled = false; }
  });
}

$("#view-admin").addEventListener("click", async (e) => {
  const a = e.target.closest("[data-approve]"), r = e.target.closest("[data-reject]"), m = e.target.closest("[data-mkadmin]");
  try {
    if (a) openApprove(a.dataset.approve);
    if (r && confirm(`${t("reject")}?`)) { await updateDoc(doc(db, "users", r.dataset.reject), { status: "rejected" }); loadAdmin(); }
    if (m) { await updateDoc(doc(db, "users", m.dataset.mkadmin), { role: "admin" }); toast(t("saved")); loadAdmin(); }
  } catch (err) { fail(err); }
});
