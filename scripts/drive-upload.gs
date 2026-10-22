/**
 * RCMI photo uploads → Google Drive.
 * Paste into a new project at script.google.com (signed in as the RCMI Drive owner), fill in the
 * two folder IDs, then Deploy → New deployment → Web app: Execute as "Me", Who has access "Anyone".
 * Copy the web app URL into the website (public/js/config.js → uploadUrl).
 *
 * Only signed-in, active RCMI website accounts can upload: each upload carries the person's Firebase ID token,
 * which Firestore verifies when the script reads their profile (status must be "approved").
 * Collection photos: RCMI members only. Market photos: members and general users.
 * Contest photos: anyone registered for that contest; saved in RCMI/Contests/<contest name>/ (folder made automatically).
 *
 * After changing this code: Deploy → Manage deployments → ✏️ Edit → Version: New version → Deploy
 * (keeps the same web app URL, so the website needs no change).
 */
const FOLDERS = {
  collection: "1jjIFoDc_4dUEnA0h-r64e0vk74sSbjUg",   // RCMI/Collections
  market: "1KodZLwpbq9zXj21XodMWNkT92xx7WLuL",       // RCMI/Market
  contest: "1Tmwl83gg-TXH7p1MWha-2LamrwzYqOQi"       // RCMI/Contests (one subfolder per contest)
};
const PROJECT_ID = "rcmi-website";
const MAX_BYTES = 6 * 1024 * 1024;   // per photo
const MAX_PER_HOUR = 80;             // uploads per account per hour

function doPost(e) {
  try {
    const req = JSON.parse(e.postData.contents);
    const folderId = FOLDERS[req.kind];
    if (!folderId) return out({ error: "bad kind" });

    // 1. Who is this? Read the Firebase ID token (checked for real by Firestore in step 2).
    const parts = String(req.idToken || "").split(".");
    if (parts.length !== 3) return out({ error: "not signed in" });
    const claims = JSON.parse(Utilities.newBlob(Utilities.base64DecodeWebSafe(parts[1] + "===".slice((parts[1].length + 3) % 4))).getDataAsString());
    if (claims.aud !== PROJECT_ID || claims.exp * 1000 < Date.now()) return out({ error: "sign in again" });
    const uid = claims.user_id || claims.sub;

    // 2. Active account? Read their own profile from Firestore with their token: Google checks the token's
    //    signature here, so a fake or expired token is refused.
    const prof = UrlFetchApp.fetch("https://firestore.googleapis.com/v1/projects/" + PROJECT_ID + "/databases/(default)/documents/users/" + uid, {
      headers: { Authorization: "Bearer " + req.idToken }, muteHttpExceptions: true
    });
    if (prof.getResponseCode() !== 200) return out({ error: "no account" });
    const f = JSON.parse(prof.getContentText()).fields || {};
    const status = f.status && f.status.stringValue;
    const type = (f.accountType && f.accountType.stringValue) || "member";
    if (status !== "approved") return out({ error: "account not active" });
    if (req.kind === "collection" && type !== "member") return out({ error: "members only" });

    // Contest: the person must be registered for that contest while registration is open.
    let targetFolder = null, contestFileBase = "";
    if (req.kind === "contest") {
      const cid = String(req.contestId || "");
      if (!/^[\w-]{1,60}$/.test(cid)) return out({ error: "no contest" });
      const base = "https://firestore.googleapis.com/v1/projects/" + PROJECT_ID + "/databases/(default)/documents/contests/" + cid;
      const opt = { headers: { Authorization: "Bearer " + req.idToken }, muteHttpExceptions: true };
      const cr = UrlFetchApp.fetch(base, opt), er = UrlFetchApp.fetch(base + "/entries/" + uid, opt);
      if (cr.getResponseCode() !== 200) return out({ error: "no contest" });
      if (er.getResponseCode() !== 200) return out({ error: "register first" });
      const cf = JSON.parse(cr.getContentText()).fields || {};
      if ((cf.status && cf.status.stringValue) !== "open") return out({ error: "registration closed" });
      const contestName = (cf.title && cf.title.stringValue) || cid;
      targetFolder = contestFolder(cid, contestName);
      // File name: <contest name>_<participant name>_<7-digit registration number>
      const ef = JSON.parse(er.getContentText()).fields || {};
      const no = ef.regNo ? String(ef.regNo.integerValue || ef.regNo.doubleValue || "").padStart(7, "0") : "0000000";
      contestFileBase = [contestName, (ef.name && ef.name.stringValue) || uid, no].map(cleanName).join("_");
    }

    // 3. Simple rate limit per account.
    const cache = CacheService.getScriptCache(), key = "n_" + uid;
    const n = Number(cache.get(key) || 0);
    if (n >= MAX_PER_HOUR) return out({ error: "too many uploads, try again later" });
    cache.put(key, String(n + 1), 3600);

    // 4. Save the photo (JPEG/PNG/WebP only) and make it viewable by link so the website can show it.
    const mime = String(req.mime || "");
    if (!/^image\/(jpeg|png|webp)$/.test(mime)) return out({ error: "images only" });
    const bytes = Utilities.base64Decode(req.data);
    if (bytes.length > MAX_BYTES) return out({ error: "photo too large" });
    const stamp = Utilities.formatDate(new Date(), "Asia/Jakarta", "yyyyMMdd-HHmmss");
    const ext = mime === "image/png" ? ".png" : mime === "image/webp" ? ".webp" : ".jpg";
    if (contestFileBase) {
      // A new photo replaces the participant's earlier one (same name) in the contest folder.
      const old = targetFolder.getFilesByName(contestFileBase + ext);
      while (old.hasNext()) old.next().setTrashed(true);
    }
    const name = contestFileBase ? contestFileBase + ext : stamp + "_" + uid.slice(0, 8) + "_" + String(req.name || "photo").replace(/[^\w.-]+/g, "_").slice(0, 60) + (mime === "image/png" ? ".png" : mime === "image/webp" ? ".webp" : ".jpg");
    const file = (targetFolder || DriveApp.getFolderById(folderId)).createFile(Utilities.newBlob(bytes, mime, name));
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    file.setDescription("Uploaded from the RCMI website by " + uid);
    return out({ id: file.getId() });
  } catch (err) {
    return out({ error: String(err && err.message || err) });
  }
}

// RCMI/Contests/<contest name>: made on the first upload, remembered by contest id (renaming the contest keeps the same folder).
function contestFolder(cid, title) {
  const props = PropertiesService.getScriptProperties(), key = "contest_" + cid;
  const known = props.getProperty(key);
  if (known) { try { return DriveApp.getFolderById(known); } catch (e) {} }
  const lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    const again = props.getProperty(key);
    if (again) { try { return DriveApp.getFolderById(again); } catch (e) {} }
    const parent = DriveApp.getFolderById(FOLDERS.contest);
    const name = String(title).replace(/[\\/:*?"<>|]+/g, " ").trim().slice(0, 100) || cid;
    const it = parent.getFoldersByName(name);
    const folder = it.hasNext() ? it.next() : parent.createFolder(name);
    props.setProperty(key, folder.getId());
    return folder;
  } finally { lock.releaseLock(); }
}

// Safe for Drive file and folder names; keeps spaces and letters, drops / \ : * ? " < > | and the "_" separator.
function cleanName(x) { return String(x).replace(/[\\/:*?"<>|_]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80); }

function doGet() { return out({ ok: true, service: "RCMI photo uploads" }); }

function out(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/** Run once from the editor (▶ Run → authorize) so Drive and URL-fetch permissions are granted. */
function setup() {
  Object.keys(FOLDERS).forEach(k => Logger.log(k + ": " + DriveApp.getFolderById(FOLDERS[k]).getName()));
}
