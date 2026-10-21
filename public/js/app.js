import { initializeApp } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect, getRedirectResult,
  onAuthStateChanged, signOut, reauthenticateWithPopup
} from "https://www.gstatic.com/firebasejs/11.0.2/firebase-auth.js";
import {
  getFirestore, doc, getDoc, setDoc, updateDoc, deleteDoc, addDoc, collection, query, where,
  orderBy, limit, getDocs, onSnapshot, serverTimestamp, runTransaction, Timestamp, writeBatch,
  startAfter, arrayUnion, arrayRemove
} from "https://www.gstatic.com/firebasejs/11.0.2/firebase-firestore.js";
import { firebaseConfig, uploadUrl } from "./config.js?v=1792607658";
import { t, getLang, setLang, applyStatic } from "./i18n.js?v=1792596508";
import { GALLERY } from "./gallery-data.js?v=1792607658";
import { SEED_EVENTS } from "./seed-events.js?v=1792607658";
import { parseLedgerCSV, parseLedgerTable, buildPL, balanceIssues } from "./finance.js?v=1792607658";
import { parseMemberSheets, phoneKey as sheetPhoneKey } from "./members-sync.js?v=1792607658";

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
// Normalise an Indonesian phone number to 62812… so "0812-…", "+62 812…" and "812…" all match.
const phoneKey = (s) => { let d = String(s || "").replace(/\D/g, ""); if (d.startsWith("0")) d = "62" + d.slice(1); else if (d.startsWith("8")) d = "62" + d; return d; };
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
/* Photos go to Google Drive (RCMI → Collections / Market) through the RCMI upload script when it's
   set up (config.js → uploadUrl); otherwise they're stored inside the post itself as before. */
const driveUrl = (id) => `https://drive.google.com/thumbnail?id=${encodeURIComponent(id)}&sz=w1600`;
// Only our own kinds of image addresses are ever put into the page.
function photoSrc(p) {
  p = String(p || "");
  return /^(data:image\/(jpeg|png|webp);base64,|https:\/\/(drive\.google\.com|lh3\.googleusercontent\.com)\/)/.test(p) ? esc(p) : "";
}
function toJpegBase64(src, maxSide = 2048, q = 0.88) {
  // src: a File, or a canvas (layout collage)
  const fromCanvas = (c) => c.toDataURL("image/jpeg", q).split(",")[1];
  if (src instanceof HTMLCanvasElement) return Promise.resolve(fromCanvas(src));
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(src), img = new Image();
    img.onload = () => {
      const k = Math.min(1, maxSide / Math.max(img.width, img.height));
      const c = document.createElement("canvas"); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(url); resolve(fromCanvas(c));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error(t("err_photo"))); };
    img.src = url;
  });
}
async function uploadToDrive(kind, src, name, onStep) {
  // An older in-post photo (data:image/jpeg;base64,…) is sent as it is.
  const data = typeof src === "string" ? src.split(",")[1] : await toJpegBase64(src);
  const idToken = await state.user.getIdToken();
  const r = await fetch(uploadUrl, { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify({ idToken, kind, name: String(name || "photo").slice(0, 60), mime: "image/jpeg", data }) });
  const j = await r.json().catch(() => ({ error: "upload failed" }));
  if (!j.id) throw new Error(t("upload_failed") + (j.error ? ` (${j.error})` : ""));
  onStep?.();
  return driveUrl(j.id);
}
// Upload the chosen files (Drive when available, else inside the post). `btn` shows progress.
async function storePhotos(input, kind, max = 3, extraSlots = 0, btn = null, done0 = 0, total0 = 0) {
  if (!uploadUrl) return readPhotos(input, max, extraSlots);
  const files = [...(input.files || [])].slice(0, max);
  const total = total0 || files.length; let n = done0;
  const label = btn?.textContent;
  const step = () => { n++; if (btn) btn.textContent = t("uploading", { n, total }); };
  if (btn) btn.textContent = t("uploading", { n, total });
  const out = [];
  for (const f of files) out.push(await uploadToDrive(kind, f, f.name, step));
  if (btn && !total0) btn.textContent = label;
  return out;
}

// Photos live inside the Firestore document (max 1 MB), so more photos = smaller each.
async function readPhotos(input, max = 3, extraSlots = 0) {
  const files = [...(input.files || [])].slice(0, max);
  const n = files.length + extraSlots;
  const budget = Math.min(280000, Math.floor(800000 / Math.max(1, n)));
  const side = n <= 3 ? 1000 : n <= 6 ? 900 : 800;
  const out = [];
  for (const f of files) out.push(await compressPhoto(f, side, budget));
  return out;
}
function bindPhotoPreview(form) {
  const input = form.querySelector('input[type="file"]');
  const box = form.querySelector(".thumbs");
  if (!input || !box) return;
  input.addEventListener("change", () => {
    box.innerHTML = "";
    [...input.files].slice(0, Number(input.dataset.max || 3)).forEach(f => {
      const img = document.createElement("img"); img.alt = ""; img.src = URL.createObjectURL(f); box.appendChild(img);
    });
  });
}

/* ---------------- language + scale ruler (work without Firebase) ---------------- */
$$("[data-lang]").forEach(b => b.addEventListener("click", () => { setLang(b.dataset.lang); updateRuler(); renderGallery(); if (typeof renderStats === "function") renderStats(); rerender(); }));

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
// Gallery media is view-only on the site: no right-click "save / open image", no dragging the photo out.
const isDriveMedia = (el) => el.closest?.(".lb-stage, .g-tile") || (el.tagName === "IMG" && el.src.includes("drive.google.com"));
document.addEventListener("contextmenu", (e) => { if (isDriveMedia(e.target)) e.preventDefault(); });
document.addEventListener("dragstart", (e) => { if (isDriveMedia(e.target)) e.preventDefault(); });
const lbState = { group: null, i: 0 };
function lbShow() {
  const g = GALLERY.find(x => x.key === lbState.group); if (!g) return;
  const it = g.items[lbState.i];
  $("#lb-stage").innerHTML = it.kind === "video"
    // View only: the sandbox blocks the player's "open in Drive" pop-out, and a shield covers that button.
    ? `<div class="lb-video"><iframe src="https://drive.google.com/file/d/${encodeURIComponent(it.id)}/preview" allow="autoplay; fullscreen" allowfullscreen
         sandbox="allow-scripts allow-same-origin allow-presentation" title="Video"></iframe><span class="lb-shield" aria-hidden="true"></span></div>`
    : `<img src="${driveThumb(it.id, 1600)}" alt="" referrerpolicy="no-referrer" draggable="false">`;
  $("#lb-count").textContent = `${lbState.i + 1} / ${g.items.length}`;
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

// Home page member count: public/stats is kept up to date by admins' member syncs and approvals.
let publicStats = null;
function renderStats() {
  const el = $("#stats");
  const lu = $("#lead-users");
  lu.textContent = publicStats?.members ? t("lead_users", { total: publicStats.members + (publicStats.general || 0), m: publicStats.members, g: publicStats.general || 0 }) : "";
  if (!publicStats?.members) { el.hidden = true; return; }
  el.textContent = t("stats", { n: publicStats.members, p: publicStats.provinces || 0 });
  el.hidden = false;
}
getDoc(doc(db, "public", "stats")).then(snap => { publicStats = snap.exists() ? snap.data() : null; renderStats(); }).catch(() => {});
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
// Sign-in buttons: signed out → sign in and go to the members area; signed in → just open the members area.
const ENTER_KEY = "rcmi-enter";
const setEnter = (v) => { try { v ? sessionStorage.setItem(ENTER_KEY, "1") : sessionStorage.removeItem(ENTER_KEY); } catch (e) {} };
const wantsEnter = () => { try { return sessionStorage.getItem(ENTER_KEY) === "1"; } catch (e) { return false; } };
// What the person chose before Google sign-in: login-member, login-general, new-member, new-general.
const INTENT_KEY = "rcmi-intent";
const setIntent = (v) => { try { v ? sessionStorage.setItem(INTENT_KEY, v) : sessionStorage.removeItem(INTENT_KEY); } catch (e) {} };
const getIntent = () => { try { return sessionStorage.getItem(INTENT_KEY) || ""; } catch (e) { return ""; } };
function openSignInChooser() {
  const opt = (id, icon, kind) => `<button type="button" class="choose-opt ${kind}" data-intent="${id}">
      <span class="choose-ic" aria-hidden="true">${icon}</span>
      <span><strong>${t("ch_" + id.replace("-", "_"))}</strong><small>${t("ch_" + id.replace("-", "_") + "_d")}</small></span></button>`;
  openModal(`
    <h2>${t("sign_in")}</h2>
    <p class="choose-label">${t("ch_have_account")}</p>
    <div class="choose-grid">
      ${opt("login-member", "🪪", "login")}
      ${opt("login-general", "👤", "login")}
    </div>
    <p class="choose-label">${t("ch_new_here")}</p>
    <div class="choose-grid">
      ${opt("new-member", "🏁", "create")}
      ${opt("new-general", "✨", "create")}
    </div>
    <p class="muted choose-note">${t("ch_google_note")}</p>
    <div class="form-actions"><button type="button" class="btn btn-ghost" data-act="close">${t("cancel")}</button></div>`);
  $("#modal-body").onclick = (ev) => {
    if (ev.target.dataset.act === "close") { closeModal(); return; }
    const b = ev.target.closest("[data-intent]"); if (!b) return;
    setIntent(b.dataset.intent); setEnter(true); closeModal(); signIn();
  };
}
$$("#btn-signin, .js-signin").forEach(b => b.addEventListener("click", () => {
  if (state.user) { location.hash = "#/collection"; return; }
  openSignInChooser();
}));
$("#btn-signout").addEventListener("click", async () => { await signOut(auth); location.hash = "#/"; });
getRedirectResult(auth).catch(fail);

/* ---------------- state + screens ---------------- */
const state = { user: null, profile: null, tab: "collection", sub: "", carFilter: "mine", marketFilter: "all", cars: [], listings: [], events: [], roster: null, rosterPrivate: {}, siteUsers: {}, memberSearch: "" };
// Keep the address clean: rcmi-website.web.app/#/… instead of …/index.html#/…
if (/\/index\.html$/i.test(location.pathname)) history.replaceState(null, "", location.pathname.replace(/index\.html$/i, "") + location.search + location.hash);
let unsubProfile = null;

/* ================= Admin notifications (bell in the top bar, live) ================= */
const notif = { unsubs: [], pending: [], messages: [], recent: [], proofs: {}, notices: [], seenAt: 0, lastCount: null, uid: null };
function stopNotifs() { notif.unsubs.forEach(u => u()); notif.unsubs = []; notif.uid = null; notif.lastCount = null; $("#bell-wrap").hidden = true; }
function startNotifs() {
  if (notif.uid === state.user.uid) return;
  stopNotifs(); notif.uid = state.user.uid; notif.startedAt = Date.now();
  $("#bell-wrap").hidden = false;
  const since = Timestamp.fromDate(new Date(Date.now() - 30 * 864e5));
  const on = (q, fn) => notif.unsubs.push(onSnapshot(q, fn, () => {}));
  notif.pending = []; notif.messages = []; notif.recent = []; notif.proofs = {}; notif.notices = [];
  // Everyone: notices from the admins (post hidden / removed / visible again).
  on(query(collection(db, "notices"), where("uid", "==", state.user.uid)), s => { notif.notices = s.docs.map(d => ({ id: d.id, ...d.data() })); renderBell(); });
  if (!isAdmin()) return;
  on(query(collection(db, "users"), where("status", "==", "pending")), s => { notif.pending = s.docs.map(d => ({ id: d.id, ...d.data() })); renderBell(); });
  on(query(collection(db, "messages"), where("status", "==", "new")), s => { notif.messages = s.docs.map(d => ({ id: d.id, ...d.data() })); renderBell(); });
  on(query(collection(db, "users"), where("createdAt", ">", since)), s => { notif.recent = s.docs.map(d => ({ id: d.id, ...d.data() })).filter(u => u.status === "approved"); renderBell(); });
  on(collection(db, "joinPayments"), s => { notif.proofs = Object.fromEntries(s.docs.map(d => [d.id, d.data()])); renderBell(); });
}
const ms = (ts) => toDate(ts)?.getTime() || 0;
function bellItems() {
  const seen = ms(state.profile?.notifSeenAt);
  const items = [];
  for (const n of notif.notices) items.push({ at: ms(n.at), unread: !n.read, href: "#", notice: n.id,
    text: t({ hidden: "nt_hidden", deleted: "nt_deleted", unhidden: "nt_unhidden" }[n.kind] || "nt_hidden", { title: esc(n.title), where: t(n.target === "market" ? "nav_market" : "nav_feed") })
      + (n.note ? `<em class="bell-note">${t("mod_reason")}: ${esc(n.note)}</em>` : "") });
  for (const u of notif.pending) items.push({ at: ms(notif.proofs[u.id]?.createdAt) || ms(u.createdAt), unread: true, href: "#/admin",
    text: t(u.accountType === "general" ? "notif_pending_general" : notif.proofs[u.id] ? "notif_pending_paid" : "notif_pending_member", { name: esc(u.displayName) }) });
  for (const m of notif.messages) items.push({ at: ms(m.createdAt), unread: true, href: "#/admin",
    text: t("notif_message", { name: esc(m.name), msg: esc(String(m.message).slice(0, 80)) }) });
  for (const u of notif.recent) items.push({ at: ms(u.approvedAt || u.createdAt), unread: ms(u.createdAt) > seen, href: u.accountType === "general" ? "#/admin" : `#/members/${encodeURIComponent(u.rosterId || "")}`,
    text: t(u.accountType === "general" ? "notif_new_general" : "notif_new_member", { name: esc(u.displayName), no: u.memberNo ? memberNo(u.memberNo) : "" }) });
  return items.sort((a, b) => b.at - a.at);
}
function renderBell() {
  const items = bellItems();
  const n = items.filter(i => i.unread).length;
  const c = $("#bell-count"); c.hidden = !n; c.textContent = n > 99 ? "99+" : String(n);
  $("#btn-bell").setAttribute("aria-label", t("notif_title") + (n ? ` (${n})` : ""));
  $("#bell-list").innerHTML = items.length ? items.slice(0, 30).map(i => `
    <a class="bell-item ${i.unread ? "unread" : ""}" href="${i.href}"${i.notice ? ` data-notice="${esc(i.notice)}"` : ""}>
      <span>${i.text}</span><small>${i.at ? new Date(i.at).toLocaleString(locale(), { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : ""}</small>
    </a>`).join("") : `<p class="muted bell-empty">${t("notif_empty")}</p>`;
  // Pop a toast only for things that arrive while the admin has the site open (not the first load).
  if (notif.lastCount !== null && Date.now() - notif.startedAt > 4000 && n > notif.lastCount) toast(t("notif_toast", { n: n - notif.lastCount }));
  notif.lastCount = n;
}
function toggleBell(open) {
  const p = $("#bell-panel"); open = open ?? p.hidden;
  p.hidden = !open; $("#btn-bell").setAttribute("aria-expanded", String(open));
}
$("#btn-bell").addEventListener("click", (e) => { e.stopPropagation(); toggleBell(); });
$("#bell-panel").addEventListener("click", (e) => {
  const nt = e.target.closest("[data-notice]");
  if (nt) { e.preventDefault(); openNotice(nt.dataset.notice); }
  if (e.target.closest("a")) toggleBell(false);
});
function openNotice(id) {
  const n = notif.notices.find(x => x.id === id); if (!n) return;
  if (!n.read) updateDoc(doc(db, "notices", id), { read: true }).catch(() => {});
  const where = t(n.target === "market" ? "nav_market" : "nav_feed");
  openModal(`
    <h2>${t({ hidden: "nt_hidden_title", deleted: "nt_deleted_title", unhidden: "nt_unhidden_title" }[n.kind] || "nt_hidden_title")}</h2>
    <p>${t({ hidden: "nt_hidden", deleted: "nt_deleted", unhidden: "nt_unhidden" }[n.kind] || "nt_hidden", { title: `<strong>${esc(n.title)}</strong>`, where })}</p>
    ${n.note ? `<p class="mod-note"><strong>${t("mod_reason")}:</strong> ${esc(n.note)}</p>` : ""}
    ${n.kind !== "unhidden" ? `<p class="muted">${t("nt_contact")}</p>` : ""}
    <p class="muted">${fmtDate(n.at, { day: "numeric", month: "long", year: "numeric" })}</p>
    <div class="form-actions">
      ${n.kind !== "unhidden" ? `<a class="btn btn-ghost" href="#contact" data-act="close">${t("nav_contact")}</a>` : ""}
      <button type="button" class="btn btn-mat" data-act="close">${t("close")}</button>
    </div>`);
  $("#modal-body").onclick = (ev) => { if (ev.target.dataset.act === "close") closeModal(); };
}
document.addEventListener("click", (e) => { if (!e.target.closest("#bell-wrap")) toggleBell(false); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") toggleBell(false); });
$("#bell-seen").addEventListener("click", async (e) => {
  e.stopPropagation();
  try {
    notif.notices.filter(n => !n.read).forEach(n => updateDoc(doc(db, "notices", n.id), { read: true }).catch(() => {}));
    if (isAdmin()) await updateDoc(doc(db, "users", state.user.uid), { notifSeenAt: serverTimestamp() });
  } catch (err) { fail(err); }
});

let lastScreen = "";
function show(screen) {
  $("#landing").hidden = screen !== "landing";
  $("#feedpage").hidden = screen !== "feed";
  $("#marketpage").hidden = screen !== "market";
  // The main-site menu stays in the top bar everywhere; "How to join" only on the public pages.
  $("#landing-nav").hidden = false;
  const joinLink = $('#landing-nav a[href="#join"]'); if (joinLink) joinLink.hidden = screen === "app" || screen === "gate";
  $$("#landing-nav a").forEach(a => a.classList.toggle("on", a.getAttribute("href") === "#/" + screen));
  $("#gate").hidden = screen !== "gate";
  $("#app").hidden = screen !== "app";
  if (screen !== lastScreen && screen !== "landing") window.scrollTo(0, 0);
  lastScreen = screen;
}
function showGate(which) {
  show("gate");
  ["onboarding", "pending", "rejected", "blocked", "deactivated"].forEach(w => { $(`#gate-${w}`).hidden = w !== which; });
  if (which === "pending" && state.joinPayFor !== state.user?.uid) { state.joinPayFor = state.user?.uid; renderJoinPay(); }
}

/* New member waiting for approval: pay the Rp150.000 joining fee (QRIS / bank) and upload the proof. */
const JOIN_FEE = 150000;
async function renderJoinPay() {
  const box = $("#join-pay");
  if (isGeneral()) { box.hidden = true; return; }
  await loadPaySettings();
  let proof = null;
  try { const s = await getDoc(doc(db, "joinPayments", state.user.uid)); proof = s.exists() ? s.data() : null; } catch (e) {}
  const p = state.pay;
  const qris = typeof p.qris === "string" && p.qris.startsWith("data:image/") ? p.qris : "";
  const hasBank = p.bank && p.accountNo;
  box.hidden = false;
  box.innerHTML = `
    <h2>${t("joinpay_title")}</h2>
    <p>${t("joinpay_lead", { amount: `<strong>${fmtIDR(JOIN_FEE)}</strong>` })}</p>
    ${qris ? `<div class="qris"><img src="${qris}" alt="QRIS RCMI"><div>
        <p>${t("qris_hint", { amount: `<strong>${fmtIDR(JOIN_FEE)}</strong>` })}</p>
        <p class="muted">${t("qris_mobile")}</p>
        <a class="btn btn-ghost btn-sm" href="${qris}" download="QRIS-RCMI.png">${t("qris_save")}</a></div></div>` : ""}
    ${hasBank ? `<p class="muted">${qris ? t("or_transfer") : t("dues_transfer_to")}</p>
      <p class="acct"><strong>${esc(p.bank)} ${esc(p.accountNo)}</strong><br>${esc(p.accountName)}</p>` : ""}
    ${!qris && !hasBank ? `<p class="muted">${t("joinpay_ask_admin")}</p>` : ""}
    ${proof ? `<p class="joinpay-ok">${t("joinpay_received")}</p>` : ""}
    <form class="form" id="f-joinpay">
      <label><span>${t(proof ? "joinpay_replace" : "joinpay_upload")}</span><input type="file" name="file" accept="image/*" required></label>
      <div class="form-actions"><button class="btn btn-mat" type="submit">${t("joinpay_send")}</button></div>
    </form>`;
  $("#f-joinpay").addEventListener("submit", async (e) => {
    e.preventDefault(); const btn = e.target.querySelector("[type=submit]"); btn.disabled = true;
    try {
      const data = await compressPhoto(e.target.file.files[0], 1200, 380000);
      await setDoc(doc(db, "joinPayments", state.user.uid), { proof: data, createdAt: serverTimestamp() });
      toast(t("joinpay_received")); renderJoinPay();
    } catch (err) { fail(err); btn.disabled = false; }
  });
}
// The main website is "#/" and its anchors (#about, #gallery…); the members area is "#/collection", "#/members/…" etc.
const isMemberRoute = () => TABS.includes(location.hash.replace(/^#\/?/, "").split("/")[0]);

function render() {
  const user = state.user, member = isMemberRoute();
  renderContact();
  $("#btn-signin").hidden = !!user;
  $("#btn-area").hidden = !user || member;
  $("#btn-home").hidden = !user || !member;
  $$(".js-signin").forEach(b => { b.dataset.i18n = user ? "open_member_area" : "join_cta"; b.textContent = t(b.dataset.i18n); });
  if (location.hash === "#market") { history.replaceState(null, "", "#/market"); }
  if (location.hash === "#feed") { history.replaceState(null, "", "#/feed"); }
  // Market: its own page on the main website, open to everyone (#/market, #/market/<id> opens a listing).
  if (location.hash.startsWith("#/market")) {
    show("market");
    const canPost = state.profile?.status === "approved";
    $("#btn-add-listing").hidden = !canPost;
    $("#market-hint").hidden = canPost;
    const done = () => openDeepLink();
    if (!state.listingsLoaded) { state.listingsLoaded = true; loadListings().then(done); } else { renderListings(); done(); }
    return;
  }
  // Collection: its own page on the main website, open to everyone.
  if (location.hash.startsWith("#/feed")) {
    show("feed");
    if (!state.feedLoaded) { state.feedLoaded = true; loadFeed(true); } else renderFeed();
    renderFeedRoute();
    return;
  }
  if (!member) {
    const wasApp = lastScreen !== "landing";
    show("landing");
    const id = location.hash.slice(1);
    if (id && !id.startsWith("/")) requestAnimationFrame(() => document.getElementById(id)?.scrollIntoView());
    else if (wasApp) window.scrollTo(0, 0);
    return;
  }
  if (!user) { show("landing"); history.replaceState(null, "", "#/"); return; }
  if (state.gate) return showGate(state.gate);
  if (state.profile?.status === "approved") { show("app"); route(); }
}

onAuthStateChanged(auth, (user) => {
  state.user = user;
  if (unsubProfile) { unsubProfile(); unsubProfile = null; }
  $("#user-chip").hidden = !user;
  if (!user) { state.profile = null; state.gate = null; stopNotifs(); render(); return; }
  state.listingsLoaded = false; state.feedLoaded = false;
  $("#user-avatar").src = user.photoURL || "";
  $("#user-avatar").hidden = !user.photoURL;

  // Live listener on the member's own record: moves them from pending to approved automatically.
  unsubProfile = onSnapshot(doc(db, "users", user.uid), (snap) => {
    if (!snap.exists()) {
      const f = $("#form-onboarding");
      // Request rejected by an admin while they were waiting: back to the start, they can sign up again.
      if (state.profile && state.profile.status === "pending") {
        state.profile = null; state.gate = null;
        signOut(auth).finally(() => openModal(`<h2>${t("rejected_title")}</h2><p>${t("rejected_again")}</p>
          <div class="form-actions"><button type="button" class="btn btn-mat" data-act="close">${t("close")}</button></div>`));
        $("#modal-body").onclick = (ev) => { if (ev.target.dataset.act === "close") closeModal(); };
        location.hash = "#/";
        return;
      }
      // Blocked by email: show the blocked page instead of the sign-up form.
      getDoc(doc(db, "blocked", String(user.email || "").toLowerCase())).then(b => {
        if (b.exists() && !state.profile) { state.gate = "blocked"; render(); }
      }).catch(() => {});
      state.profile = null; state.gate = "onboarding";
      // Pre-registered by email? Then the account activates itself on save.
      getDoc(doc(db, "invites", String(user.email || "").toLowerCase())).then(inv => {
        state.invite = inv.exists() ? inv.data() : null;
        if (!f.displayName.value) f.displayName.value = state.invite?.name || user.displayName || "";
        if (!f.city.value && state.invite?.city) f.city.value = state.invite.city;
        const note = $("#invite-note");
        note.hidden = !state.invite;
        if (state.invite) note.textContent = t("invite_found", { no: memberNo(state.invite.memberNo) });
        applyIntent();
      }).catch(() => { state.invite = null; if (!f.displayName.value) f.displayName.value = user.displayName || ""; applyIntent(); });
    } else {
      state.profile = { id: snap.id, ...snap.data() };
      // Old-style rejection: clear it so they can create their account again.
      if (state.profile.status === "rejected") {
        deleteDoc(doc(db, "users", user.uid)).then(() => toast(t("rejected_again"))).catch(() => {});
      }
      state.gate = ["pending", "blocked", "deactivated"].includes(state.profile.status) ? state.profile.status : state.profile.status === "rejected" ? "onboarding" : null;
      $("#tab-admin").hidden = state.profile.role !== "admin";
      $("#tab-finance").hidden = state.profile.accountType === "general";
      if (state.profile.role === "admin") refreshInboxCount();
      // The bell: admins get sign-ups/messages too; everyone gets notices about their own posts.
      if (state.profile.status === "approved") { startNotifs(); renderBell(); } else stopNotifs();
      $("#btn-add-event").hidden = state.profile.role !== "admin";
      const general = isGeneral();
      $$('.tabs a[data-tab="members"], .tabs a[data-tab="dues"]').forEach(a => { a.hidden = general; });
      const ct = $("#tab-card"); ct.dataset.i18n = general ? "tab_profile" : "tab_card"; ct.textContent = t(ct.dataset.i18n);
      $("#btn-add-car").hidden = general;
      if (state.profile.status === "approved" && state.contactSyncedFor !== user.uid) { state.contactSyncedFor = user.uid; saveContact(state.profile); }
    }
    // Just signed in from a "Masuk" button → open the members area; otherwise stay where they are.
    if (snap.exists()) setIntent("");
    if (snap.exists() && getAfter() === "feed-add") {
      setAfter(""); setEnter(false);
      if (!location.hash.startsWith("#/feed")) location.hash = "#/feed";
      setTimeout(feedPlus, 400);
    }
    if (wantsEnter()) { setEnter(false); if (!isMemberRoute()) { location.hash = "#/collection"; return; } }
    render();
  }, fail);
});

// Pre-select the sign-up form from the option chosen before Google sign-in.
function applyIntent() {
  const f = $("#form-onboarding"); const intent = getIntent();
  const general = intent.endsWith("general");
  if (intent) f.querySelector(`[name=accountType][value=${general ? "general" : "member"}]`).checked = true;
  // Chose "log in" but this Google account has no account yet.
  const note = $("#intent-note");
  note.hidden = !intent.startsWith("login");
  if (!note.hidden) note.textContent = t(general ? "ch_no_account_general" : "ch_no_account_member");
  syncAccountType();
}
function syncAccountType() {
  const general = $("#form-onboarding").accountType.value === "general";
  const newMember = !general && getIntent() === "new-member";
  $("#phone-hint").textContent = t(general ? "f_phone_hint_general" : "f_phone_hint");
  const lead = $("#onb-lead"); lead.dataset.i18n = general ? "onb_lead_general" : newMember ? "onb_lead_newmember" : "onb_lead"; lead.textContent = t(lead.dataset.i18n);
  $("#invite-note").hidden = general || !state.invite;
  $("#form-onboarding [type=submit]").textContent = t(general ? "create_account" : state.invite ? "activate_account" : "send_request");
}
$$("#form-onboarding [name=accountType]").forEach(r => r.addEventListener("change", syncAccountType));

// Typed phone number isn't on the RCMI list (or already used): ask for the registered number, or apply as new.
function showPhoneMismatch(phone, taken) {
  return new Promise((resolve) => {
    let done = false; const finish = (v) => { if (!done) { done = true; resolve(v); } };
    openModal(`
      <h2>${t(taken ? "phone_taken_title" : "phone_mismatch_title")}</h2>
      <p>${t(taken ? "phone_taken_body" : "phone_mismatch_body", { phone: `<strong>${esc(phone)}</strong>` })}</p>
      <p class="muted">${t(taken ? "phone_taken_hint" : "phone_mismatch_hint")}</p>
      <div class="form-actions">
        <button type="button" class="btn btn-ghost" data-act="new">${t("phone_mismatch_new")}</button>
        <button type="button" class="btn btn-mat" data-act="fix">${t("phone_fix")}</button>
      </div>`);
    $("#modal-body").onclick = (ev) => {
      const act = ev.target.dataset.act; if (!act) return;
      finish(act); closeModal();
    };
    modal.addEventListener("close", () => finish("fix"), { once: true });
  });
}

$("#form-onboarding").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target; const u = state.user;
  const btn = f.querySelector("[type=submit]"); btn.disabled = true;
  const key = phoneKey(f.whatsapp.value);
  const accountType = f.accountType.value === "general" ? "general" : "member";
  try {
    // Members: 1) registered Google email (if admins added one), else 2) registered phone number.
    // General users: no matching; they wait for an admin.
    if (key) {
      const bp = await getDoc(doc(db, "blockedPhones", key)).catch(() => null);
      if (bp?.exists()) { toast(t("blocked_phone")); btn.disabled = false; return; }
    }
    let inv = accountType === "member" ? state.invite : null;
    if (accountType === "member" && !inv && key) {
      const snap = await getDoc(doc(db, "phoneInvites", key)).catch(() => null);
      inv = snap?.exists() ? { ...snap.data(), phoneKey: key } : null;
      if (!inv && getIntent() !== "new-member") {
        const choice = await showPhoneMismatch(f.whatsapp.value.trim(), false);
        if (choice === "fix") { btn.disabled = false; f.whatsapp.focus(); f.whatsapp.select(); return; }
      }
    }
    await setDoc(doc(db, "users", u.uid), {
      displayName: f.displayName.value.trim(),
      email: u.email,
      photoURL: u.photoURL || "",
      city: f.city.value.trim(),
      instagram: igHandle(f.instagram.value),
      whatsapp: f.whatsapp.value.trim(),
      bio: f.bio.value.trim(),
      role: "member",
      accountType,
      createdAt: serverTimestamp(),
      ...(inv ? { status: "approved", memberNo: inv.memberNo, rosterId: inv.rosterId, approvedAt: serverTimestamp(), ...(inv.phoneKey ? { phoneKey: inv.phoneKey } : {}) }
        : accountType === "general" ? { status: "approved", approvedAt: serverTimestamp(), ...(key ? { phoneKey: key } : {}) }
        : { status: "pending", ...(key ? { phoneKey: key } : {}) })
    });
    saveContact({ displayName: f.displayName.value.trim(), whatsapp: f.whatsapp.value.trim(), instagram: f.instagram.value });
    if (inv) {
      await updateDoc(doc(db, "roster", inv.rosterId), { claimedBy: u.uid }).catch(() => {});
      toast(t("approved_msg", { no: memberNo(inv.memberNo) }));
      if (!isMemberRoute()) location.hash = "#/card";
    } else if (accountType === "general") {
      toast(t("general_welcome"));
      if (!isMemberRoute()) location.hash = "#/events";
    }
  } catch (err) {
    // The rules refuse when that member record is already linked to another account.
    if (err?.code === "permission-denied" && key) {
      const choice = await showPhoneMismatch(f.whatsapp.value.trim(), true);
      if (choice === "new") {
        try {
          await setDoc(doc(db, "users", u.uid), { displayName: f.displayName.value.trim(), email: u.email, photoURL: u.photoURL || "",
            city: f.city.value.trim(), instagram: igHandle(f.instagram.value), whatsapp: f.whatsapp.value.trim(), bio: f.bio.value.trim(),
            role: "member", accountType: "member", createdAt: serverTimestamp(), status: "pending", phoneKey: key });
        } catch (e2) { fail(e2); }
      }
    } else fail(err);
    btn.disabled = false;
  }
});

/* ---------------- routing ---------------- */
const TABS = ["collection", "events", "members", "dues", "card", "finance", "admin"];
window.addEventListener("hashchange", render);
function route() {
  if (!state.profile || state.profile.status !== "approved" || !isMemberRoute()) return;
  const [h, sub = ""] = location.hash.replace(/^#\/?/, "").split("/");
  let tab = TABS.includes(h) ? h : "collection";
  state.sub = decodeURIComponent(sub);
  if (tab === "admin" && state.profile.role !== "admin") tab = "collection";
  if (tab === "finance" && isGeneral()) tab = "events";
  if (isGeneral() && (tab === "members" || tab === "dues")) tab = "events";
  state.tab = tab;
  $$(".tabs a").forEach(a => { if (a.dataset.tab === tab) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current"); });
  TABS.forEach(n => { $(`#view-${n}`).hidden = n !== tab; });
  ({ collection: loadCars, events: loadEvents, members: loadMembers, dues: loadDues, finance: loadFinance, card: () => fetchRoster().catch(() => {}).then(renderCard), admin: loadAdmin })[tab]();
}
function rerender() {
  if ($("#app").hidden) return;
  ({ collection: renderCars, events: renderEvents, members: showMembers, dues: renderDues, finance: renderFinance, card: renderCard, admin: loadAdmin })[state.tab]();
}
const isAdmin = () => state.profile?.role === "admin";
// Two account types: RCMI members, and general users (non-members). Older accounts without the field are members.
const isGeneral = () => state.profile?.accountType === "general";
// Seller contact for the market, readable by any approved account (members and general users).
const saveContact = (p) => setDoc(doc(db, "contacts", state.user.uid), {
  name: String(p.displayName || "").slice(0, 80), whatsapp: String(p.whatsapp || "").slice(0, 20), instagram: igHandle(p.instagram) || ""
}).catch(() => {});
const canEdit = (ownerUid) => ownerUid === state.user?.uid || isAdmin();

/* ================= Collection ================= */
async function loadCars() {
  try {
    // My Collection: only your own cars, newest first.
    const snap = await getDocs(query(collection(db, "cars"), where("ownerUid", "==", state.user.uid)));
    state.cars = snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(c => !c.hidden)   // own posts hidden by an admin stay visible here, marked
      .sort((a, b) => (toDate(b.createdAt)?.getTime() || 0) - (toDate(a.createdAt)?.getTime() || 0));
    renderCars();
  } catch (e) { fail(e); }
}
function renderCars() {
  const list = state.cars;
  $("#cars").innerHTML = list.length ? list.map(c => `
    <button type="button" class="item" data-car="${esc(c.id)}">
      ${c.photos?.[0] ? `<img class="ph" src="${photoSrc(c.photos[0])}" alt="" loading="lazy">` : `<div class="ph ph-empty">1:64</div>`}
      <div class="meta">${c.modHidden ? `<span class="tag tag-hidden">${t("mod_hidden_tag")}</span>` : ""}<h3>${esc(c.name)}</h3><p>${esc(c.maker || "")}${c.maker ? " · " : ""}${t("by")} ${esc(c.ownerName)}</p></div>
    </button>`).join("") : `<p class="empty">${t("empty_collection")}</p>`;
}
$("#cars").addEventListener("click", (e) => {
  const el = e.target.closest("[data-car]"); if (!el) return;
  const c = state.cars.find(x => x.id === el.dataset.car); if (!c) return;
  openModal(`
    ${c.photos?.length ? `<div class="detail-photos">${c.photos.map(p => `<img src="${photoSrc(p)}" alt="">`).join("")}</div>` : ""}
    <h2>${esc(c.name)}</h2>
    ${c.maker ? `<p><strong>${t("car_maker")}:</strong> ${esc(c.maker)}</p>` : ""}
    ${c.notes ? `<p>${esc(c.notes)}</p>` : ""}
    ${c.modHidden ? `<p class="mod-note">🚫 ${t("mod_hidden_owner")}${c.modNote ? `<br><strong>${t("mod_reason")}:</strong> ${esc(c.modNote)}` : ""}</p>` : ""}
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
$("#btn-add-car").addEventListener("click", () => openAddCar(loadCars));
function openAddCar(after) {
  openModal(`
    <h2>${t("add_car")}</h2>
    <form class="form" id="f-car">
      <label><span>${t("car_name")}</span><input name="name" required maxlength="100" placeholder="Toyota Celica GT-Four ST185"></label>
      <label><span>${t("car_maker")}</span><input name="maker" maxlength="80"></label>
      <label><span>${t("car_notes")}</span><textarea name="notes" rows="3" maxlength="600"></textarea></label>
      <div class="seg post-mode" role="group">
        <button type="button" data-pmode="photos" aria-pressed="true">${t("pm_photos")}</button>
        <button type="button" data-pmode="layout" aria-pressed="false">▦ ${t("pm_layout")}</button>
      </div>
      <div class="pm-photos">
        <label><span>${t("photos")} (${t("feed_max10")})</span><input type="file" name="photos" accept="image/*" multiple required data-max="10"></label>
        <div class="thumbs"></div>
      </div>
      <div class="pm-layout" hidden>
        <label><span>${t("lay_pick")}</span><input type="file" name="lphotos" accept="image/*" multiple></label>
        <div class="lay-choices" id="lay-choices"></div>
        <div class="lay-stage"><canvas id="lay-canvas" width="1080" height="1080"></canvas><p class="muted lay-empty" id="lay-empty">${t("lay_empty")}</p></div>
        <div class="lay-tools">
          <label class="lay-check"><input type="checkbox" name="lborder" checked> ${t("lay_border")}</label>
          <button type="button" class="btn btn-sm btn-ghost" data-act="lshuffle">⟳ ${t("lay_shuffle")}</button>
        </div>
        <small class="muted">${t("lay_hint")}</small>
        <label class="lay-more"><span>${t("lay_more")}</span><input type="file" name="lextra" accept="image/*" multiple data-max="9"></label>
        <div class="thumbs lay-thumbs"></div>
      </div>
      <div class="form-actions">
        <button type="button" class="btn btn-ghost" data-act="close">${t("cancel")}</button>
        <button class="btn btn-mat" type="submit">${t("feed_share")}</button>
      </div>
    </form>`);
  const f = $("#f-car"); bindPhotoPreview(f);
  const lay = bindLayout(f);
  f.lextra.addEventListener("change", () => {
    const box = f.querySelector(".lay-thumbs"); box.innerHTML = "";
    [...f.lextra.files].slice(0, 9).forEach(x => { const i = document.createElement("img"); i.alt = ""; i.src = URL.createObjectURL(x); box.appendChild(i); });
    if (f.lextra.files.length > 9) toast(t("lay_more_max"));
  });
  $("#modal-body").onclick = (ev) => {
    if (ev.target.dataset.act === "close") closeModal();
    const pm = ev.target.closest("[data-pmode]");
    if (pm) {
      const isLay = pm.dataset.pmode === "layout";
      f.querySelectorAll("[data-pmode]").forEach(b => b.setAttribute("aria-pressed", String(b === pm)));
      f.querySelector(".pm-photos").hidden = isLay; f.querySelector(".pm-layout").hidden = !isLay;
      f.photos.required = !isLay; f.lphotos.required = isLay;
    }
  };
  f.addEventListener("submit", async (e) => {
    e.preventDefault(); const btn = f.querySelector('[type="submit"]'); btn.disabled = true;
    try {
      const useLayout = !f.querySelector(".pm-layout").hidden;
      if (useLayout && lay.count() < 2) { toast(t("lay_need2")); btn.disabled = false; return; }
      if (!useLayout && f.photos.files.length > 10) toast(t("feed_max10_note"));
      let photos; const label = btn.textContent;
      if (useLayout) {
        const extra = Math.min(9, f.lextra.files.length);
        if (uploadUrl) {
          const total = 1 + extra;
          btn.textContent = t("uploading", { n: 0, total });
          const first = await uploadToDrive("collection", lay.canvas(), "layout", () => { btn.textContent = t("uploading", { n: 1, total }); });
          photos = [first, ...(extra ? await storePhotos(f.lextra, "collection", 9, 0, btn, 1, total) : [])];
        } else photos = [await lay.export(Math.min(300000, Math.floor(800000 / (1 + extra)))), ...(extra ? await readPhotos(f.lextra, 9, 1) : [])];
      } else photos = await storePhotos(f.photos, "collection", 10, 0, btn);
      btn.textContent = label;
      await addDoc(collection(db, "cars"), {
        name: f.name.value.trim(), maker: f.maker.value.trim(), notes: f.notes.value.trim(), photos,
        ownerUid: state.user.uid, ownerName: state.profile.displayName, ownerPhoto: state.profile.photoURL || state.user.photoURL || "",
        ownerCity: state.profile.city || "", createdAt: serverTimestamp()
      });
      closeModal(); toast(t("feed_posted")); state.feedLoaded = false; after?.();
    } catch (err) { fail(err); btn.disabled = false; }
  });
}

/* ---- Layout: several photos in one square image, like Instagram's Layout ---- */
// Each template: list of cells [x, y, w, h] in a 6×6 grid.
const LAYOUTS = {
  2: [[[0,0,3,6],[3,0,3,6]], [[0,0,6,3],[0,3,6,3]]],
  3: [[[0,0,4,6],[4,0,2,3],[4,3,2,3]], [[0,0,6,4],[0,4,3,2],[3,4,3,2]], [[0,0,2,6],[2,0,2,6],[4,0,2,6]], [[0,0,6,2],[0,2,6,2],[0,4,6,2]]],
  4: [[[0,0,3,3],[3,0,3,3],[0,3,3,3],[3,3,3,3]], [[0,0,6,4],[0,4,2,2],[2,4,2,2],[4,4,2,2]], [[0,0,4,6],[4,0,2,2],[4,2,2,2],[4,4,2,2]]],
  5: [[[0,0,3,3],[3,0,3,3],[0,3,2,3],[2,3,2,3],[4,3,2,3]], [[0,0,4,3],[4,0,2,3],[0,3,2,3],[2,3,2,3],[4,3,2,3]], [[0,0,2,3],[2,0,2,3],[4,0,2,3],[0,3,3,3],[3,3,3,3]]],
  6: [[[0,0,2,3],[2,0,2,3],[4,0,2,3],[0,3,2,3],[2,3,2,3],[4,3,2,3]], [[0,0,3,2],[3,0,3,2],[0,2,3,2],[3,2,3,2],[0,4,3,2],[3,4,3,2]], [[0,0,4,4],[4,0,2,2],[4,2,2,2],[0,4,2,2],[2,4,2,2],[4,4,2,2]]]
};
function bindLayout(form) {
  const input = form.lphotos, cv = form.querySelector("#lay-canvas"), ctx = cv.getContext("2d");
  const st = { imgs: [], tpl: 0, sel: -1 };
  const loadImg = (file) => new Promise((res, rej) => { const u = URL.createObjectURL(file); const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = u; });
  const cells = () => (LAYOUTS[st.imgs.length] || [])[st.tpl] || [];
  function choices() {
    const box = form.querySelector("#lay-choices"); const list = LAYOUTS[st.imgs.length] || [];
    box.innerHTML = list.map((tpl, k) => `<button type="button" class="lay-opt" data-tpl="${k}" aria-pressed="${k === st.tpl}">
      ${tpl.map(([x, y, w, h]) => `<i style="left:${x / 6 * 100}%;top:${y / 6 * 100}%;width:${w / 6 * 100}%;height:${h / 6 * 100}%"></i>`).join("")}</button>`).join("");
  }
  function draw() {
    const S = 1080, unit = S / 6, gap = form.lborder.checked ? 12 : 0;
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, S, S);
    form.querySelector("#lay-empty").hidden = st.imgs.length >= 2;
    cells().forEach(([x, y, w, h], i) => {
      const img = st.imgs[i]; if (!img) return;
      const dx = x * unit + (x ? gap / 2 : gap), dy = y * unit + (y ? gap / 2 : gap);
      const dw = w * unit - (x ? gap / 2 : gap) - (x + w < 6 ? gap / 2 : gap), dh = h * unit - (y ? gap / 2 : gap) - (y + h < 6 ? gap / 2 : gap);
      const r = Math.max(dw / img.width, dh / img.height), sw = dw / r, sh = dh / r;   // cover crop, centred
      ctx.drawImage(img, (img.width - sw) / 2, (img.height - sh) / 2, sw, sh, dx, dy, dw, dh);
      if (i === st.sel) { ctx.strokeStyle = "#D6102B"; ctx.lineWidth = 10; ctx.strokeRect(dx + 5, dy + 5, dw - 10, dh - 10); }
    });
  }
  input.addEventListener("change", async () => {
    const files = [...input.files].slice(0, 6);
    if (input.files.length > 6) toast(t("lay_max6"));
    st.imgs = await Promise.all(files.map(loadImg)); st.tpl = 0; st.sel = -1;
    if (st.imgs.length === 1) toast(t("lay_need2"));
    choices(); draw();
  });
  form.addEventListener("click", (e) => {
    const o = e.target.closest("[data-tpl]");
    if (o) { st.tpl = Number(o.dataset.tpl); st.sel = -1; choices(); draw(); }
    if (e.target.closest("[data-act=lshuffle]") && st.imgs.length > 1) { st.imgs.push(st.imgs.shift()); st.sel = -1; draw(); }
  });
  form.lborder.addEventListener("change", draw);
  // Tap one photo, then another, to swap them.
  cv.addEventListener("click", (e) => {
    const r = cv.getBoundingClientRect(), gx = (e.clientX - r.left) / r.width * 6, gy = (e.clientY - r.top) / r.height * 6;
    const i = cells().findIndex(([x, y, w, h]) => gx >= x && gx < x + w && gy >= y && gy < y + h);
    if (i < 0 || !st.imgs[i]) return;
    if (st.sel < 0) st.sel = i;
    else { if (st.sel !== i) [st.imgs[st.sel], st.imgs[i]] = [st.imgs[i], st.imgs[st.sel]]; st.sel = -1; }
    draw();
  });
  return {
    count: () => st.imgs.length,
    canvas: () => { st.sel = -1; draw(); return cv; },
    export: async (maxChars = 300000) => {
      st.sel = -1; draw();
      let c = cv;
      if (maxChars < 150000) { c = document.createElement("canvas"); c.width = c.height = 800; c.getContext("2d").drawImage(cv, 0, 0, 800, 800); }
      for (let q = 0.85; q >= 0.35; q -= 0.08) { const d = c.toDataURL("image/jpeg", q); if (d.length <= maxChars) return d; }
      throw new Error(t("err_photo"));
    }
  };
}

/* ================= Collection feed on the main website (Instagram-style) ================= */
const FEED_PAGE = 6;
state.feed = []; state.feedCursor = null; state.feedDone = false;
async function loadFeed(reset = false) {
  if (reset) { state.feed = []; state.feedCursor = null; state.feedDone = false; }
  if (state.feedDone || state.feedLoading) return;
  state.feedLoading = true; $("#feed-more").disabled = true;
  try {
    const parts = [collection(db, "cars"), orderBy("createdAt", "desc")];
    if (state.feedCursor) parts.push(startAfter(state.feedCursor));
    parts.push(limit(FEED_PAGE));
    const snap = await getDocs(query(...parts));
    state.feedCursor = snap.docs[snap.docs.length - 1] || state.feedCursor;
    state.feedDone = snap.docs.length < FEED_PAGE;
    state.feed.push(...snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(c => !c.hidden && !c.modHidden));
    renderFeed();
  } catch (e) { console.warn(e); }
  state.feedLoading = false; $("#feed-more").disabled = false;
}
const ago = (ts) => {
  const d = toDate(ts); if (!d) return "";
  const s = (Date.now() - d.getTime()) / 1000;
  if (s < 3600) return t("ago_min", { n: Math.max(1, Math.round(s / 60)) });
  if (s < 86400) return t("ago_hour", { n: Math.round(s / 3600) });
  if (s < 7 * 86400) return t("ago_day", { n: Math.round(s / 86400) });
  return fmtDate(d, { day: "numeric", month: "long", year: "numeric" });
};
function postHTML(c) {
  const likes = c.likedBy || [];
  const mine = !!state.user && likes.includes(state.user.uid);
  const photos = c.photos || [];
  return `<article class="post" data-post="${esc(c.id)}">
    <header class="post-head" data-owner="${esc(c.ownerUid || "")}" role="link" tabindex="0">
      <span class="post-av">${c.ownerPhoto ? `<img src="${esc(c.ownerPhoto)}" alt="" referrerpolicy="no-referrer">` : esc(initials(c.ownerName))}</span>
      <div><strong>${esc(c.ownerName || "RCMI")}</strong>${c.ownerCity ? `<small>${esc(c.ownerCity)}</small>` : ""}</div>
      ${isAdmin() ? `<button type="button" class="post-mod" data-mod-post="${esc(c.id)}" aria-label="${t("mod_title")}" title="${t("mod_title")}">⋯</button>` : ""}
    </header>
    <div class="post-media">
      ${photos.length ? `<div class="post-track">${photos.map(p => `<img src="${photoSrc(p)}" alt="${esc(c.name)}" loading="lazy" draggable="false">`).join("")}</div>
        ${photos.length > 1 ? `<button type="button" class="post-nav prev" data-slide="-1" aria-label="Previous">‹</button><button type="button" class="post-nav next" data-slide="1" aria-label="Next">›</button>` : ""}
        ${photos.length > 1 ? `<div class="post-dots">${photos.map((_, i) => `<i class="${i ? "" : "on"}"></i>`).join("")}</div><span class="post-count">1/${photos.length}</span>` : ""}`
        : `<div class="post-empty">1:64</div>`}
      <span class="post-heart" aria-hidden="true">♥</span>
    </div>
    <div class="post-actions">
      <button type="button" class="like ${mine ? "on" : ""}" data-like="${esc(c.id)}" aria-pressed="${mine}" aria-label="${t("like")}">
        <svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true"><path d="M12 21s-7.5-4.6-9.6-9.2C.9 8.4 3 4.5 6.8 4.5c2.2 0 3.6 1.2 4.2 2.3h2c.6-1.1 2-2.3 4.2-2.3 3.8 0 5.9 3.9 4.4 7.3C19.5 16.4 12 21 12 21Z"/></svg>
      </button>
      <button type="button" class="share" data-share-post="${esc(c.id)}" aria-label="${t("share")}">${SHARE_ICON}</button>
      <span class="like-count">${likes.length ? t(likes.length === 1 ? "likes_one" : "likes_n", { n: likes.length }) : ""}</span>
    </div>
    <p class="post-cap"><strong>${esc(c.name)}</strong>${c.maker ? ` <span class="post-maker">· ${esc(c.maker)}</span>` : ""}${c.notes ? `<br>${esc(c.notes)}` : ""}</p>
    <time class="post-time">${ago(c.createdAt)}</time>
  </article>`;
}
function renderFeed() {
  const box = $("#feed-list"); if (!box) return;
  box.innerHTML = state.feed.length ? state.feed.map(postHTML).join("") : `<p class="empty">${t("feed_empty")}</p>`;
  $("#feed-more").hidden = state.feedDone || !state.feed.length;
  wireCarousels(box);
  renderPeople();
}
$("#feed-more").addEventListener("click", () => loadFeed());
async function toggleLike(id, forceOn = false) {
  if (!state.user || state.profile?.status !== "approved") { openSignInChooser(); return; }
  const c = state.feed.find(x => x.id === id) || (state.feedProfile?.posts || []).find(x => x.id === id); if (!c) return;
  const uid = state.user.uid; const on = (c.likedBy || []).includes(uid);
  if (forceOn && on) return;
  c.likedBy = on ? c.likedBy.filter(x => x !== uid) : [...(c.likedBy || []), uid];
  paintLike(c);
  try { await updateDoc(doc(db, "cars", id), { likedBy: on ? arrayRemove(uid) : arrayUnion(uid) }); }
  catch (e) { c.likedBy = on ? [...c.likedBy, uid] : c.likedBy.filter(x => x !== uid); paintLike(c); fail(e); }
}
// Update one post's heart and count in place (keeps the photo carousel where it is).
function paintLike(c) {
  // Same car can be in the feed, a profile and an open post at once: keep them all in step.
  [state.feed, state.feedProfile?.posts || []].forEach(list => { const x = list.find(y => y.id === c.id); if (x && x !== c) x.likedBy = c.likedBy; });
  document.querySelectorAll(`.post[data-post="${CSS.escape(c.id)}"]`).forEach(post => {
    const n = (c.likedBy || []).length, mine = (c.likedBy || []).includes(state.user?.uid);
    const b = post.querySelector(".like"); b.classList.toggle("on", mine); b.setAttribute("aria-pressed", String(mine));
    post.querySelector(".like-count").textContent = n ? t(n === 1 ? "likes_one" : "likes_n", { n }) : "";
  });
}
// Show the whole photo, like Instagram: the post takes the shape of its first photo
// (between 4:5 portrait and 1.91:1 landscape); other photos fit inside without cropping.
document.addEventListener("load", (e) => {
  const img = e.target;
  if (!(img instanceof HTMLImageElement) || !img.matches(".post-track img:first-child")) return;
  const r = Math.min(1.91, Math.max(0.8, img.naturalWidth / img.naturalHeight || 1));
  img.closest(".post-media").style.aspectRatio = String(r);
}, true);
// Arrows to slide through a post's photos (for computers; phones just swipe).
document.addEventListener("click", (e) => {
  const b = e.target.closest(".post-nav[data-slide]"); if (!b) return;
  const tr = b.closest(".post-media").querySelector(".post-track");
  tr.scrollBy({ left: Number(b.dataset.slide) * tr.clientWidth, behavior: "smooth" });
});
// Likes and double-tap work in the feed, on profiles and in an opened post.
document.addEventListener("click", (e) => {
  const b = e.target.closest(".post [data-like]"); if (b) toggleLike(b.dataset.like);
});
document.addEventListener("dblclick", (e) => {
  const m = e.target.closest(".post-media"); if (!m) return;
  const post = m.closest(".post"); const h = m.querySelector(".post-heart");
  h.classList.remove("pop"); void h.offsetWidth; h.classList.add("pop");
  setTimeout(() => toggleLike(post.dataset.post, true), 350);
});

/* Report a market problem to the admins: the Contact form, topic "Market", prefilled. */
function openReport(l) {
  location.hash = "#contact";
  setTimeout(() => {
    const f = $("#form-contact");
    if (f && !f.hidden) {
      f.topic.value = "pasar";
      if (l) f.message.value = t("mn_report_msg", { title: l.title, seller: l.ownerName || "", url: `${SITE_URL}#/market/${l.id}` });
      f.message.focus();
    }
    document.getElementById("contact")?.scrollIntoView({ behavior: "smooth" });
  }, 250);
}
document.addEventListener("click", (e) => { if (e.target.closest(".js-report")) { e.preventDefault(); openReport(null); } });

/* ---- Share (WhatsApp & co.): the phone's share sheet when available, otherwise a small menu ---- */
const SHARE_ICON = `<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><path d="M21 3 10 14M21 3l-7 18-4-7-7-4 18-7Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>`;
const SITE_URL = location.origin + "/";
async function shareLink({ title, text, url }) {
  if (navigator.share) {
    try { await navigator.share({ title, text, url }); return; }
    catch (e) { if (e.name === "AbortError") return; }
  }
  const enc = encodeURIComponent;
  openModal(`
    <h2>${t("share")}</h2>
    <p class="muted share-what">${esc(title)}</p>
    <div class="share-grid">
      <a class="share-opt wa" target="_blank" rel="noopener" href="https://wa.me/?text=${enc(text + "\n" + url)}"><b>WhatsApp</b></a>
      <a class="share-opt tg" target="_blank" rel="noopener" href="https://t.me/share/url?url=${enc(url)}&text=${enc(text)}"><b>Telegram</b></a>
      <a class="share-opt fb" target="_blank" rel="noopener" href="https://www.facebook.com/sharer/sharer.php?u=${enc(url)}"><b>Facebook</b></a>
      <a class="share-opt x" target="_blank" rel="noopener" href="https://twitter.com/intent/tweet?text=${enc(text)}&url=${enc(url)}"><b>X</b></a>
      <button type="button" class="share-opt copy" data-act="copy"><b>${t("copy_link")}</b></button>
    </div>
    <input class="share-url" readonly value="${esc(url)}">
    <div class="form-actions"><button type="button" class="btn btn-ghost" data-act="close">${t("close")}</button></div>`);
  $("#modal-body").onclick = async (ev) => {
    const a = ev.target.closest("[data-act]")?.dataset.act;
    if (a === "close") closeModal();
    if (a === "copy") {
      try { await navigator.clipboard.writeText(url); } catch (e) { const i = $(".share-url"); i.select(); document.execCommand("copy"); }
      toast(t("link_copied"));
    }
  };
}
function sharePost(c) {
  shareLink({ title: c.name, text: t("share_post_text", { car: c.name, owner: c.ownerName || "RCMI" }), url: `${SITE_URL}#/feed/p/${c.id}` });
}
function shareListing(l) {
  const price = l.price ? " · " + fmtIDR(l.price) : "";
  shareLink({ title: l.title, text: t("share_listing_text", { type: typeLabel(l.type), title: l.title + price }), url: `${SITE_URL}#/market/${l.id}` });
}
document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-share-post]"); if (!b) return;
  const id = b.dataset.sharePost;
  const c = state.feed.find(x => x.id === id) || (state.feedProfile?.posts || []).find(x => x.id === id) || state.deepPost;
  if (c) sharePost(c);
});
// Shared links: #/feed/p/<id> opens that post, #/market/<id> opens that listing.
async function openDeepLink() {
  const h = location.hash;
  if (state.deepOpened === h) return;
  let m = h.match(/^#\/feed\/p\/([^/]+)/);
  if (m) {
    state.deepOpened = h;
    const id = decodeURIComponent(m[1]);
    let c = state.feed.find(x => x.id === id);
    if (!c) { try { const s = await getDoc(doc(db, "cars", id)); c = s.exists() ? { id: s.id, ...s.data() } : null; } catch (e) {} }
    if (!c || c.hidden || (c.modHidden && !isAdmin() && c.ownerUid !== state.user?.uid)) { toast(t("not_found")); return; }
    state.deepPost = c;
    openModal(`<div class="post-modal">${postHTML(c)}</div>`); $("#modal-body").onclick = null;
    wireCarousels($("#modal-body"));
    modal.addEventListener("close", () => { state.deepOpened = null; history.replaceState(null, "", "#/feed"); }, { once: true });
    return;
  }
  m = h.match(/^#\/market\/([^/]+)/);
  if (m) {
    state.deepOpened = h;
    const id = decodeURIComponent(m[1]);
    let l = state.listings.find(x => x.id === id);
    if (!l) { try { const s = await getDoc(doc(db, "listings", id)); l = s.exists() ? { id: s.id, ...s.data() } : null; } catch (e) {} }
    if (!l || l.hidden || (l.modHidden && !isAdmin() && l.ownerUid !== state.user?.uid)) { toast(t("not_found")); return; }
    openListing(l);
    modal.addEventListener("close", () => { state.deepOpened = null; history.replaceState(null, "", "#/market"); }, { once: true });
  }
}

/* ---- Instagram-style extras: collectors row, profiles with a photo grid, the + button ---- */
const feedAv = (photo, name) => photo ? `<img src="${esc(photo)}" alt="" referrerpolicy="no-referrer">` : esc(initials(name));
function renderPeople() {
  const box = $("#feed-people"); if (!box) return;
  const seen = new Map();
  state.feed.forEach(c => { if (c.ownerUid && !seen.has(c.ownerUid)) seen.set(c.ownerUid, c); });
  const cur = state.feedProfile?.uid || "";
  box.innerHTML = seen.size ? `
    <a class="ig-person ${cur ? "" : "on"}" href="#/feed"><span class="ig-ring all">★</span><small>${t("all")}</small></a>
    ${[...seen.values()].map(c => `<a class="ig-person ${cur === c.ownerUid ? "on" : ""}" href="#/feed/u/${encodeURIComponent(c.ownerUid)}">
      <span class="ig-ring">${feedAv(c.ownerPhoto, c.ownerName)}</span><small>${esc(String(c.ownerName || "").split(" ")[0])}</small></a>`).join("")}` : "";
}
async function renderFeedRoute() {
  if (/^#\/feed\/p\//.test(location.hash)) openDeepLink();
  const m = location.hash.match(/^#\/feed\/u\/([^/]+)/);
  const uid = m ? decodeURIComponent(m[1]) : "";
  $("#feed-main").hidden = !!uid; $("#feed-profile").hidden = !uid;
  if (!uid) { state.feedProfile = null; renderPeople(); return; }
  if (state.feedProfile?.uid !== uid) {
    state.feedProfile = { uid, posts: null };
    renderPeople(); paintProfile();
    try {
      const snap = await getDocs(query(collection(db, "cars"), where("ownerUid", "==", uid)));
      if (state.feedProfile?.uid !== uid) return;
      state.feedProfile.posts = snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(c => !c.hidden && !c.modHidden)
        .sort((a, b) => ms(b.createdAt) - ms(a.createdAt));
    } catch (e) { state.feedProfile.posts = []; }
  }
  renderPeople(); paintProfile();
  window.scrollTo(0, 0);
}
function paintProfile() {
  const p = state.feedProfile; if (!p) return;
  const posts = p.posts || [];
  const any = posts[0] || state.feed.find(c => c.ownerUid === p.uid) || {};
  const likes = posts.reduce((a, c) => a + (c.likedBy || []).length, 0);
  $("#feed-profile").innerHTML = `
    <div class="ig-profile">
      <span class="ig-ring big">${feedAv(any.ownerPhoto, any.ownerName)}</span>
      <div>
        <h2>${esc(any.ownerName || "")}</h2>
        ${any.ownerCity ? `<p class="muted">${esc(any.ownerCity)}</p>` : ""}
        <p class="ig-stats"><span><strong>${p.posts ? posts.length : "…"}</strong> ${t("feed_posts")}</span><span><strong>${likes}</strong> ${t("feed_likes")}</span></p>
      </div>
    </div>
    ${p.posts && !posts.length ? `<p class="empty">${t("feed_empty")}</p>` : ""}
    <div class="ig-grid">${posts.map(c => `<button type="button" class="ig-tile" data-open-post="${esc(c.id)}">
      ${c.photos?.[0] ? `<img src="${photoSrc(c.photos[0])}" alt="${esc(c.name)}" loading="lazy" draggable="false">` : `<span>1:64</span>`}
      ${(c.photos || []).length > 1 ? `<i class="ig-multi" aria-hidden="true">❏</i>` : ""}
      <span class="ig-hover">♥ ${(c.likedBy || []).length}</span></button>`).join("")}</div>`;
}
$("#feed-profile").addEventListener("click", (e) => {
  const tile = e.target.closest("[data-open-post]"); if (!tile) return;
  const c = (state.feedProfile?.posts || []).find(x => x.id === tile.dataset.openPost); if (!c) return;
  openModal(`<div class="post-modal">${postHTML(c)}</div>`);
  $("#modal-body").onclick = null;
  wireCarousels($("#modal-body"));
});
// Tap a name or avatar in a post to open that collector's profile.
document.addEventListener("click", (e) => {
  if (e.target.closest(".post-mod")) return;
  const h = e.target.closest(".post-head[data-owner]"); if (!h) return;
  if (modal.open) closeModal();
  location.hash = `#/feed/u/${encodeURIComponent(h.dataset.owner)}`;
});
function wireCarousels(root) {
  root.querySelectorAll(".post-track").forEach(tr => tr.addEventListener("scroll", () => {
    const i = Math.round(tr.scrollLeft / tr.clientWidth);
    const post = tr.closest(".post");
    post.querySelectorAll(".post-dots i").forEach((d, k) => d.classList.toggle("on", k === i));
    const cnt = post.querySelector(".post-count"); if (cnt) cnt.textContent = `${i + 1}/${tr.children.length}`;
    const pv = post.querySelector(".post-nav.prev"), nx = post.querySelector(".post-nav.next");
    if (pv) pv.hidden = i === 0; if (nx) nx.hidden = i >= tr.children.length - 1;
  }, { passive: true }));
  root.querySelectorAll(".post-nav.prev").forEach(b => { b.hidden = true; });
}

// "+" new post: sign in first; general users can't post to the collection (members only).
const AFTER_KEY = "rcmi-after";
const setAfter = (v) => { try { v ? sessionStorage.setItem(AFTER_KEY, v) : sessionStorage.removeItem(AFTER_KEY); } catch (e) {} };
const getAfter = () => { try { return sessionStorage.getItem(AFTER_KEY) || ""; } catch (e) { return ""; } };
function feedPlus() {
  if (!state.user) { toast(t("feed_login_first")); setAfter("feed-add"); openSignInChooser(); return; }
  if (state.profile?.status !== "approved") { toast(t(state.profile ? "feed_wait_approval" : "feed_finish_signup")); return; }
  if (isGeneral()) { toast(t("feed_members_only")); return; }
  openAddCar(() => { location.hash = "#/feed"; state.feedLoaded = true; loadFeed(true); });
}
$$(".js-feed-plus").forEach(b => b.addEventListener("click", feedPlus));

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
    // Hidden by an admin: only the seller (and admins) still see it, marked as hidden.
    state.listings = snap.docs.map(d => ({ id: d.id, ...d.data() }))
      .filter(l => !l.hidden && (!l.modHidden || l.ownerUid === state.user?.uid || isAdmin()));
    renderListings();
  } catch (e) { fail(e); }
}
const typeLabel = (ty) => t({ sell: "t_sell", trade: "t_trade", wanted: "t_wanted" }[ty] || "t_sell");
function renderListings() {
  const f = state.marketFilter;
  const list = f === "all" ? state.listings : state.listings.filter(l => l.type === f);
  $("#listings").innerHTML = list.length ? list.map(l => `
    <button type="button" class="item" data-listing="${esc(l.id)}">
      ${l.photos?.[0] ? `<img class="ph" src="${photoSrc(l.photos[0])}" alt="" loading="lazy">` : `<div class="ph ph-empty">1:64</div>`}
      <div class="meta">
        <span class="tag ${l.status === "sold" ? "tag-sold" : "tag-" + esc(l.type)}">${l.status === "sold" ? t("sold") : typeLabel(l.type)}</span>${l.modHidden ? ` <span class="tag tag-hidden">${t("mod_hidden_tag")}</span>` : ""}
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
  const l = state.listings.find(x => x.id === el.dataset.listing); if (l) openListing(l);
});
function openListing(l) {
  const ig = igHandle(l.ownerInstagram);
  const member = state.profile?.status === "approved";
  openModal(`
    ${l.photos?.length ? `<div class="detail-photos">${l.photos.map(p => `<img src="${photoSrc(p)}" alt="">`).join("")}</div>` : ""}
    <span class="tag tag-${esc(l.type)}">${typeLabel(l.type)}</span>
    <h2>${esc(l.title)}</h2>
    ${l.price ? `<p class="price">${fmtIDR(l.price)}</p>` : ""}
    ${l.condition ? `<p><strong>${t("l_condition")}:</strong> ${esc(l.condition)}</p>` : ""}
    ${l.description ? `<p>${esc(l.description)}</p>` : ""}
    <p class="muted">${esc(l.ownerName)} · ${fmtDate(l.createdAt, { day: "numeric", month: "short" })}</p>
    ${l.modHidden ? `<p class="mod-note">🚫 ${t(isAdmin() && l.ownerUid !== state.user?.uid ? "mod_hidden_admin" : "mod_hidden_owner")}${l.modNote ? `<br><strong>${t("mod_reason")}:</strong> ${esc(l.modNote)}` : ""}</p>` : ""}
    <p class="listing-risk">⚠️ ${t("mn_short")}</p>
    ${isAdmin() ? `<div class="mod-bar"><small>${t("admin_only")}</small>
      ${l.modHidden ? `<button type="button" class="btn btn-sm btn-mat" data-act="unhide">${t("mod_unhide")}</button>` : `<button type="button" class="btn btn-sm btn-ghost" data-act="modhide">${t("mod_hide")}</button>`}
      <button type="button" class="btn btn-sm btn-danger" data-act="moddel">${t("mod_delete")}</button></div>` : ""}
    <div class="form-actions">
      <button type="button" class="btn btn-ghost share-btn" data-act="share">${SHARE_ICON} ${t("share")}</button>
      <button type="button" class="btn btn-ghost" data-act="report">${t("mn_report_listing")}</button>
      ${ig ? `<a class="btn btn-ghost" target="_blank" rel="noopener" href="https://instagram.com/${encodeURIComponent(ig)}">Instagram</a>` : ""}
      <span id="listing-wa">${member ? "" : `<button type="button" class="btn btn-ghost" data-act="signin">${t("wa_signin")}</button>`}</span>
      ${canEdit(l.ownerUid) && l.status !== "sold" ? `<button class="btn btn-ghost" data-act="sold">${t("mark_sold")}</button>` : ""}
      ${canEdit(l.ownerUid) ? `<button class="btn btn-danger" data-act="del">${t("delete")}</button>` : ""}
    </div>`);
  // Members see the seller's WhatsApp (read from the member list, which only approved members can open).
  if (member && l.ownerUid) {
    getDoc(doc(db, "contacts", l.ownerUid)).then(u => {
      const wa = waNumber(u.exists() ? u.data().whatsapp : "");
      const box = $("#listing-wa");
      if (box && wa) box.innerHTML = `<a class="btn btn-mat" target="_blank" rel="noopener" href="https://wa.me/${wa}">${t("contact")} WhatsApp</a>`;
    }).catch(() => {});
  }
  $("#modal-body").onclick = async (ev) => {
    const act = ev.target.dataset.act;
    if (act === "signin") { closeModal(); openSignInChooser(); return; }
    if (ev.target.closest("[data-act=share]")) { shareListing(l); return; }
    if (act === "report") { closeModal(); openReport(l); return; }
    if (act === "modhide" || act === "moddel") { openModerate("listings", l, act === "moddel" ? "delete" : "hide"); return; }
    if (act === "unhide") { await unhidePost("listings", l); closeModal(); return; }
    try {
      if (act === "sold") { await updateDoc(doc(db, "listings", l.id), { status: "sold" }); closeModal(); toast(t("saved")); loadListings(); }
      if (act === "del" && confirm(t("confirm_delete"))) { await deleteDoc(doc(db, "listings", l.id)); closeModal(); toast(t("deleted")); loadListings(); }
    } catch (e2) { fail(e2); }
  };
}
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
      <label class="lay-check rules-ok"><input type="checkbox" name="rules" required> <span>${t("mr_agree")} <a href="#/market" data-act="rules">${t("mr_title")}</a></span></label>
      <div class="form-actions">
        <button type="button" class="btn btn-ghost" data-act="close">${t("cancel")}</button>
        <button class="btn btn-mat" type="submit">${t("save")}</button>
      </div>
    </form>`);
  const f = $("#f-l"); bindPhotoPreview(f);
  // Rule 3: a price is always required (for "wanted": the budget; for "trade": the value).
  f.price.required = true; f.price.min = "1000";
  const syncPrice = () => {
    const ty = f.type.value;
    f.price.closest("label").querySelector("span").textContent = t(ty === "wanted" ? "l_budget" : ty === "trade" ? "l_value" : "l_price") + " *";
    f.description.required = ty === "wanted";
    f.description.placeholder = ty === "wanted" ? t("l_wanted_ph") : "";
  };
  f.type.addEventListener("change", syncPrice); syncPrice();
  $("#modal-body").onclick = (ev) => {
    if (ev.target.dataset.act === "close") closeModal();
    if (ev.target.dataset.act === "rules") { ev.preventDefault(); closeModal(); const d = $("#market-rules"); d.open = true; d.scrollIntoView({ behavior: "smooth" }); }
  };
  f.addEventListener("submit", async (e) => {
    e.preventDefault(); const btn = f.querySelector('[type="submit"]');
    if (!(Number(f.price.value) > 0)) { toast(t("l_price_required")); f.price.focus(); return; }
    btn.disabled = true;
    try {
      const photos = await storePhotos(f.photos, "market", 3, 0, f.querySelector('[type="submit"]'));
      await addDoc(collection(db, "listings"), {
        type: f.type.value, title: f.title.value.trim(), price: Number(f.price.value),
        condition: f.condition.value.trim(), description: f.description.value.trim(), photos, status: "open",
        ownerUid: state.user.uid, ownerName: state.profile.displayName,
        ownerInstagram: state.profile.instagram || "",
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
  if (isAdmin()) {
    const ds = await getDocs(query(collection(db, "users"), where("status", "==", "deactivated"))).catch(() => null);
    state.deactUsers = Object.fromEntries((ds?.docs || []).map(d => [d.id, { id: d.id, ...d.data() }]));
  } else state.deactUsers = {};
  const roster = rs.docs.map(d => ({ id: d.id, ...d.data() }));
  // Members who joined on the site without a roster record still get a profile.
  const linked = new Set(roster.map(r => r.claimedBy).filter(Boolean));
  Object.values(state.siteUsers).forEach(u => {
    if (!linked.has(u.id) && u.accountType !== "general") roster.push({ id: "u-" + u.id, memberNo: u.memberNo || null, name: u.displayName, city: u.city, province: "", status: "member", claimedBy: u.id, joined: "" });
  });
  roster.sort((a, b) => (a.memberNo ?? 1e9) - (b.memberNo ?? 1e9) || String(a.name).localeCompare(b.name));
  state.roster = roster;
  if (isAdmin()) {
    const numbered = roster.filter(r => r.memberNo && r.status !== "applicant");
    const stats = {
      members: numbered.length,
      provinces: new Set(numbered.map(r => String(r.province || "").trim().toLowerCase()).filter(Boolean)).size,
      general: Object.values(state.siteUsers).filter(u => u.accountType === "general").length
    };
    if (stats.members && (stats.members !== publicStats?.members || stats.provinces !== publicStats?.provinces || stats.general !== publicStats?.general)) {
      publicStats = { ...stats };
      setDoc(doc(db, "public", "stats"), { ...stats, updatedAt: serverTimestamp() }).then(renderStats).catch(() => {});
    }
  }
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
  $("#mem-sync-bar").hidden = !isAdmin();
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

  // General users (non-members), below the member list — admins only, since it includes contact details.
  const gs = $("#general-section"); gs.hidden = !isAdmin();
  if (isAdmin()) {
    const all = Object.values(state.siteUsers).filter(u => u.accountType === "general");
    const gens = all.filter(u => !q || norm(`${u.displayName} ${u.city} ${u.instagram} ${u.email}`).includes(q))
      .sort((a, b) => String(a.displayName).localeCompare(String(b.displayName)));
    $("#general-count").textContent = `(${all.length})`;
    $("#general-roster").innerHTML = gens.map(u => {
      const wa = waNumber(u.whatsapp);
      const since = fmtDate(u.approvedAt || u.createdAt, { day: "numeric", month: "short", year: "numeric" });
      return `<div class="r-item r-general">
        <span class="r-no">${u.photoURL ? `<img src="${esc(u.photoURL)}" alt="" referrerpolicy="no-referrer">` : esc(initials(u.displayName))}</span>
        <span><strong>${esc(u.displayName)}</strong>
          <small>${[u.city, u.instagram && "@" + u.instagram].filter(Boolean).map(esc).join(" · ") || "—"}</small>
          <small>${[u.whatsapp, u.email].filter(Boolean).map(esc).join(" · ")}</small>
          ${since ? `<small class="muted">${t("registered_on", { date: since })}</small>` : ""}
          ${wa ? `<a class="r-wa" href="https://wa.me/${wa}" target="_blank" rel="noopener">WhatsApp</a>` : ""}
          ${u.role !== "admin" ? `<button type="button" class="r-deact" data-deactivate="${esc(u.id)}">${t("deactivate")}</button>` : ""}</span>
      </div>`;
    }).join("") || `<p class="empty">${t(all.length ? "no_results" : "no_general")}</p>`;
  }
}
$("#member-profile").addEventListener("submit", async (e) => {
  if (e.target.id !== "f-invite") return;
  e.preventDefault();
  const f = e.target; const id = f.dataset.r; const r = (state.roster || []).find(x => x.id === id);
  const phone = f.phone.value.trim();
  const btn = f.querySelector("[type=submit]"); btn.disabled = true;
  try {
    await setInvitePhone(r, phone);
    toast(t("saved"));
  } catch (err) { fail(err); }
  btn.disabled = false;
});
// Save a member's phone: private copy for admins + a phone invite used for automatic activation.
async function setInvitePhone(r, phone) {
  const oldKey = phoneKey((state.rosterPrivate[r.id] || {}).phone);
  const key = phoneKey(phone);
  const batch = writeBatch(db);
  if (oldKey && oldKey !== key) batch.delete(doc(db, "phoneInvites", oldKey));
  if (key && r.memberNo) batch.set(doc(db, "phoneInvites", key), { rosterId: r.id, memberNo: r.memberNo, name: r.name || "", city: r.city || "" });
  batch.set(doc(db, "rosterPrivate", r.id), { phone }, { merge: true });
  await batch.commit();
  state.rosterPrivate[r.id] = { ...(state.rosterPrivate[r.id] || {}), phone };
}
// Save a member's Google email: private copy for admins + an invite the member can read at sign-in.
async function setInviteEmail(r, email) {
  const old = (state.rosterPrivate[r.id] || {}).email || "";
  const batch = writeBatch(db);
  if (old && old !== email) batch.delete(doc(db, "invites", old));
  if (email) batch.set(doc(db, "invites", email), { rosterId: r.id, memberNo: r.memberNo ?? null, name: r.name || "", city: r.city || "" });
  batch.set(doc(db, "rosterPrivate", r.id), { email }, { merge: true });
  await batch.commit();
  state.rosterPrivate[r.id] = { ...(state.rosterPrivate[r.id] || {}), email };
}

/* ---------- Members: sync from the RCMI Membership Registration sheet (admins only) ---------- */
async function syncMembersFromSheet(sheetId) {
  // Only the "RCMI Member List" tab is used.
  const tabs = (await readSpreadsheet(sheetId)).filter(x => /member\s*list/i.test(x.title));
  if (!tabs.length) throw new Error(t("sheet_no_member_list"));
  const { members } = parseMemberSheets(tabs);
  const applicants = [];
  if (!members.length && !applicants.length) throw new Error(t("sheet_no_members"));
  await fetchRoster(true);
  const existing = new Map((state.roster || []).map(r => [r.id, r]));
  const rid = (no) => `m${String(no).padStart(3, "0")}`;
  const writes = [];
  for (const m of members) {
    const id = rid(m.no), old = existing.get(id) || {};
    // The sheet decides number, name, phone and T-shirt. City/province/join date only fill gaps, so manual corrections stay.
    writes.push(["roster", id, { memberNo: m.no, name: m.name, status: "member",
      ...(old.province ? {} : { province: m.province || "" }), ...(old.joined ? {} : { joined: m.joined || "" }), ...(old.city ? {} : { city: old.city || "" }) }]);
    writes.push(["rosterPrivate", id, { phone: m.phone || "", ...(m.shirt ? { shirtSize: m.shirt.size || "", shirtQty: m.shirt.qty || 1, shirtPaid: !!m.shirt.paid } : {}) }]);
    const pk = sheetPhoneKey(m.phone);
    if (pk) writes.push(["phoneInvites", pk, { rosterId: id, memberNo: m.no, name: m.name, city: old.city || "" }]);
  }
  const numberedNames = new Set(members.map(m => m.name.toLowerCase()));
  for (const a of applicants) {
    const id = `a-${a.key}`;
    if (numberedNames.has(a.name.toLowerCase())) continue;
    writes.push(["roster", id, { memberNo: existing.get(id)?.memberNo ?? null, name: a.name, province: a.province || "", status: existing.get(id)?.status || "applicant", applied: a.applied || "" }]);
    writes.push(["rosterPrivate", id, { phone: a.phone || "" }]);
  }
  // Old applicant entries for people who now have a member number in the sheet are removed (same name or same phone),
  // unless an account was already linked to them.
  const memberPhones = new Set(members.map(m => sheetPhoneKey(m.phone)).filter(Boolean));
  const memberNames = new Set(members.map(m => m.name.toLowerCase().replace(/\s+/g, " ").trim()));
  // Applicants aren't taken from the sheet any more: remove leftover applicant entries nobody has linked to.
  const removes = (state.roster || []).filter(r => r.id.startsWith("a-") && !r.claimedBy).map(r => r.id);
  const skip = new Set(removes);
  const ops = [
    ...writes.filter(([c, id]) => !((c === "roster" || c === "rosterPrivate") && skip.has(id))).map(w => ["set", ...w]),
    ...removes.flatMap(id => [["del", "roster", id], ["del", "rosterPrivate", id]])
  ];
  for (let i = 0; i < ops.length; i += 400) {
    const batch = writeBatch(db);
    ops.slice(i, i + 400).forEach(([op, c, id, data]) => op === "del" ? batch.delete(doc(db, c, id)) : batch.set(doc(db, c, id), data, { merge: true }));
    await batch.commit();
  }
  // Keep the next member number ahead of the highest number in the sheet.
  const maxNo = Math.max(0, ...members.map(m => m.no));
  await runTransaction(db, async (tx) => {
    const cRef = doc(db, "counters", "members"); const c = await tx.get(cRef);
    tx.set(cRef, { next: Math.max(c.exists() ? c.data().next || 1 : 1, maxNo + 1) });
  });
  return { members: members.length, applicants: applicants.length };
}
function askMemberSheet() {
  openModal(`
    <h2>${t("mem_sync")}</h2>
    <p class="muted">${t("mem_sync_help")}</p>
    <form class="form" id="f-msheet">
      <label><span>${t("fin_sheet_link")}</span><input name="link" required placeholder="https://docs.google.com/spreadsheets/d/…" value="${esc(state.memSource?.link || "")}"></label>
      <div class="form-actions">
        <button type="button" class="btn btn-ghost" data-act="close">${t("cancel")}</button>
        <button class="btn btn-mat" type="submit">${t("mem_sync")}</button>
      </div>
    </form>`);
  $("#modal-body").onclick = (ev) => { if (ev.target.dataset.act === "close") closeModal(); };
  $("#f-msheet").addEventListener("submit", async (e) => {
    e.preventDefault(); const btn = e.target.querySelector("[type=submit]"); btn.disabled = true;
    const link = e.target.link.value.trim(); const id = sheetIdFrom(link);
    if (!id) { toast(t("fin_sheet_bad")); btn.disabled = false; return; }
    try {
      const r = await syncMembersFromSheet(id);
      await setDoc(doc(db, "sources", "members"), { link, sheetId: id, savedBy: state.user.uid });
      state.memSource = { link, sheetId: id };
      closeModal(); toast(t("mem_sync_done", r)); state.roster = null; loadMembers();
    } catch (err) { fail(err); btn.disabled = false; }
  });
}
$("#mem-sync").addEventListener("click", async (e) => {
  if (!state.memSource) { try { const s = await getDoc(doc(db, "sources", "members")); state.memSource = s.exists() ? s.data() : null; } catch (err) {} }
  if (!state.memSource?.sheetId) return askMemberSheet();
  const btn = e.currentTarget; btn.disabled = true;
  try { const r = await syncMembersFromSheet(state.memSource.sheetId); toast(t("mem_sync_done", r)); state.roster = null; loadMembers(); }
  catch (err) { fail(err); }
  btn.disabled = false;
});
$("#mem-sync-link").addEventListener("click", async () => {
  if (!state.memSource) { try { const s = await getDoc(doc(db, "sources", "members")); state.memSource = s.exists() ? s.data() : null; } catch (err) {} }
  askMemberSheet();
});

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
  const deact = isAdmin() && r.claimedBy ? (state.deactUsers || {})[r.claimedBy] : null;
  const u = r.claimedBy ? state.siteUsers[r.claimedBy] || deact : null;
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
          <dt>Status</dt><dd>${deact ? `<span class="type-tag blocked">${t("deact_tag")}</span>` : u ? "✓ " + t("on_site") : t("not_on_site")}</dd>
        </dl>
        ${priv ? `<div class="admin-box"><small>${t("admin_only")}</small>
          ${priv.phone ? `${t("phone")}: <a href="https://wa.me/${waNumber(priv.phone)}" target="_blank" rel="noopener">${esc(priv.phone)}</a><br>` : ""}
          ${priv.shirtSize ? `${t("shirt")}: ${esc(priv.shirtSize)} × ${priv.shirtQty || 1} — ${priv.shirtPaid ? t("paid") : t("unpaid")}<br>` : ""}
          <span id="profile-dues"></span>
          <form class="invite-form" id="f-invite" data-r="${esc(r.id)}">
            <label for="invite-phone">${t("phone_label_admin")}</label>
            <div class="invite-row">
              <input id="invite-phone" type="tel" name="phone" value="${esc(priv.phone || "")}" placeholder="08…" autocomplete="off" inputmode="tel">
              <button class="btn btn-sm btn-mat" type="submit">${t("save")}</button>
            </div>
            <small class="muted">${r.claimedBy ? t("gmail_linked") : t("phone_hint_admin")}</small>
          </form>
        </div>` : ""}
        ${isAdmin() && u && u.id !== state.user.uid && u.role !== "admin" ? `<div class="deact-box">
          ${deact ? `<p class="muted">${t("deact_is")}</p><button type="button" class="btn btn-mat" data-reactivate="${esc(u.id)}">${t("reactivate")}</button>`
                  : `<button type="button" class="btn btn-danger" data-deactivate="${esc(u.id)}">${t("deactivate")}</button><small class="muted">${t("deact_hint")}</small>`}
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
    const cars = cs.docs.map(d => ({ id: d.id, ...d.data() })).filter(c => !c.hidden || isAdmin());
    const listings = ls.docs.map(d => ({ id: d.id, ...d.data() })).filter(l => l.status !== "sold" && (!l.hidden || isAdmin()));
    const tile = (x, title) => `<div class="item">${x.photos?.[0] ? `<img class="ph" src="${photoSrc(x.photos[0])}" alt="" loading="lazy">` : `<div class="ph ph-empty">1:64</div>`}<div class="meta"><h3>${esc(title)}</h3>${x.price ? `<p class="price">${fmtIDR(x.price)}</p>` : x.maker ? `<p>${esc(x.maker)}</p>` : ""}</div></div>`;
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
// Dues are counted from July 2025 (when RCMI started collecting kas), or from a member's join month if later.
const PAY_DEFAULTS = { amount: 50000, dueDay: 10, bank: "", accountNo: "", accountName: "", trackFrom: "2025-07" };
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
  const lastAhead = Object.keys(byMonth).filter(m => m > ym()).sort().pop();
  const months = monthRange(from, lastAhead || ym()).reverse();
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
          <button class="btn btn-sm btn-ghost" data-dact="upto" data-r="${esc(r.id)}">${t("paid_upto")}</button>
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

// Admin: mark every month from the member's start up to a chosen month as paid, in one go (e.g. "paid up to July 2027").
async function openPaidUpTo(r) {
  const start = [state.pay.trackFrom || "2025-07", r.joined ? r.joined.slice(0, 7) : ""].sort().pop();
  const options = monthRange(start, addMonth(ym(), 24));
  let existing = {};
  try {
    const snap = await getDocs(query(collection(db, "dues"), where("rosterId", "==", r.id)));
    snap.docs.forEach(d => { existing[d.data().month] = d.data(); });
  } catch (e) { fail(e); return; }
  const lastPaid = Object.keys(existing).filter(m => ["paid", "waived"].includes(existing[m].status)).sort().pop();
  openModal(`
    <h2>${t("paid_upto_title", { name: esc(r.name) })}</h2>
    <p class="muted">${t("paid_upto_help", { start: monthLabel(start) })}</p>
    <form class="form" id="f-upto">
      <label><span>${t("paid_upto_label")}</span>
        <select name="month">${options.map(m => `<option value="${m}" ${m === (lastPaid || ym()) ? "selected" : ""}>${monthLabel(m)}</option>`).join("")}</select>
      </label>
      <div class="form-actions">
        <button type="button" class="btn btn-ghost" data-act="close">${t("cancel")}</button>
        <button class="btn btn-mat" type="submit">${t("save")}</button>
      </div>
    </form>`);
  $("#modal-body").onclick = (ev) => { if (ev.target.dataset.act === "close") closeModal(); };
  $("#f-upto").addEventListener("submit", async (e) => {
    e.preventDefault(); const btn = e.target.querySelector("[type=submit]"); btn.disabled = true;
    const until = e.target.month.value;
    const todo = monthRange(start, until).filter(m => !["paid", "waived"].includes(existing[m]?.status));
    try {
      for (let i = 0; i < todo.length; i += 400) {
        const batch = writeBatch(db);
        todo.slice(i, i + 400).forEach(m => batch.set(doc(db, "dues", `${r.id}_${m}`), {
          rosterId: r.id, month: m, memberNo: r.memberNo, name: r.name, uid: existing[m]?.uid || r.claimedBy || null,
          amount: existing[m]?.amount || state.pay.amount, status: "paid", paidAt: serverTimestamp(), confirmedBy: state.user.uid,
          note: existing[m]?.note || t("paid_upto_note")
        }, { merge: true }));
        await batch.commit();
      }
      closeModal(); toast(t("paid_upto_done", { n: todo.length, month: monthLabel(until) })); renderDuesAll();
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
    if (b.dataset.dact === "upto") { openPaidUpTo(r); return; }
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
// Google profile photos come small (…=s96-c); ask for a sharper square version for the card.
const bigPhoto = (u) => String(u || "").replace(/=s\d+(-c)?$/, "=s400-c");
// Digital version of the printed RCMI member card: pearl card, EXCLUSIVE MEMBER, logo, RCMI QR, name and number.
function cardHTML({ no, name, city, instagram, photoURL, since }) {
  const sub = [city, instagram ? "@" + igHandle(instagram) : "", since ? `${t("card_since")} ${fmtDate(since, { month: "short", year: "numeric" })}` : ""].filter(Boolean).map(esc).join(" · ");
  return `
    <div class="mcard" role="img" aria-label="RCMI ${esc(name)} ${no ? "#" + no : ""}">
      <p class="mcard-kicker">Exclusive Member</p>
      <img class="mcard-logo" src="/img/logo-dark.png" alt="">
      ${photoURL
        ? `<img class="mcard-photo" src="${esc(bigPhoto(photoURL))}" alt="" referrerpolicy="no-referrer" onerror="this.outerHTML='<div class=&quot;mcard-photo mcard-initials&quot;>${esc(initials(name))}</div>'">`
        : `<div class="mcard-photo mcard-initials">${esc(initials(name))}</div>`}
      <p class="mcard-name">${esc(name)}</p>
      <p class="mcard-no">${no ? "#" + no : esc(t("applicant"))}</p>
      ${sub ? `<p class="mcard-sub">${sub}</p>` : ""}
    </div>`;
}
function renderCard() {
  const p = state.profile;
  $("#member-card").hidden = isGeneral();
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
    saveContact({ displayName: f.displayName.value.trim(), whatsapp: f.whatsapp.value.trim(), instagram: f.instagram.value });
    toast(t("profile_saved"));
  } catch (err) { fail(err); }
});

/* ================= Finance: Laba Rugi (admins only) ================= */
state.finPeriod = "all";
async function loadFinance() {
  if (isGeneral()) return;
  try {
    const [snap, src] = await Promise.all([getDoc(doc(db, "finance", "ledger")), isAdmin() ? getDoc(doc(db, "finance", "source")) : Promise.resolve(null)]);
    state.ledger = snap.exists() ? snap.data() : null;
    state.finSource = src?.exists() ? src.data() : null;
    renderFinance();
  } catch (e) { fail(e); }
}
const idr = (n) => (n < 0 ? "(" : "") + "Rp" + Math.abs(Math.round(n)).toLocaleString("id-ID") + (n < 0 ? ")" : "");
const monthName = (ym) => { const [y, m] = ym.split("-").map(Number); return new Date(y, m - 1, 1).toLocaleDateString(locale(), { month: "long", year: "numeric" }); };
function periodRange(p) {
  if (p === "all") return ["", "9999-12-31"];
  if (/^\d{4}$/.test(p)) return [`${p}-01-01`, `${p}-12-31`];
  return [`${p}-01`, `${p}-31`];
}
function renderFinance() {
  const body = $("#fin-body"); if (!body) return;
  const L = state.ledger;
  // Members view; only admins sync or import.
  const admin = isAdmin();
  $("#fin-sync").hidden = !admin;
  $("#fin-sync-link").hidden = !admin || !state.finSource?.sheetId;
  $(".fin-import").hidden = !admin;
  const note = $(".fin-note [data-i18n]"); note.dataset.i18n = admin ? "fin_only_admin" : "fin_members_view"; note.textContent = t(note.dataset.i18n);
  $("#fin-source").innerHTML = "";
  if (state.finSource?.sheetId) $("#fin-source").insertAdjacentHTML("afterend", "");
  $("#fin-source").textContent = L ? t("fin_imported", { n: L.rows.length, date: fmtDate(L.importedAt, { day: "numeric", month: "short", year: "numeric" }), file: L.fileName || "CSV" }) : "";
  const sel = $("#fin-period");
  if (!L || !L.rows?.length) {
    sel.hidden = true; $("#fin-print").hidden = true;
    body.innerHTML = `<div class="empty fin-empty"><p><strong>${t("fin_empty")}</strong></p>${admin ? `<p>${t("fin_import_help")}</p>` : ""}</div>`;
    return;
  }
  sel.hidden = false; $("#fin-print").hidden = false;
  const rows = L.rows;
  const years = [...new Set(rows.map(r => r.date.slice(0, 4)))].sort();
  const months = [...new Set(rows.map(r => r.date.slice(0, 7)))].sort();
  sel.innerHTML = `<option value="all">${t("fin_period_all")}</option>`
    + years.map(y => `<option value="${y}">${y}</option>`).join("")
    + `<optgroup label="${t("fin_month")}">${months.map(m => `<option value="${m}">${monthName(m)}</option>`).join("")}</optgroup>`;
  sel.value = state.finPeriod;
  const [from, to] = periodRange(state.finPeriod);
  const pl = buildPL(rows, from, to);
  const issues = balanceIssues(rows);
  const periodLabel = state.finPeriod === "all" ? `${fmtDate(rows[0].date, { day: "numeric", month: "short", year: "numeric" })} – ${fmtDate(rows.at(-1).date, { day: "numeric", month: "short", year: "numeric" })}` : (/^\d{4}$/.test(state.finPeriod) ? state.finPeriod : monthName(state.finPeriod));
  const line = (label, amt, cls = "") => `<tr class="${cls}"><td>${esc(label)}</td><td class="num">${idr(amt)}</td></tr>`;

  body.innerHTML = `
    <div class="fin-tiles">
      <div class="fin-tile"><span>${t("fin_income")}</span><b>${idr(pl.totalIncome)}</b></div>
      <div class="fin-tile"><span>${t("fin_expense")}</span><b>${idr(pl.totalExpense)}</b></div>
      <div class="fin-tile ${pl.net < 0 ? "neg" : "pos"}"><span>${t(pl.net < 0 ? "fin_deficit" : "fin_surplus")}</span><b>${idr(pl.net)}</b></div>
      <div class="fin-tile dark"><span>${t("fin_closing")}</span><b>${idr(pl.closing)}</b></div>
    </div>

    <div class="fin-grid">
      <section class="panel-flat fin-pl">
        <h3>${t("fin_pl_title")}</h3>
        <p class="muted">${esc(periodLabel)} · ${t("fin_tx", { n: pl.count })}</p>
        <table class="fin-table">
          <tbody>
            <tr class="sec"><td colspan="2">${t("fin_income")}</td></tr>
            ${pl.income.map(l => line(l.label, l.amount)).join("")}
            ${line(t("fin_total_income"), pl.totalIncome, "total")}
            <tr class="sec"><td colspan="2">${t("fin_expense")}</td></tr>
            ${pl.groups.map(g => `
              <tr class="grp"><td>${esc(g.name)}</td><td class="num">${idr(g.total)}</td></tr>
              ${g.lines.map(l => line(l.label, l.amount, "sub")).join("")}`).join("")}
            ${line(t("fin_total_expense"), pl.totalExpense, "total")}
            ${line(t(pl.net < 0 ? "fin_deficit" : "fin_surplus"), pl.net, "net")}
            ${state.finPeriod !== "all" ? line(t("fin_opening"), pl.opening, "sub") + line(t("fin_closing"), pl.closing, "sub") : ""}
          </tbody>
        </table>
      </section>

      <div class="fin-side">
        ${pl.ids.income || pl.ids.expense ? `
        <section class="panel-flat fin-card">
          <h3>${t("fin_ids_title")}</h3>
          <table class="fin-table">
            ${line(t("fin_ids_income"), pl.ids.income)}
            ${line(t("fin_ids_expense"), -pl.ids.expense)}
            ${line(t("fin_result"), pl.ids.net, "net")}
          </table>
          <p class="muted small">${t("fin_ids_note")}</p>
        </section>` : ""}
        ${pl.rims.sales || pl.rims.cost ? `
        <section class="panel-flat fin-card">
          <h3>${t("fin_rims_title")}</h3>
          <table class="fin-table">
            ${line(t("fin_rims_sales", { n: pl.rims.sets }), pl.rims.sales)}
            ${line(t("fin_rims_cost"), -pl.rims.cost)}
            ${line(t("fin_result"), pl.rims.net, "net")}
          </table>
          <p class="muted small">${t("fin_rims_note")}</p>
        </section>` : ""}
        ${issues.length ? `
        <section class="fin-warn">
          <h3>${t("fin_issues_title")}</h3>
          ${issues.slice(0, 1).map(i => `<p>${t("fin_issue_line", { no: i.no, date: fmtDate(i.date, { day: "numeric", month: "short", year: "numeric" }), desc: esc(i.desc), sheet: idr(i.saldo), calc: idr(i.calc), diff: idr(i.diff) })}</p>`).join("")}
          <p class="small">${t("fin_issue_end", { sheet: idr(rows.at(-1).saldo ?? 0), calc: idr(rows.reduce((a, r) => a + r.income - r.expense, 0)) })}</p>
        </section>` : ""}
      </div>
    </div>

    <section class="panel-flat fin-monthly">
      <h3>${t("fin_monthly")}</h3>
      <table class="fin-table cols">
        <thead><tr><th>${t("fin_month")}</th><th class="num">${t("fin_income")}</th><th class="num">${t("fin_expense")}</th><th class="num">${t("fin_net_short")}</th><th class="num">${t("fin_balance")}</th></tr></thead>
        <tbody>${pl.monthly.map(m => `<tr><td>${monthName(m.month)}</td><td class="num">${idr(m.income)}</td><td class="num">${idr(m.expense)}</td><td class="num ${m.net < 0 ? "neg" : ""}">${idr(m.net)}</td><td class="num">${idr(m.balance)}</td></tr>`).join("")}</tbody>
      </table>
    </section>

    <details class="panel-flat fin-ledger">
      <summary><strong>${t("fin_ledger", { n: pl.count })}</strong></summary>
      <table class="fin-table cols">
        <thead><tr><th>${t("fin_date")}</th><th>${t("fin_desc")}</th><th>${t("fin_category")}</th><th class="num">${t("fin_amount")}</th></tr></thead>
        <tbody>${pl.detail.map(d => `<tr><td>${fmtDate(d.date, { day: "2-digit", month: "short", year: "2-digit" })}</td><td>${esc(d.desc)}${d.note && d.note !== "-" ? `<small>${esc(d.note)}</small>` : ""}</td><td><small>${esc(d.line)}</small></td><td class="num ${d.kind === "expense" ? "neg" : ""}">${d.kind === "expense" ? "−" : ""}${idr(d.amount)}</td></tr>`).join("")}</tbody>
      </table>
    </details>`;
}
$("#fin-period").addEventListener("change", (e) => { state.finPeriod = e.target.value; renderFinance(); });
$("#fin-print").addEventListener("click", () => window.print());
/* ---------- Reading private Google Sheets with the admin's own Google account ---------- */
// The admin grants "view your Google Sheets" once per session; sheets stay private (no link sharing needed).
// Sheet links are kept in Firestore (admins only), never in the site's public code.
const sheetIdFrom = (s) => (String(s).match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]{20,})/) || String(s).match(/^([a-zA-Z0-9_-]{30,})$/) || [])[1] || "";
let sheetsToken = null, sheetsTokenAt = 0;
async function getSheetsToken() {
  if (sheetsToken && Date.now() - sheetsTokenAt < 50 * 60e3) return sheetsToken;
  const p = new GoogleAuthProvider();
  p.addScope("https://www.googleapis.com/auth/spreadsheets.readonly");
  p.setCustomParameters({ login_hint: state.user.email || "" });
  const res = await reauthenticateWithPopup(auth.currentUser, p);
  sheetsToken = GoogleAuthProvider.credentialFromResult(res)?.accessToken;
  sheetsTokenAt = Date.now();
  if (!sheetsToken) throw new Error(t("sheet_no_access"));
  return sheetsToken;
}
/** All tabs of a spreadsheet: [{ title, gid, rows }]. */
async function readSpreadsheet(sheetId) {
  const tok = await getSheetsToken();
  const api = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}`;
  const call = async (url) => {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${tok}` } });
    if (res.status === 401) { sheetsToken = null; throw new Error(t("sheet_no_access")); }
    if (res.status === 403) { const b = await res.text(); throw new Error(/has not been used|disabled/i.test(b) ? t("sheet_api_off") : t("sheet_no_access")); }
    if (res.status === 404) throw new Error(t("sheet_not_found"));
    if (!res.ok) throw new Error(`Google Sheets ${res.status}`);
    return res.json();
  };
  const meta = await call(`${api}?fields=sheets.properties(title,sheetId)`);
  const tabs = (meta.sheets || []).map(s => s.properties);
  const ranges = tabs.map(p => "ranges=" + encodeURIComponent(`'${p.title.replace(/'/g, "''")}'`)).join("&");
  const vals = await call(`${api}/values:batchGet?${ranges}&valueRenderOption=FORMATTED_VALUE`);
  return tabs.map((p, i) => ({ title: p.title, gid: String(p.sheetId), rows: vals.valueRanges?.[i]?.values || [] }));
}
async function syncFromSheet(sheetId, gid) {
  const tabs = await readSpreadsheet(sheetId);
  const tab = tabs.find(x => gid && x.gid === String(gid)) || tabs.find(x => x.rows.some(r => r.some(c => /^tanggal/i.test(String(c).trim())))) || tabs[0];
  const rows = parseLedgerTable(tab?.rows || []);
  if (!rows.length) throw new Error(t("fin_parse_empty"));
  await setDoc(doc(db, "finance", "ledger"), { rows, fileName: "Google Sheet", importedAt: serverTimestamp(), importedBy: state.user.uid });
  return rows.length;
}
function askSheetLink() {
  openModal(`
    <h2>${t("fin_sync")}</h2>
    <p class="muted">${t("fin_sync_help")}</p>
    <form class="form" id="f-sheet">
      <label><span>${t("fin_sheet_link")}</span><input name="link" required placeholder="https://docs.google.com/spreadsheets/d/…" value="${esc(state.finSource?.link || "")}"></label>
      <div class="form-actions">
        <button type="button" class="btn btn-ghost" data-act="close">${t("cancel")}</button>
        <button class="btn btn-mat" type="submit">${t("fin_sync")}</button>
      </div>
    </form>`);
  $("#modal-body").onclick = (ev) => { if (ev.target.dataset.act === "close") closeModal(); };
  $("#f-sheet").addEventListener("submit", async (e) => {
    e.preventDefault(); const btn = e.target.querySelector("[type=submit]"); btn.disabled = true;
    const link = e.target.link.value.trim(); const id = sheetIdFrom(link);
    const gid = (link.match(/[#&?]gid=(\d+)/) || [])[1] || "";
    if (!id) { toast(t("fin_sheet_bad")); btn.disabled = false; return; }
    try {
      const n = await syncFromSheet(id, gid);
      await setDoc(doc(db, "finance", "source"), { link, sheetId: id, gid, savedBy: state.user.uid });
      closeModal(); toast(t("fin_import_done", { n })); state.finPeriod = "all"; loadFinance();
    } catch (err) { fail(err); btn.disabled = false; }
  });
}
$("#fin-sync").addEventListener("click", async (e) => {
  const src = state.finSource;
  if (!src?.sheetId) return askSheetLink();
  const btn = e.currentTarget; btn.disabled = true;
  try { const n = await syncFromSheet(src.sheetId, src.gid); toast(t("fin_import_done", { n })); loadFinance(); }
  catch (err) { fail(err); }
  btn.disabled = false;
});
$("#fin-sync").addEventListener("contextmenu", (e) => { e.preventDefault(); askSheetLink(); });
$("#fin-sync-link").addEventListener("click", () => askSheetLink());

$("#fin-file").addEventListener("change", async (e) => {
  const file = e.target.files[0]; if (!file) return;
  try {
    const rows = parseLedgerCSV(await file.text());
    if (!rows.length) throw new Error(t("fin_parse_empty"));
    await setDoc(doc(db, "finance", "ledger"), { rows, fileName: file.name, importedAt: serverTimestamp(), importedBy: state.user.uid });
    toast(t("fin_import_done", { n: rows.length }));
    state.finPeriod = "all"; loadFinance();
  } catch (err) { fail(err); }
  e.target.value = "";
});

/* ================= Contact us (signed-in users send; admins read) ================= */
function renderContact() {
  const f = $("#form-contact"); if (!f) return;
  const user = state.user;
  $("#contact-signin").hidden = !!user;
  f.hidden = !user || !$("#contact-done").hidden;
  if (user) {
    if (!f.name.value) f.name.value = state.profile?.displayName || user.displayName || "";
    if (!f.contact.value) f.contact.value = state.profile?.whatsapp || user.email || "";
  }
}
$$(".js-contact-signin").forEach(b => b.addEventListener("click", () => { setEnter(false); signIn(); }));
$("#form-contact").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target; const btn = f.querySelector("[type=submit]");
  if (f.website.value) return; // bot trap
  btn.disabled = true;
  try {
    await addDoc(collection(db, "messages"), {
      name: f.name.value.trim().slice(0, 80), contact: f.contact.value.trim().slice(0, 120), topic: f.topic.value,
      message: f.message.value.trim().slice(0, 2000), status: "new", createdAt: serverTimestamp(),
      uid: state.user.uid, email: state.user.email || "", lang: getLang()
    });
    f.reset(); f.hidden = true; $("#contact-done").hidden = false;
  } catch (err) { fail(err); }
  btn.disabled = false;
});

const TOPIC_KEY = { keanggotaan: "topic_membership", iuran: "topic_dues", pasar: "topic_market", acara: "topic_events", lainnya: "topic_other" };
async function refreshInboxCount() {
  if (!isAdmin()) return;
  try {
    const snap = await getDocs(query(collection(db, "messages"), where("status", "==", "new")));
    const n = snap.docs.length;
    $("#tab-admin").dataset.count = n ? String(n) : "";
    $("#inbox-count").textContent = n ? t("inbox_new", { n }) : "";
  } catch (e) {}
}
async function loadInbox() {
  if (!isAdmin()) return;
  try {
    const snap = await getDocs(query(collection(db, "messages"), orderBy("createdAt", "desc"), limit(100)));
    state.inbox = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    const box = $("#admin-inbox");
    box.innerHTML = state.inbox.length ? state.inbox.map(m => {
      const isEmail = /@/.test(m.contact);
      const wa = !isEmail ? waNumber(m.contact) : "";
      const reply = isEmail ? `mailto:${encodeURIComponent(m.contact)}?subject=${encodeURIComponent("RCMI — " + t(TOPIC_KEY[m.topic] || "topic_other"))}`
        : wa ? `https://wa.me/${wa}` : (m.email ? `mailto:${encodeURIComponent(m.email)}` : "");
      return `<article class="msg ${m.status === "new" ? "msg-new" : ""}">
        <div class="msg-head">
          <strong>${esc(m.name)}</strong>
          <span class="tag">${esc(t(TOPIC_KEY[m.topic] || "topic_other"))}</span>
          ${m.status === "new" ? `<span class="tag tag-sell">${t("inbox_unread")}</span>` : ""}
          <small class="muted">${fmtDate(m.createdAt, { day: "numeric", month: "short", year: "numeric" })}${m.createdAt ? " " + toDate(m.createdAt).toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit" }) : ""}</small>
        </div>
        <p class="msg-body">${esc(m.message)}</p>
        <small class="muted">${esc(m.contact)}${m.email && m.email !== m.contact ? " · " + esc(m.email) : ""}</small>
        <div class="actions">
          ${reply ? `<a class="btn btn-sm btn-mat" target="_blank" rel="noopener" href="${reply}">${t(isEmail || !wa ? "inbox_reply_email" : "inbox_reply_wa")}</a>` : ""}
          ${m.status === "new" ? `<button class="btn btn-sm btn-ghost" data-mact="done" data-m="${esc(m.id)}">${t("inbox_done")}</button>`
                               : `<button class="btn btn-sm btn-ghost" data-mact="new" data-m="${esc(m.id)}">${t("inbox_mark_new")}</button>`}
          <button class="btn btn-sm btn-danger" data-mact="del" data-m="${esc(m.id)}">${t("delete")}</button>
        </div>
      </article>`;
    }).join("") : `<p class="muted">${t("inbox_empty")}</p>`;
    refreshInboxCount();
  } catch (e) { fail(e); }
}
$("#admin-inbox").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-mact]"); if (!b) return;
  const ref = doc(db, "messages", b.dataset.m);
  try {
    if (b.dataset.mact === "done") await updateDoc(ref, { status: "done" });
    if (b.dataset.mact === "new") await updateDoc(ref, { status: "new" });
    if (b.dataset.mact === "del") { if (!confirm(t("confirm_delete"))) return; await deleteDoc(ref); }
    loadInbox();
  } catch (err) { fail(err); }
});

/* ================= Admin ================= */
async function loadAdmin() {
  if (!isAdmin()) return;
  refreshMigrate(); loadModHidden();
  loadInbox();
  try {
    const [pend] = await Promise.all([
      getDocs(query(collection(db, "users"), where("status", "==", "pending"))),
      fetchRoster(true)
    ]);
    const pending = state.pending = pend.docs.map(d => ({ id: d.id, ...d.data() }));
    const deactList = Object.values(state.deactUsers || {});
    $("#admin-deact-count").textContent = `(${deactList.length})`;
    $("#admin-deact").innerHTML = deactList.length ? deactList.map(u => `
      <div class="row">
        <img src="${esc(u.photoURL)}" alt="" referrerpolicy="no-referrer">
        <div class="grow"><strong>${u.memberNo && u.accountType !== "general" ? memberNo(u.memberNo) + " · " : ""}${esc(u.displayName)}</strong><span class="type-tag blocked">${t("deact_tag")}</span>
          <small>${[u.city, u.email].filter(Boolean).map(esc).join(" · ")}</small>
          ${u.deactivatedAt ? `<small class="muted">${t("deact_on", { date: fmtDate(u.deactivatedAt, { day: "numeric", month: "short", year: "numeric" }) })}</small>` : ""}</div>
        <div class="actions"><button class="btn btn-sm btn-mat" data-reactivate="${esc(u.id)}">${t("reactivate")}</button></div>
      </div>`).join("") : `<p class="muted">${t("no_deact")}</p>`;
    getDocs(collection(db, "blocked")).then(s => {
      const list = state.blocked = s.docs.map(d => ({ id: d.id, ...d.data() }));
      $("#admin-blocked-count").textContent = `(${list.length})`;
      $("#admin-blocked").innerHTML = list.length ? list.map(b => `
        <div class="row">
          <div class="grow"><strong>${esc(b.name || b.id)}</strong><span class="type-tag blocked">${t("blocked_tag")}</span>
            <small>${[b.city, b.id].filter(Boolean).map(esc).join(" · ")}</small>
            ${b.blockedAt ? `<small class="muted">${t("blocked_on", { date: fmtDate(b.blockedAt, { day: "numeric", month: "short", year: "numeric" }) })}</small>` : ""}</div>
          <div class="actions"><button class="btn btn-sm btn-ghost" data-unblock="${esc(b.id)}">${t("unblock")}</button></div>
        </div>`).join("") : `<p class="muted">${t("no_blocked")}</p>`;
    }).catch(() => {});
    const proofs = state.joinProofs = {};
    await Promise.all(pending.filter(u => u.accountType !== "general").map(u =>
      getDoc(doc(db, "joinPayments", u.id)).then(s => { if (s.exists()) proofs[u.id] = s.data(); }).catch(() => {})));
    const all = Object.values(state.siteUsers);
    const members = state.members = all.filter(u => u.accountType !== "general").sort((a, b) => (a.memberNo || 0) - (b.memberNo || 0));
    const generals = all.filter(u => u.accountType === "general").sort((a, b) => String(a.displayName).localeCompare(String(b.displayName)));
    $("#admin-members-count").textContent = `(${members.length})`;
    $("#admin-general-count").textContent = `(${generals.length})`;
    const since = (u) => fmtDate(u.approvedAt || u.createdAt, { day: "numeric", month: "short", year: "numeric" });
    $("#admin-general").innerHTML = generals.length ? generals.map(u => `
      <div class="row">
        <img src="${esc(u.photoURL)}" alt="" referrerpolicy="no-referrer">
        <div class="grow"><strong>${esc(u.displayName)}</strong><span class="type-tag general">${t("type_general")}</span>
          <small>${esc(u.city)}${u.instagram ? " · @" + esc(u.instagram) : ""}${u.email ? " · " + esc(u.email) : ""}${u.whatsapp ? " · " + esc(u.whatsapp) : ""}</small>
          ${since(u) ? `<small>${t("registered_on", { date: since(u) })}</small>` : ""}</div>
        <div class="actions">
          ${waNumber(u.whatsapp) ? `<a class="btn btn-sm btn-ghost" target="_blank" rel="noopener" href="https://wa.me/${waNumber(u.whatsapp)}">WhatsApp</a>` : ""}
          ${u.role !== "admin" ? `<button class="btn btn-sm btn-ghost" data-mkadmin="${esc(u.id)}">${t("make_admin")}</button>` : ""}
        </div>
      </div>`).join("") : `<p class="muted">${t("no_general")}</p>`;
    $("#admin-pending").innerHTML = pending.length ? pending.map(u => `
      <div class="row">
        <img src="${esc(u.photoURL)}" alt="" referrerpolicy="no-referrer">
        <div class="grow"><strong>${esc(u.displayName)}</strong><span class="type-tag ${u.accountType === "general" ? "general" : ""}">${t(u.accountType === "general" ? "type_general" : "type_member")}</span>
          <small>${esc(u.city)} · ${u.instagram ? "@" + esc(u.instagram) : ""} · ${esc(u.email)}</small>
          ${u.bio ? `<small>${esc(u.bio)}</small>` : ""}
          ${u.accountType !== "general" ? (proofs[u.id] ? `<button type="button" class="btn btn-sm btn-ghost proof-btn" data-proof="${esc(u.id)}">${t("view_join_proof")}</button>` : `<small class="muted">${t("no_join_proof")}</small>`) : ""}</div>
        <div class="actions">
          <button class="btn btn-sm btn-mat" data-approve="${esc(u.id)}">${t("approve")}</button>
          <button class="btn btn-sm btn-ghost" data-reject="${esc(u.id)}" title="${esc(t("reject_hint"))}">${t("reject")}</button>
          <button class="btn btn-sm btn-danger" data-block="${esc(u.id)}" title="${esc(t("block_hint"))}">${t("block")}</button>
        </div>
      </div>`).join("") : `<p class="muted">${t("no_pending")}</p>`;
    $("#admin-members").innerHTML = members.map(u => `
      <div class="row">
        <img src="${esc(u.photoURL)}" alt="" referrerpolicy="no-referrer">
        <div class="grow"><strong>${u.accountType === "general" ? "" : memberNo(u.memberNo) + " · "}${esc(u.displayName)}</strong>${u.accountType === "general" ? `<span class="type-tag general">${t("type_general")}</span>` : ""}
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

/* Deactivate: no access to the site, and all their collection cars and market posts are hidden.
   Reactivate undoes both. */
async function setActive(uid, active) {
  const [cs, ls] = await Promise.all([
    getDocs(query(collection(db, "cars"), where("ownerUid", "==", uid))),
    getDocs(query(collection(db, "listings"), where("ownerUid", "==", uid)))
  ]);
  const batch = writeBatch(db);
  batch.update(doc(db, "users", uid), active ? { status: "approved", reactivatedAt: serverTimestamp() } : { status: "deactivated", deactivatedAt: serverTimestamp() });
  [...cs.docs, ...ls.docs].forEach(d => batch.update(d.ref, { hidden: !active }));
  await batch.commit();
  return cs.size + ls.size;
}
document.addEventListener("click", async (e) => {
  const d = e.target.closest("[data-deactivate]"), r = e.target.closest("[data-reactivate]");
  if (!d && !r) return;
  if (!isAdmin()) return;
  const uid = (d || r).dataset[d ? "deactivate" : "reactivate"];
  const u = state.siteUsers[uid] || (state.deactUsers || {})[uid];
  if (!confirm(t(d ? "deact_confirm" : "react_confirm", { name: u?.displayName || "" }))) return;
  (d || r).disabled = true;
  try {
    const n = await setActive(uid, !!r);
    toast(t(d ? "deact_done" : "react_done", { n }));
    state.roster = null; await fetchRoster(true);
    state.listingsLoaded = false; state.feedLoaded = false;
    if (state.tab === "admin") loadAdmin(); else if (state.tab === "members") showMembers();
  } catch (err) { fail(err); (d || r).disabled = false; }
});

/* Move older photos (stored inside posts) to Google Drive: admins, from the Admin page. */
async function scanOldPhotos() {
  const [cs, ls] = await Promise.all([getDocs(collection(db, "cars")), getDocs(collection(db, "listings"))]);
  const pick = (snap, kind) => snap.docs.map(d => ({ ref: d.ref, kind, ...d.data() }))
    .filter(x => (x.photos || []).some(p => String(p).startsWith("data:image/")));
  return [...pick(cs, "collection"), ...pick(ls, "market")];
}
async function refreshMigrate() {
  const box = $("#admin-migrate");
  if (!isAdmin() || !uploadUrl) { box.hidden = true; return; }
  box.hidden = false;
  try {
    const list = state.migList = await scanOldPhotos();
    const n = list.reduce((a, x) => a + x.photos.filter(p => String(p).startsWith("data:")).length, 0);
    $("#mig-status").textContent = n ? t("mig_count", { n, posts: list.length }) : t("mig_done_all");
    $("#mig-run").hidden = !n;
  } catch (e) { $("#mig-status").textContent = String(e.message || e); }
}
$("#mig-run").addEventListener("click", async () => {
  const btn = $("#mig-run"); btn.disabled = true;
  const list = state.migList || [];
  const total = list.reduce((a, x) => a + x.photos.filter(p => String(p).startsWith("data:")).length, 0);
  let done = 0;
  try {
    for (const x of list) {
      const out = [];
      for (const [i, p] of x.photos.entries()) {
        if (!String(p).startsWith("data:image/")) { out.push(p); continue; }
        $("#mig-status").textContent = t("mig_progress", { n: done + 1, total });
        out.push(await uploadToDrive(x.kind, p, `${x.ownerName || ""}_${x.name || x.title || "photo"}_${i + 1}`));
        done++;
      }
      await updateDoc(x.ref, { photos: out });   // each post is switched only once all its photos are in Drive
    }
    toast(t("mig_finished", { n: done }));
  } catch (e) { fail(e); }
  btn.disabled = false; state.feedLoaded = false; state.listingsLoaded = false;
  refreshMigrate();
});

/* ================= Admin moderation: hide or delete a post with a reason; the owner gets a notice ================= */
document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-mod-post]"); if (!b || !isAdmin()) return;
  e.stopPropagation();
  const id = b.dataset.modPost;
  const c = state.feed.find(x => x.id === id) || (state.feedProfile?.posts || []).find(x => x.id === id) || state.deepPost;
  if (c) openModerate("cars", c, "hide");
});
function openModerate(col, item, mode) {
  const title = item.name || item.title || "";
  openModal(`
    <h2>${t("mod_title")}</h2>
    <p class="muted">${esc(title)} · ${esc(item.ownerName || "")}</p>
    <form class="form" id="f-mod">
      <div class="seg" role="group">
        <button type="button" data-mmode="hide" aria-pressed="${mode === "hide"}">${t("mod_hide")}</button>
        <button type="button" data-mmode="delete" aria-pressed="${mode === "delete"}">${t("mod_delete")}</button>
      </div>
      <label><span>${t("mod_note_label")}</span><textarea name="note" rows="3" maxlength="500" required placeholder="${esc(t("mod_note_ph"))}"></textarea></label>
      <small class="muted" id="mod-explain">${t(mode === "delete" ? "mod_delete_explain" : "mod_hide_explain")}</small>
      <div class="form-actions">
        <button type="button" class="btn btn-ghost" data-act="close">${t("cancel")}</button>
        <button class="btn btn-danger" type="submit">${t(mode === "delete" ? "mod_delete" : "mod_hide")}</button>
      </div>
    </form>`);
  const f = $("#f-mod"); let m = mode;
  $("#modal-body").onclick = (ev) => {
    if (ev.target.dataset.act === "close") closeModal();
    const mb = ev.target.closest("[data-mmode]"); if (!mb) return;
    m = mb.dataset.mmode;
    f.querySelectorAll("[data-mmode]").forEach(x => x.setAttribute("aria-pressed", String(x === mb)));
    $("#mod-explain").textContent = t(m === "delete" ? "mod_delete_explain" : "mod_hide_explain");
    f.querySelector("[type=submit]").textContent = t(m === "delete" ? "mod_delete" : "mod_hide");
  };
  f.addEventListener("submit", async (e) => {
    e.preventDefault(); const btn = f.querySelector("[type=submit]"); btn.disabled = true;
    const note = f.note.value.trim();
    try {
      const batch = writeBatch(db);
      const ref = doc(db, col, item.id);
      if (m === "delete") batch.delete(ref);
      else batch.update(ref, { modHidden: true, modNote: note, modBy: state.user.uid, modAt: serverTimestamp() });
      if (item.ownerUid) batch.set(doc(collection(db, "notices")), {
        uid: item.ownerUid, kind: m === "delete" ? "deleted" : "hidden", target: col === "cars" ? "collection" : "market",
        postId: item.id, title: String(title).slice(0, 100), note, by: state.user.uid, at: serverTimestamp(), read: false
      });
      await batch.commit();
      closeModal(); toast(t(m === "delete" ? "mod_deleted_done" : "mod_hidden_done"));
      afterModeration(col);
    } catch (err) { fail(err); btn.disabled = false; }
  });
}
async function unhidePost(col, item) {
  if (!confirm(t("mod_unhide_confirm", { title: item.name || item.title || "" }))) return;
  try {
    const batch = writeBatch(db);
    batch.update(doc(db, col, item.id), { modHidden: false, modNote: "", modBy: state.user.uid, modAt: serverTimestamp() });
    if (item.ownerUid) batch.set(doc(collection(db, "notices")), { uid: item.ownerUid, kind: "unhidden", target: col === "cars" ? "collection" : "market",
      postId: item.id, title: String(item.name || item.title || "").slice(0, 100), note: "", by: state.user.uid, at: serverTimestamp(), read: false });
    await batch.commit();
    toast(t("mod_unhidden_done")); afterModeration(col);
  } catch (e) { fail(e); }
}
function afterModeration(col) {
  if (col === "cars") { state.feedLoaded = false; state.feedProfile = null; if (location.hash.startsWith("#/feed")) { state.feedLoaded = true; loadFeed(true); renderFeedRoute(); } }
  else { state.listingsLoaded = false; if (location.hash.startsWith("#/market")) { state.listingsLoaded = true; loadListings(); } }
  if (state.tab === "admin" && !$("#app").hidden) loadModHidden();
}
async function loadModHidden() {
  if (!isAdmin()) return;
  try {
    const [cs, ls] = await Promise.all([
      getDocs(query(collection(db, "cars"), where("modHidden", "==", true))),
      getDocs(query(collection(db, "listings"), where("modHidden", "==", true)))
    ]);
    const list = state.modHiddenList = [...cs.docs.map(d => ({ col: "cars", id: d.id, ...d.data() })), ...ls.docs.map(d => ({ col: "listings", id: d.id, ...d.data() }))]
      .sort((a, b) => ms(b.modAt) - ms(a.modAt));
    $("#admin-modhidden-count").textContent = `(${list.length})`;
    $("#admin-modhidden").innerHTML = list.length ? list.map(x => `
      <div class="row">
        ${x.photos?.[0] ? `<img src="${photoSrc(x.photos[0])}" alt="" style="border-radius:8px">` : ""}
        <div class="grow"><strong>${esc(x.name || x.title || "")}</strong><span class="type-tag">${t(x.col === "cars" ? "nav_feed" : "nav_market")}</span>
          <small>${esc(x.ownerName || "")}${x.modAt ? " · " + fmtDate(x.modAt, { day: "numeric", month: "short", year: "numeric" }) : ""}</small>
          ${x.modNote ? `<small>${t("mod_reason")}: ${esc(x.modNote)}</small>` : ""}</div>
        <div class="actions">
          <button class="btn btn-sm btn-mat" data-unhide="${esc(x.col)}:${esc(x.id)}">${t("mod_unhide")}</button>
          <button class="btn btn-sm btn-danger" data-moddel="${esc(x.col)}:${esc(x.id)}">${t("mod_delete")}</button>
        </div>
      </div>`).join("") : `<p class="muted">${t("mod_none")}</p>`;
  } catch (e) { console.warn(e); }
}
$("#admin-modhidden").addEventListener("click", (e) => {
  const u = e.target.closest("[data-unhide]"), d = e.target.closest("[data-moddel]");
  const key = (u || d)?.dataset[u ? "unhide" : "moddel"]; if (!key) return;
  const [col, id] = key.split(":");
  const x = (state.modHiddenList || []).find(y => y.col === col && y.id === id); if (!x) return;
  if (u) unhidePost(col, x); else openModerate(col, x, "delete");
});

/* Reject: remove the request entirely, so the person goes back to the start and can sign up again. */
async function rejectRequest(uid) {
  await deleteDoc(doc(db, "users", uid));
  await Promise.all([deleteDoc(doc(db, "joinPayments", uid)), deleteDoc(doc(db, "contacts", uid))].map(p => p.catch(() => {})));
}
/* Block: the account stays "blocked", and its Google email + phone can't be used to register again. */
async function blockUser(u) {
  const email = String(u.email || "").toLowerCase();
  const key = u.phoneKey || phoneKey(u.whatsapp);
  const batch = writeBatch(db);
  batch.update(doc(db, "users", u.id), { status: "blocked", blockedAt: serverTimestamp() });
  if (email) batch.set(doc(db, "blocked", email), { uid: u.id, name: u.displayName || "", phoneKey: key || "", city: u.city || "", blockedAt: serverTimestamp(), by: state.user.uid });
  if (key) batch.set(doc(db, "blockedPhones", key), { uid: u.id, email, name: u.displayName || "" });
  await batch.commit();
  await Promise.all([deleteDoc(doc(db, "joinPayments", u.id)), deleteDoc(doc(db, "contacts", u.id))].map(p => p.catch(() => {})));
}
/* Unblock: clear the block and the old account record; they can sign up again from scratch. */
async function unblockUser(b) {
  const batch = writeBatch(db);
  batch.delete(doc(db, "blocked", b.id));
  if (b.phoneKey) batch.delete(doc(db, "blockedPhones", b.phoneKey));
  if (b.uid) batch.delete(doc(db, "users", b.uid));
  await batch.commit();
}

/* Import the Google Form roster from the browser (no terminal needed). Admin only; safe to run again. */
async function importRoster(file) {
  const data = JSON.parse(await file.text());
  if (!Array.isArray(data.members)) throw new Error("roster.json: 'members' list not found");
  const rid = (no) => `m${String(no).padStart(3, "0")}`;
  const batch = writeBatch(db);
  for (const m of data.members) {
    batch.set(doc(db, "roster", rid(m.no)), { memberNo: m.no, name: m.name, city: m.city || "", province: m.province || "", joined: m.joined || "", status: "member" }, { merge: true });
    batch.set(doc(db, "rosterPrivate", rid(m.no)), { phone: m.phone || "", shirtSize: m.shirt?.size || "", shirtQty: m.shirt?.qty || 0, shirtPaid: !!m.shirt?.paid, ...(m.email ? { email: m.email.toLowerCase() } : {}) }, { merge: true });
    if (m.email) batch.set(doc(db, "invites", m.email.toLowerCase()), { rosterId: rid(m.no), memberNo: m.no, name: m.name, city: m.city || "" });
    if (phoneKey(m.phone)) batch.set(doc(db, "phoneInvites", phoneKey(m.phone)), { rosterId: rid(m.no), memberNo: m.no, name: m.name, city: m.city || "" });
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
  const pf = e.target.closest("[data-proof]");
  if (pf) { const d = state.joinProofs?.[pf.dataset.proof]; if (d) openModal(`<h2>${t("view_join_proof")}</h2><img class="proof-img" src="${esc(d.proof)}" alt=""><p class="muted">${fmtDate(d.createdAt, { day: "numeric", month: "short", year: "numeric" })}</p>`); return; }
  try {
    if (a) {
      const pu = (state.pending || []).find(x => x.id === a.dataset.approve);
      if (pu?.accountType === "general") {
        a.disabled = true;
        await updateDoc(doc(db, "users", pu.id), { status: "approved", approvedAt: serverTimestamp() });
        toast(t("approved_general")); loadAdmin();
      } else openApprove(a.dataset.approve);
    }
    if (r) {
      const pu = (state.pending || []).find(x => x.id === r.dataset.reject);
      if (!confirm(t("reject_confirm", { name: pu?.displayName || "" }))) return;
      await rejectRequest(r.dataset.reject);
      toast(t("rejected_done")); loadAdmin();
    }
    const bl = e.target.closest("[data-block]");
    if (bl) {
      const pu = (state.pending || []).find(x => x.id === bl.dataset.block) || state.siteUsers[bl.dataset.block];
      if (!pu || !confirm(t("block_confirm", { name: pu.displayName || "" }))) return;
      await blockUser(pu);
      toast(t("blocked_done")); loadAdmin();
    }
    const ub = e.target.closest("[data-unblock]");
    if (ub) {
      const b = (state.blocked || []).find(x => x.id === ub.dataset.unblock);
      if (!b || !confirm(t("unblock_confirm", { name: b.name || b.id }))) return;
      await unblockUser(b);
      toast(t("unblocked_done")); loadAdmin();
    }
    if (m) { await updateDoc(doc(db, "users", m.dataset.mkadmin), { role: "admin" }); toast(t("saved")); loadAdmin(); }
  } catch (err) { fail(err); }
});
