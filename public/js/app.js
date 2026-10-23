import { initializeApp } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect, getRedirectResult,
  onAuthStateChanged, signOut, reauthenticateWithPopup
} from "https://www.gstatic.com/firebasejs/11.0.2/firebase-auth.js";
import {
  getFirestore, doc, getDoc, setDoc, updateDoc, deleteDoc, addDoc, collection, query, where,
  orderBy, limit, getDocs, onSnapshot, serverTimestamp, runTransaction, Timestamp, writeBatch,
  startAfter, arrayUnion, arrayRemove, getCountFromServer
} from "https://www.gstatic.com/firebasejs/11.0.2/firebase-firestore.js";
import { firebaseConfig, uploadUrl } from "./config.js?v=1792714162";
import { t, getLang, setLang, applyStatic } from "./i18n.js?v=1792596508";
import { GALLERY } from "./gallery-data.js?v=1792714162";
import { SEED_EVENTS } from "./seed-events.js?v=1792714162";
import { parseLedgerCSV, parseLedgerTable, buildPL, balanceIssues } from "./finance.js?v=1792714162";
import { parseMemberSheets, phoneKey as sheetPhoneKey } from "./members-sync.js?v=1792714162";

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
  // Also the site's own news photos (public/img/news/…).
  return /^(data:image\/(jpeg|png|webp);base64,|https:\/\/(drive\.google\.com|lh3\.googleusercontent\.com)\/|\/img\/news\/[\w.-]+\.jpg$)/.test(p) ? esc(p) : "";
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
  // kind "contest:<id>" → RCMI/Contests/<contest name>/
  const [k, contestId] = String(kind).split(":");
  const send = (kk) => fetch(uploadUrl, { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify({ idToken, kind: kk, contestId, name: String(name || "photo").slice(0, 60), mime: "image/jpeg", data }) })
    .then(r => r.json()).catch(() => ({ error: "upload failed" }));
  let j = await send(k);
  // Upload script not updated for contests yet: keep working by saving in the Market folder.
  if (k === "contest" && j.error === "bad kind") j = await send("market");
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
$$("[data-lang]").forEach(b => b.addEventListener("click", () => { setLang(b.dataset.lang); renderGallery(); if (typeof renderHomeShop === "function") renderHomeShop(); if (typeof renderStats === "function") renderStats(); rerender(); }));



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

/* Home slider: big banners on Kopdar and IDS 2025 photos, auto-advancing, swipeable. */
function startSlider() {
  const hs = $("#hs"), track = $("#hs-track"); if (!hs || !track) return;
  // Each slide names its own photo (landscape Kopdar + IDS 2025 photos, none on the red stage backdrop).
  const slides = $$(".hs-slide", track);
  slides.forEach(sl => {
    if (sl.dataset.photo) sl.style.setProperty("--bg", `url("${driveThumb(sl.dataset.photo, 1600)}")`);
    if (sl.dataset.pos) sl.style.setProperty("--pos", sl.dataset.pos);
  });
  $("#hs-dots").innerHTML = slides.map((_, i) => `<button type="button" data-hs-to="${i}" aria-label="${i + 1}"></button>`).join("");
  let cur = 0, timer = null;
  const go = (i, smooth = true) => {
    cur = (i + slides.length) % slides.length;
    track.scrollTo({ left: cur * track.clientWidth, behavior: smooth ? "smooth" : "auto" });
  };
  const mark = () => $$("#hs-dots button").forEach((b, k) => b.setAttribute("aria-current", String(k === cur)));
  track.addEventListener("scroll", () => { const i = Math.round(track.scrollLeft / track.clientWidth); if (i !== cur) { cur = i; } mark(); }, { passive: true });
  const play = () => { clearInterval(timer); if (!matchMedia("(prefers-reduced-motion: reduce)").matches) timer = setInterval(() => { if (!document.hidden && !$("#landing").hidden) go(cur + 1); }, 6000); };
  hs.addEventListener("click", (e) => {
    const n = e.target.closest("[data-hs]"), d = e.target.closest("[data-hs-to]");
    if (n) { go(cur + Number(n.dataset.hs)); play(); }
    if (d) { go(Number(d.dataset.hsTo)); play(); }
  });
  hs.addEventListener("pointerdown", () => clearInterval(timer));
  hs.addEventListener("pointerup", play);
  addEventListener("resize", () => go(cur, false));
  mark(); play();
}

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

applyStatic(); renderGallery(); renderPitlane(); startSlider();
const fy = $("#foot-year"); if (fy) fy.textContent = new Date().getFullYear();

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
$("#btn-signout").addEventListener("click", async () => { await dropPushToken(); await signOut(auth); location.hash = "#/"; });
getRedirectResult(auth).catch(fail);

/* ---------------- state + screens ---------------- */
const state = { user: null, profile: null, tab: "collection", sub: "", carFilter: "mine", marketFilter: "all", cars: [], listings: [], events: [], roster: null, rosterPrivate: {}, siteUsers: {}, memberSearch: "" };
// Keep the address clean: rcmi-website.web.app/#/… instead of …/index.html#/…
if (/\/index\.html$/i.test(location.pathname)) history.replaceState(null, "", location.pathname.replace(/index\.html$/i, "") + location.search + location.hash);
let unsubProfile = null;

/* ================= Admin notifications (bell in the top bar, live) ================= */
const notif = { unsubs: [], pending: [], messages: [], recent: [], proofs: {}, notices: [], seenAt: 0, lastCount: null, uid: null };
function stopNotifs() { notif.unsubs.forEach(u => u()); notif.unsubs = []; notif.uid = null; notif.lastCount = null; $("#bell-wrap").hidden = true; if (typeof stopDM === "function" && dm.uid) stopDM(); }
function startNotifs() {
  if (notif.uid === state.user.uid) return;
  stopNotifs(); notif.uid = state.user.uid; notif.startedAt = Date.now();
  startDM();
  $("#bell-wrap").hidden = false;
  const since = Timestamp.fromDate(new Date(Date.now() - 30 * 864e5));
  const on = (q, fn) => notif.unsubs.push(onSnapshot(q, fn, () => {}));
  notif.pending = []; notif.messages = []; notif.delReqs = []; notif.recent = []; notif.proofs = {}; notif.notices = [];
  // Everyone: notices from the admins (post hidden / removed / visible again).
  on(query(collection(db, "notices"), where("uid", "==", state.user.uid)), s => { notif.notices = s.docs.map(d => ({ id: d.id, ...d.data() })); renderBell(); if (state.tab === "activity") renderActivity(); });
  if (!isStaff()) return;
  on(query(collection(db, "users"), where("status", "==", "pending")), s => { notif.pending = s.docs.map(d => ({ id: d.id, ...d.data() })).filter(u => isAdmin() || u.accountType === "general"); renderBell(); });
  on(query(collection(db, "listings"), where("delReq", "==", true)), s => { notif.delReqs = s.docs.map(d => ({ id: d.id, ...d.data() })); renderBell(); if (state.tab === "admin" && !$("#app").hidden) loadDelRequests(); });
  if (!isAdmin()) return;
  on(query(collection(db, "messages"), where("status", "==", "new")), s => { notif.messages = s.docs.map(d => ({ id: d.id, ...d.data() })); renderBell(); });
  on(query(collection(db, "users"), where("createdAt", ">", since)), s => { notif.recent = s.docs.map(d => ({ id: d.id, ...d.data() })).filter(u => u.status === "approved"); renderBell(); });
  on(collection(db, "joinPayments"), s => { notif.proofs = Object.fromEntries(s.docs.map(d => [d.id, d.data()])); renderBell(); });
}
const ms = (ts) => toDate(ts)?.getTime() || 0;
function bellItems() {
  const seen = ms(state.profile?.notifSeenAt);
  const items = [];
  for (const n of notif.notices) items.push(String(n.kind).startsWith("contest_")
    ? { at: ms(n.at), unread: !n.read, notice: n.id, href: `#/contest/${encodeURIComponent(n.postId)}`, text: contestNoticeText(n) }
    : ACT_KINDS.includes(n.kind)
    ? { at: ms(n.at), unread: !n.read, notice: n.id, href: n.target === "market" ? `#/market/${encodeURIComponent(n.postId)}` : `#/feed/p/${encodeURIComponent(n.postId)}`,
        text: activityText(n) }
    : { at: ms(n.at), unread: !n.read, href: "#", notice: n.id,
        text: t(NT_TEXT[n.kind] || "nt_hidden", { title: esc(n.title), where: t(n.target === "market" ? "nav_market" : "nav_feed") })
          + (n.note ? `<em class="bell-note">${t("mod_reason")}: ${esc(n.note)}</em>` : "") });
  for (const u of notif.pending) items.push({ at: ms(notif.proofs[u.id]?.createdAt) || ms(u.createdAt), unread: true, href: "#/admin",
    text: t(u.accountType === "general" ? "notif_pending_general" : notif.proofs[u.id] ? "notif_pending_paid" : "notif_pending_member", { name: esc(u.displayName) }) });
  for (const x of notif.delReqs || []) items.push({ at: ms(x.delReqAt), unread: true, href: "#/admin",
    text: t("notif_delreq", { name: esc(x.ownerName || ""), title: esc(x.title || "") }) + `<em class="bell-note">${t("del_reason")}: ${esc(x.delReason || "")}</em>` });
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
const NT_TEXT = { hidden: "nt_hidden", deleted: "nt_deleted", unhidden: "nt_unhidden", delapproved: "nt_delapproved", delrejected: "nt_delrejected" };
function openNotice(id) {
  const n = notif.notices.find(x => x.id === id); if (!n) return;
  if (!n.read) updateDoc(doc(db, "notices", id), { read: true }).catch(() => {});
  if (String(n.kind).startsWith("contest_")) { location.hash = `#/contest/${encodeURIComponent(n.postId)}`; return; }
  if (n.kind === "rate") { openRate(n.postId); return; }
  if (n.kind === "review") { openReviews(state.user.uid); return; }
  if (ACT_KINDS.includes(n.kind)) {   // open the post (for comments: then its comments)
    const h = n.target === "market" ? `#/market/${encodeURIComponent(n.postId)}` : `#/feed/p/${encodeURIComponent(n.postId)}`;
    state.deepOpened = null; state.openCommentsAfter = n.target === "market" || n.kind === "like" || n.kind === "claim" ? null : `cars:${n.postId}`;
    if (location.hash === h) openDeepLink(); else location.hash = h;
    return;
  }
  const where = t(n.target === "market" ? "nav_market" : "nav_feed");
  openModal(`
    <h2>${t({ hidden: "nt_hidden_title", deleted: "nt_deleted_title", unhidden: "nt_unhidden_title", delapproved: "nt_delapproved_title", delrejected: "nt_delrejected_title" }[n.kind] || "nt_hidden_title")}</h2>
    <p>${t(NT_TEXT[n.kind] || "nt_hidden", { title: `<strong>${esc(n.title)}</strong>`, where })}</p>
    ${n.note ? `<p class="mod-note"><strong>${t("mod_reason")}:</strong> ${esc(n.note)}</p>` : ""}
    ${n.kind !== "unhidden" && n.kind !== "delapproved" ? `<p class="muted">${t("nt_contact")}</p>` : ""}
    <p class="muted">${fmtDate(n.at, { day: "numeric", month: "long", year: "numeric" })}</p>
    <div class="form-actions">
      ${n.kind !== "unhidden" && n.kind !== "delapproved" ? `<a class="btn btn-ghost" href="#contact" data-act="close">${t("nav_contact")}</a>` : ""}
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

/* ================= Activity tab: likes, comments and buys on your posts ================= */
const ACT_KINDS = ["like", "comment", "reply", "claim", "rate", "review"];
function activityText(n) {
  const name = esc(n.fromName || ""), title = esc(n.title);
  if (n.kind === "claim") return t("nt_claim", { name, n: esc(n.note), title });
  if (n.kind === "rate") return t("nt_rate", { name, title });
  if (n.kind === "review") return t("nt_review", { name, title, n: esc(n.note) });
  if (n.kind === "like") return t(n.target === "market" ? "nt_like_listing" : "nt_like", { name, title });
  return t(n.kind === "reply" ? "nt_reply" : "nt_comment", { name, title }) + `<em class="bell-note">“${esc(n.note)}”</em>`;
}
const ACT_ICON = { like: "♥", comment: "💬", reply: "💬", claim: "⚡", rate: "⭐", review: "⭐" };
let actFilter = "all";
function renderActivity() {
  const box = $("#activity-list"); if (!box) return;
  const list = notif.notices.filter(n => ACT_KINDS.includes(n.kind))
    .filter(n => actFilter === "all" || n.kind === actFilter || (actFilter === "comment" && n.kind === "reply") || (actFilter === "claim" && n.kind === "rate") || (actFilter === "review" && n.kind === "review"))
    .sort((a, b) => ms(b.at) - ms(a.at));
  box.innerHTML = list.length ? list.map(n => `
    <a class="act-item ${n.read ? "" : "unread"}" href="#" data-notice="${esc(n.id)}">
      <span class="act-ic act-${esc(n.kind)}" aria-hidden="true">${ACT_ICON[n.kind]}</span>
      <span class="act-body"><span>${activityText(n)}</span>
        <small>${t(n.target === "market" ? "nav_market" : "tab_collection")} · ${ms(n.at) ? new Date(ms(n.at)).toLocaleString(locale(), { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : ""}</small></span>
    </a>`).join("") : `<p class="empty">${t("act_empty")}</p>`;
}
$("#view-activity").addEventListener("click", (e) => {
  const f = e.target.closest("[data-afilter]");
  if (f) { actFilter = f.dataset.afilter; $$("#view-activity [data-afilter]").forEach(b => b.setAttribute("aria-pressed", String(b === f))); renderActivity(); return; }
  const a = e.target.closest("[data-notice]");
  if (a) { e.preventDefault(); openNotice(a.dataset.notice); }
});
// Tell the post owner when someone likes their post (only when the heart turns on, never for your own post).
function likeNotice(target, item) {
  if (!item?.ownerUid || item.ownerUid === state.user.uid) return;
  addDoc(collection(db, "notices"), { uid: item.ownerUid, kind: "like", target, postId: item.id, title: String(item.name || item.title || "").slice(0, 100),
    note: "", from: state.user.uid, fromName: String(state.profile?.displayName || "").slice(0, 80), at: serverTimestamp(), read: false }).catch(() => {});
}

let lastScreen = "";
function show(screen) {
  $("#landing").hidden = screen !== "landing";
  $("#feedpage").hidden = screen !== "feed";
  $("#marketpage").hidden = screen !== "market";
  $("#dmpage").hidden = screen !== "dm";
  $("#contestpage").hidden = screen !== "contest";
  $("#newspage").hidden = screen !== "news";
  // The main-site menu stays in the top bar everywhere; "How to join" only on the public pages.
  $("#landing-nav").hidden = false;
  const joinLink = $('#landing-nav a[href="#join"]'); if (joinLink) joinLink.hidden = screen === "app" || screen === "gate";
  $$("#landing-nav a").forEach(a => a.classList.toggle("on", a.getAttribute("href") === "#/" + screen || (screen === "landing" && a.getAttribute("href") === "#/")));
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
  // News: new releases from resin brands; everyone reads, staff post.
  if (location.hash.startsWith("#/news")) {
    show("news");
    renderNewsRoute();
    return;
  }
  // Photo contests: public pages; entering, voting and judging need an account.
  if (location.hash.startsWith("#/contest")) {
    show("contest");
    renderContestRoute();
    return;
  }
  // Direct messages: signed-in accounts only.
  if (location.hash.startsWith("#/dm")) {
    show("dm");
    if (!user) { $("#dm-chat").innerHTML = ""; $("#dm-list").innerHTML = `<p class="empty">${t("dm_signin")}</p>`; return; }
    renderDM();
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
      $("#tab-admin").hidden = !isStaff();
      { const ta = $("#tab-admin"); ta.dataset.i18n = isMod() ? "tab_mod" : "tab_admin"; ta.textContent = t(ta.dataset.i18n); }
      $("#tab-finance").hidden = state.profile.accountType === "general";
      if (state.profile.role === "admin") refreshInboxCount();
      // The bell: admins get sign-ups/messages too; everyone gets notices about their own posts.
      if (state.profile.status === "approved") { startNotifs(); renderBell(); if (state.addrFor !== user.uid) { state.addrFor = user.uid; loadMyAddr(); } } else stopNotifs();
      $("#btn-add-event").hidden = state.profile.role !== "admin";
      const general = isGeneral();
      $$('.tabs a[data-tab="members"], .tabs a[data-tab="dues"]').forEach(a => { a.hidden = general; });
      const ct = $("#tab-card"); ct.dataset.i18n = "tab_card"; ct.textContent = t(ct.dataset.i18n);
      $("#btn-add-car").hidden = false;
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
    // Shipping address first (private), then the profile.
    await saveAddr(readAddr(f));
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

/* ================= Shipping address (private: the person + admins) ================= */
const ID_PROVINCES = ["Aceh","Sumatera Utara","Sumatera Barat","Riau","Kepulauan Riau","Jambi","Bengkulu","Sumatera Selatan","Kepulauan Bangka Belitung","Lampung",
  "Banten","DKI Jakarta","Jawa Barat","Jawa Tengah","DI Yogyakarta","Jawa Timur","Bali","Nusa Tenggara Barat","Nusa Tenggara Timur",
  "Kalimantan Barat","Kalimantan Tengah","Kalimantan Selatan","Kalimantan Timur","Kalimantan Utara",
  "Sulawesi Utara","Gorontalo","Sulawesi Tengah","Sulawesi Barat","Sulawesi Selatan","Sulawesi Tenggara",
  "Maluku","Maluku Utara","Papua","Papua Barat","Papua Barat Daya","Papua Selatan","Papua Tengah","Papua Pegunungan"];
const ADDR_KEYS = ["recipient", "phone", "street", "village", "district", "city", "province", "postal", "note"];
function addrFieldsHTML() {
  const sel = (name, label, req = true) => `<label><span>${t(label)}${req ? " *" : ""}</span><select name="addr_${name}" ${req ? "required" : ""} disabled><option value="">—</option></select></label>`;
  return `<fieldset class="addr">
    <legend>${t("addr_title")} <small>${t("addr_private")}</small></legend>
    <label class="lay-check addr-same"><input type="checkbox" name="addr_same"> <span>${t("addr_same")}</span></label>
    <div class="row2">
      <label><span>${t("addr_recipient")} *</span><input name="addr_recipient" required maxlength="80" autocomplete="name"></label>
      <label><span>${t("addr_phone")} *</span><input name="addr_phone" required maxlength="20" inputmode="tel" autocomplete="tel" placeholder="08…"></label>
    </div>
    <div class="row2">${sel("province", "addr_province")}${sel("city", "addr_city")}</div>
    <div class="row2">${sel("district", "addr_district")}${sel("village", "addr_village")}</div>
    <label><span>${t("addr_street")} *</span><textarea name="addr_street" required rows="2" maxlength="300" autocomplete="street-address" placeholder="${esc(t("addr_street_ph"))}"></textarea></label>
    <div class="row2">
      <label><span>${t("addr_postal")} *</span><input name="addr_postal" required maxlength="5" pattern="[0-9]{5}" inputmode="numeric" autocomplete="postal-code" placeholder="12345"></label>
      <label><span>${t("addr_note")}</span><input name="addr_note" maxlength="200" placeholder="${esc(t("addr_note_ph"))}"></label>
    </div>
  </fieldset>`;
}
/* Province → city/regency → kecamatan → kelurahan dropdowns, from /wilayah (Kemendagri codes, 38 provinces). */
let wilIndex = null; const wilReg = {};
const wilLoadIndex = () => wilIndex || (wilIndex = fetch("/wilayah/index.json").then(r => r.json()));
const wilLoadReg = (id) => wilReg[id] || (wilReg[id] = fetch(`/wilayah/${id}.json`).then(r => r.json()));
function setOpts(el, items, keep = "") {   // items: [[value, label]]
  el.innerHTML = `<option value="">—</option>` + items.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join("");
  el.disabled = !items.length || !!el.closest("form.locked");
  if (keep) { if (!items.some(([v]) => v === keep)) el.insertAdjacentHTML("beforeend", `<option value="${esc(keep)}">${esc(keep)}</option>`); el.value = keep; }
}
async function bindWilayah(f, preset = {}) {
  const P = f.addr_province, C = f.addr_city, D = f.addr_district, V = f.addr_village;
  if (!P) return;
  const idx = await wilLoadIndex();
  const provs = idx.map(p => [p[1], p[1]]);
  const regsOf = (pname) => (idx.find(p => p[1] === pname)?.[2] || []);
  let reg = null;
  async function onProv(keepC, keepD, keepV) {
    setOpts(C, regsOf(P.value).map(r => [r[1], r[1]]), keepC); setOpts(D, []); setOpts(V, []);
    if (keepC) await onCity(keepD, keepV);
  }
  async function onCity(keepD, keepV) {
    setOpts(D, []); setOpts(V, []);
    const r = regsOf(P.value).find(x => x[1] === C.value); if (!r) { if (keepD) setOpts(D, [], keepD); if (keepV) setOpts(V, [], keepV); return; }
    D.disabled = true; D.options[0].textContent = "…";
    reg = await wilLoadReg(r[0]);
    setOpts(D, reg.d.map(d => [d[1], d[1]]), keepD);
    if (keepD) onDist(keepV);
  }
  function onDist(keepV) {
    const d = reg?.d.find(x => x[1] === D.value);
    setOpts(V, d ? (reg.v[d[0]] || []).map(v => Array.isArray(v) ? [v[0], v[0]] : [v, v]) : [], keepV);
  }
  // Postal code follows the chosen kelurahan/desa (you can still change it).
  function onVillage() {
    const d = reg?.d.find(x => x[1] === D.value); if (!d) return;
    const v = (reg.v[d[0]] || []).find(x => Array.isArray(x) && x[0] === V.value);
    if (v?.[1] && f.addr_postal) { f.addr_postal.value = v[1]; f.addr_postal.classList.add("autofilled"); setTimeout(() => f.addr_postal.classList.remove("autofilled"), 1200); }
  }
  // Listeners are attached once and always use the latest set of handlers (this function can run again to pre-fill).
  f._wh = { onProv, onCity, onDist, onVillage };
  if (!f.dataset.wil) {
    f.dataset.wil = "1";
    P.addEventListener("change", () => f._wh.onProv()); C.addEventListener("change", () => f._wh.onCity());
    D.addEventListener("change", () => f._wh.onDist()); V.addEventListener("change", () => f._wh.onVillage());
  }
  setOpts(P, provs, preset.province || "");
  if (preset.province) await onProv(preset.city, preset.district, preset.village);
}
function fillAddrSlots() { $$(".addr-slot").forEach(el => { if (!el.dataset.ready) { el.dataset.ready = "1"; el.innerHTML = addrFieldsHTML(); bindWilayah(el.closest("form")).catch(() => {}); bindSameAsProfile(el.closest("form")); } }); }
// "Same as my name and phone": recipient = the profile's name, phone = the profile's WhatsApp number.
function bindSameAsProfile(f) {
  const same = f.addr_same, R = f.addr_recipient, Ph = f.addr_phone;
  const sync = () => {
    R.readOnly = Ph.readOnly = same.checked;
    if (same.checked) { R.value = f.displayName.value.trim(); Ph.value = f.whatsapp.value.trim(); }
  };
  same.addEventListener("change", sync);
  f.displayName.addEventListener("input", () => same.checked && sync());
  f.whatsapp.addEventListener("input", () => same.checked && sync());
  same.checked = true; sync();
  f._syncSame = sync;
}
fillAddrSlots();
const readAddr = (f) => Object.fromEntries(ADDR_KEYS.map(k => [k, String(f["addr_" + k]?.value || "").trim()]));
function writeAddr(f, a) {
  ["recipient", "phone", "street", "postal", "note"].forEach(k => { const el = f["addr_" + k]; if (el && document.activeElement !== el) el.value = a?.[k] || ""; });
  // Tick "same as profile" when the saved recipient matches the profile (or nothing is saved yet).
  if (f.addr_same) {
    const sameNow = !a || (norm(a.recipient) === norm(f.displayName.value) && phoneKey(a.phone) === phoneKey(f.whatsapp.value));
    f.addr_same.checked = sameNow; f._syncSame?.();
  }
  if (a) bindWilayah(f, a).catch(() => {});
}
const saveAddr = (a) => setDoc(doc(db, "addresses", state.user.uid), { ...a, updatedAt: serverTimestamp() });
const addrLines = (a) => a ? [a.recipient + (a.phone ? ` (${a.phone})` : ""), a.street, [a.village, a.district].filter(Boolean).join(", "),
  [a.city, a.province, a.postal].filter(Boolean).join(", "), a.note ? `(${a.note})` : ""].filter(Boolean) : [];
async function loadMyAddr() {
  try { const s = await getDoc(doc(db, "addresses", state.user.uid)); state.myAddr = s.exists() ? s.data() : null; }
  catch (e) { state.myAddr = null; }
  $("#addr-banner").hidden = !!state.myAddr;
  if ($("#form-profile")) writeAddr($("#form-profile"), state.myAddr);
  renderMyAddr();
  if (!state.myAddr && $("#form-profile")) lockProfile(false);
}
// "My address" on the profile page (private: only you and admins see it).
function renderMyAddr() {
  const box = $("#my-addr"); if (!box) return;
  const a = state.myAddr;
  box.hidden = false;
  box.innerHTML = `<h3>📦 ${t("addr_mine")}</h3>
    ${a ? `<address>${addrLines(a).map(esc).join("<br>")}</address>` : `<p class="muted">${t("addr_none")}</p>`}
    <p class="muted small">${t("addr_private")}</p>
    <a class="btn btn-sm btn-ghost" href="#form-profile" data-addr-edit>${t(a ? "addr_edit" : "addr_add")}</a>`;
}
document.addEventListener("click", (e) => {
  if (!e.target.closest("[data-addr-edit]")) return;
  e.preventDefault();
  lockProfile(false);
  const fs = $("#profile-addr fieldset"); fs?.scrollIntoView({ behavior: "smooth", block: "start" }); fs?.querySelector("input:not([readonly]), select")?.focus();
});

/* ---------------- routing ---------------- */
const TABS = ["collection", "events", "members", "dues", "activity", "card", "finance", "admin"];
window.addEventListener("hashchange", render);
// "Home" in the top menu: back to the main page, at the top (also when already there).
document.querySelector('#landing-nav a[href="#/"]')?.addEventListener("click", () => { if (location.hash === "#/" || location.hash === "") window.scrollTo({ top: 0, behavior: "smooth" }); });
function route() {
  if (!state.profile || state.profile.status !== "approved" || !isMemberRoute()) return;
  const [h, sub = ""] = location.hash.replace(/^#\/?/, "").split("/");
  let tab = TABS.includes(h) ? h : "collection";
  state.sub = decodeURIComponent(sub);
  if (tab === "admin" && !isStaff()) tab = "collection";
  if (tab === "finance" && isGeneral()) tab = "events";
  if (isGeneral() && (tab === "members" || tab === "dues")) tab = "events";
  state.tab = tab;
  $$(".tabs a").forEach(a => { if (a.dataset.tab === tab) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current"); });
  TABS.forEach(n => { $(`#view-${n}`).hidden = n !== tab; });
  ({ collection: loadCars, events: loadEvents, members: loadMembers, dues: loadDues, activity: renderActivity, finance: loadFinance, card: () => fetchRoster().catch(() => {}).then(renderCard), admin: loadAdmin })[tab]();
}
function rerender() {
  if ($("#app").hidden) return;
  ({ collection: renderCars, events: renderEvents, members: showMembers, dues: renderDues, activity: renderActivity, finance: renderFinance, card: renderCard, admin: loadAdmin })[state.tab]();
}
const isAdmin = () => state.profile?.role === "admin";
// Moderator: approves/rejects general users, handles listing delete requests, deletes posts, deactivates accounts.
const isMod = () => state.profile?.role === "moderator";
const isStaff = () => isAdmin() || isMod();
const isStaffRole = (u) => u?.role === "admin" || u?.role === "moderator";
const isJury = () => state.profile?.role === "jury" && state.profile?.status === "approved";
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
      ${c.ownerUid === state.user?.uid && !c.editedAt ? `<button class="btn btn-mat" data-act="edit">✏️ ${t("edit_post")}</button>` : ""}
      ${canEdit(c.ownerUid) ? `<button class="btn btn-danger" data-act="del">${t("delete")}</button>` : ""}
      <button class="btn btn-ghost" data-act="close">${t("cancel")}</button>
    </div>`);
  $("#modal-body").onclick = async (ev) => {
    const act = ev.target.dataset.act;
    if (act === "close") closeModal();
    if (act === "del") openDeleteReason("cars", c);
    if (act === "edit") openEditPost("cars", c);
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
      closeModal(); toast(t("feed_posted")); state.feedLoaded = false; state.allCars = null; after?.();
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
      ${c.ownerUid && c.ownerUid !== state.user?.uid ? `<button type="button" class="post-dm" data-dm="${esc(c.ownerUid)}" data-dm-name="${esc(c.ownerName || "")}" data-dm-photo="${esc(c.ownerPhoto || "")}" aria-label="${t("dm_message")}" title="${t("dm_message")}"><svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M21 3 10 14M21 3l-7 18-4-7-7-4 18-7Z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg></button>` : ""}
      ${state.user && c.ownerUid === state.user.uid ? `<button type="button" class="post-mod" data-own-post="${esc(c.id)}" aria-label="${t("post_options")}" title="${t("post_options")}">⋯</button>`
        : isStaff() ? `<button type="button" class="post-mod" data-mod-post="${esc(c.id)}" aria-label="${t("mod_title")}" title="${t("mod_title")}">⋯</button>` : ""}
    </header>
    <div class="post-media">
      ${photos.length ? `<div class="post-track">${photos.map(p => `<img src="${photoSrc(p)}" alt="${esc(c.name)}" loading="lazy" draggable="false">`).join("")}</div>
        ${photos.length > 1 ? `<button type="button" class="post-nav prev" data-slide="-1" aria-label="Previous">‹</button><button type="button" class="post-nav next" data-slide="1" aria-label="Next">›</button>` : ""}
        ${photos.length > 1 ? `<div class="post-dots">${photos.map((_, i) => `<i class="${i ? "" : "on"}"></i>`).join("")}</div><span class="post-count">1/${photos.length}</span>` : ""}`
        : `<div class="post-empty">1:64</div>`}
      <span class="post-heart" aria-hidden="true">♥</span>
    </div>
    <div class="post-actions">
      <button type="button" class="share" data-share-post="${esc(c.id)}" aria-label="${t("share")}">${SHARE_ICON}</button>
      <button type="button" class="cmt-btn" data-cmt-open="cars:${esc(c.id)}" aria-label="${t("comments")}">${CMT_ICON}</button>
      <button type="button" class="like ${mine ? "on" : ""}" data-like="${esc(c.id)}" aria-pressed="${mine}" aria-label="${t("like")}">
        <svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true"><path d="M12 21s-7.5-4.6-9.6-9.2C.9 8.4 3 4.5 6.8 4.5c2.2 0 3.6 1.2 4.2 2.3h2c.6-1.1 2-2.3 4.2-2.3 3.8 0 5.9 3.9 4.4 7.3C19.5 16.4 12 21 12 21Z"/></svg>
      </button>
      <span class="like-count">${likes.length ? t(likes.length === 1 ? "likes_one" : "likes_n", { n: likes.length }) : ""}</span>
    </div>
    <p class="post-cap"><strong>${esc(c.name)}</strong>${c.maker ? ` <span class="post-maker">· ${esc(c.maker)}</span>` : ""}${c.notes ? `<br>${tagify(c.notes, "feed")}` : ""}</p>
    <div class="post-cmts" data-cmts="cars:${esc(c.id)}"></div>
    <time class="post-time">${ago(c.createdAt)}${c.editedAt ? ` · ${t("edited")}` : ""}</time>
  </article>`;
}
function renderFeed() {
  const box = $("#feed-list"); if (!box) return;
  box.innerHTML = state.feed.length ? state.feed.map(postHTML).join("") : `<p class="empty">${t("feed_empty")}</p>`;
  $("#feed-more").hidden = state.feedDone || !state.feed.length;
  wireCarousels(box);
  fillCommentPreviews(box);
  renderPeople();
}
$("#feed-more").addEventListener("click", () => loadFeed());
async function toggleLike(id, forceOn = false) {
  if (!state.user) { toast(t("like_signin")); openSignInChooser(); return; }
  if (state.profile?.status !== "approved") { toast(t("cmt_need_active")); return; }
  const c = state.feed.find(x => x.id === id) || (state.feedProfile?.posts || []).find(x => x.id === id) || state.searchPosts.find(x => x.id === id); if (!c) return;
  const uid = state.user.uid; const on = (c.likedBy || []).includes(uid);
  if (forceOn && on) return;
  c.likedBy = on ? c.likedBy.filter(x => x !== uid) : [...(c.likedBy || []), uid];
  paintLike(c);
  try { await updateDoc(doc(db, "cars", id), { likedBy: on ? arrayRemove(uid) : arrayUnion(uid) }); if (!on) likeNotice("collection", c); }
  catch (e) { c.likedBy = on ? [...c.likedBy, uid] : c.likedBy.filter(x => x !== uid); paintLike(c); fail(e); }
}
// Update one post's heart and count in place (keeps the photo carousel where it is).
function paintLike(c) {
  // Same car can be in the feed, a profile and an open post at once: keep them all in step.
  [state.feed, state.feedProfile?.posts || [], state.searchPosts, state.allCars || []].forEach(list => { const x = list.find(y => y.id === c.id); if (x && x !== c) x.likedBy = c.likedBy; });
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

/* Like a market listing (same rule as the collection: sign in first). */
document.addEventListener("click", async (e) => {
  const b = e.target.closest("[data-like-listing]"); if (!b) return;
  if (!state.user) { toast(t("like_signin")); closeModal(); openSignInChooser(); return; }
  if (state.profile?.status !== "approved") { toast(t("cmt_need_active")); return; }
  const l = state.listings.find(x => x.id === b.dataset.likeListing) || state.cmtItems[`listings:${b.dataset.likeListing}`]; if (!l) return;
  const uid = state.user.uid, on = (l.likedBy || []).includes(uid);
  l.likedBy = on ? l.likedBy.filter(x => x !== uid) : [...(l.likedBy || []), uid];
  const paint = () => { const n = l.likedBy.length; b.classList.toggle("on", l.likedBy.includes(uid));
    b.parentElement.querySelector(".like-count").textContent = n ? t(n === 1 ? "likes_one" : "likes_n", { n }) : ""; };
  paint();
  try { await updateDoc(doc(db, "listings", l.id), { likedBy: on ? arrayRemove(uid) : arrayUnion(uid) }); if (!on) likeNotice("market", l); renderListings(); }
  catch (err) { l.likedBy = on ? [...l.likedBy, uid] : l.likedBy.filter(x => x !== uid); paint(); fail(err); }
});

// Stock line on a war listing card: "3 pcs left", a bar, or SOLD OUT / starts at… — kept live (see watchWars).
function warStockHTML(l) {
  const left = Math.max(0, (l.qty || 0) - (l.claimed || 0)), pct = l.qty ? Math.min(100, (l.claimed || 0) / l.qty * 100) : 0;
  const start = ms(l.warStart);
  return `<div class="l-stock ${left ? "" : "out"}" data-stock="${esc(l.id)}">
    <span>${left ? `🔥 ${t("war_pcs_left", { n: left })}` : t("war_soldout")}</span><small>${t("war_of", { qty: l.qty })}</small>
    <i style="--p:${pct}%"></i>
    ${start > Date.now() ? `<small class="l-start">⏳ ${new Date(start).toLocaleString(locale(), { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</small>` : ""}
  </div>`;
}
// Live stock for every war listing while the market is open.
function watchWars() {
  if (state.warUnsub) return;
  state.warUnsub = onSnapshot(query(collection(db, "listings"), where("war", "==", true)), (snap) => {
    let changed = false;
    snap.docs.forEach(d => {
      const x = d.data(), l = state.listings.find(y => y.id === d.id); if (!l) return;
      if (l.claimed !== x.claimed || l.status !== x.status || l.qty !== x.qty) { l.claimed = x.claimed; l.status = x.status; l.qty = x.qty; changed = true; }
    });
    if (changed) document.querySelectorAll("[data-stock]").forEach(el => {
      const l = state.listings.find(y => y.id === el.dataset.stock); if (l) el.outerHTML = warStockHTML(l);
    });
  }, () => {});
}

/* ================= War buy: limited quantity, first come first served, live ================= */
function startWar(l0) {
  const box = $(`#modal-body [data-war="${CSS.escape(l0.id)}"]`); if (!box) return;
  let l = { ...l0 }, claims = [], timer = null;
  const unsubs = [
    onSnapshot(doc(db, "listings", l0.id), s => { if (s.exists()) { l = { id: s.id, ...s.data() }; Object.assign(l0, l); paint(); } }, () => {}),
    onSnapshot(query(collection(db, "listings", l0.id, "claims"), orderBy("at", "asc")), s => { claims = s.docs.map(d => ({ id: d.id, ...d.data() })); paint(); }, () => {})
  ];
  const stop = () => { unsubs.forEach(u => u()); clearInterval(timer); };
  modal.addEventListener("close", stop, { once: true });
  timer = setInterval(() => { if (ms(l.warStart) > Date.now() - 1500) paint(); }, 1000);
  function paint() {
    if (!box.isConnected) return stop();
    const me = state.user?.uid, mine = claims.find(c => c.uid === me);
    const taken = Math.max(l.claimed || 0, claims.length), left = Math.max(0, l.qty - taken);
    const startAt = ms(l.warStart), waiting = startAt && startAt > Date.now();
    const isOwner = me && me === l.ownerUid;
    let btn;
    if (l.status === "sold") btn = `<button class="btn war-buy" disabled>${t("sold")}</button>`;
    else if (mine) btn = `<p class="war-got">🎉 ${t("war_got", { n: claims.indexOf(mine) + 1 })}</p><button type="button" class="btn btn-ghost btn-sm" data-war-cancel>${t("war_cancel")}</button>`;
    else if (isOwner) btn = `<p class="muted">${t("war_owner")}</p>`;
    else if (!left) btn = `<button class="btn war-buy" disabled>${t("war_soldout")}</button>`;
    else if (waiting) btn = `<button class="btn war-buy" disabled>⏳ ${t("war_starts_in", { time: countdown(startAt - Date.now()) })}</button>`;
    else btn = `<button type="button" class="btn btn-mat war-buy" data-war-buy>⚡ ${t("war_buy")}</button>`;
    box.innerHTML = `
      <div class="war-head"><strong>⚡ WAR BUY</strong><span>${t("war_left", { left, qty: l.qty })}</span></div>
      <div class="war-bar"><i style="width:${Math.min(100, taken / l.qty * 100)}%"></i></div>
      ${startAt ? `<p class="muted war-start">${t("war_start_at", { when: new Date(startAt).toLocaleString(locale(), { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) })}</p>` : ""}
      <div class="war-action">${btn}</div>
      <h4>${t("war_buyers")} (${claims.length}/${l.qty})</h4>
      ${claims.length ? `<ol class="war-list">${claims.map((c, i) => `<li class="${c.uid === me ? "me" : ""}">
        <span class="war-n">#${i + 1}</span><span class="cmt-av">${c.photo ? `<img src="${esc(c.photo)}" alt="" referrerpolicy="no-referrer">` : esc(initials(c.name))}</span>
        <span class="war-name">${esc(c.name)}</span><small>${ms(c.at) ? new Date(ms(c.at)).toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : ""}</small>
        ${(isOwner || isAdmin()) && l.status !== "sold" ? `<button type="button" class="cmt-act" data-war-remove="${esc(c.id)}">${t("war_remove")}</button>` : ""}</li>`).join("")}</ol>`
        : `<p class="muted">${t("war_none")}</p>`}`;
  }
  box.addEventListener("click", async (e) => {
    if (e.target.closest("[data-war-buy]")) {
      if (!state.user) { toast(t("war_signin")); closeModal(); openSignInChooser(); return; }
      if (state.profile?.status !== "approved") { toast(t("cmt_need_active")); return; }
      const b = e.target.closest("[data-war-buy]"); b.disabled = true; b.textContent = "…";
      try {
        const n = await runTransaction(db, async (tx) => {
          const ref = doc(db, "listings", l.id), cref = doc(db, "listings", l.id, "claims", state.user.uid);
          const [snap, mineSnap] = [await tx.get(ref), await tx.get(cref)];
          const d = snap.data();
          if (d.status === "sold") throw new Error(t("sold"));
          if (mineSnap.exists()) throw new Error(t("war_already"));
          if (ms(d.warStart) > Date.now()) throw new Error(t("war_not_started"));
          const next = (d.claimed || 0) + 1;
          if (next > d.qty) throw new Error(t("war_soldout"));
          tx.update(ref, { claimed: next });
          tx.set(cref, { uid: state.user.uid, name: String(state.profile.displayName || "").slice(0, 80),
            photo: String(state.profile.photoURL || state.user.photoURL || "").slice(0, 600), n: next, at: serverTimestamp() });
          return next;
        });
        toast(t("war_got", { n }));
        addDoc(collection(db, "notices"), { uid: l.ownerUid, kind: "claim", target: "market", postId: l.id, title: String(l.title || "").slice(0, 100),
          note: `#${n}`, from: state.user.uid, fromName: String(state.profile.displayName || "").slice(0, 80), at: serverTimestamp(), read: false }).catch(() => {});
      } catch (err) { toast(err.message === "Missing or insufficient permissions." ? t("war_soldout") : err.message); paint(); }
    }
    if (e.target.closest("[data-war-cancel]")) {
      if (!confirm(t("war_cancel_confirm"))) return;
      try {
        await runTransaction(db, async (tx) => {
          const ref = doc(db, "listings", l.id), cref = doc(db, "listings", l.id, "claims", state.user.uid);
          const snap = await tx.get(ref);
          tx.update(ref, { claimed: Math.max(0, (snap.data().claimed || 1) - 1) }); tx.delete(cref);
        });
      } catch (err) { fail(err); }
    }
    const rm = e.target.closest("[data-war-remove]");
    if (rm) {
      if (!confirm(t("war_remove_confirm"))) return;
      try {
        const batch = writeBatch(db);
        batch.delete(doc(db, "listings", l.id, "claims", rm.dataset.warRemove));
        batch.update(doc(db, "listings", l.id), { claimed: Math.max(0, (l.claimed || 1) - 1) });
        await batch.commit();
      } catch (err) { fail(err); }
    }
  });
  paint();
}
function countdown(msLeft) {
  const s = Math.max(0, Math.round(msLeft / 1000)), d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60), x = s % 60;
  return d ? `${d}d ${h}h ${m}m` : h ? `${h}:${String(m).padStart(2, "0")}:${String(x).padStart(2, "0")}` : `${m}:${String(x).padStart(2, "0")}`;
}

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
  const c = state.feed.find(x => x.id === id) || (state.feedProfile?.posts || []).find(x => x.id === id) || state.searchPosts.find(x => x.id === id) || state.deepPost;
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
    wireCarousels($("#modal-body")); fillCommentPreviews($("#modal-body"));
    modal.addEventListener("close", () => { state.deepOpened = null; history.replaceState(null, "", "#/feed"); }, { once: true });
    if (state.openCommentsAfter === `cars:${c.id}`) { state.openCommentsAfter = null; setTimeout(() => openComments("cars", c.id), 150); }
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

/* ================= Comments & replies (collection posts & market listings) ================= */
const CMT_ICON = `<svg viewBox="0 0 24 24" width="25" height="25" aria-hidden="true"><path d="M20.5 11.6a8.4 8.4 0 0 1-12.3 7.5L3.5 20.5l1.5-4.5A8.4 8.4 0 1 1 20.5 11.6Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>`;
state.cmtItems = {};   // "cars:<id>" / "listings:<id>" → the post, for titles and owner
const cmtCol = (col, id) => collection(db, col, id, "comments");
const findPost = (col, id) => state.cmtItems[`${col}:${id}`]
  || (col === "cars" ? (state.feed.find(x => x.id === id) || (state.feedProfile?.posts || []).find(x => x.id === id) || state.searchPosts.find(x => x.id === id) || (state.deepPost?.id === id ? state.deepPost : null))
                     : state.listings.find(x => x.id === id));
function cmtLine(c, col, postId, owner, isReply) {
  const canDel = state.user && (c.uid === state.user.uid || owner === state.user.uid || isAdmin());
  const canReply = state.user && state.profile?.status === "approved";
  return `<div class="cmt ${isReply ? "cmt-reply" : ""}" data-cid="${esc(c.id)}">
    <span class="cmt-av">${c.photo ? `<img src="${esc(c.photo)}" alt="" referrerpolicy="no-referrer">` : esc(initials(c.name))}</span>
    <div class="cmt-body"><p><strong>${esc(c.name)}</strong> ${c.replyToName ? `<span class="cmt-at">@${esc(c.replyToName)}</span> ` : ""}${esc(c.text)}</p>
      <small>${ago(c.at)}
        ${canReply ? ` · <button type="button" class="cmt-act" data-cmt-reply="${esc(c.parent || c.id)}|${esc(c.id)}|${esc(c.name)}">${t("cmt_reply")}</button>` : ""}
        ${canDel ? ` · <button type="button" class="cmt-act" data-cmt-del="${col}:${esc(postId)}:${esc(c.id)}">${t("delete")}</button>` : ""}</small></div>
  </div>`;
}
// Under each feed post: "View all N comments" + the 2 newest + "Add a comment…".
async function fillCommentPreviews(root) {
  for (const box of root.querySelectorAll("[data-cmts]")) {
    if (box.dataset.loaded) continue; box.dataset.loaded = "1";
    const [col, id] = box.dataset.cmts.split(":");
    try {
      const [cnt, snap] = await Promise.all([getCountFromServer(cmtCol(col, id)), getDocs(query(cmtCol(col, id), orderBy("at", "desc"), limit(2)))]);
      paintPreview(box, col, id, cnt.data().count, snap.docs.map(d => ({ id: d.id, ...d.data() })).reverse());
    } catch (e) { paintPreview(box, col, id, 0, []); }
  }
}
function paintPreview(box, col, id, n, latest) {
  box.innerHTML = `
    ${n > latest.length ? `<button type="button" class="cmt-all" data-cmt-open="${col}:${esc(id)}">${t("cmt_view_all", { n })}</button>` : ""}
    ${latest.map(c => `<p class="cmt-mini"><strong>${esc(c.name)}</strong> ${c.replyToName ? `<span class="cmt-at">@${esc(c.replyToName)}</span> ` : ""}${esc(c.text)}</p>`).join("")}
    <button type="button" class="cmt-add" data-cmt-open="${col}:${esc(id)}">${t("cmt_add")}</button>`;
}
function refreshPreview(col, id) {
  document.querySelectorAll(`[data-cmts="${col}:${CSS.escape(id)}"]`).forEach(b => { delete b.dataset.loaded; });
  fillCommentPreviews(document);
}
// The full list (comments with their replies underneath) and a box to write one.
async function renderCommentsInto(box, col, item) {
  if (!box) return;
  const key = `${col}:${item.id}`;
  box.innerHTML = `<h3 class="cmt-title">${t("comments")}</h3><div class="cmt-list"><p class="muted">…</p></div>${cmtFormHTML(key)}`;
  try {
    const snap = await getDocs(query(cmtCol(col, item.id), orderBy("at", "asc"), limit(300)));
    const all = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    const ids = new Set(all.map(c => c.id));
    const tops = all.filter(c => !c.parent || !ids.has(c.parent));
    const html = tops.map(c => cmtLine(c, col, item.id, item.ownerUid, false)
      + all.filter(r => r.parent === c.id).map(r => cmtLine(r, col, item.id, item.ownerUid, true)).join("")).join("");
    box.querySelector(".cmt-title").textContent = all.length ? `${t("comments")} (${all.length})` : t("comments");
    box.querySelector(".cmt-list").innerHTML = html || `<p class="muted cmt-none">${t("cmt_none")}</p>`;
    const l = box.querySelector(".cmt-list"); l.scrollTop = l.scrollHeight;
    box._comments = all;
  } catch (e) { box.querySelector(".cmt-list").innerHTML = `<p class="muted">${t("cmt_none")}</p>`; }
}
function cmtFormHTML(key) {
  const [kcol, kid] = key.split(":");
  if (kcol === "listings" && findPost(kcol, kid)?.status === "sold") return `<p class="muted cmt-closed">🔒 ${t("cmt_closed_sold")}</p>`;
  if (!state.user) return `<button type="button" class="btn btn-ghost cmt-signin" data-cmt-signin>${t("cmt_signin")}</button>`;
  if (state.profile?.status !== "approved") return `<p class="muted">${t("cmt_need_active")}</p>`;
  const ph = state.profile.photoURL || state.user.photoURL;
  return `<div class="cmt-replying" hidden><span></span><button type="button" data-cmt-cancel aria-label="${t("cancel")}">✕</button></div>
  <form class="cmt-form" data-cmt-form="${esc(key)}">
    <span class="cmt-av">${ph ? `<img src="${esc(ph)}" alt="" referrerpolicy="no-referrer">` : esc(initials(state.profile.displayName))}</span>
    <input name="text" maxlength="500" autocomplete="off" placeholder="${esc(t("cmt_placeholder"))}" required>
    <input type="hidden" name="parent"><input type="hidden" name="replyTo"><input type="hidden" name="replyName">
    <button type="submit" class="cmt-post">${t("cmt_post")}</button>
  </form>`;
}
function openComments(col, id) {
  const item = findPost(col, id); if (!item) return;
  state.cmtItems[`${col}:${id}`] = item;
  openModal(`<div class="cmt-sheet"><p class="muted cmt-of">${esc(item.name || item.title || "")} · ${esc(item.ownerName || "")}</p><section data-cmt-inline="${col}:${esc(id)}"></section></div>`);
  $("#modal-body").onclick = null;
  renderCommentsInto($("#modal-body [data-cmt-inline]"), col, item).then(() => $("#modal-body .cmt-form [name=text]")?.focus());
}
function setReplying(box, parent, replyTo, name) {
  const f = box.querySelector(".cmt-form"), bar = box.querySelector(".cmt-replying"); if (!f) return;
  f.parent.value = parent || ""; f.replyTo.value = replyTo || ""; f.replyName.value = name || "";
  bar.hidden = !parent; if (parent) bar.querySelector("span").textContent = t("cmt_replying_to", { name });
  f.text.placeholder = parent ? t("cmt_reply_ph", { name }) : t("cmt_placeholder");
  f.text.focus();
}
document.addEventListener("click", async (e) => {
  const o = e.target.closest("[data-cmt-open]");
  if (o) { const [col, id] = o.dataset.cmtOpen.split(":"); openComments(col, id); return; }
  if (e.target.closest("[data-cmt-signin]")) { closeModal(); openSignInChooser(); return; }
  const r = e.target.closest("[data-cmt-reply]");
  if (r) { const [parent, replyTo, name] = r.dataset.cmtReply.split("|"); setReplying(r.closest("[data-cmt-inline]"), parent, replyTo, name); return; }
  const x = e.target.closest("[data-cmt-cancel]");
  if (x) { setReplying(x.closest("[data-cmt-inline]"), "", "", ""); return; }
  const d = e.target.closest("[data-cmt-del]");
  if (d) {
    const [col, pid, cid] = d.dataset.cmtDel.split(":");
    if (!confirm(t("cmt_del_confirm"))) return;
    try {
      await deleteDoc(doc(db, col, pid, "comments", cid));
      const item = findPost(col, pid); const box = d.closest("[data-cmt-inline]");
      if (item && box) renderCommentsInto(box, col, item);
      refreshPreview(col, pid);
    } catch (err) { fail(err); }
  }
});
document.addEventListener("submit", async (e) => {
  const f = e.target.closest("[data-cmt-form]"); if (!f) return;
  e.preventDefault();
  const [col, id] = f.dataset.cmtForm.split(":");
  const text = f.text.value.trim(); if (!text) return;
  const btn = f.querySelector("button[type=submit]"); btn.disabled = true;
  const box = f.closest("[data-cmt-inline]");
  try {
    const me = state.profile, item = findPost(col, id);
    const parent = f.parent.value, replyName = f.replyName.value;
    const data = { uid: state.user.uid, name: String(me.displayName || "").slice(0, 80),
      photo: String(me.photoURL || state.user.photoURL || "").slice(0, 600), text: text.slice(0, 500), at: serverTimestamp() };
    if (parent) { data.parent = parent; data.replyToName = replyName.slice(0, 80); }
    await addDoc(cmtCol(col, id), data);
    // Notifications: the post owner ("commented on your post") and, for a reply, the person replied to.
    const base = { target: col === "cars" ? "collection" : "market", postId: id, title: String(item?.name || item?.title || "").slice(0, 100),
      note: text.slice(0, 200), from: state.user.uid, fromName: String(me.displayName || "").slice(0, 80), read: false };
    const told = new Set([state.user.uid]);
    if (parent) {
      const target = (box?._comments || []).find(c => c.id === f.replyTo.value) || (box?._comments || []).find(c => c.id === parent);
      if (target && !told.has(target.uid)) {
        told.add(target.uid);
        addDoc(collection(db, "notices"), { ...base, uid: target.uid, kind: "reply", parentId: target.id, at: serverTimestamp() }).catch(() => {});
      }
    }
    if (item?.ownerUid && !told.has(item.ownerUid)) addDoc(collection(db, "notices"), { ...base, uid: item.ownerUid, kind: "comment", at: serverTimestamp() }).catch(() => {});
    f.text.value = "";
    if (box && item) { await renderCommentsInto(box, col, item); box.querySelector(".cmt-form [name=text]")?.focus(); }
    refreshPreview(col, id);
  } catch (err) { fail(err); }
  btn.disabled = false;
});

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
  if (!state.reviews) loadReviews().then(paintProfile);
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
        <p class="ig-rep">${t("rep_seller")}: ${repBadge(p.uid) || "…"}</p>
        ${p.uid !== state.user?.uid ? `<button type="button" class="btn btn-sm btn-mat ig-dm" data-dm="${esc(p.uid)}" data-dm-name="${esc(any.ownerName || "")}" data-dm-photo="${esc(any.ownerPhoto || "")}">✉️ ${t("dm_message")}</button>` : ""}
      </div>
    </div>
    ${p.posts && !posts.length ? `<p class="empty">${t("feed_empty")}</p>` : ""}
    <div class="ig-grid">${posts.map(c => `<button type="button" class="ig-tile" data-open-post="${esc(c.id)}">
      ${c.photos?.[0] ? `<img src="${photoSrc(c.photos[0])}" alt="${esc(c.name)}" loading="lazy" draggable="false">` : `<span>1:64</span>`}
      ${(c.photos || []).length > 1 ? `<i class="ig-multi" aria-hidden="true">❏</i>` : ""}
      <span class="ig-hover">♥ ${(c.likedBy || []).length}</span></button>`).join("")}</div>`;
}
/* Hashtags (#jdm, #r34…) in captions and listings are links that search for that tag. */
function tagify(text, where) {
  return esc(text).replace(/(^|\s)#([\p{L}\p{N}_]{1,40})/gu, (m, pre, tag) => `${pre}<a href="#" class="hashtag" data-tag="${tag}" data-tag-where="${where}">#${tag}</a>`);
}
document.addEventListener("click", (e) => {
  const a = e.target.closest("a.hashtag"); if (!a) return;
  e.preventDefault();
  if (modal.open) closeModal();
  const q = "#" + a.dataset.tag;
  if (a.dataset.tagWhere === "market") {
    if (!location.hash.startsWith("#/market")) location.hash = "#/market";
    setTimeout(() => { $("#market-q").value = q; renderListings(); $("#market-q").scrollIntoView({ block: "center" }); }, 200);
  } else {
    if (location.hash !== "#/feed") location.hash = "#/feed";
    setTimeout(() => { $("#feed-search").hidden = false; $("#feed-q").value = q; loadAllCars().then(runFeedSearch); window.scrollTo(0, 0); }, 200);
  }
});

/* ---- Search the collection: everyone's posts, by car, maker, notes, owner or city ---- */
const searchText = (...xs) => norm(xs.filter(Boolean).join(" "));
state.searchPosts = [];
$("#feed-search-btn").addEventListener("click", () => {
  const box = $("#feed-search"); box.hidden = !box.hidden;
  if (!box.hidden) { $("#feed-q").focus(); loadAllCars(); } else { $("#feed-q").value = ""; runFeedSearch(); }
});
async function loadAllCars() {
  if (state.allCars) { runFeedSearch(); return; }
  try {
    const snap = await getDocs(query(collection(db, "cars"), orderBy("createdAt", "desc"), limit(500)));
    state.allCars = snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(c => !c.hidden && !c.modHidden);
  } catch (e) { state.allCars = []; }
  runFeedSearch();
}
let feedSearchTimer;
$("#feed-q").addEventListener("input", () => { clearTimeout(feedSearchTimer); feedSearchTimer = setTimeout(runFeedSearch, 150); });
function runFeedSearch() {
  const q = norm($("#feed-q").value);
  const res = $("#feed-results");
  const on = !!q;
  res.hidden = !on; $("#feed-people").hidden = on;
  if (!/^#\/feed\/u\//.test(location.hash)) $("#feed-main").hidden = on; else $("#feed-profile").hidden = on;
  if (!on) return;
  if (!state.allCars) { res.innerHTML = `<p class="muted">…</p>`; return; }
  const words = q.split(" ");
  const hits = state.searchPosts = state.allCars.filter(c => { const h = searchText(c.name, c.maker, c.notes, c.ownerName, c.ownerCity); return words.every(w => h.includes(w)); });
  res.innerHTML = `<p class="muted ig-found">${t(hits.length === 1 ? "search_found_one" : "search_found", { n: hits.length })}</p>
    ${hits.length ? `<div class="ig-grid">${hits.map(c => `<button type="button" class="ig-tile" data-open-post="${esc(c.id)}">
      ${c.photos?.[0] ? `<img src="${photoSrc(c.photos[0])}" alt="${esc(c.name)}" loading="lazy" draggable="false">` : `<span>1:64</span>`}
      <span class="ig-hover">${esc(c.name)}</span></button>`).join("")}</div>` : `<p class="empty">${t("search_none")}</p>`}`;
}
$("#feed-results").addEventListener("click", (e) => {
  const tile = e.target.closest("[data-open-post]"); if (!tile) return;
  const c = state.searchPosts.find(x => x.id === tile.dataset.openPost); if (!c) return;
  openModal(`<div class="post-modal">${postHTML(c)}</div>`);
  $("#modal-body").onclick = null;
  wireCarousels($("#modal-body")); fillCommentPreviews($("#modal-body"));
});

$("#feed-profile").addEventListener("click", (e) => {
  const tile = e.target.closest("[data-open-post]"); if (!tile) return;
  const c = (state.feedProfile?.posts || []).find(x => x.id === tile.dataset.openPost); if (!c) return;
  openModal(`<div class="post-modal">${postHTML(c)}</div>`);
  $("#modal-body").onclick = null;
  wireCarousels($("#modal-body")); fillCommentPreviews($("#modal-body"));
});
// Tap a name or avatar in a post to open that collector's profile.
document.addEventListener("click", (e) => {
  if (e.target.closest(".post-mod")) return;
  if (e.target.closest(".post-dm")) return;
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

/* ================= Direct messages (private, 1-to-1) =================
   chats/{uidA_uidB} (uids sorted) → members, names, photos, last message, readAt per person, blockedBy, report fields.
   chats/{id}/messages → from, text, photo, at. Only the two people can read a chat; admins/moderators only once it's reported. */
const dm = { chats: [], unsub: null, uid: null, open: null, unsubMsgs: null, lastSeenAt: 0 };
const chatIdOf = (a, b) => [a, b].sort().join("_");
const otherOf = (c) => (c.members || []).find(u => u !== state.user?.uid) || "";
const chatUnread = (c) => c.lastFrom && c.lastFrom !== state.user?.uid && ms(c.lastAt) > ms(c.readAt?.[state.user?.uid]);
function startDM() {
  if (dm.uid === state.user.uid) return;
  stopDM(); dm.uid = state.user.uid; dm.startedAt = Date.now();
  $("#dm-wrap").hidden = false;
  dm.unsub = onSnapshot(query(collection(db, "chats"), where("members", "array-contains", state.user.uid)), s => {
    const before = dm.chats.filter(chatUnread).length;
    dm.chats = s.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => ms(b.lastAt) - ms(a.lastAt));
    const n = dm.chats.filter(chatUnread).length;
    const c = $("#dm-count"); c.hidden = !n; c.textContent = n > 99 ? "99+" : String(n);
    if (Date.now() - dm.startedAt > 4000 && n > before && !location.hash.startsWith("#/dm/")) toast(t("dm_new_toast"));
    if (location.hash.startsWith("#/dm")) renderDM();
  }, () => {});
}
function stopDM() { dm.unsub?.(); dm.unsub = null; dm.uid = null; dm.chats = []; dm.unsubMsgs?.(); dm.unsubMsgs = null; const w = $("#dm-wrap"); if (w) w.hidden = true; }

// Start (or open) a chat with someone: from a profile or a market listing.
async function openChatWith(uid, name = "", photo = "", context = "") {
  if (!state.user) { toast(t("dm_signin")); openSignInChooser(); return; }
  if (state.profile?.status !== "approved") { toast(t("cmt_need_active")); return; }
  if (!uid || uid === state.user.uid) return;
  const id = chatIdOf(state.user.uid, uid);
  try {
    const ref = doc(db, "chats", id), snap = await getDoc(ref);
    if (!snap.exists()) {
      const me = state.user.uid;
      await setDoc(ref, { members: [me, uid].sort(), names: { [me]: String(state.profile.displayName || "").slice(0, 80), [uid]: String(name || "").slice(0, 80) },
        photos: { [me]: String(state.profile.photoURL || state.user.photoURL || "").slice(0, 600), [uid]: String(photo || "").slice(0, 600) },
        createdAt: serverTimestamp(), lastAt: serverTimestamp(), lastText: "", lastFrom: "", readAt: {}, blockedBy: [] });
    }
  } catch (e) { fail(e); return; }
  dm.draft = context;
  if (modal.open) closeModal();
  location.hash = `#/dm/${encodeURIComponent(id)}`;
}
document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-dm]"); if (!b) return;
  e.preventDefault(); e.stopPropagation();
  openChatWith(b.dataset.dm, b.dataset.dmName || "", b.dataset.dmPhoto || "", b.dataset.dmContext || "");
}, true);

function renderDM() {
  const box = $("#dm-body"); if (!box) return;
  if (!state.user) { box.innerHTML = `<p class="empty">${t("dm_signin")}</p>`; return; }
  const m = location.hash.match(/^#\/dm\/([^/]+)/);
  const id = m ? decodeURIComponent(m[1]) : "";
  $("#dmpage").classList.toggle("in-chat", !!id);
  document.body.classList.toggle("dm-open", !!id);
  fitChat();
  const list = dm.chats.filter(c => c.lastFrom || c.id === id);
  $("#dm-list").innerHTML = list.length ? list.map(c => {
    const o = otherOf(c), nm = c.names?.[o] || "RCMI", ph = c.photos?.[o] || "";
    return `<a class="dm-row ${c.id === id ? "on" : ""} ${chatUnread(c) ? "unread" : ""}" href="#/dm/${encodeURIComponent(c.id)}">
      <span class="cmt-av">${ph ? `<img src="${esc(ph)}" alt="" referrerpolicy="no-referrer">` : esc(initials(nm))}</span>
      <span class="dm-row-t"><strong>${esc(nm)}</strong><small>${c.lastFrom === state.user.uid ? t("dm_you") + ": " : ""}${esc(c.lastText || "")}</small></span>
      <small class="dm-time">${ms(c.lastAt) ? ago(c.lastAt) : ""}</small></a>`;
  }).join("") : `<p class="empty">${t("dm_none")}</p>`;
  if (!id) { dm.unsubMsgs?.(); dm.unsubMsgs = null; dm.open = null; $("#dm-chat").innerHTML = `<p class="empty dm-pick">${t("dm_pick")}</p>`; return; }
  const c = dm.chats.find(x => x.id === id);
  if (!c) { $("#dm-chat").innerHTML = `<p class="empty">…</p>`; return; }
  const o = otherOf(c), nm = c.names?.[o] || "RCMI";
  const blocked = (c.blockedBy || []).length > 0, iBlocked = (c.blockedBy || []).includes(state.user.uid);
  if (dm.open !== id) {
    dm.open = id; dm.footKey = ""; dm.unsubMsgs?.();
    $("#dm-chat").innerHTML = `
      <header class="dm-head">
        <a class="dm-back" href="#/dm" aria-label="${t("dm_back")}"><svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg></a>
        <a class="dm-who" href="#/feed/u/${encodeURIComponent(o)}"><span class="cmt-av">${c.photos?.[o] ? `<img src="${esc(c.photos[o])}" alt="" referrerpolicy="no-referrer">` : esc(initials(nm))}</span><strong>${esc(nm)}</strong></a>
        <button type="button" class="post-mod" data-dm-menu aria-label="${t("dm_menu")}">⋯</button>
      </header>
      <div class="dm-msgs" id="dm-msgs"><p class="empty">…</p></div>
      <div id="dm-foot"></div>`;
    dm.unsubMsgs = onSnapshot(query(collection(db, "chats", id, "messages"), orderBy("at", "asc"), limit(500)), s => {
      dm.msgs = s.docs.map(d => ({ id: d.id, ...d.data() }));
      paintMsgs();
      markChatRead(id);
    }, () => { $("#dm-msgs").innerHTML = `<p class="empty">${t("not_found")}</p>`; });
  }
  const footKey = `${id}|${blocked}|${iBlocked}`;
  if (dm.footKey === footKey && $("#dm-foot")?.children.length) return;
  dm.footKey = footKey;
  $("#dm-foot").innerHTML = blocked
    ? `<p class="muted dm-blocked">${t(iBlocked ? "dm_you_blocked" : "dm_blocked")}</p>`
    : `<form class="dm-form" id="f-dm">
        <label class="dm-photo" title="${esc(t("photos"))}" aria-label="${esc(t("photos"))}"><input type="file" name="photo" accept="image/*" hidden><svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><path d="M4 8h3l2-3h6l2 3h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1Z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><circle cx="12" cy="13.5" r="3.5" fill="none" stroke="currentColor" stroke-width="2"/></svg></label>
        <textarea name="text" rows="1" maxlength="1000" placeholder="${esc(t("dm_ph"))}"></textarea>
        <button class="dm-send" type="submit" aria-label="${esc(t("dm_send"))}" title="${esc(t("dm_send"))}"><svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M21 3 10 14M21 3l-7 18-4-7-7-4 18-7Z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg></button>
      </form>`;
  const f = $("#f-dm");
  if (f) {
    if (dm.draft) { f.text.value = dm.draft; dm.draft = ""; }
    f.text.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey && !matchMedia("(pointer: coarse)").matches) { e.preventDefault(); f.requestSubmit(); } });
    f.photo.addEventListener("change", () => { f.querySelector(".dm-photo").classList.toggle("on", !!f.photo.files.length); });
    const grow = () => { f.text.style.height = "auto"; f.text.style.height = Math.min(f.text.scrollHeight, 120) + "px"; };
    f.text.addEventListener("input", grow);
    f.text.addEventListener("focus", () => setTimeout(() => { fitChat(); const b = $("#dm-msgs"); if (b) b.scrollTop = b.scrollHeight; }, 300));
    f.addEventListener("submit", (e) => { e.preventDefault(); sendDM(c, f); });
  }
}
// On phones an open chat fills the screen between the top bar and the keyboard, like a messaging app.
function fitChat() {
  const r = document.documentElement.style, vv = window.visualViewport;
  r.setProperty("--tb", ($(".topbar")?.offsetHeight || 0) + "px");
  r.setProperty("--vvh", (vv ? vv.height : innerHeight) + "px");
}
window.visualViewport?.addEventListener("resize", fitChat);
fitChat();   // also positions the sticky news strip right under the top bar
if (window.ResizeObserver && $(".topbar")) new ResizeObserver(fitChat).observe($(".topbar"));
addEventListener("resize", fitChat);
function paintMsgs() {
  const box = $("#dm-msgs"); if (!box) return;
  const me = state.user.uid;
  box.innerHTML = (dm.msgs || []).length ? dm.msgs.map(m => `
    <div class="dm-msg ${m.from === me ? "me" : ""}" data-msg="${esc(m.id)}">
      ${m.photo ? `<img src="${photoSrc(m.photo)}" alt="" loading="lazy">` : ""}
      ${m.text ? `<p>${esc(m.text).replace(/\n/g, "<br>")}</p>` : ""}
      <small>${ms(m.at) ? new Date(ms(m.at)).toLocaleString(locale(), { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "…"}
        ${m.from === me ? ` · <button type="button" class="cmt-act" data-unsend="${esc(m.id)}">${t("dm_unsend")}</button>` : ""}</small>
    </div>`).join("") : `<p class="empty">${t("dm_say_hi")}</p>`;
  box.scrollTop = box.scrollHeight;
}
function markChatRead(id) {
  const c = dm.chats.find(x => x.id === id);
  if (c && chatUnread(c)) updateDoc(doc(db, "chats", id), { [`readAt.${state.user.uid}`]: serverTimestamp() }).catch(() => {});
}
async function sendDM(c, f) {
  const text = f.text.value.trim();
  if (!text && !f.photo.files.length) return;
  const btn = f.querySelector("[type=submit]"); btn.disabled = true; btn.classList.add("busy");
  try {
    const photos = f.photo.files.length ? await storePhotos(f.photo, "market", 1, 0) : [];
    const batch = writeBatch(db);
    batch.set(doc(collection(db, "chats", c.id, "messages")), { from: state.user.uid, text: text.slice(0, 1000), photo: photos[0] || "", at: serverTimestamp() });
    batch.update(doc(db, "chats", c.id), { lastText: (text || "📷").slice(0, 120), lastAt: serverTimestamp(), lastFrom: state.user.uid,
      [`readAt.${state.user.uid}`]: serverTimestamp(), [`names.${state.user.uid}`]: String(state.profile.displayName || "").slice(0, 80) });
    await batch.commit();
    f.text.value = ""; f.text.style.height = ""; f.photo.value = ""; f.querySelector(".dm-photo").classList.remove("on");
  } catch (err) { fail(err); }
  btn.disabled = false; btn.classList.remove("busy"); f.text.focus();
}
$("#dmpage").addEventListener("click", async (e) => {
  const u = e.target.closest("[data-unsend]");
  if (u) {
    if (!confirm(t("dm_unsend_confirm"))) return;
    try { await deleteDoc(doc(db, "chats", dm.open, "messages", u.dataset.unsend)); } catch (err) { fail(err); }
    return;
  }
  if (e.target.closest("[data-dm-menu]")) {
    const c = dm.chats.find(x => x.id === dm.open); if (!c) return;
    const iBlocked = (c.blockedBy || []).includes(state.user.uid);
    openModal(`
      <h2>${esc(c.names?.[otherOf(c)] || "")}</h2>
      <div class="form-actions dm-menu">
        <a class="btn btn-ghost" href="#/feed/u/${encodeURIComponent(otherOf(c))}" data-act="close">${t("dm_profile")}</a>
        <button type="button" class="btn btn-ghost" data-act="${iBlocked ? "unblock" : "block"}">${t(iBlocked ? "dm_unblock" : "dm_block")}</button>
        <button type="button" class="btn btn-danger" data-act="report">${t("dm_report")}</button>
        <button type="button" class="btn btn-ghost" data-act="close">${t("close")}</button>
      </div>`);
    $("#modal-body").onclick = async (ev) => {
      const act = ev.target.dataset.act; if (!act) return;
      if (act === "close") { closeModal(); return; }
      try {
        if (act === "block") { if (!confirm(t("dm_block_confirm"))) return; await updateDoc(doc(db, "chats", c.id), { blockedBy: arrayUnion(state.user.uid) }); toast(t("dm_blocked_done")); }
        if (act === "unblock") { await updateDoc(doc(db, "chats", c.id), { blockedBy: arrayRemove(state.user.uid) }); toast(t("saved")); }
        if (act === "report") {
          const why = prompt(t("dm_report_why")); if (!why || why.trim().length < 5) { if (why !== null) toast(t("del_reason_required")); return; }
          await updateDoc(doc(db, "chats", c.id), { reported: true, reportedBy: state.user.uid, reportNote: why.trim().slice(0, 300), reportedAt: serverTimestamp() });
          toast(t("dm_reported"));
        }
        closeModal();
      } catch (err) { fail(err); }
    };
  }
});

/* Staff: reported chats — read the conversation, then mark it resolved. */
async function loadReportedChats() {
  if (!isStaff()) return;
  try {
    const s = await getDocs(query(collection(db, "chats"), where("reported", "==", true)));
    const list = state.repChats = s.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => ms(b.reportedAt) - ms(a.reportedAt));
    $("#admin-repchats-count").textContent = `(${list.length})`;
    $("#admin-repchats").innerHTML = list.length ? list.map(c => `
      <div class="row"><div class="grow"><strong>${(c.members || []).map(u => esc(c.names?.[u] || u)).join(" ↔ ")}</strong>
        <small>${t("dm_reported_by", { name: esc(c.names?.[c.reportedBy] || "") })}${c.reportedAt ? " · " + fmtDate(c.reportedAt, { day: "numeric", month: "short", year: "numeric" }) : ""}</small>
        <small><strong>${t("mod_reason")}:</strong> ${esc(c.reportNote || "")}</small></div>
        <div class="actions"><button class="btn btn-sm btn-mat" data-repchat="${esc(c.id)}">${t("dm_read")}</button>
          <button class="btn btn-sm btn-ghost" data-repchat-ok="${esc(c.id)}">${t("dm_resolve")}</button></div></div>`).join("") : `<p class="muted">${t("dm_rep_none")}</p>`;
  } catch (e) { console.warn(e); }
}
$("#admin-repchats").addEventListener("click", async (e) => {
  const r = e.target.closest("[data-repchat]"), ok = e.target.closest("[data-repchat-ok]");
  if (ok) { try { await updateDoc(doc(db, "chats", ok.dataset.repchatOk), { reported: false }); toast(t("saved")); loadReportedChats(); } catch (err) { fail(err); } return; }
  if (!r) return;
  const c = (state.repChats || []).find(x => x.id === r.dataset.repchat); if (!c) return;
  try {
    const s = await getDocs(query(collection(db, "chats", c.id, "messages"), orderBy("at", "asc"), limit(500)));
    openModal(`<h2>${(c.members || []).map(u => esc(c.names?.[u] || "")).join(" ↔ ")}</h2>
      <div class="dm-msgs dm-audit">${s.docs.map(d => { const m = d.data(); return `<div class="dm-msg ${m.from === c.reportedBy ? "me" : ""}">
        <small><strong>${esc(c.names?.[m.from] || "")}</strong></small>
        ${m.photo ? `<img src="${photoSrc(m.photo)}" alt="" loading="lazy">` : ""}${m.text ? `<p>${esc(m.text).replace(/\n/g, "<br>")}</p>` : ""}
        <small>${fmtDate(m.at, { day: "numeric", month: "short", year: "numeric" })}</small></div>`; }).join("") || `<p class="empty">—</p>`}</div>
      <div class="form-actions"><button class="btn btn-ghost" data-act="close">${t("close")}</button></div>`);
    $("#modal-body").onclick = (ev) => { if (ev.target.dataset.act === "close") closeModal(); };
  } catch (err) { fail(err); }
});

/* ================= Seller reputation =================
   1. Marking a listing sold, the seller picks the buyer (war listings: everyone with a slot).
   2. The buyer gets a "rate this seller" notice: 1–5 stars, "as described", short comment. Once per sale.
   3. Sellers show ⭐ average (from 3 reviews) · number of reviews; tap for the full list. Seller can reply once. */
const REP_MIN = 3;
state.reviews = null;
async function loadReviews(force = false) {
  if (state.reviews && !force) return state.reviews;
  try {
    const s = await getDocs(query(collection(db, "reviews"), orderBy("at", "desc"), limit(2000)));
    state.reviews = s.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch (e) { state.reviews = state.reviews || []; }
  return state.reviews;
}
function repOf(uid) {
  const list = (state.reviews || []).filter(r => r.sellerUid === uid);
  const sum = list.reduce((a, r) => a + (r.stars || 0), 0);
  return { n: list.length, avg: list.length ? sum / list.length : 0, asDesc: list.filter(r => r.asDescribed).length, list };
}
const starsTxt = (n) => "★".repeat(Math.round(n)) + "☆".repeat(5 - Math.round(n));
// Small badge: "⭐ 4.8 (12)" once there are enough reviews, "2 reviews" before that, "New seller" with none.
function repBadge(uid, clickable = true) {
  if (!uid || !state.reviews) return "";
  const r = repOf(uid);
  const txt = r.n >= REP_MIN ? `⭐ ${r.avg.toFixed(1)} <small>(${r.n})</small>` : r.n ? t(r.n === 1 ? "rep_one" : "rep_few", { n: r.n }) : t("rep_new");
  return clickable ? `<button type="button" class="rep-badge" data-rep="${esc(uid)}">${txt}</button>` : `<span class="rep-badge">${txt}</span>`;
}
document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-rep]"); if (!b) return;
  e.preventDefault(); e.stopPropagation(); openReviews(b.dataset.rep);
}, true);

async function openReviews(uid) {
  await loadReviews(true);
  const r = repOf(uid);
  const name = r.list[0]?.sellerName || state.listings.find(l => l.ownerUid === uid)?.ownerName || "";
  let sales = 0;
  try { const s = await getDocs(query(collection(db, "listings"), where("ownerUid", "==", uid))); sales = s.docs.filter(d => d.data().status === "sold").length; } catch (e) {}
  const mine = uid === state.user?.uid;
  openModal(`
    <h2>${t("rep_title")}${name ? ` · ${esc(name)}` : ""}</h2>
    <div class="rep-sum">
      <div><strong>${r.n >= REP_MIN ? r.avg.toFixed(1) : "–"}</strong><span class="rep-stars">${r.n >= REP_MIN ? starsTxt(r.avg) : ""}</span></div>
      <p class="muted">${t("rep_counts", { n: r.n, sales })}${r.n ? ` · ${t("rep_asdesc", { p: Math.round(r.asDesc / r.n * 100) })}` : ""}</p>
      ${r.n && r.n < REP_MIN ? `<p class="muted"><small>${t("rep_min_note", { n: REP_MIN })}</small></p>` : ""}
    </div>
    <div class="rep-list">${r.list.length ? r.list.map(v => `
      <article class="rep-item" data-review="${esc(v.id)}">
        <header><span class="rep-stars">${starsTxt(v.stars)}</span> <strong>${esc(v.reviewerName || "")}</strong>
          <small class="muted">${fmtDate(v.at, { day: "numeric", month: "short", year: "numeric" })}</small></header>
        <p class="muted rep-item-t">${esc(v.title || "")}${v.asDescribed ? ` · ✅ ${t("rep_asdesc_yes")}` : ` · ⚠️ ${t("rep_asdesc_no")}`}</p>
        ${v.text ? `<p>${esc(v.text)}</p>` : ""}
        ${v.reply ? `<p class="rep-reply"><strong>${t("rep_seller_reply")}:</strong> ${esc(v.reply)}</p>`
          : mine ? `<form class="rep-reply-form" data-reply-review="${esc(v.id)}"><input name="reply" maxlength="300" required placeholder="${esc(t("rep_reply_ph"))}"><button class="btn btn-sm btn-ghost" type="submit">${t("rep_reply")}</button></form>` : ""}
        ${isStaff() ? `<button type="button" class="cmt-act" data-review-del="${esc(v.id)}">${t("delete")}</button>` : ""}
      </article>`).join("") : `<p class="empty">${t("rep_none")}</p>`}</div>
    <div class="form-actions"><button type="button" class="btn btn-ghost" data-act="close">${t("close")}</button></div>`);
  $("#modal-body").onclick = async (ev) => {
    if (ev.target.dataset.act === "close") { closeModal(); return; }
    const d = ev.target.closest("[data-review-del]");
    if (d && isStaff()) {
      if (!confirm(t("rep_del_confirm"))) return;
      try { await deleteDoc(doc(db, "reviews", d.dataset.reviewDel)); toast(t("deleted")); openReviews(uid); renderListings(); } catch (err) { fail(err); }
    }
  };
  $("#modal-body").onsubmit = async (ev) => {
    const f = ev.target.closest("[data-reply-review]"); if (!f) return;
    ev.preventDefault();
    const reply = f.reply.value.trim(); if (!reply) return;
    try { await updateDoc(doc(db, "reviews", f.dataset.replyReview), { reply: reply.slice(0, 300), replyAt: serverTimestamp() }); toast(t("saved")); openReviews(uid); }
    catch (err) { fail(err); }
  };
}

// Can I rate this sold listing? (I'm its buyer, or I had a war slot, and I haven't rated it yet.)
async function canRate(l) {
  if (!state.user || l.status !== "sold" || l.ownerUid === state.user.uid) return false;
  const me = state.user.uid;
  let buyer = l.buyerUid === me;
  if (!buyer && l.war) { try { buyer = (await getDoc(doc(db, "listings", l.id, "claims", me))).exists(); } catch (e) {} }
  if (!buyer) return false;
  try { return !(await getDoc(doc(db, "reviews", `${l.id}_${me}`))).exists(); } catch (e) { return false; }
}
async function openRate(listingId) {
  let l = state.listings.find(x => x.id === listingId);
  try { const s = await getDoc(doc(db, "listings", listingId)); if (s.exists()) l = { id: s.id, ...s.data() }; } catch (e) {}
  if (!l) { toast(t("not_found")); return; }
  if (!(await canRate(l))) { toast(t("rep_cant")); return; }
  openModal(`
    <h2>${t("rep_rate_title")}</h2>
    <p class="muted">${esc(l.title)} · ${esc(l.ownerName || "")}</p>
    <form class="form" id="f-rate">
      <fieldset class="rate-stars" aria-label="${esc(t("rep_stars"))}">
        ${[5, 4, 3, 2, 1].map(n => `<input type="radio" name="stars" id="rs${n}" value="${n}" required><label for="rs${n}" title="${n}">★</label>`).join("")}
      </fieldset>
      <label class="lay-check"><input type="checkbox" name="asDescribed" checked> <span>${t("rep_asdesc_q")}</span></label>
      <label><span>${t("rep_comment")}</span><textarea name="text" rows="3" maxlength="300" placeholder="${esc(t("rep_comment_ph"))}"></textarea></label>
      <div class="form-actions">
        <button type="button" class="btn btn-ghost" data-act="close">${t("cancel")}</button>
        <button class="btn btn-mat" type="submit">${t("rep_send")}</button>
      </div>
    </form>`);
  $("#modal-body").onclick = (ev) => { if (ev.target.dataset.act === "close") closeModal(); };
  const f = $("#f-rate");
  f.addEventListener("submit", async (e) => {
    e.preventDefault();
    const stars = parseInt(f.stars.value, 10);
    if (!(stars >= 1 && stars <= 5)) { toast(t("rep_pick_stars")); return; }
    const btn = f.querySelector("[type=submit]"); btn.disabled = true;
    const me = String(state.profile?.displayName || "").slice(0, 80);
    try {
      await setDoc(doc(db, "reviews", `${l.id}_${state.user.uid}`), {
        listingId: l.id, sellerUid: l.ownerUid, sellerName: String(l.ownerName || "").slice(0, 80), title: String(l.title || "").slice(0, 100),
        reviewerUid: state.user.uid, reviewerName: me, stars, asDescribed: f.asDescribed.checked, text: f.text.value.trim().slice(0, 300), at: serverTimestamp() });
      addDoc(collection(db, "notices"), { uid: l.ownerUid, kind: "review", target: "market", postId: l.id, title: String(l.title || "").slice(0, 100),
        note: `${stars}★`, from: state.user.uid, fromName: me, at: serverTimestamp(), read: false }).catch(() => {});
      notif.notices.filter(n => n.kind === "rate" && n.postId === l.id && !n.read).forEach(n => updateDoc(doc(db, "notices", n.id), { read: true }).catch(() => {}));
      closeModal(); toast(t("rep_thanks")); await loadReviews(true); renderListings();
    } catch (err) { fail(err); btn.disabled = false; }
  });
}

// Mark sold: the seller picks who bought it (commenters, or search any account). War listings: every slot holder can rate.
async function openMarkSold(l) {
  const cmts = $("#modal-body [data-cmt-inline]")?._comments || [];
  const people = new Map();
  cmts.forEach(c => { if (c.uid && c.uid !== state.user.uid) people.set(c.uid, c.name || ""); });
  let contacts = [];
  try { contacts = (await getDocs(collection(db, "contacts"))).docs.map(d => ({ uid: d.id, name: d.data().name || "" })).filter(c => c.uid !== state.user.uid && c.name); } catch (e) {}
  const opt = (uid, name) => `<label class="buyer-opt"><input type="radio" name="buyer" value="${esc(uid)}" data-name="${esc(name)}"> <span>${esc(name)}</span></label>`;
  openModal(`
    <h2>${t("mark_sold")}</h2>
    <p class="muted">${esc(l.title)}</p>
    <form class="form" id="f-sold">
      ${l.war ? `<p>${t("sold_war_note")}</p>` : `
      <p><strong>${t("sold_who")}</strong><br><small class="muted">${t("sold_who_hint")}</small></p>
      ${people.size ? `<div class="buyer-list">${[...people].map(([u, n]) => opt(u, n)).join("")}</div>` : ""}
      <input type="search" id="buyer-q" placeholder="${esc(t("sold_search_ph"))}" autocomplete="off">
      <div class="buyer-list" id="buyer-results"></div>
      <label class="buyer-opt"><input type="radio" name="buyer" value="" checked> <span>${t("sold_outside")}</span></label>`}
      <p class="muted"><small>${t("sold_confirm")}</small></p>
      <div class="form-actions">
        <button type="button" class="btn btn-ghost" data-act="close">${t("cancel")}</button>
        <button class="btn btn-mat" type="submit">${t("mark_sold")}</button>
      </div>
    </form>`);
  $("#modal-body").onclick = (ev) => { if (ev.target.dataset.act === "close") closeModal(); };
  const f = $("#f-sold");
  $("#buyer-q")?.addEventListener("input", (e) => {
    const w = norm(e.target.value);
    $("#buyer-results").innerHTML = w.length < 2 ? "" : contacts.filter(c => !people.has(c.uid) && norm(c.name).includes(w)).slice(0, 8).map(c => opt(c.uid, c.name)).join("");
  });
  f.addEventListener("submit", async (e) => {
    e.preventDefault(); const btn = f.querySelector("[type=submit]"); btn.disabled = true;
    try {
      const pick = f.querySelector("input[name=buyer]:checked");
      const buyerUid = l.war ? "" : (pick?.value || ""), buyerName = buyerUid ? String(pick.dataset.name || "").slice(0, 80) : "";
      await updateDoc(doc(db, "listings", l.id), { status: "sold", soldAt: serverTimestamp(), ...(buyerUid ? { buyerUid, buyerName } : {}) });
      const base = { kind: "rate", target: "market", postId: l.id, title: String(l.title || "").slice(0, 100), note: "",
        from: state.user.uid, fromName: String(state.profile?.displayName || "").slice(0, 80), read: false };
      let buyers = buyerUid ? [buyerUid] : [];
      if (l.war) { try { buyers = (await getDocs(collection(db, "listings", l.id, "claims"))).docs.map(d => d.id).filter(u => u !== state.user.uid); } catch (e2) {} }
      buyers.forEach(u => addDoc(collection(db, "notices"), { ...base, uid: u, at: serverTimestamp() }).catch(() => {}));
      closeModal(); toast(t(buyers.length ? "sold_done_rate" : "sold_done")); loadListings();
    } catch (err) { fail(err); btn.disabled = false; }
  });
}

/* ================= Marketplace ================= */
async function loadListings() {
  try {
    const snap = await getDocs(query(collection(db, "listings"), orderBy("createdAt", "desc"), limit(120)));
    // Hidden by an admin: only the seller (and admins) still see it, marked as hidden.
    state.listings = snap.docs.map(d => ({ id: d.id, ...d.data() }))
      .filter(l => !l.hidden && (!l.modHidden || l.ownerUid === state.user?.uid || isAdmin()))
      .filter(l => !isArchived(l));
    if (state.listings.some(l => l.war)) watchWars();
    renderListings();
    loadReviews(true).then(renderListings);
  } catch (e) { fail(e); }
}
// Sold listings stay visible (marked Sold) for 30 days, then they're archived: no longer shown in the market.
const ARCHIVE_DAYS = 30;
const soldTime = (l) => ms(l.soldAt) || ms(l.createdAt);
const isArchived = (l) => l.status === "sold" && Date.now() - soldTime(l) > ARCHIVE_DAYS * 864e5;
const typeLabel = (ty) => t({ sell: "t_sell", trade: "t_trade", wanted: "t_wanted" }[ty] || "t_sell");
function renderListings() {
  const f = state.marketFilter;
  const words = norm($("#market-q")?.value || "").split(" ").filter(Boolean);
  const list = (f === "all" ? state.listings : f === "war" ? state.listings.filter(l => l.war) : state.listings.filter(l => l.type === f && (f !== "sell" || !l.war)))
    .filter(l => { if (!words.length) return true; const h = searchText(l.title, l.description, l.condition, l.ownerName, typeLabel(l.type)); return words.every(w => h.includes(w)); });
  $("#listings").innerHTML = list.length ? list.map(l => `
    <button type="button" class="item" data-listing="${esc(l.id)}">
      ${l.photos?.[0] ? `<img class="ph" src="${photoSrc(l.photos[0])}" alt="" loading="lazy">` : `<div class="ph ph-empty">1:64</div>`}
      <div class="meta">
        ${l.status === "sold" ? `<span class="tag tag-sold">${t("sold")}</span>` : l.war ? `<span class="tag tag-war">⚡ ${t("war_tag")}</span>` : `<span class="tag tag-${esc(l.type)}">${typeLabel(l.type)}</span>`}${l.modHidden ? ` <span class="tag tag-hidden">${t("mod_hidden_tag")}</span>` : ""}
        <h3>${esc(l.title)}</h3>
        <p>${l.price ? `<span class="price">${fmtIDR(l.price)}</span> · ` : ""}${esc(l.ownerName)} ${repBadge(l.ownerUid, false)}</p>
        ${l.war && l.status !== "sold" ? warStockHTML(l) : ""}
        ${(l.likedBy || []).length ? `<p class="l-likes">♥ ${(l.likedBy || []).length}</p>` : ""}
      </div>
    </button>`).join("") : `<p class="empty">${t(words.length ? "search_none" : "empty_market")}</p>`;
}
let marketSearchTimer;
$("#market-q").addEventListener("input", () => { clearTimeout(marketSearchTimer); marketSearchTimer = setTimeout(renderListings, 150); });
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
    ${l.description ? `<p>${tagify(l.description, "market")}</p>` : ""}
    <p class="muted">${esc(l.ownerName)} ${repBadge(l.ownerUid)} · ${fmtDate(l.createdAt, { day: "numeric", month: "short" })}${l.status === "sold" && l.buyerName && (l.ownerUid === state.user?.uid || l.buyerUid === state.user?.uid || isStaff()) ? ` · ${t("sold_to", { name: esc(l.buyerName) })}` : ""}</p>
    <div id="rate-slot"></div>
    ${l.modHidden ? `<p class="mod-note">🚫 ${t(isAdmin() && l.ownerUid !== state.user?.uid ? "mod_hidden_admin" : "mod_hidden_owner")}${l.modNote ? `<br><strong>${t("mod_reason")}:</strong> ${esc(l.modNote)}` : ""}</p>` : ""}
    ${l.delReq && (l.ownerUid === state.user?.uid || isStaff()) ? `<p class="mod-note">🗑 ${t("del_req_pending")}${l.delReason ? `<br><strong>${t("del_reason")}:</strong> ${esc(l.delReason)}` : ""}</p>` : ""}
    <p class="listing-risk">⚠️ ${t("mn_short")}</p>
    ${l.status === "sold" ? `<p class="sold-note">✅ ${t(isArchived(l) ? "sold_archived" : "sold_note", { days: Math.max(1, Math.ceil((soldTime(l) + ARCHIVE_DAYS * 864e5 - Date.now()) / 864e5)) })}</p>` : ""}
    ${l.war ? `<section class="war-box" data-war="${esc(l.id)}"></section>` : ""}
    <div class="post-actions l-actions">
      <button type="button" class="share" data-act="share" aria-label="${t("share")}">${SHARE_ICON}</button>
      <button type="button" class="cmt-btn" data-act="cmt" aria-label="${t("comments")}">${CMT_ICON}</button>
      <button type="button" class="like ${(l.likedBy || []).includes(state.user?.uid) ? "on" : ""}" data-like-listing="${esc(l.id)}" aria-label="${t("like")}">
        <svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true"><path d="M12 21s-7.5-4.6-9.6-9.2C.9 8.4 3 4.5 6.8 4.5c2.2 0 3.6 1.2 4.2 2.3h2c.6-1.1 2-2.3 4.2-2.3 3.8 0 5.9 3.9 4.4 7.3C19.5 16.4 12 21 12 21Z"/></svg>
      </button>
      <span class="like-count">${(l.likedBy || []).length ? t((l.likedBy || []).length === 1 ? "likes_one" : "likes_n", { n: (l.likedBy || []).length }) : ""}</span>
    </div>
    <section class="cmt-inline" data-cmt-inline="listings:${esc(l.id)}"></section>
    ${isStaff() ? `<div class="mod-bar"><small>${t(isAdmin() ? "admin_only" : "mod_only")}</small>
      ${!isAdmin() ? "" : l.modHidden ? `<button type="button" class="btn btn-sm btn-mat" data-act="unhide">${t("mod_unhide")}</button>` : `<button type="button" class="btn btn-sm btn-ghost" data-act="modhide">${t("mod_hide")}</button>`}
      <button type="button" class="btn btn-sm btn-danger" data-act="moddel">${t("mod_delete")}</button></div>` : ""}
    <div class="form-actions">
      ${l.ownerUid && l.ownerUid !== state.user?.uid ? `<button type="button" class="btn btn-mat" data-dm="${esc(l.ownerUid)}" data-dm-name="${esc(l.ownerName || "")}" data-dm-context="${esc(t("dm_about", { title: l.title }))}">✉️ ${t("dm_msg_seller")}</button>` : ""}
      <button type="button" class="btn btn-ghost" data-act="report">${t("mn_report_listing")}</button>
      ${ig ? `<a class="btn btn-ghost" target="_blank" rel="noopener" href="https://instagram.com/${encodeURIComponent(ig)}">Instagram</a>` : ""}
      <span id="listing-wa">${member ? "" : `<button type="button" class="btn btn-ghost" data-act="signin">${t("wa_signin")}</button>`}</span>
      ${l.ownerUid === state.user?.uid && l.status !== "sold" && !l.editedAt ? `<button class="btn btn-mat" data-act="edit">✏️ ${t("edit_post")}</button>` : ""}
      ${canEdit(l.ownerUid) && l.status !== "sold" ? `<button class="btn btn-ghost" data-act="sold">${t("mark_sold")}</button>` : ""}
      ${isAdmin() ? `<button class="btn btn-danger" data-act="del">${t("delete")}</button>`
        : l.ownerUid === state.user?.uid ? (l.delReq ? `<button class="btn btn-ghost" data-act="delcancel">${t("del_req_cancel")}</button>`
        : `<button class="btn btn-danger" data-act="delreq">${t("del_req")}</button>`) : ""}
    </div>`);
  state.cmtItems[`listings:${l.id}`] = l;
  if (l.war) startWar(l);
  canRate(l).then(ok => { const s = $("#rate-slot"); if (ok && s) s.innerHTML = `<button type="button" class="btn btn-mat rate-btn" data-act="rate">⭐ ${t("rep_rate_btn")}</button>`; });
  renderCommentsInto($("#modal-body [data-cmt-inline]"), "listings", l);
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
    if (act === "delreq") { openDeleteReason("listings", l); return; }
    if (act === "edit") { openEditPost("listings", l); return; }
    if (act === "delcancel") {
      try { await updateDoc(doc(db, "listings", l.id), { delReq: false, delReason: "" }); l.delReq = false; closeModal(); toast(t("del_req_cancelled")); loadListings(); } catch (e2) { fail(e2); }
      return;
    }
    if (ev.target.closest("[data-act=cmt]")) { const i = $("#modal-body .cmt-form [name=text]"); if (i) { i.scrollIntoView({ behavior: "smooth", block: "center" }); i.focus(); } return; }
    if (act === "report") { closeModal(); openReport(l); return; }
    if (act === "rate") { openRate(l.id); return; }
    if (act === "modhide" || act === "moddel") { openModerate("listings", l, act === "moddel" ? "delete" : "hide"); return; }
    if (act === "unhide") { await unhidePost("listings", l); closeModal(); return; }
    try {
      if (act === "sold") { openMarkSold(l); return; }
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
          <select name="type">
            <option value="sell">${t("t_sell")}</option>
            <option value="wanted">${t("t_wanted")}</option>
            <option value="trade">${t("t_trade")}</option>
            <option value="war">⚡ ${t("t_war_sell")}</option>
          </select>
        </label>
        <label><span>${t("l_price")}</span><input name="price" type="number" min="0" step="1000" inputmode="numeric"></label>
      </div>
      <div class="war-opts" hidden>
        <p class="war-explain"><b>⚡ ${t("t_war_sell")}</b> — ${t("war_label_d")}</p>
        <div class="row2 war-fields">
          <label><span>${t("war_qty")} *</span><input name="qty" type="number" min="1" max="500" step="1" value="5" inputmode="numeric"></label>
          <label><span>${t("war_start")}</span><input name="warStart" type="datetime-local"></label>
        </div>
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
  // War sell: quantity + optional start time.
  const syncWar = () => { const war = f.type.value === "war"; f.querySelector(".war-opts").hidden = !war; f.qty.required = war; };
  f.type.addEventListener("change", syncWar); syncWar();
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
        type: f.type.value === "war" ? "sell" : f.type.value, title: f.title.value.trim(), price: Number(f.price.value),
        condition: f.condition.value.trim(), description: f.description.value.trim(), photos, status: "open",
        ...(f.type.value === "war" ? { war: true, qty: Math.max(1, Math.min(500, parseInt(f.qty.value, 10) || 1)), claimed: 0,
          warStart: f.warStart.value ? Timestamp.fromDate(new Date(f.warStart.value)) : null } : {}),
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
  if (isStaff()) {
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
  const deact = isStaff() && r.claimedBy ? (state.deactUsers || {})[r.claimedBy] : null;
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
      <div>${cardHTML({ no: r.memberNo, name, city, instagram: u?.instagram, photoURL: u?.photoURL, since, uid: u?.id || r.claimedBy || "" })}</div>
      <div>
        <h1>${esc(name)}</h1>
        ${u && u.id !== state.user?.uid ? `<button type="button" class="btn btn-sm btn-mat" data-dm="${esc(u.id)}" data-dm-name="${esc(name)}" data-dm-photo="${esc(u.photoURL || "")}">✉️ ${t("dm_message")}</button>` : ""}
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
          <div id="profile-addr-admin"></div>
          <form class="invite-form" id="f-invite" data-r="${esc(r.id)}">
            <label for="invite-phone">${t("phone_label_admin")}</label>
            <div class="invite-row">
              <input id="invite-phone" type="tel" name="phone" value="${esc(priv.phone || "")}" placeholder="08…" autocomplete="off" inputmode="tel">
              <button class="btn btn-sm btn-mat" type="submit">${t("save")}</button>
            </div>
            <small class="muted">${r.claimedBy ? t("gmail_linked") : t("phone_hint_admin")}</small>
          </form>
        </div>` : ""}
        ${isStaff() && u && u.id !== state.user.uid && (isAdmin() ? u.role !== "admin" : !isStaffRole(u)) ? `<div class="deact-box">
          ${deact ? `<p class="muted">${t("deact_is")}</p><button type="button" class="btn btn-mat" data-reactivate="${esc(u.id)}">${t("reactivate")}</button>`
                  : `<button type="button" class="btn btn-danger" data-deactivate="${esc(u.id)}">${t("deactivate")}</button><small class="muted">${t("deact_hint")}</small>`}
        </div>` : ""}
        <div id="profile-extra"></div>
      </div>
    </div>`;
  fillSellerStatus(box);
  if (isAdmin() && u) {
    getDoc(doc(db, "addresses", u.id)).then(a => {
      const el = $("#profile-addr-admin"); if (!el || state.sub !== id) return;
      el.innerHTML = `<p class="addr-admin"><strong>${t("addr_title")}:</strong><br>${a.exists() ? addrLines(a.data()).map(esc).join("<br>") : `<span class="muted">${t("addr_none")}</span>`}</p>`;
    }).catch(() => {});
  }
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
function cardHTML({ no, name, city, instagram, photoURL, since, general = false, uid = "" }) {
  const sub = [city, instagram ? "@" + igHandle(instagram) : "", since ? `${t("card_since")} ${fmtDate(since, { month: "short", year: "numeric" })}` : ""].filter(Boolean).map(esc).join(" · ");
  return `
    <div class="mcard" role="img" aria-label="RCMI ${esc(name)} ${no ? "#" + no : ""}">
      <p class="mcard-kicker">${general ? "General Member" : "Exclusive Member"}</p>
      <img class="mcard-logo" src="/img/logo-dark.png" alt="">
      ${photoURL
        ? `<img class="mcard-photo" src="${esc(bigPhoto(photoURL))}" alt="" referrerpolicy="no-referrer" onerror="this.outerHTML='<div class=&quot;mcard-photo mcard-initials&quot;>${esc(initials(name))}</div>'">`
        : `<div class="mcard-photo mcard-initials">${esc(initials(name))}</div>`}
      <p class="mcard-name">${esc(name)}</p>
      ${general ? "" : `<p class="mcard-no">${no ? "#" + no : esc(t("applicant"))}</p>`}
      ${uid ? `<p class="mcard-seller" data-seller="${esc(uid)}"></p>` : ""}
      ${sub ? `<p class="mcard-sub">${sub}</p>` : ""}
    </div>`;
}
/* Seller status on the card, from Market sales and buyers' reviews:
   New seller → Seller (1+ sale) → Trusted Seller (3+ reviews, ⭐4.5+) → Top Seller (10+ reviews, 20+ sales, ⭐4.7+). */
state.salesOf = {};
function sellerLevel(r, sales) {
  if (r.n >= 10 && sales >= 20 && r.avg >= 4.7) return { key: "seller_top", cls: "top" };
  if (r.n >= REP_MIN && r.avg >= 4.5) return { key: "seller_trusted", cls: "trusted" };
  if (sales > 0 || r.n > 0) return { key: "seller_active", cls: "active" };
  return { key: "seller_new", cls: "new" };
}
async function fillSellerStatus(root) {
  const el = root?.querySelector("[data-seller]"); if (!el) return;
  const uid = el.dataset.seller;
  await loadReviews();
  if (state.salesOf[uid] == null) {
    try { const s = await getDocs(query(collection(db, "listings"), where("ownerUid", "==", uid))); state.salesOf[uid] = s.docs.filter(d => d.data().status === "sold").length; }
    catch (e) { state.salesOf[uid] = 0; }
  }
  const r = repOf(uid), sales = state.salesOf[uid], lv = sellerLevel(r, sales);
  const bits = [r.n >= REP_MIN ? `⭐ ${r.avg.toFixed(1)}` : "", sales ? t("seller_sold", { n: sales }) : ""].filter(Boolean).join(" · ");
  el.className = `mcard-seller lv-${lv.cls}`;
  el.innerHTML = `<b>${t(lv.key)}</b>${bits ? `<span>${bits}</span>` : ""}`;
}
function renderCard() {
  const p = state.profile;
  $("#member-card").hidden = false;
  const r = (state.roster || []).find(x => x.id === p.rosterId);
  $("#member-card").innerHTML = cardHTML({
    general: isGeneral(), uid: state.user.uid, no: p.memberNo, name: p.displayName, city: p.city, instagram: p.instagram, photoURL: p.photoURL,
    since: r?.joined ? new Date(r.joined) : (p.approvedAt || p.createdAt)
  });
  fillSellerStatus($("#member-card"));
  const f = $("#form-profile");
  ["displayName", "city", "instagram", "whatsapp", "bio"].forEach(k => { if (document.activeElement !== f[k]) f[k].value = p[k] || ""; });
  f._syncSame?.();
  $("#email-on").checked = !p.emailOff;
  refreshPushUI();
  // Read-only until "Edit" — except when the address is still missing, then open for editing.
  if (!state.profEditing) lockProfile(state.myAddr !== null);   // still loading (undefined) or saved → read-only
}
/* My details: shown read-only; "Edit" unlocks the form, Save/Cancel lock it again. */
function lockProfile(locked) {
  const f = $("#form-profile"); state.profEditing = !locked;
  f.classList.toggle("locked", locked);
  f.querySelectorAll("input, select, textarea").forEach(el => {
    if (el.type === "hidden") return;
    if (locked) el.disabled = true;
    else el.disabled = el.tagName === "SELECT" ? el.options.length <= 1 : false;
  });
  if (!locked) f._syncSame?.();
  $("#prof-edit").hidden = !locked;
  f.querySelector(".prof-actions").hidden = locked;
}
$("#email-on").addEventListener("change", async (e) => {
  const on = e.target.checked;
  try { await updateDoc(doc(db, "users", state.user.uid), { emailOff: !on }); state.profile.emailOff = !on; toast(t(on ? "email_on_t" : "email_off_t")); }
  catch (err) { e.target.checked = !on; fail(err); }
});
$("#prof-edit").addEventListener("click", () => { lockProfile(false); $("#form-profile").displayName.focus(); });
$("#prof-cancel").addEventListener("click", () => { state.profEditing = false; renderCard(); writeAddr($("#form-profile"), state.myAddr); lockProfile(true); });
$("#form-profile").addEventListener("submit", async (e) => {
  e.preventDefault(); const f = e.target;
  try {
    await updateDoc(doc(db, "users", state.user.uid), {
      displayName: f.displayName.value.trim(), city: f.city.value.trim(), instagram: igHandle(f.instagram.value),
      whatsapp: f.whatsapp.value.trim(), bio: f.bio.value.trim(), updatedAt: serverTimestamp()
    });
    saveContact({ displayName: f.displayName.value.trim(), whatsapp: f.whatsapp.value.trim(), instagram: f.instagram.value });
    await saveAddr(readAddr(f)); state.myAddr = readAddr(f); $("#addr-banner").hidden = true; renderMyAddr();
    toast(t("profile_saved")); lockProfile(true);
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
  if (!isStaff()) return;
  $("#view-admin").classList.toggle("mod-view", !isAdmin());
  loadReportedChats();
  if (!isAdmin()) return loadModerator();
  refreshMigrate(); loadModHidden(); loadDelRequests(); loadDelLog();
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
        <div class="grow"><strong>${esc(u.displayName)}</strong><span class="type-tag general">${t("type_general")}</span>${u.role === "moderator" ? `<span class="type-tag">${t("role_mod")}</span>` : ""}${u.role === "jury" ? `<span class="type-tag jury">${t("role_jury")}</span>` : ""}
          <small>${esc(u.city)}${u.instagram ? " · @" + esc(u.instagram) : ""}${u.email ? " · " + esc(u.email) : ""}${u.whatsapp ? " · " + esc(u.whatsapp) : ""}</small>
          ${since(u) ? `<small>${t("registered_on", { date: since(u) })}</small>` : ""}</div>
        <div class="actions">
          ${waNumber(u.whatsapp) ? `<a class="btn btn-sm btn-ghost" target="_blank" rel="noopener" href="https://wa.me/${waNumber(u.whatsapp)}">WhatsApp</a>` : ""}
          ${roleSel(u)}
          ${u.role !== "admin" ? `<button class="btn btn-sm btn-danger" data-deactivate="${esc(u.id)}">${t("deactivate")}</button>` : ""}
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
          <small>${esc(u.city)} · ${u.instagram ? "@" + esc(u.instagram) : ""}${u.role === "admin" ? " · admin" : u.role === "moderator" ? " · " + t("role_mod") : u.role === "jury" ? " · " + t("role_jury") : ""}</small></div>
        <div class="actions">${roleSel(u)}</div>
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

/* Moderator page: pending general users (approve/reject), general users + deactivated accounts,
   listing delete requests and the deleted-collection log. */
async function loadModerator() {
  loadDelRequests(); loadDelLog();
  try {
    const [pend, gen, ds] = await Promise.all([
      getDocs(query(collection(db, "users"), where("status", "==", "pending"))),
      getDocs(query(collection(db, "users"), where("status", "==", "approved"), where("accountType", "==", "general"))),
      getDocs(query(collection(db, "users"), where("status", "==", "deactivated")))
    ]);
    const pending = state.pending = pend.docs.map(d => ({ id: d.id, ...d.data() })).filter(u => u.accountType === "general");
    const generals = gen.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => String(a.displayName).localeCompare(String(b.displayName)));
    generals.forEach(u => { state.siteUsers[u.id] = u; });
    const deact = Object.fromEntries(ds.docs.map(d => [d.id, { id: d.id, ...d.data() }]));
    state.deactUsers = { ...(state.deactUsers || {}), ...deact };
    $("#admin-pending").innerHTML = pending.length ? pending.map(u => `
      <div class="row">
        <img src="${esc(u.photoURL)}" alt="" referrerpolicy="no-referrer">
        <div class="grow"><strong>${esc(u.displayName)}</strong><span class="type-tag general">${t("type_general")}</span>
          <small>${esc(u.city)} · ${u.instagram ? "@" + esc(u.instagram) : ""} · ${esc(u.email)}</small>${u.bio ? `<small>${esc(u.bio)}</small>` : ""}</div>
        <div class="actions">
          <button class="btn btn-sm btn-mat" data-approve="${esc(u.id)}">${t("approve")}</button>
          <button class="btn btn-sm btn-ghost" data-reject="${esc(u.id)}">${t("reject")}</button>
        </div>
      </div>`).join("") : `<p class="muted">${t("no_pending")}</p>`;
    $("#admin-general-count").textContent = `(${generals.length})`;
    $("#admin-general").innerHTML = generals.length ? generals.map(u => `
      <div class="row">
        <img src="${esc(u.photoURL)}" alt="" referrerpolicy="no-referrer">
        <div class="grow"><strong>${esc(u.displayName)}</strong><span class="type-tag general">${t("type_general")}</span>
          <small>${esc(u.city)}${u.instagram ? " · @" + esc(u.instagram) : ""}${u.email ? " · " + esc(u.email) : ""}</small></div>
        <div class="actions">${!isStaffRole(u) && u.id !== state.user.uid ? `<button class="btn btn-sm btn-danger" data-deactivate="${esc(u.id)}">${t("deactivate")}</button>` : ""}</div>
      </div>`).join("") : `<p class="muted">${t("no_general")}</p>`;
    const dl = Object.values(deact);
    $("#admin-deact-count").textContent = `(${dl.length})`;
    $("#admin-deact").innerHTML = dl.length ? dl.map(u => `
      <div class="row">
        <img src="${esc(u.photoURL)}" alt="" referrerpolicy="no-referrer">
        <div class="grow"><strong>${u.memberNo && u.accountType !== "general" ? memberNo(u.memberNo) + " · " : ""}${esc(u.displayName)}</strong><span class="type-tag blocked">${t("deact_tag")}</span>
          <small>${[u.city, u.email].filter(Boolean).map(esc).join(" · ")}</small></div>
        <div class="actions"><button class="btn btn-sm btn-mat" data-reactivate="${esc(u.id)}">${t("reactivate")}</button></div>
      </div>`).join("") : `<p class="muted">${t("no_deact")}</p>`;
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
  if (!isStaff()) return;
  const uid = (d || r).dataset[d ? "deactivate" : "reactivate"];
  const u = state.siteUsers[uid] || (state.deactUsers || {})[uid];
  if (!isAdmin() && isStaffRole(u)) return;
  if (!confirm(t(d ? "deact_confirm" : "react_confirm", { name: u?.displayName || "" }))) return;
  (d || r).disabled = true;
  try {
    const n = await setActive(uid, !!r);
    toast(t(d ? "deact_done" : "react_done", { n }));
    state.roster = null; await fetchRoster(true);
    state.listingsLoaded = false; state.feedLoaded = false;
    if (state.tab === "admin") loadAdmin(); else if (state.tab === "members") showMembers(); else if (modal.open) closeModal();
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

/* ================= Owner delete: a reason is mandatory.
   Collection posts are deleted straight away (the reason is logged for the admins);
   market listings only get a delete REQUEST that an admin approves or rejects. ================= */
/* ================= Edit your own post (Collection or Market): text, price, and photos (remove / add) ================= */
function openEditPost(col, item) {
  if (item.editedAt) { toast(t("ep_used")); return; }
  const market = col === "listings", max = market ? 3 : 10;
  let keep = [...(item.photos || [])];
  const typeSel = market && !item.war ? `
      <label><span>${t("l_type")}</span>
        <select name="type">
          ${["sell", "wanted", "trade"].map(v => `<option value="${v}" ${item.type === v ? "selected" : ""}>${t("t_" + v)}</option>`).join("")}
        </select></label>` : "";
  openModal(`
    <h2>${t("edit_post")}</h2>
    <form class="form" id="f-edit">
      ${market ? `
        <div class="row2">${typeSel}
          <label><span id="ep-price-l">${t("l_price")} *</span><input name="price" type="number" min="1000" step="1000" inputmode="numeric" required value="${Number(item.price) || ""}"></label>
        </div>
        ${item.war ? `<label><span>${t("war_qty")} *</span><input name="qty" type="number" min="${Math.max(1, item.claimed || 0)}" max="500" step="1" required value="${item.qty || 1}" inputmode="numeric"></label>` : ""}
        <label><span>${t("l_title")}</span><input name="title" required maxlength="100" value="${esc(item.title || "")}"></label>
        <label><span>${t("l_condition")}</span><input name="condition" maxlength="80" value="${esc(item.condition || "")}"></label>
        <label><span>${t("l_desc")}</span><textarea name="description" rows="4" maxlength="800">${esc(item.description || "")}</textarea></label>`
      : `
        <label><span>${t("car_name")}</span><input name="name" required maxlength="100" value="${esc(item.name || "")}"></label>
        <label><span>${t("car_maker")}</span><input name="maker" maxlength="80" value="${esc(item.maker || "")}"></label>
        <label><span>${t("car_notes")}</span><textarea name="notes" rows="4" maxlength="600">${esc(item.notes || "")}</textarea></label>`}
      <div><span class="ep-label">${t("ep_photos")} <small class="muted">(${t("ep_max", { n: max })})</small></span>
        <div class="ep-photos" id="ep-photos"></div></div>
      <label class="ep-add"><span>＋ ${t("ep_add")}</span><input type="file" name="photos" accept="image/*" multiple></label>
      <div class="thumbs" id="ep-new"></div>
      <p class="mod-note">✏️ ${t("ep_once")}</p>
      <div class="form-actions">
        <button type="button" class="btn btn-ghost" data-act="close">${t("cancel")}</button>
        <button class="btn btn-mat" type="submit">${t("save")}</button>
      </div>
    </form>`);
  const f = $("#f-edit");
  const paintKeep = () => {
    $("#ep-photos").innerHTML = keep.map((p, i) => `<span class="ep-ph"><img src="${photoSrc(p)}" alt=""><button type="button" data-rm="${i}" aria-label="${esc(t("ep_remove"))}">×</button></span>`).join("");
  };
  const paintNew = () => {
    const box = $("#ep-new"); box.innerHTML = "";
    [...f.photos.files].slice(0, Math.max(0, max - keep.length)).forEach(x => { const i = document.createElement("img"); i.alt = ""; i.src = URL.createObjectURL(x); box.appendChild(i); });
    if (keep.length + f.photos.files.length > max) toast(t("ep_max", { n: max }));
  };
  paintKeep();
  f.photos.addEventListener("change", paintNew);
  if (market && f.type) {
    const sync = () => { $("#ep-price-l").textContent = t(f.type.value === "wanted" ? "l_budget" : f.type.value === "trade" ? "l_value" : "l_price") + " *"; f.description.required = f.type.value === "wanted"; };
    f.type.addEventListener("change", sync); sync();
  }
  $("#modal-body").onclick = (ev) => {
    if (ev.target.dataset.act === "close") { closeModal(); return; }
    const rm = ev.target.closest("[data-rm]");
    if (rm) { keep.splice(Number(rm.dataset.rm), 1); paintKeep(); paintNew(); }
  };
  f.addEventListener("submit", async (e) => {
    e.preventDefault();
    const room = Math.max(0, max - keep.length), adding = Math.min(room, f.photos.files.length);
    if (!market && keep.length + adding < 1) { toast(t("ep_need_photo")); return; }
    if (market && !(Number(f.price.value) > 0)) { toast(t("l_price_required")); f.price.focus(); return; }
    if (market && item.war && (parseInt(f.qty.value, 10) || 0) < (item.claimed || 0)) { toast(t("ep_war_qty_min", { n: item.claimed || 0 })); return; }
    if (!confirm(t("ep_once_confirm"))) return;
    const btn = f.querySelector("[type=submit]"); btn.disabled = true;
    try {
      const added = adding ? await storePhotos(f.photos, market ? "market" : "collection", room, keep.length, btn) : [];
      const photos = [...keep, ...added].slice(0, max);
      const changes = market
        ? { title: f.title.value.trim(), price: Number(f.price.value), condition: f.condition.value.trim(), description: f.description.value.trim(), photos,
            ...(f.type ? { type: f.type.value } : {}), ...(item.war ? { qty: Math.max(item.claimed || 1, Math.min(500, parseInt(f.qty.value, 10) || 1)) } : {}) }
        : { name: f.name.value.trim(), maker: f.maker.value.trim(), notes: f.notes.value.trim(), photos };
      await updateDoc(doc(db, col, item.id), { ...changes, editedAt: serverTimestamp() });
      Object.assign(item, changes, { editedAt: new Date() });
      closeModal(); toast(t("saved"));
      if (market) { afterModeration("listings"); if (location.hash.startsWith("#/market")) renderListings(); }
      else {
        document.querySelectorAll(`.post[data-post="${CSS.escape(item.id)}"]`).forEach(p => {
          const tmp = document.createElement("div"); tmp.innerHTML = postHTML(item).trim();
          const fresh = tmp.firstElementChild, oldC = p.querySelector(".post-cmts"), newC = fresh.querySelector(".post-cmts");
          if (oldC && newC) newC.replaceWith(oldC);   // keep the comments already shown
          p.replaceWith(fresh); wireCarousels(fresh);
        });
        state.allCars = null; state.feedProfile = null;
        if (state.tab === "collection" && !$("#app").hidden) loadCars();
      }
    } catch (err) { fail(err); btn.disabled = false; }
  });
}
function openDeleteReason(col, item) {
  const market = col === "listings";
  openModal(`
    <h2>${t(market ? "del_req" : "delete")}</h2>
    <p class="muted">${esc(item.name || item.title || "")}</p>
    <form class="form" id="f-delr">
      <label><span>${t("del_reason")} *</span><textarea name="reason" rows="3" minlength="5" maxlength="300" required placeholder="${esc(t("del_reason_ph"))}"></textarea></label>
      <small class="muted">${t(market ? "del_req_explain" : "del_now_explain")}</small>
      <div class="form-actions">
        <button type="button" class="btn btn-ghost" data-act="close">${t("cancel")}</button>
        <button class="btn btn-danger" type="submit">${t(market ? "del_req_send" : "delete")}</button>
      </div>
    </form>`);
  $("#modal-body").onclick = (ev) => { if (ev.target.dataset.act === "close") closeModal(); };
  const f = $("#f-delr");
  f.addEventListener("submit", async (e) => {
    e.preventDefault();
    const reason = f.reason.value.trim();
    if (reason.length < 5) { toast(t("del_reason_required")); f.reason.focus(); return; }
    const btn = f.querySelector("[type=submit]"); btn.disabled = true;
    try {
      if (market) {
        await updateDoc(doc(db, "listings", item.id), { delReq: true, delReason: reason.slice(0, 300), delReqAt: serverTimestamp() });
        item.delReq = true; item.delReason = reason;
        closeModal(); toast(t("del_req_sent")); loadListings();
      } else {
        const batch = writeBatch(db);
        batch.set(doc(collection(db, "deleteLog")), { uid: state.user.uid, name: String(state.profile?.displayName || "").slice(0, 80),
          target: "collection", postId: item.id, title: String(item.name || "").slice(0, 100), reason: reason.slice(0, 300), at: serverTimestamp() });
        batch.delete(doc(db, "cars", item.id));
        await batch.commit();
        closeModal(); toast(t("deleted"));
        document.querySelectorAll(`.post[data-post="${CSS.escape(item.id)}"]`).forEach(p => p.remove());
        afterModeration("cars"); if (state.tab === "collection" && !$("#app").hidden) loadCars();
      }
    } catch (err) { fail(err); btn.disabled = false; }
  });
}
document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-own-post]"); if (!b) return;
  e.stopPropagation();
  const id = b.dataset.ownPost;
  const c = state.feed.find(x => x.id === id) || (state.feedProfile?.posts || []).find(x => x.id === id) || state.searchPosts.find(x => x.id === id) || state.deepPost;
  if (!c || c.ownerUid !== state.user?.uid) return;
  openModal(`
    <h2>${t("post_options")}</h2>
    <p class="muted">${esc(c.name || "")}</p>
    <div class="form-actions dm-menu">
      ${c.editedAt ? `<p class="muted">${t("ep_used")}</p>` : `<button type="button" class="btn btn-mat" data-act="edit">✏️ ${t("edit_post")}</button>`}
      <button type="button" class="btn btn-danger" data-act="del">🗑 ${t("delete")}</button>
      <button type="button" class="btn btn-ghost" data-act="close">${t("cancel")}</button>
    </div>`);
  $("#modal-body").onclick = (ev) => {
    const act = ev.target.closest("[data-act]")?.dataset.act;
    if (act === "close") closeModal();
    if (act === "edit") openEditPost("cars", c);
    if (act === "del") openDeleteReason("cars", c);
  };
});

/* Admin: collection posts their owners deleted, with the reason they gave (newest first). */
async function loadDelLog() {
  if (!isStaff()) return;
  try {
    const s = await getDocs(query(collection(db, "deleteLog"), orderBy("at", "desc"), limit(100)));
    const list = state.delLog = s.docs.map(d => ({ id: d.id, ...d.data() }));
    $("#admin-dellog-count").textContent = `(${list.length})`;
    $("#admin-dellog").innerHTML = list.length ? list.map(x => `
      <div class="row">
        <div class="grow"><strong>${esc(x.title || "")}</strong><span class="type-tag">${t("nav_feed")}</span>
          <small>${esc(x.name || "")}${x.at ? " · " + fmtDate(x.at, { day: "numeric", month: "short", year: "numeric" }) + " " + toDate(x.at).toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit" }) : ""}</small>
          <small><strong>${t("del_reason")}:</strong> ${esc(x.reason || "")}</small></div>
        <div class="actions"><button class="btn btn-sm btn-ghost" data-dellog-rm="${esc(x.id)}">${t("del_log_clear")}</button></div>
      </div>`).join("") : `<p class="muted">${t("del_log_none")}</p>`;
  } catch (e) { console.warn(e); }
}
$("#admin-dellog").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-dellog-rm]"); if (!b) return;
  try { await deleteDoc(doc(db, "deleteLog", b.dataset.dellogRm)); loadDelLog(); } catch (err) { fail(err); }
});

/* Admin: market delete requests — approve (delete) or reject; the seller gets a notice either way. */
async function loadDelRequests() {
  if (!isStaff()) return;
  try {
    const s = await getDocs(query(collection(db, "listings"), where("delReq", "==", true)));
    const list = state.delReqs = s.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => ms(b.delReqAt) - ms(a.delReqAt));
    $("#admin-delreq-count").textContent = `(${list.length})`;
    $("#admin-delreq").innerHTML = list.length ? list.map(x => `
      <div class="row">
        ${x.photos?.[0] ? `<img src="${photoSrc(x.photos[0])}" alt="" style="border-radius:8px">` : ""}
        <div class="grow"><strong><a href="#/market/${esc(x.id)}">${esc(x.title || "")}</a></strong><span class="type-tag">${t("nav_market")}</span>
          <small>${esc(x.ownerName || "")}${x.delReqAt ? " · " + fmtDate(x.delReqAt, { day: "numeric", month: "short", year: "numeric" }) : ""}</small>
          <small><strong>${t("del_reason")}:</strong> ${esc(x.delReason || "")}</small></div>
        <div class="actions">
          <button class="btn btn-sm btn-danger" data-delok="${esc(x.id)}">${t("del_approve")}</button>
          <button class="btn btn-sm btn-ghost" data-delno="${esc(x.id)}">${t("del_reject")}</button>
        </div>
      </div>`).join("") : `<p class="muted">${t("del_req_none")}</p>`;
  } catch (e) { console.warn(e); }
}
$("#admin-delreq").addEventListener("click", async (e) => {
  const ok = e.target.closest("[data-delok]"), no = e.target.closest("[data-delno]"); if (!ok && !no) return;
  const x = (state.delReqs || []).find(y => y.id === (ok || no).dataset[ok ? "delok" : "delno"]); if (!x) return;
  let note = x.delReason || "";
  if (no) { note = prompt(t("del_reject_why")) ?? null; if (note === null) return; }
  else if (!confirm(t("del_approve_confirm", { title: x.title || "" }))) return;
  try {
    const batch = writeBatch(db);
    const ref = doc(db, "listings", x.id);
    if (ok) batch.delete(ref); else batch.update(ref, { delReq: false, delReason: "" });
    if (x.ownerUid) batch.set(doc(collection(db, "notices")), { uid: x.ownerUid, kind: ok ? "delapproved" : "delrejected", target: "market",
      postId: x.id, title: String(x.title || "").slice(0, 100), note: String(note).slice(0, 500), by: state.user.uid, at: serverTimestamp(), read: false });
    await batch.commit();
    toast(t(ok ? "del_approved_done" : "del_rejected_done"));
    loadDelRequests(); afterModeration("listings");
  } catch (err) { fail(err); }
});

/* ================= Admin moderation: hide or delete a post with a reason; the owner gets a notice ================= */
document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-mod-post]"); if (!b || !isStaff()) return;
  e.stopPropagation();
  const id = b.dataset.modPost;
  const c = state.feed.find(x => x.id === id) || (state.feedProfile?.posts || []).find(x => x.id === id) || state.searchPosts.find(x => x.id === id) || state.deepPost;
  if (c) openModerate("cars", c, isAdmin() ? "hide" : "delete");
});
function openModerate(col, item, mode) {
  if (!isAdmin()) mode = "delete";   // moderators can delete, not hide
  const title = item.name || item.title || "";
  openModal(`
    <h2>${t("mod_title")}</h2>
    <p class="muted">${esc(title)} · ${esc(item.ownerName || "")}</p>
    <form class="form" id="f-mod">
      <div class="seg" role="group" ${isAdmin() ? "" : "hidden"}>
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
  if (col === "cars") { state.allCars = null; state.feedLoaded = false; state.feedProfile = null; if (location.hash.startsWith("#/feed")) { state.feedLoaded = true; loadFeed(true); renderFeedRoute(); } }
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
    const mm = e.target.closest("[data-mkmod]");
    if (mm && isAdmin()) {
      const on = mm.dataset.on === "1", u = state.siteUsers[mm.dataset.mkmod];
      if (!confirm(t(on ? "make_mod_confirm" : "remove_mod_confirm", { name: u?.displayName || "" }))) return;
      await updateDoc(doc(db, "users", mm.dataset.mkmod), { role: on ? "moderator" : "member" });
      toast(t("saved")); state.roster = null; loadAdmin();
    }
    const mj = e.target.closest("[data-mkjury]");
    if (mj && isAdmin()) {
      const on = mj.dataset.on === "1", u = state.siteUsers[mj.dataset.mkjury];
      if (!confirm(t(on ? "make_jury_confirm" : "remove_jury_confirm", { name: u?.displayName || "" }))) return;
      await updateDoc(doc(db, "users", mj.dataset.mkjury), { role: on ? "jury" : "member" });
      toast(t("saved")); state.roster = null; loadAdmin();
    }
  } catch (err) { fail(err); }
});


/* ================= Roles: one menu per person (admins only). "Member" takes any role away. ================= */
const ROLES = ["member", "moderator", "jury", "admin"];
// The founder (member RCMI-0001) is protected: no one else can change that account's role (the database enforces it too).
const isFounder = (u) => Number(u?.memberNo) === 1 && (u?.accountType || "member") === "member";
function roleSel(u) {
  const r = u.role || "member";
  if (!isAdmin()) return "";
  if (isFounder(u) && u.id !== state.user?.uid) return `<span class="type-tag founder">👑 ${t("role_founder")} · ${t("ro_" + r)}</span>`;
  if (u.id === state.user?.uid) return `<span class="type-tag ${isFounder(u) ? "founder" : ""}">${isFounder(u) ? `👑 ${t("role_founder")} · ` : ""}${t("ro_" + r)} · ${t("role_you")}</span>`;
  return `<label class="role-sel"><span>${t("role_label")}</span><select data-role-of="${esc(u.id)}">${ROLES.map(x => `<option value="${x}" ${x === r ? "selected" : ""}>${t("ro_" + x)}</option>`).join("")}</select></label>`;
}
document.addEventListener("change", async (e) => {
  const sel = e.target.closest("select[data-role-of]"); if (!sel || !isAdmin()) return;
  const uid = sel.dataset.roleOf, u = state.siteUsers?.[uid], from = u?.role || "member", to = sel.value;
  if (to === from) return;
  if (isFounder(u)) { toast(t("role_founder_locked")); sel.value = from; return; }
  if (from === "admin" && Object.values(state.siteUsers || {}).filter(x => x.role === "admin").length <= 1) { toast(t("role_last_admin")); sel.value = from; return; }
  if (!confirm(t(to === "member" ? "role_remove_confirm" : "role_confirm", { name: u?.displayName || "", from: t("ro_" + from), to: t("ro_" + to) }))) { sel.value = from; return; }
  sel.disabled = true;
  try { await updateDoc(doc(db, "users", uid), { role: to }); toast(t("saved")); state.roster = null; ct.jurors = null; loadAdmin(); }
  catch (err) { sel.value = from; sel.disabled = false; fail(err); }
});

/* ================= App: install to the home screen + phone push notifications ================= */
const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const isStandalone = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
const lsGet = (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } };
const lsSet = (k, v) => { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) {} };
let swReg = null, installEvt = null;
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").then(r => { swReg = r; }).catch(() => {});

function showBanner(show) {
  const b = $("#app-banner"); if (!b) return;
  b.hidden = !show || isStandalone() || Number(lsGet("rcmi-app-banner") || 0) > Date.now();
}
addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault(); installEvt = e;
  $("#btn-install-2").hidden = false;
  setTimeout(() => showBanner(matchMedia("(max-width: 720px)").matches), 3000);
});
addEventListener("appinstalled", () => { installEvt = null; showBanner(false); $("#btn-install-2").hidden = true; toast(t("app_installed")); });
// iPhone Safari has no install button of its own: offer the Add to Home Screen steps.
if (isIOS && !isStandalone()) { $("#btn-install-2").hidden = false; setTimeout(() => showBanner(true), 4000); }
async function installApp() {
  if (installEvt) {
    installEvt.prompt();
    const r = await installEvt.userChoice.catch(() => null);
    installEvt = null; if (r?.outcome === "accepted") showBanner(false);
    return;
  }
  openModal(`<h2>${t("app_ios_t")}</h2><p>${t("app_ios_steps")}</p>
    <div class="form-actions"><button type="button" class="btn btn-mat" data-act="close">OK</button></div>`);
  $("#modal-body").onclick = (ev) => { if (ev.target.dataset.act === "close") closeModal(); };
}
$("#btn-install").addEventListener("click", installApp);
$("#btn-install-2").addEventListener("click", installApp);
$("#app-banner-x").addEventListener("click", () => { lsSet("rcmi-app-banner", String(Date.now() + 14 * 864e5)); showBanner(false); });

// Push: Firebase Cloud Messaging. Each device's token is kept under users/{uid}/push/{token};
// the 10-minute notification job sends to them (scripts/user-notify.mjs, scripts/notify.mjs).
let msgMod = null;
const pushReady = () => "Notification" in window && "serviceWorker" in navigator && "PushManager" in window;
const tokenKey = () => `rcmi-push-${state.user?.uid || ""}`;
async function messaging() {
  if (!msgMod) msgMod = await import("https://www.gstatic.com/firebasejs/11.0.2/firebase-messaging.js");
  return (await msgMod.isSupported()) ? msgMod.getMessaging(fbApp) : null;
}
async function savePushToken() {
  const m = await messaging(); if (!m) throw new Error(t("push_unsupported"));
  const reg = swReg || await navigator.serviceWorker.ready;
  const token = await msgMod.getToken(m, { serviceWorkerRegistration: reg });
  if (!token) throw new Error(t("push_unsupported"));
  const old = lsGet(tokenKey());
  if (old && old !== token) deleteDoc(doc(db, "users", state.user.uid, "push", old)).catch(() => {});
  await setDoc(doc(db, "users", state.user.uid, "push", token), { at: serverTimestamp(), ua: navigator.userAgent.slice(0, 200) });
  lsSet(tokenKey(), token);
}
function refreshPushUI() {
  const cb = $("#push-on"); if (!cb || !state.user) return;
  const ok = pushReady();
  cb.checked = ok && Notification.permission === "granted" && !!lsGet(tokenKey());
  $("#push-note").textContent = t(ok ? "push_pref_d" : isIOS && !isStandalone() ? "push_ios" : "push_unsupported");
  // Tokens change now and then: refresh this device's once per visit.
  if (cb.checked && state.pushFresh !== state.user.uid) { state.pushFresh = state.user.uid; savePushToken().catch(() => {}); }
}
async function dropPushToken() {
  const tok = lsGet(tokenKey()); if (!tok || !state.user) return;
  await deleteDoc(doc(db, "users", state.user.uid, "push", tok)).catch(() => {});
  try { const m = await messaging(); if (m) await msgMod.deleteToken(m); } catch (e) {}
  lsSet(tokenKey(), null);
}
$("#push-on").addEventListener("change", async (e) => {
  const cb = e.target; cb.disabled = true;
  try {
    if (!cb.checked) { await dropPushToken(); toast(t("push_off_t")); return; }
    if (!pushReady()) { cb.checked = false; toast(t(isIOS && !isStandalone() ? "push_ios" : "push_unsupported")); return; }
    const perm = await Notification.requestPermission();
    if (perm !== "granted") { cb.checked = false; toast(t("push_denied")); return; }
    await savePushToken();
    toast(t("push_on_t"));
  } catch (err) { cb.checked = false; fail(err); }
  finally { cb.disabled = false; }
});


/* ================= Home: shop-style rows (newest Market listings, war sells, Collection posts) ================= */
const home = { listings: null, cars: null, at: 0 };
async function loadHomeShop(force = false) {
  if (!force && home.at && Date.now() - home.at < 5 * 60e3) { renderHomeShop(); return; }
  home.at = Date.now();
  try {
    const [ls, cs] = await Promise.all([
      getDocs(query(collection(db, "listings"), orderBy("createdAt", "desc"), limit(40))),
      getDocs(query(collection(db, "cars"), orderBy("createdAt", "desc"), limit(24)))
    ]);
    home.listings = ls.docs.map(d => ({ id: d.id, ...d.data() })).filter(l => !l.hidden && !l.modHidden && l.status !== "sold");
    home.cars = cs.docs.map(d => ({ id: d.id, ...d.data() })).filter(c => !c.hidden && !c.modHidden && (c.photos || []).length);
  } catch (e) { home.listings = home.listings || []; home.cars = home.cars || []; }
  renderHomeShop();
}
function productCard(l) {
  const ph = photoSrc(l.photos?.[0]);
  const badge = l.war ? `<span class="pc-badge war">⚡ ${t("war_tag")}</span>` : `<span class="pc-badge t-${esc(l.type)}">${typeLabel(l.type)}</span>`;
  const left = l.war ? Math.max(0, (l.qty || 0) - (l.claimed || 0)) : null;
  return `<a class="pcard" href="#/market/${encodeURIComponent(l.id)}">
    <span class="pc-img">${ph ? `<img src="${ph}" alt="" loading="lazy">` : `<span class="pc-empty">1:64</span>`}${badge}</span>
    <span class="pc-body">
      <span class="pc-title">${esc(l.title)}</span>
      <span class="pc-price">${l.price ? fmtIDR(l.price) : ""}</span>
      <span class="pc-meta">${l.war ? t("home_left", { n: left, q: l.qty || 0 }) : esc(l.ownerName || "")}</span>
    </span>
  </a>`;
}
function carCard(c) {
  return `<a class="pcard" href="#/feed/p/${encodeURIComponent(c.id)}">
    <span class="pc-img"><img src="${photoSrc(c.photos[0])}" alt="" loading="lazy">${(c.photos || []).length > 1 ? `<span class="pc-badge n">${c.photos.length}</span>` : ""}</span>
    <span class="pc-body">
      <span class="pc-title">${esc(c.name)}</span>
      <span class="pc-meta">${esc(c.maker || "")}${c.maker ? " · " : ""}${esc(c.ownerName || "")}</span>
    </span>
  </a>`;
}
function renderHomeShop() {
  if (!home.listings) return;
  const war = home.listings.filter(l => l.war && (l.qty || 0) > (l.claimed || 0)).slice(0, 4);
  const reg = home.listings.filter(l => !l.war).slice(0, 8);
  $("#home-war").hidden = !war.length;
  $("#home-war-grid").innerHTML = war.map(productCard).join("");
  $("#home-market-grid").innerHTML = reg.length ? reg.map(productCard).join("") : `<p class="muted">${t("empty_market")}</p>`;
  $("#home-cars-grid").innerHTML = home.cars.length ? home.cars.slice(0, 8).map(carCard).join("") : `<p class="muted">${t("empty_collection")}</p>`;
}
loadHomeShop();
addEventListener("hashchange", () => { if (!$("#landing").hidden) loadHomeShop(); });
// Category tiles / "View all": open the Market with that filter.
document.addEventListener("click", (e) => {
  const a = e.target.closest("[data-go-filter]"); if (!a) return;
  state.marketFilter = a.dataset.goFilter;
  $$("[data-mfilter]").forEach(x => x.setAttribute("aria-pressed", String(x.dataset.mfilter === state.marketFilter)));
  if (location.hash === "#/market") renderListings();
});
$("#btn-install-3")?.addEventListener("click", () => installApp());


/* ================= Photo contests =================
   contests/{id}: title, theme, desc, prizes, rules, submitEnd, voteEnd, announceAt, judges[], juryWeight, status, public, winners[]
   Flow: admin creates (draft) → publishes: registration open (account needed; register, then submit 1 photo)
   → voting (everyone signed in: 1 vote; jury scores blind on 4 criteria) → judging (jury only) → admin announces winners. */
const CT_STEPS = ["open", "voting", "judging", "closed"];
const CT_POSTERS = ["r32", "f40"];   // public/img/contest/poster-*.jpg (rendered from tools/posters)
function openPoster(p) {
  openModal(`<img class="ct-big" src="/img/contest/poster-${p}.jpg" alt="${esc(t("ct_poster_alt"))}">
    <div class="form-actions"><a class="btn btn-mat" href="/img/contest/poster-${p}.jpg" download="RCMI-Photo-Contest-${p}.jpg">${t("ct_poster_dl")}</a><button type="button" class="btn btn-ghost" data-act="close">${t("close")}</button></div>`);
  $("#modal-body").onclick = (ev) => { if (ev.target.dataset.act === "close") closeModal(); };
}
document.addEventListener("click", (e) => { const b = e.target.closest("[data-ct-poster]"); if (b) { e.preventDefault(); openPoster(b.dataset.ctPoster); } });
const CT_CRIT = ["comp", "creat", "theme", "quality"];
const ct = { list: null, cur: null, entries: [], myEntry: null, myVote: null, myScores: {}, allScores: null, allVotes: null, jurors: null, tok: 0 };
const br = (x) => esc(x).replace(/\n/g, "<br>");
const ctWhen = (ts) => toDate(ts) ? `${fmtDate(ts, { day: "numeric", month: "short", year: "numeric" })}, ${toDate(ts).toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit" })}` : "";
const ctOk = (e) => !!e.photo && (e.status || "ok") === "ok";
const regNo = (n) => n ? String(n).padStart(7, "0") : "";
function contestNoticeText(n) {
  const title = `<strong>${esc(n.title)}</strong>`;
  if (n.kind === "contest_win") return t("nt_contest_win", { n: esc(n.note), title });
  if (n.kind === "contest_disq") return t("nt_contest_disq", { title }) + (n.note ? `<em class="bell-note">${t("mod_reason")}: ${esc(n.note)}</em>` : "");
  return t(n.kind === "contest_voting" ? "nt_contest_voting" : "nt_contest_result", { title });
}
async function loadContests() {
  const q = isAdmin() ? collection(db, "contests") : query(collection(db, "contests"), where("public", "==", true));
  const s = await getDocs(q);
  ct.list = s.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => ms(b.createdAt) - ms(a.createdAt));
  return ct.list;
}
async function renderContestRoute() {
  const root = $("#contest-root"); if (!root) return;
  const id = decodeURIComponent(location.hash.replace(/^#\/contest\/?/, "").split("/")[0] || "");
  const tok = ++ct.tok;
  root.innerHTML = `<p class="muted ct-loading">…</p>`;
  if (id) return openContest(id, tok);
  try { await loadContests(); } catch (e) { ct.list = []; }
  if (tok !== ct.tok) return;
  root.innerHTML = `
    <div class="ct-top">
      <div><h1>${t("ct_title")}</h1><p class="muted">${t("ct_lead")}</p></div>
      ${isAdmin() ? `<button type="button" class="btn btn-mat" data-ct="new">＋ ${t("ct_new")}</button>` : ""}
    </div>
    ${ct.list.some(c => c.status !== "draft") ? "" : `<div class="ct-soon">
      <span class="ct-badge ph-open">${t("ct_soon_badge")}</span>
      <h2>📸 ${t("ct_soon_t")}</h2><p>${t("ct_soon_d")}</p>
      <dl><dt>${t("ct_step_open")}</dt><dd>${t("ct_soon_badge")}</dd><dt>${t("ct_step_voting")}</dt><dd>${t("ct_soon_badge")}</dd><dt>${t("ct_step_closed")}</dt><dd>${t("ct_soon_badge")}</dd><dt>${t("ct_participants")}</dt><dd>${t("ct_max_n", { n: 100 })}</dd><dt>${t("ct_winners")}</dt><dd>🥇 🥈 🥉</dd></dl>
      ${state.user ? "" : `<button type="button" class="btn btn-mat" data-ct="signin">${t("ct_soon_cta")}</button>`}
    </div>
    <div class="ct-posters">${CT_POSTERS.map(p => `<button type="button" data-ct-poster="${p}"><img src="/img/contest/poster-${p}.jpg" alt="${esc(t("ct_poster_alt"))}" loading="lazy"></button>`).join("")}</div>`}
    <div class="ct-list">${ct.list.length ? ct.list.map(c => `
      <a class="ct-item" href="#/contest/${encodeURIComponent(c.id)}">
        <span class="ct-item-cover">${c.winners?.[0]?.photo ? `<img src="${photoSrc(c.winners[0].photo)}" alt="" loading="lazy">` : `<span>📸</span>`}</span>
        <span class="ct-item-body">
          <span class="ct-badge ph-${esc(c.status)}">${t("ct_ph_" + c.status)}</span>
          <b>${esc(c.title)}</b>
          ${c.theme ? `<small>${t("ct_theme")}: ${esc(c.theme)}</small>` : ""}
          <small class="muted">${c.status === "open" ? `${c.registered || 0} / ${c.maxEntries || 100} ${t("ct_spots")}${c.submitEnd ? " · " + t("ct_until", { d: ctWhen(c.submitEnd) }) : ""}` : c.status === "voting" && c.voteEnd ? t("ct_vote_until", { d: ctWhen(c.voteEnd) }) : c.status === "closed" && c.winners?.[0] ? `🏆 ${esc(c.winners[0].name)}` : ""}</small>
        </span>
      </a>`).join("") : (ct.list.some(c => c.status !== "draft") ? `<p class="empty">${t("ct_none")}</p>` : "")}</div>`;
}
async function openContest(id, tok) {
  let snap = null;
  try { snap = await getDoc(doc(db, "contests", id)); } catch (e) {}
  if (tok !== ct.tok) return;
  if (!snap?.exists()) { $("#contest-root").innerHTML = `<a class="btn btn-ghost" href="#/contest">← ${t("ct_all")}</a><p class="empty">${t("not_found")}</p>`; return; }
  const c = ct.cur = { id, ...snap.data() };
  const uid = state.user?.uid;
  Object.assign(ct, { entries: [], myEntry: null, myVote: null, myScores: {}, allScores: null, allVotes: null });
  const jobs = [];
  if (uid) jobs.push(getDoc(doc(db, "contests", id, "entries", uid)).then(s => { ct.myEntry = s.exists() ? { id: s.id, ...s.data() } : null; }).catch(() => {}));
  if (c.status !== "open" || isAdmin()) jobs.push(getDocs(collection(db, "contests", id, "entries")).then(s => { ct.entries = s.docs.map(d => ({ id: d.id, ...d.data() })); }).catch(() => {}));
  if (uid && c.status === "voting") jobs.push(getDoc(doc(db, "contests", id, "votes", uid)).then(s => { ct.myVote = s.exists() ? s.data().entry : null; }).catch(() => {}));
  if (uid && (c.judges || []).includes(uid)) jobs.push(getDocs(query(collection(db, "contests", id, "scores"), where("judge", "==", uid))).then(s => { s.docs.forEach(d => { ct.myScores[d.data().entry] = d.data(); }); }).catch(() => {}));
  if (isAdmin() && c.status !== "draft") jobs.push(Promise.all([getDocs(collection(db, "contests", id, "scores")), getDocs(collection(db, "contests", id, "votes"))])
    .then(([a, b]) => { ct.allScores = a.docs.map(d => d.data()); ct.allVotes = b.docs.map(d => ({ id: d.id, ...d.data() })); }).catch(() => {}));
  if (isAdmin()) jobs.push(loadJurors());
  await Promise.all(jobs);
  if (tok !== ct.tok) return;
  paintContest();
}
async function loadJurors() {
  if (ct.jurors) return ct.jurors;
  try { const s = await getDocs(query(collection(db, "users"), where("role", "==", "jury"))); ct.jurors = s.docs.map(d => ({ id: d.id, ...d.data() })); }
  catch (e) { ct.jurors = []; }
  return ct.jurors;
}
function entryCard(e, extra = "") {
  return `<figure class="ct-card ${ct.myVote === e.id ? "voted" : ""}">
    <button type="button" class="ct-ph" data-ct-view="${esc(e.id)}"><img src="${photoSrc(e.photo)}" alt="${esc(e.title)}" loading="lazy">${e.rank ? `<span class="ct-rank r${e.rank}">#${e.rank}</span>` : ""}</button>
    <figcaption><b>${esc(e.title || "—")}</b>${ct.cur.status === "voting" || ct.cur.status === "judging" ? "" : `<span>${esc(e.name || "")}</span>`}${extra}</figcaption>
  </figure>`;
}
// Stable but mixed order for voting, so the first entries aren't always the earliest.
const ctShuffle = (list) => [...list].sort((a, b) => ((parseInt(a.id.slice(-6), 36) * 7919) % 1000) - ((parseInt(b.id.slice(-6), 36) * 7919) % 1000));
function paintContest() {
  const c = ct.cur, uid = state.user?.uid, root = $("#contest-root");
  const isJudge = !!uid && (c.judges || []).includes(uid) && isJury();
  const jw = c.juryWeight ?? 70;
  const si = CT_STEPS.indexOf(c.status);
  const dateFor = (p) => {
    const d = { open: c.submitEnd, voting: c.voteEnd, judging: c.announceAt, closed: c.announcedAt || c.announceAt }[p];
    return d ? `<small>${ctWhen(d)}</small>` : "";
  };
  root.innerHTML = `
    <a class="btn btn-ghost ct-back" href="#/contest">← ${t("ct_all")}</a>
    <header class="ct-head">
      <span class="ct-badge ph-${esc(c.status)}">${t("ct_ph_" + c.status)}</span>
      <h1>${esc(c.title)}</h1>
      ${c.theme ? `<p class="ct-theme">${t("ct_theme")}: <b>${esc(c.theme)}</b></p>` : ""}
      ${c.desc ? `<p class="ct-desc">${br(c.desc)}</p>` : ""}
    </header>
    <ol class="ct-steps">${CT_STEPS.map((p, i) => `<li class="${i < si ? "done" : i === si ? "on" : ""}"><b>${i < si ? "✓" : i + 1}</b><span>${t("ct_step_" + p)}</span>${dateFor(p)}</li>`).join("")}</ol>
    <div class="ct-info">
      ${c.prizes ? `<details open><summary>🏆 ${t("ct_prizes")}</summary><p>${br(c.prizes)}</p></details>` : ""}
      ${c.rules ? `<details><summary>📋 ${t("ct_rules")}</summary><p>${br(c.rules)}</p></details>` : ""}
      <details><summary>⚖️ ${t("ct_how")}</summary><p>${t("ct_how_d", { j: jw, v: 100 - jw })}</p></details>
    </div>
    <div id="ct-main">${ctMainHTML(c)}</div>
    ${isJudge ? `<section class="ct-jury panel-flat" id="ct-jury">${juryHTML(c)}</section>` : ""}
    ${isAdmin() ? `<section class="ct-admin panel-flat" id="ct-admin">${adminContestHTML(c)}</section>` : ""}`;
}
function ctMainHTML(c) {
  const uid = state.user?.uid, me = ct.myEntry, ok = ct.entries.filter(ctOk);
  if (c.status === "draft") return `<p class="mod-note">📝 ${t("ct_draft_note")}</p>`;
  if (c.status === "open") {
    let box;
    if (!uid) box = `<p>${t("ct_need_account")}</p><button type="button" class="btn btn-mat" data-ct="signin">${t("sign_in")}</button>`;
    else if (state.profile?.status !== "approved") box = `<p>${t("ct_need_active")}</p>`;
    else if (isJury() || (c.judges || []).includes(uid)) box = `<p>⚖️ ${t("ct_jury_cant")}</p>`;
    else if (!me && (c.registered || 0) >= (c.maxEntries || 100)) box = `<h3>🚫 ${t("ct_full")}</h3><p class="muted">${t("ct_full_d")}</p>`;
    else if (!me) box = `
      <h3>${t("ct_reg_t")}</h3>
      <p class="muted">${t("ct_reg_d", { type: t(isGeneral() ? "type_general" : "type_member") })}</p>
      <label class="lay-check"><input type="checkbox" id="ct-agree"> <span>${t("ct_agree")}</span></label>
      <button type="button" class="btn btn-mat" data-ct="register">${t("ct_register")}</button>`;
    else if (!me.photo || state.ctEditing) box = `
      <h3>${me.photo ? t("ct_change_photo") : `✅ ${t("ct_registered")}`}</h3>
      ${me.regNo ? `<p class="ct-regno">${t("ct_regno")}: <b>${regNo(me.regNo)}</b></p>` : ""}
      <p class="muted">${t("ct_submit_d", { d: c.submitEnd ? ctWhen(c.submitEnd) : t("ct_before_close") })}</p>
      <form class="form" id="f-ct-entry">
        <label><span>${t("ct_photo")} *</span><input type="file" name="photo" accept="image/*" ${me.photo ? "" : "required"}></label>
        <div class="thumbs"></div>
        <label><span>${t("ct_entry_title")} *</span><input name="title" required maxlength="80" value="${esc(me.title || "")}"></label>
        <label><span>${t("ct_caption")}</span><textarea name="caption" rows="2" maxlength="500">${esc(me.caption || "")}</textarea></label>
        <div class="form-actions">
          ${me.photo ? `<button type="button" class="btn btn-ghost" data-ct="cancel-edit">${t("cancel")}</button>` : `<button type="button" class="btn btn-ghost" data-ct="withdraw">${t("ct_unregister")}</button>`}
          <button class="btn btn-mat" type="submit">${t("ct_submit")}</button>
        </div>
      </form>`;
    else box = `
      <h3>✅ ${t("ct_submitted")}</h3>
      ${me.regNo ? `<p class="ct-regno">${t("ct_regno")}: <b>${regNo(me.regNo)}</b></p>` : ""}
      <div class="ct-grid one">${entryCard(me)}</div>
      <p class="muted">${t("ct_submitted_d")}</p>
      <div class="form-actions"><button type="button" class="btn btn-ghost" data-ct="edit">${t("ct_change_photo")}</button><button type="button" class="btn btn-ghost" data-ct="withdraw">${t("ct_withdraw")}</button></div>`;
    const max = c.maxEntries || 100, taken = Math.min(max, c.registered || 0);
    return `<div class="ct-spots"><div><b>${taken}</b> / ${max} ${t("ct_spots")}</div><span><i style="width:${Math.round(taken / max * 100)}%"></i></span><small>${t("ct_spots_left", { n: max - taken })}</small></div>
      <section class="ct-box panel-flat">${box}</section>`;
  }
  if (c.status === "voting" || c.status === "judging") {
    const voting = c.status === "voting";
    const list = ctShuffle(ok);
    return `
      <div class="ct-gallery-head"><h2>${t("ct_entries")} <small>(${ok.length})</small></h2>
        <p class="muted">${voting ? (uid ? t(ct.myVote ? "ct_voted_d" : "ct_vote_d") : t("ct_vote_signin")) : t("ct_judging_d")}</p></div>
      ${me && me.status === "disq" ? `<p class="mod-note">🚫 ${t("ct_disq_mine")}${me.disqReason ? `<br><strong>${t("mod_reason")}:</strong> ${esc(me.disqReason)}` : ""}</p>` : ""}
      <div class="ct-grid">${list.map(e => entryCard(e, voting ? (e.id === uid ? `<em class="ct-mine">${t("ct_yours")}</em>`
        : `<button type="button" class="ct-vote ${ct.myVote === e.id ? "on" : ""}" data-ct-vote="${esc(e.id)}">${ct.myVote === e.id ? `★ ${t("ct_your_vote")}` : `☆ ${t("ct_vote")}`}</button>`) : "")).join("") || `<p class="empty">${t("ct_no_entries")}</p>`}</div>`;
  }
  // closed: winners podium + full ranking
  const ranked = ok.filter(e => e.rank).sort((a, b) => a.rank - b.rank);
  const winners = c.winners || [];
  return `
    <section class="ct-winners">
      <h2>🏆 ${t("ct_winners")}</h2>
      ${c.announcedAt ? `<p class="muted">${t("ct_announced", { d: ctWhen(c.announcedAt) })}</p>` : ""}
      <div class="podium">${winners.map(w => `
        <figure class="pod r${w.rank}">
          <button type="button" class="ct-ph" data-ct-view="${esc(w.uid)}"><img src="${photoSrc(w.photo)}" alt="" loading="lazy"><span class="ct-rank r${w.rank}">${w.rank === 1 ? "🥇" : w.rank === 2 ? "🥈" : w.rank === 3 ? "🥉" : "#" + w.rank}</span></button>
          <figcaption><b>${esc(w.title)}</b><span>${esc(w.name)}</span><small>${t("ct_final", { s: Number(w.final || 0).toFixed(1) })}</small></figcaption>
        </figure>`).join("")}</div>
    </section>
    ${ranked.length ? `<h2 class="ct-sub">${t("ct_ranking")}</h2>
    <div class="ct-grid">${ranked.map(e => entryCard(e, `<small>${t("ct_score_line", { s: Number(e.final || 0).toFixed(1), j: Number(e.jury || 0).toFixed(2), v: e.votes || 0 })}</small>`)).join("")}</div>` : ""}`;
}
function juryHTML(c) {
  if (!["voting", "judging"].includes(c.status)) return `<h2>⚖️ ${t("ct_jury_t")}</h2><p class="muted">${t(c.status === "closed" ? "ct_jury_done" : "ct_jury_wait")}</p>`;
  const list = ct.entries.filter(ctOk).sort((a, b) => a.id.localeCompare(b.id));
  const done = list.filter(e => ct.myScores[e.id]).length;
  return `<h2>⚖️ ${t("ct_jury_t")}</h2>
    <p class="muted">${t("ct_jury_d")}</p>
    <p class="ct-progress"><b>${done}/${list.length}</b> ${t("ct_scored")}</p>
    <div class="jury-list">${list.map((e, i) => {
      const sc = ct.myScores[e.id];
      return `<form class="jury-row ${sc ? "done" : ""}" data-score="${esc(e.id)}">
        <button type="button" class="ct-ph" data-ct-view="${esc(e.id)}"><img src="${photoSrc(e.photo)}" alt="" loading="lazy"></button>
        <div class="jury-f">
          <b>${t("ct_entry_n", { n: i + 1 })} · ${esc(e.title)}</b>
          ${CT_CRIT.map(k => `<label class="jury-c"><span>${t("ct_c_" + k)}</span><input type="range" name="${k}" min="1" max="10" step="1" value="${sc?.crit?.[k] || 5}"><output>${sc?.crit?.[k] || 5}</output></label>`).join("")}
          <input name="note" maxlength="500" placeholder="${esc(t("ct_note_ph"))}" value="${esc(sc?.note || "")}">
          <div class="jury-save"><span class="ct-total">${sc ? `✓ ${Number(sc.total).toFixed(2)}` : ""}</span><button class="btn btn-sm btn-mat" type="submit">${t(sc ? "ct_update" : "save")}</button></div>
        </div>
      </form>`; }).join("") || `<p class="muted">${t("ct_no_entries")}</p>`}</div>`;
}
function ctResults() {
  const c = ct.cur, w = (c.juryWeight ?? 70) / 100;
  const votes = {}; (ct.allVotes || []).forEach(v => { votes[v.entry] = (votes[v.entry] || 0) + 1; });
  const maxV = Math.max(0, ...Object.values(votes));
  return ct.entries.filter(ctOk).map(e => {
    const sc = (ct.allScores || []).filter(s => s.entry === e.id);
    const jury = sc.length ? sc.reduce((a, s) => a + Number(s.total || 0), 0) / sc.length : 0;
    const v = votes[e.id] || 0;
    return { e, jury, nScores: sc.length, votes: v, final: w * jury * 10 + (1 - w) * (maxV ? v / maxV * 100 : 0) };
  }).sort((a, b) => b.final - a.final || b.jury - a.jury || b.votes - a.votes);
}
function adminContestHTML(c) {
  const next = { draft: ["open", "ct_go_open"], open: ["voting", "ct_go_voting"], voting: ["judging", "ct_go_judging"], judging: ["announce", "ct_go_announce"] }[c.status];
  const judges = (c.judges || []).map(id => (ct.jurors || []).find(j => j.id === id) || { id, displayName: id });
  const ok = ct.entries.filter(ctOk), res = c.status === "draft" || c.status === "open" ? [] : ctResults();
  return `<h2>🛠 ${t("ct_admin")}</h2>
    <div class="form-actions ct-admin-actions">
      ${next ? `<button type="button" class="btn btn-mat" data-ct-phase="${next[0]}">${t(next[1])}</button>` : ""}
      <button type="button" class="btn btn-ghost" data-ct="edit-contest">${t("ct_edit")}</button>
      <button type="button" class="btn btn-danger" data-ct="delete-contest">${t("delete")}</button>
    </div>
    <h3>${t("ct_jury_panel")} <small>(${judges.length})</small></h3>
    ${judges.length ? `<ul class="ct-judges">${judges.map(j => `<li>${esc(j.displayName)} <small class="muted">${(ct.allScores || []).filter(s => s.judge === j.id).length}/${ok.length} ${t("ct_scored")}</small></li>`).join("")}</ul>` : `<p class="mod-note">${t("ct_no_judges")}</p>`}
    <h3>${t("ct_participants")} <small>(${ct.entries.length} ${t("ct_registered_n")}, ${ct.entries.filter(e => e.photo).length} ${t("ct_with_photo")})</small></h3>
    <div class="ct-admin-list">${ct.entries.map(e => `
      <div class="row">
        ${e.photo ? `<img src="${photoSrc(e.photo)}" alt="" data-ct-view="${esc(e.id)}">` : `<span class="ct-nophoto">—</span>`}
        <div class="grow"><strong>${e.regNo ? `${regNo(e.regNo)} · ` : ""}${esc(e.name)}</strong>${e.status === "disq" ? `<span class="type-tag">${t("ct_disq")}</span>` : ""}<small>${esc(e.title || t("ct_no_photo_yet"))}</small></div>
        <div class="actions">${e.status === "disq" ? `<button class="btn btn-sm btn-ghost" data-ct-reinstate="${esc(e.id)}">${t("ct_reinstate")}</button>` : `<button class="btn btn-sm btn-ghost" data-ct-disq="${esc(e.id)}">${t("ct_disqualify")}</button>`}</div>
      </div>`).join("") || `<p class="muted">${t("ct_no_regs")}</p>`}</div>
    ${res.length ? `<h3>${t("ct_results_live")}</h3>
    <div class="table-wrap"><table class="ct-table"><thead><tr><th>#</th><th>${t("ct_entry_title")}</th><th>${t("ct_jury_avg")}</th><th>${t("ct_votes")}</th><th>${t("ct_final_h")}</th></tr></thead>
      <tbody>${res.map((r, i) => `<tr><td>${i + 1}</td><td>${esc(r.e.title)}<small> · ${esc(r.e.name)}</small></td><td>${r.jury.toFixed(2)} <small>(${r.nScores})</small></td><td>${r.votes}</td><td><b>${r.final.toFixed(1)}</b></td></tr>`).join("")}</tbody></table></div>` : ""}`;
}
function toTs(v) { return v ? Timestamp.fromDate(new Date(v)) : null; }
function tsInput(ts) { const d = toDate(ts); if (!d) return ""; const z = new Date(d.getTime() - d.getTimezoneOffset() * 6e4); return z.toISOString().slice(0, 16); }
async function openContestForm(c = null) {
  const jurors = await loadJurors();
  const chosen = new Set(c ? c.judges || [] : jurors.map(j => j.id));
  openModal(`
    <h2>${t(c ? "ct_edit" : "ct_new")}</h2>
    <form class="form" id="f-contest">
      <label><span>${t("ct_f_title")} *</span><input name="title" required maxlength="100" value="${esc(c?.title || "")}" placeholder="RCMI Photo Contest #1"></label>
      <label><span>${t("ct_theme")}</span><input name="theme" maxlength="100" value="${esc(c?.theme || "")}" placeholder="JDM legends on the street"></label>
      <label><span>${t("ct_f_desc")}</span><textarea name="desc" rows="3" maxlength="1500">${esc(c?.desc || "")}</textarea></label>
      <label><span>${t("ct_prizes")}</span><textarea name="prizes" rows="3" maxlength="1000" placeholder="1st: …&#10;2nd: …&#10;3rd: …">${esc(c?.prizes || "")}</textarea></label>
      <label><span>${t("ct_rules")}</span><textarea name="rules" rows="4" maxlength="3000">${esc(c?.rules || t("ct_rules_default"))}</textarea></label>
      <div class="row2">
        <label><span>${t("ct_f_submit_end")}</span><input type="datetime-local" name="submitEnd" value="${tsInput(c?.submitEnd)}"></label>
        <label><span>${t("ct_f_vote_end")}</span><input type="datetime-local" name="voteEnd" value="${tsInput(c?.voteEnd)}"></label>
      </div>
      <div class="row2">
        <label><span>${t("ct_f_announce")}</span><input type="datetime-local" name="announceAt" value="${tsInput(c?.announceAt)}"></label>
        <label><span>${t("ct_f_weight")}</span><input type="number" name="juryWeight" min="0" max="100" step="5" value="${c?.juryWeight ?? 70}"></label>
      </div>
      <label><span>${t("ct_f_max")}</span><input type="number" name="maxEntries" min="1" max="1000" step="1" value="${c?.maxEntries ?? 100}"></label>
      <fieldset class="ct-pick"><legend>${t("ct_jury_panel")}</legend>
        ${jurors.length ? jurors.map(j => `<label class="lay-check"><input type="checkbox" name="judge" value="${esc(j.id)}" ${chosen.has(j.id) ? "checked" : ""}> ${esc(j.displayName)}</label>`).join("") : `<p class="muted">${t("ct_no_jurors")}</p>`}
      </fieldset>
      <div class="form-actions"><button type="button" class="btn btn-ghost" data-act="close">${t("cancel")}</button><button class="btn btn-mat" type="submit">${t("save")}</button></div>
    </form>`);
  $("#modal-body").onclick = (ev) => { if (ev.target.dataset.act === "close") closeModal(); };
  const f = $("#f-contest");
  f.addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = f.querySelector("[type=submit]"); btn.disabled = true;
    const data = {
      title: f.title.value.trim(), theme: f.theme.value.trim(), desc: f.desc.value.trim(), prizes: f.prizes.value.trim(), rules: f.rules.value.trim(),
      submitEnd: toTs(f.submitEnd.value), voteEnd: toTs(f.voteEnd.value), announceAt: toTs(f.announceAt.value),
      juryWeight: Math.max(0, Math.min(100, Number(f.juryWeight.value) || 0)), maxEntries: Math.max(1, Math.min(1000, parseInt(f.maxEntries.value, 10) || 100)), judges: [...f.querySelectorAll("[name=judge]:checked")].map(x => x.value)
    };
    try {
      if (c) { await updateDoc(doc(db, "contests", c.id), data); closeModal(); toast(t("saved")); renderContestRoute(); }
      else { const r = await addDoc(collection(db, "contests"), { ...data, status: "draft", public: false, registered: 0, winners: [], createdAt: serverTimestamp(), createdBy: state.user.uid }); closeModal(); toast(t("saved")); location.hash = `#/contest/${r.id}`; }
    } catch (err) { fail(err); btn.disabled = false; }
  });
}
async function noticeAll(c, uids, kind, note = "") {
  for (let i = 0; i < uids.length; i += 400) {
    const b = writeBatch(db);
    uids.slice(i, i + 400).forEach(u => b.set(doc(collection(db, "notices")), { uid: u, kind, target: "contest", postId: c.id, title: String(c.title).slice(0, 100), note: String(note).slice(0, 300), at: serverTimestamp(), read: false }));
    await b.commit();
  }
}
async function setContestPhase(to) {
  const c = ct.cur;
  if (to === "announce") return openAnnounce();
  if (to === "voting" && !(c.judges || []).length && !confirm(t("ct_no_judges_confirm"))) return;
  if (!confirm(t("ct_phase_confirm", { p: t("ct_ph_" + to) }))) return;
  try {
    await updateDoc(doc(db, "contests", c.id), { status: to, public: true, [`${to}At`]: serverTimestamp() });
    if (to === "voting") await noticeAll(c, ct.entries.filter(ctOk).map(e => e.id), "contest_voting");
    toast(t("saved")); renderContestRoute();
  } catch (err) { fail(err); }
}
function openAnnounce() {
  const res = ctResults();
  if (!res.length) { toast(t("ct_no_entries")); return; }
  openModal(`
    <h2>🏆 ${t("ct_go_announce")}</h2>
    <p class="muted">${t("ct_announce_d", { j: ct.cur.juryWeight ?? 70 })}</p>
    <p><b>${t("ct_three_winners")}</b></p>
    <ol class="ct-preview">${res.slice(0, 5).map(r => `<li><b>${esc(r.e.title)}</b> · ${esc(r.e.name)} — ${r.final.toFixed(1)}</li>`).join("")}</ol>
    <div class="form-actions"><button type="button" class="btn btn-ghost" data-act="close">${t("cancel")}</button><button type="button" class="btn btn-mat" data-act="go">${t("ct_announce_btn")}</button></div>`);
  $("#modal-body").onclick = async (ev) => {
    const act = ev.target.dataset.act;
    if (act === "close") { closeModal(); return; }
    if (act !== "go") return;
    ev.target.disabled = true;
    const c = ct.cur, n = 3;   // always 3 winners: 1st, 2nd, 3rd
    try {
      const b = writeBatch(db);
      res.forEach((r, i) => b.update(doc(db, "contests", c.id, "entries", r.e.id), { votes: r.votes, jury: Math.round(r.jury * 100) / 100, final: Math.round(r.final * 10) / 10, rank: i + 1 }));
      const winners = res.slice(0, n).map((r, i) => ({ uid: r.e.id, rank: i + 1, name: r.e.name, title: r.e.title, photo: r.e.photo, final: Math.round(r.final * 10) / 10 }));
      b.update(doc(db, "contests", c.id), { status: "closed", public: true, winners, announcedAt: serverTimestamp() });
      await b.commit();
      const winIds = new Set(winners.map(w => w.uid));
      for (const w of winners) await noticeAll(c, [w.uid], "contest_win", String(w.rank));
      await noticeAll(c, res.map(r => r.e.id).filter(u => !winIds.has(u)), "contest_result");
      closeModal(); toast(t("ct_announced_done")); renderContestRoute();
    } catch (err) { fail(err); ev.target.disabled = false; }
  };
}
function viewEntry(id) {
  const e = ct.entries.find(x => x.id === id) || (ct.myEntry?.id === id ? ct.myEntry : null) || (ct.cur?.winners || []).map(w => ({ id: w.uid, ...w })).find(x => x.id === id);
  if (!e) return;
  const anon = ["voting", "judging"].includes(ct.cur?.status) && !isAdmin();
  openModal(`<img class="ct-big" src="${photoSrc(e.photo)}" alt="">
    <h2>${esc(e.title || "")}</h2>${!anon && e.name ? `<p class="muted">${esc(e.name)}</p>` : ""}${e.caption ? `<p>${br(e.caption)}</p>` : ""}
    <div class="form-actions"><button type="button" class="btn btn-ghost" data-act="close">${t("close")}</button></div>`);
  $("#modal-body").onclick = (ev) => { if (ev.target.dataset.act === "close") closeModal(); };
}
$("#contest-root").addEventListener("change", (e) => {
  if (e.target.matches("#f-ct-entry [name=photo]")) {
    const box = $("#f-ct-entry .thumbs"); box.innerHTML = "";
    const fl = e.target.files[0]; if (fl) { const i = document.createElement("img"); i.alt = ""; i.src = URL.createObjectURL(fl); box.appendChild(i); }
  }
});
$("#contest-root").addEventListener("input", (e) => {
  if (e.target.matches(".jury-c input")) e.target.nextElementSibling.textContent = e.target.value;
});
$("#contest-root").addEventListener("submit", async (e) => {
  const f = e.target; e.preventDefault();
  const c = ct.cur, uid = state.user?.uid; if (!c || !uid) return;
  const btn = f.querySelector("[type=submit]");
  if (f.id === "f-ct-entry") {
    const hasFile = f.photo.files.length > 0;
    if (!hasFile && !ct.myEntry?.photo) { toast(t("ct_photo_needed")); return; }
    btn.disabled = true;
    try {
      const photo = hasFile ? (await storePhotos(f.photo, `contest:${c.id}`, 1, 0, btn))[0] : ct.myEntry.photo;
      await setDoc(doc(db, "contests", c.id, "entries", uid), { uid, regNo: ct.myEntry.regNo, name: String(state.profile.displayName || "").slice(0, 80), avatar: String(state.profile.photoURL || state.user.photoURL || "").slice(0, 500),
        title: f.title.value.trim().slice(0, 80), caption: f.caption.value.trim().slice(0, 500), photo, at: serverTimestamp() });
      state.ctEditing = false; toast(t("ct_submitted")); renderContestRoute();
    } catch (err) { fail(err); btn.disabled = false; }
    return;
  }
  if (f.matches("[data-score]")) {
    const entry = f.dataset.score, crit = Object.fromEntries(CT_CRIT.map(k => [k, Number(f[k].value)]));
    const total = Math.round(CT_CRIT.reduce((a, k) => a + crit[k], 0) / CT_CRIT.length * 100) / 100;
    btn.disabled = true;
    try {
      const data = { judge: uid, entry, crit, total, note: f.note.value.trim().slice(0, 500), at: serverTimestamp() };
      await setDoc(doc(db, "contests", c.id, "scores", `${uid}_${entry}`), data);
      ct.myScores[entry] = data;
      $("#ct-jury").innerHTML = juryHTML(c);
      toast(t("ct_score_saved", { s: total.toFixed(2) }));
    } catch (err) { fail(err); btn.disabled = false; }
  }
});
$("#contest-root").addEventListener("click", async (e) => {
  const v = e.target.closest("[data-ct-view]"); if (v) { viewEntry(v.dataset.ctView); return; }
  const a = e.target.closest("[data-ct]")?.dataset.ct;
  const c = ct.cur, uid = state.user?.uid;
  if (a === "new") return openContestForm();
  if (a === "signin") return openSignInChooser();
  if (a === "edit-contest") return openContestForm(c);
  if (a === "delete-contest") {
    if (!confirm(t("ct_delete_confirm", { t: c.title }))) return;
    try { await deleteDoc(doc(db, "contests", c.id)); toast(t("deleted")); location.hash = "#/contest"; } catch (err) { fail(err); }
    return;
  }
  if (a === "register") {
    if (!$("#ct-agree")?.checked) { toast(t("ct_agree_needed")); return; }
    try {
      await runTransaction(db, async (tx) => {
        const cref = doc(db, "contests", c.id), cs = (await tx.get(cref)).data() || {};
        if ((cs.registered || 0) >= (cs.maxEntries || 100)) throw Object.assign(new Error(t("ct_full")), { code: "full" });
        const no = (cs.regSeq || 0) + 1;   // registration number, never reused
        tx.update(cref, { registered: (cs.registered || 0) + 1, regSeq: no });
        tx.set(doc(db, "contests", c.id, "entries", uid), { uid, regNo: no, name: String(state.profile.displayName || "").slice(0, 80), avatar: String(state.profile.photoURL || state.user.photoURL || "").slice(0, 500), title: "", caption: "", photo: "", at: serverTimestamp() });
      });
      toast(t("ct_registered")); renderContestRoute();
    } catch (err) { if (err.code === "full") { toast(t("ct_full")); renderContestRoute(); } else fail(err); }
    return;
  }
  if (a === "edit") { state.ctEditing = true; $("#ct-main").innerHTML = ctMainHTML(c); return; }
  if (a === "cancel-edit") { state.ctEditing = false; $("#ct-main").innerHTML = ctMainHTML(c); return; }
  if (a === "withdraw") {
    if (!confirm(t("ct_withdraw_confirm"))) return;
    try {
      await runTransaction(db, async (tx) => {
        const cref = doc(db, "contests", c.id), cs = (await tx.get(cref)).data() || {};
        tx.update(cref, { registered: Math.max(0, (cs.registered || 1) - 1) });
        tx.delete(doc(db, "contests", c.id, "entries", uid));
      });
      toast(t("ct_withdrawn")); renderContestRoute();
    } catch (err) { fail(err); }
    return;
  }
  const vb = e.target.closest("[data-ct-vote]");
  if (vb) {
    if (!uid) { openSignInChooser(); return; }
    if (state.profile?.status !== "approved") { toast(t("ct_need_active")); return; }
    const id = vb.dataset.ctVote;
    try {
      if (ct.myVote === id) { await deleteDoc(doc(db, "contests", c.id, "votes", uid)); ct.myVote = null; toast(t("ct_vote_removed")); }
      else { await setDoc(doc(db, "contests", c.id, "votes", uid), { entry: id, at: serverTimestamp() }); ct.myVote = id; toast(t("ct_vote_saved")); }
      $("#ct-main").innerHTML = ctMainHTML(c);
    } catch (err) { fail(err); }
    return;
  }
  const ph = e.target.closest("[data-ct-phase]"); if (ph && isAdmin()) return setContestPhase(ph.dataset.ctPhase);
  const dq = e.target.closest("[data-ct-disq]");
  if (dq && isAdmin()) {
    const reason = prompt(t("ct_disq_reason")); if (!reason || !reason.trim()) return;
    try { await updateDoc(doc(db, "contests", c.id, "entries", dq.dataset.ctDisq), { status: "disq", disqReason: reason.trim().slice(0, 300) }); await noticeAll(c, [dq.dataset.ctDisq], "contest_disq", reason.trim()); toast(t("saved")); renderContestRoute(); } catch (err) { fail(err); }
    return;
  }
  const rs = e.target.closest("[data-ct-reinstate]");
  if (rs && isAdmin()) {
    try { await updateDoc(doc(db, "contests", c.id, "entries", rs.dataset.ctReinstate), { status: "ok", disqReason: "" }); toast(t("saved")); renderContestRoute(); } catch (err) { fail(err); }
  }
});
// Admin list of entries uses a plain <img data-ct-view>, outside #ct-main: handled above via closest().

/* Home page card for the running (or just finished) contest. */
async function renderHomeContest() {
  const box = $("#home-contest"); if (!box) return;
  let list = [];
  try { list = (await getDocs(query(collection(db, "contests"), where("public", "==", true)))).docs.map(d => ({ id: d.id, ...d.data() })); } catch (e) {}
  const live = list.filter(c => ["open", "voting", "judging"].includes(c.status)).sort((a, b) => ms(b.createdAt) - ms(a.createdAt))[0]
    || list.filter(c => c.status === "closed" && Date.now() - ms(c.announcedAt) < 30 * 864e5).sort((a, b) => ms(b.announcedAt) - ms(a.announcedAt))[0];
  // Nothing published yet: "coming soon" teaser.
  if (!live) {
    box.hidden = false;
    box.innerHTML = `<a class="ct-home soon" href="#/contest">
      <span class="ct-home-ic poster"><img src="/img/contest/poster-r32.jpg" alt=""></span>
      <span class="ct-home-t"><small>${t("ct_soon_badge")}</small><b>${t("ct_soon_t")}</b><span>${t("ct_soon_d")}</span></span>
      <em>${t("ct_soon_badge")}</em></a>`;
    return;
  }
  const w = live.winners?.[0];
  const line = live.status === "open" ? t("ct_home_open", { d: live.submitEnd ? ` · ${ctWhen(live.submitEnd)}` : "" })
    : live.status === "voting" ? t("ct_home_voting") : live.status === "judging" ? t("ct_home_judging") : t("ct_home_closed", { name: esc(w?.name || "") });
  box.hidden = false;
  box.innerHTML = `<a class="ct-home" href="#/contest/${encodeURIComponent(live.id)}">
    <span class="ct-home-ic">${w?.photo ? `<img src="${photoSrc(w.photo)}" alt="">` : "📸"}</span>
    <span class="ct-home-t"><small>${t("ct_title")} · ${t("ct_ph_" + live.status)}</small><b>${esc(live.title)}</b><span>${line}</span></span>
    <em>${t(live.status === "open" ? "ct_register" : live.status === "voting" ? "ct_vote_now" : "ct_see")}</em></a>`;
}
renderHomeContest();


/* ================= News: new product releases from resin brands =================
   news/{id}: title, brand, model, scale, status (preorder|released|announced), releaseDate (text), price, link, photos[], body.
   Admins and moderators post; everyone reads. #/news lists, #/news/<id> opens one. */
const news = { list: null, at: 0, filter: "all", brand: "", q: "" };
const NEWS_STATUS = ["preorder", "released", "announced"];
async function loadNews(force = false) {
  if (news.list && !force && Date.now() - news.at < 60e3) return news.list;
  try {
    const s = await getDocs(query(collection(db, "news"), orderBy("createdAt", "desc"), limit(200)));
    news.list = s.docs.map(d => ({ id: d.id, ...d.data() })); news.at = Date.now();
  } catch (e) { news.list = news.list || []; }
  return news.list;
}
const safeLink = (u) => /^https?:\/\//i.test(String(u || "")) ? String(u) : "";
function newsCard(n) {
  const ph = photoSrc(n.photos?.[0]);
  return `<a class="pcard news-card" href="#/news/${encodeURIComponent(n.id)}">
    <span class="pc-img">${ph ? `<img src="${ph}" alt="" loading="lazy">` : `<span class="pc-empty">NEW</span>`}<span class="pc-badge ns-${esc(n.status)}">${t("ns_" + n.status)}</span></span>
    <span class="pc-body">
      <span class="news-brand">${esc(n.brand)}</span>
      <span class="pc-title">${esc(n.title)}</span>
      <span class="pc-meta news-when">${n.releaseDate ? esc(t("news_release", { d: n.releaseDate })) : esc(n.scale || "")}</span>
    </span>
  </a>`;
}
async function renderNewsRoute() {
  $("#btn-add-news").hidden = !isStaff();
  await loadNews();
  if (!location.hash.startsWith("#/news")) return;
  const brands = [...new Set(news.list.map(n => n.brand).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const bs = $("#news-brand");
  bs.innerHTML = `<option value="">${t("news_all_brands")}</option>` + brands.map(b => `<option ${b === news.brand ? "selected" : ""}>${esc(b)}</option>`).join("");
  paintNews();
  const id = decodeURIComponent(location.hash.replace(/^#\/news\/?/, ""));
  if (id && state.newsOpened !== id) { state.newsOpened = id; const n = news.list.find(x => x.id === id); if (n) openNews(n); }
  if (!id) state.newsOpened = null;
}
function paintNews() {
  const words = news.q.toLowerCase().split(/\s+/).filter(Boolean);
  const list = news.list.filter(n => (news.filter === "all" || n.status === news.filter) && (!news.brand || n.brand === news.brand)
    && words.every(w => [n.title, n.brand, n.model, n.body, n.scale].join(" ").toLowerCase().includes(w)));
  $("#news-list").innerHTML = list.length ? list.map(newsCard).join("") : `<p class="empty">${t(news.list.length ? "search_none" : "news_none")}</p>`;
}
function openNews(n) {
  openModal(`
    ${n.photos?.length ? `<div class="detail-photos">${n.photos.map(p => `<img src="${photoSrc(p)}" alt="">`).join("")}</div>` : ""}
    <span class="tag ns-tag ns-${esc(n.status)}">${t("ns_" + n.status)}</span>
    <p class="news-brand">${esc(n.brand)}</p>
    <h2>${esc(n.title)}</h2>
    <dl class="news-facts">
      ${n.model ? `<dt>${t("news_model")}</dt><dd>${esc(n.model)}</dd>` : ""}
      ${n.scale ? `<dt>${t("news_scale")}</dt><dd>${esc(n.scale)}</dd>` : ""}
      ${n.releaseDate ? `<dt>${t("news_date")}</dt><dd>${esc(n.releaseDate)}</dd>` : ""}
    </dl>
    ${n.body ? `<p class="news-body">${br(n.body)}</p>` : ""}
    <p class="muted">${t("news_posted", { d: fmtDate(n.createdAt, { day: "numeric", month: "long", year: "numeric" }) })}</p>
    <div class="form-actions">
      <button type="button" class="btn btn-ghost" data-act="share">${t("share")}</button>
      ${isStaff() ? `<button type="button" class="btn btn-ghost" data-act="edit">${t("edit")}</button>` : ""}
      ${isAdmin() ? `<button type="button" class="btn btn-danger" data-act="del">${t("delete")}</button>` : ""}
      <button type="button" class="btn btn-ghost" data-act="close">${t("close")}</button>
    </div>`);
  $("#modal-body").onclick = async (ev) => {
    const act = ev.target.closest("[data-act]")?.dataset.act;
    if (act === "close") closeModal();
    if (act === "share") {
      const url = `${location.origin}/#/news/${encodeURIComponent(n.id)}`;
      try { if (navigator.share) await navigator.share({ title: n.title, text: `${n.brand} — ${n.title}`, url }); else { await navigator.clipboard.writeText(url); toast(t("link_copied")); } } catch (e) {}
    }
    if (act === "edit") openNewsForm(n);
    if (act === "del" && isAdmin() && confirm(t("confirm_delete"))) {
      try { await deleteDoc(doc(db, "news", n.id)); closeModal(); toast(t("deleted")); await loadNews(true); location.hash = "#/news"; renderNewsRoute(); renderHomeNews(); } catch (e2) { fail(e2); }
    }
  };
  modal.addEventListener("close", () => { if (location.hash.startsWith("#/news/")) history.replaceState(null, "", "#/news"); state.newsOpened = null; }, { once: true });
}
function openNewsForm(n = null) {
  openModal(`
    <h2>${t(n ? "news_edit" : "news_add")}</h2>
    <form class="form" id="f-news">
      <div class="row2">
        <label><span>${t("news_brand")} *</span><input name="brand" required maxlength="60" list="news-brands" value="${esc(n?.brand || "")}" placeholder="Tarmac Works, Ignition Model, …"></label>
        <label><span>${t("news_status")}</span><select name="status">${NEWS_STATUS.map(x => `<option value="${x}" ${n?.status === x ? "selected" : ""}>${t("ns_" + x)}</option>`).join("")}</select></label>
      </div>
      <datalist id="news-brands">${[...new Set((news.list || []).map(x => x.brand))].map(b => `<option value="${esc(b)}">`).join("")}</datalist>
      <label><span>${t("news_headline")} *</span><input name="title" required maxlength="120" value="${esc(n?.title || "")}"></label>
      <div class="row2">
        <label><span>${t("news_model")}</span><input name="model" maxlength="100" value="${esc(n?.model || "")}"></label>
        <label><span>${t("news_scale")}</span><input name="scale" maxlength="20" value="${esc(n?.scale ?? "1:64")}"></label>
      </div>
      <label><span>${t("news_date")}</span><input name="releaseDate" maxlength="40" value="${esc(n?.releaseDate || "")}" placeholder="Q1 2027 / Dec 2026 / Out now"></label>
      <label><span>${t("news_body")}</span><textarea name="body" rows="4" maxlength="3000">${esc(n?.body || "")}</textarea></label>
      <label><span>${t("photos")} (${t("news_max6")})${n?.photos?.length ? ` · ${t("news_photos_keep")}` : ""}</span><input type="file" name="photos" accept="image/*" multiple data-max="6"></label>
      <div class="thumbs"></div>
      <div class="form-actions"><button type="button" class="btn btn-ghost" data-act="close">${t("cancel")}</button><button class="btn btn-mat" type="submit">${t(n ? "save" : "news_publish")}</button></div>
    </form>`);
  const f = $("#f-news"); bindPhotoPreview(f);
  $("#modal-body").onclick = (ev) => { if (ev.target.dataset.act === "close") closeModal(); };
  f.addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = f.querySelector("[type=submit]"); btn.disabled = true;
    try {
      const photos = f.photos.files.length ? await storePhotos(f.photos, "market", 6, 0, btn) : (n?.photos || []);
      const data = { title: f.title.value.trim(), brand: f.brand.value.trim(), model: f.model.value.trim(), scale: f.scale.value.trim(), status: f.status.value,
        releaseDate: f.releaseDate.value.trim(), price: null, link: "", photos, body: f.body.value.trim() };   // News lists items only: no prices or shop links
      if (n) await updateDoc(doc(db, "news", n.id), { ...data, updatedAt: serverTimestamp() });
      else await addDoc(collection(db, "news"), { ...data, createdAt: serverTimestamp(), authorUid: state.user.uid, authorName: String(state.profile.displayName || "").slice(0, 80) });
      closeModal(); toast(t(n ? "saved" : "news_published"));
      await loadNews(true); state.newsOpened = null;
      if (location.hash !== "#/news") location.hash = "#/news"; else renderNewsRoute();
      renderHomeNews();
    } catch (err) { fail(err); btn.disabled = false; }
  });
}
$("#btn-add-news").addEventListener("click", () => openNewsForm());
$$("[data-nfilter]").forEach(b => b.addEventListener("click", () => {
  news.filter = b.dataset.nfilter;
  $$("[data-nfilter]").forEach(x => x.setAttribute("aria-pressed", String(x === b)));
  paintNews();
}));
$("#news-brand").addEventListener("change", (e) => { news.brand = e.target.value; paintNews(); });
let newsQTimer; $("#news-q").addEventListener("input", (e) => { clearTimeout(newsQTimer); newsQTimer = setTimeout(() => { news.q = e.target.value; paintNews(); }, 150); });
async function renderHomeNews() {
  const list = (await loadNews()).slice(0, 4);
  $("#home-news").hidden = !list.length;
  $("#home-news-grid").innerHTML = list.map(newsCard).join("");
}
renderHomeNews();
