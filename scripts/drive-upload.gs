/**
 * RCMI photo uploads → Google Drive.
 * Paste into a new project at script.google.com (signed in as the RCMI Drive owner), fill in the
 * two folder IDs, then Deploy → New deployment → Web app: Execute as "Me", Who has access "Anyone".
 * Copy the web app URL into the website (public/js/config.js → uploadUrl).
 *
 * Only signed-in, active RCMI website accounts can upload: each upload carries the person's Firebase ID token,
 * which Firestore verifies when the script reads their profile (status must be "approved").
 * Collection photos: RCMI members only. Market photos: members and general users.
 */
const FOLDERS = {
  collection: "PASTE_COLLECTIONS_FOLDER_ID",
  market: "PASTE_MARKET_FOLDER_ID"
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
    const name = stamp + "_" + uid.slice(0, 8) + "_" + String(req.name || "photo").replace(/[^\w.-]+/g, "_").slice(0, 60) + (mime === "image/png" ? ".png" : mime === "image/webp" ? ".webp" : ".jpg");
    const file = DriveApp.getFolderById(folderId).createFile(Utilities.newBlob(bytes, mime, name));
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    file.setDescription("Uploaded from the RCMI website by " + uid);
    return out({ id: file.getId() });
  } catch (err) {
    return out({ error: String(err && err.message || err) });
  }
}

function doGet() { return out({ ok: true, service: "RCMI photo uploads" }); }

function out(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/** Run once from the editor (▶ Run → authorize) so Drive and URL-fetch permissions are granted. */
function setup() {
  Object.keys(FOLDERS).forEach(k => Logger.log(k + ": " + DriveApp.getFolderById(FOLDERS[k]).getName()));
}
