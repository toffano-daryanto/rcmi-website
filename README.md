# RCMI — Resin Car Model Indonesia

Community website for 1:64 resin car model collectors. Public landing page plus a members-only area behind Google sign-in with admin approval.

**Members area:** Member directory & profiles · Monthly dues · Collection showcase · Events & meetups (RSVP) · Marketplace (sell / trade / wanted) · Member card & profile · Admin approvals.
**Languages:** Bahasa Indonesia and English (toggle in the top bar).
**Stack:** Plain HTML/CSS/JS, Firebase Authentication (Google), Cloud Firestore, Firebase Hosting. No build step.

---

## One-time Firebase setup (about 10 minutes)

1. **Create the project** — go to <https://console.firebase.google.com>, click *Add project*, name it e.g. `rcmi-website`. Google Analytics is optional.
2. **Turn on Google sign-in** — *Build → Authentication → Get started → Sign-in method → Google → Enable*, pick a support email, *Save*.
3. **Create the database** — *Build → Firestore Database → Create database*. Choose location **asia-southeast2 (Jakarta)**, start in **production mode**. (The real rules are deployed from `firestore.rules`.)
4. **Register the web app** — *Project settings (gear) → General → Your apps → Web (`</>`)*, nickname `rcmi-web`, tick *Also set up Firebase Hosting*. Copy the `firebaseConfig` values into **`public/js/config.js`**.
5. **Set the project ID** — replace `YOUR-FIREBASE-PROJECT-ID` in **`.firebaserc`**.
6. **Deploy** (from your computer, once):
   ```bash
   npm install -g firebase-tools
   firebase login
   firebase deploy --only hosting,firestore
   ```
   This creates the database rules and publishes the site at `https://<project-id>.web.app`.

### Import the members from the Google Form and make yourself admin
The 22 numbered members (from *RCMI Membership Registration (Responses)* → *RCMI Member List* and *List Kaos RCMI*), the 5 applicants without a number yet, and the three 2025 events (first meet, 2nd meet, IDS 2025 / TMCP 64 Fitment Contest) are in `data/`. One command loads them into Firestore:

1. Open the site and **sign in with Google once** (submit the profile form).
2. Firebase console → *Project settings → Service accounts → Generate new private key*. Save it as `service-account.json` in the project folder (it's git-ignored — never commit it).
3. Run:
   ```bash
   cd scripts
   npm install
   node seed.mjs --key ../service-account.json --make-admin tovano.d@gmail.com
   ```
   This creates a profile for every member (RCMI-0001 … RCMI-0022), sets the next member number to 23, and makes that Google account admin, linked to RCMI-0001. It's safe to run again after editing `data/roster.json`.

When an existing member signs in, the **Admin** tab suggests their record by name (e.g. "Mahdi" → RCMI-0010 Mahdi Alatas). Approving links them, so their profile keeps their old number and registration date, and gains their photo, Instagram, bio, cars and listings. Applicants and brand-new sign-ups get the next number.

**What's imported and who sees it:** member number, name, city, province and registration date are visible to approved members. Phone numbers and T-shirt orders are admin-only (`rosterPrivate`). Home addresses, birthdates and payment proofs are **not** imported. `data/roster.json` contains phone numbers, so it is git-ignored.

### Sync members from the Google Sheet (admins)
**Anggota → Sinkron anggota dari Google Sheet** reads **only the "RCMI Member List" tab** of the *RCMI Membership Registration (Responses)* sheet with the admin's own Google account (the sheet stays private). Every sync reads the whole tab, so old and new rows are included: member number, name and phone. Addresses and birthdates are never read. Manually corrected city/province/join date are kept. Applicants are not taken from the sheet; people not on the list sign up on the site and wait for admin approval. The **Keuangan** sync uses the same Google sign-in.

**One-time setup:** enable the **Google Sheets API** for the project: console.cloud.google.com/apis/library/sheets.googleapis.com?project=rcmi-website → **Enable**. The first sync asks for permission to view your Google Sheets; because the app isn't verified by Google you may see "Google hasn't verified this app" → **Advanced → Go to rcmi-website**.

### Finance — Laba Rugi (members view, admins update)
**Keuangan** tab — members can view it read-only; general users can't see it; only admins sync/import: Profit & Loss built from the treasurer's *KEUANGAN RCMI* Google Sheet.
1. In the sheet: **File → Download → Comma Separated Values (.csv)**.
2. On the site: **Keuangan → Impor CSV** → pick the file. Re-import whenever the sheet changes.

It shows totals, the P&L by category, the IDS 2025 event result, the RCMI x Hellios rims result, month-by-month cash, a check of the sheet's running balance, and every transaction with its category. **Cetak / PDF** prints the report. The ledger is stored in Firestore (`finance/ledger`) — readable by members, writable by admins; the sheet link (`finance/source`) is admins only. Nothing financial is in this repo. Categories come from keywords in *Deskripsi/Keterangan* (see `public/js/finance.js`); combined payments like "IURAN/VELG/KAS" are split (velg Rp175.000, kas Rp50.000, rest IDS).

### Two account types
- **Anggota (member):** RCMI members. Sign up with the registered phone → active immediately (or admin approval). Full access: member list & profiles, member card, monthly dues, collection, events, market.
- **Sign up:** the top-bar button is *Sign in or create account*. New accounts are asked "Create your account as an RCMI member?" — **Yes**: registered members (matching phone) are active right away; new members see the Rp150.000 joining fee (QRIS / bank from *Pengaturan iuran*), upload the payment proof (`joinPayments/{uid}`, visible to them and admins only) and wait for admin approval — admins see a *View payment proof* button on the request. **No**: general users just register and are active right away.
- **Admin page** lists *Members* and *General users* separately, with counts.
- **Pengguna umum (general user):** non-members, active as soon as they register. Can post in the market, see sellers' WhatsApp, view events and RSVP, and view the collection. No member list, member card or dues; their "Kartu saya" tab is "Profil saya".
- The **market is public**: anyone can browse it on the main website without signing in. Sellers' WhatsApp numbers live in `contacts/{uid}` and are shown only to signed-in, approved accounts; visitors see Instagram only.

### Auto-approve by phone number
When a member signs up they enter their phone number first. If it matches a number on the RCMI list (from the Google Form import), the account activates immediately as that member — no admin approval. "0812-…", "+62 812…" and "812…" all match. If it doesn't match, a pop-up asks them to change to the number they registered, or continue as a new member (admin approval). Each member record can be claimed only once; a second account using the same number is refused and told to contact an admin.

- Phone matches are created by the member import (**Admin → Impor data**, or *Actions → Import members*). **Re-run the import once** after this update so the phone list exists.
- Admins can change a member's number on their profile (**Anggota → member → "No. HP anggota"**).
- Trade-off (chosen on purpose): the number isn't verified by SMS, so someone who knows a member's number could claim that member. If that happens, fix it in the Firebase console and tell the member to sign up again.
- Numbers are stored in `rosterPrivate` (admins only) and `phoneInvites/{62812…}`, which can be read only by exact number, never listed.

### Gallery photos and videos
The landing-page gallery (`public/js/gallery-data.js`) shows the 74 photos and videos from the RCMI Drive folder directly from Google Drive. Each file has to be shared **Anyone with the link → Viewer**, or its tile stays blank. Share the media files individually — **not the whole folder**, which also holds the registration responses and payment proofs. On the site the media is view-only: there's no "Open in Drive" link, right-click/drag-to-save is blocked, and the video player's pop-out button is disabled. (Files shared by link can never be made 100% impossible to find, but visitors have no way through the site to open them in Drive.)

### Monthly dues (Iuran)
- **Members** see this month's status, where to transfer (Rp50.000, due by the 10th), their history, and upload a transfer receipt.
- **Admins** switch to *Semua anggota*: pick a month, confirm or reject receipts, mark paid / waive, and download a CSV.
- **QRIS:** upload RCMI's QRIS image under *Pengaturan iuran*. Members see it on the Iuran page, scan it (or save it and upload from their gallery on mobile), pay Rp50.000 and send the screenshot. QRIS payments up to Rp500.000 to micro-business merchants have a 0% fee.
- Set the bank account, amount, due day and the month to start tracking from under **Iuran → Semua anggota → Pengaturan iuran**. The joining month counts as paid (it's covered by the Rp150.000 registration fee).
- Each member sees only their own payments; admins see everyone's (`dues/{rosterId}_{YYYY-MM}`).

### Contact us
The **Contact** section on the main website has a form (name, WhatsApp/email, topic, message). Only **signed-in** accounts can send it; each message is tied to the sender's Google account. Only **admins** can read messages: **Admin → Inbox** lists them newest first, with a count of unread ones on the Admin tab, a one-tap reply on WhatsApp or by email, *Mark done* and *Delete*. Messages are stored in `messages/{id}` (create: signed-in users, read/update/delete: admins).

### Language
The site opens in **English** by default; visitors can switch to Bahasa Indonesia with the ID/EN toggle (the choice is remembered on their device).

### Custom domain (optional)
*Hosting → Add custom domain*, then add the domain under *Authentication → Settings → Authorized domains* so Google sign-in works there too.

---

## Automatic deploys (optional)

`.github/workflows/deploy.yml` redeploys the site and database rules on every push to `main`.

1. Google Cloud console → *IAM & Admin → Service accounts* (same project) → *Create service account*, role **Firebase Admin**, then *Keys → Add key → JSON*.
2. GitHub repo → *Settings → Secrets and variables → Actions → New repository secret*, name `FIREBASE_SERVICE_ACCOUNT`, paste the whole JSON.

Without the secret, the workflow skips deploying instead of failing.

---

## No terminal? Do everything in the browser

**1. Database rules** — Firebase console → *Firestore Database → Rules*: replace everything with the contents of `firestore.rules`, then **Publish**.

**2. Put the site online** (pick one):
- **GitHub Actions** (auto-updates on every push): Firebase console → *Project settings → Service accounts → Generate new private key*. In GitHub → repo *Settings → Secrets and variables → Actions*, add secret `FIREBASE_SERVICE_ACCOUNT` with the whole JSON. Then *Actions → Deploy to Firebase → Run workflow*. Site: `https://rcmi-website.web.app`.
  If the deploy says permission denied: Google Cloud console → *IAM* (project rcmi-website) → edit the `firebase-adminsdk-…` account → add roles **Firebase Admin** and **Service Usage Consumer**.
- **Netlify Drop** (no GitHub needed): open app.netlify.com/drop and drag the `public` folder in. Then Firebase console → *Authentication → Settings → Authorized domains* → add the `….netlify.app` address so Google sign-in works there.

**3. Make yourself admin** — open the site, sign in with Google and submit the profile form. Then Firebase console → *Firestore Database → Data → users →* your document, and set: `status` = `approved`, `role` = `admin`, add `memberNo` (number) = `1`, add `rosterId` (string) = `m001`. Reload the site.

**4. Import members** — *Admin* tab → **Impor data anggota** → choose `data/roster.json` → **Impor data**. This loads the 22 members, 5 applicants, the 2025 events and the dues settings, and links you to RCMI-0001.

(Optional: with the `FIREBASE_SERVICE_ACCOUNT` and `ROSTER_JSON` secrets set, *Actions → Import members → Run workflow* does steps 3–4 for you.)

## Database structure (Firestore)

| Collection | What's in it | Who can write |
|---|---|---|
| `users/{uid}` | name, city, Instagram, WhatsApp, bio, `status` (pending/approved/rejected), `role` (member/admin), `memberNo` | the member (own profile details only); admins (status, role) |
| `roster/{id}` | imported member record: number, name, city, province, registration date, linked account | admins |
| `rosterPrivate/{id}` | phone, T-shirt size / qty / paid — admin-only | admins |
| `dues/{rosterId}_{YYYY-MM}` | monthly dues: status (pending/paid/rejected/waived), amount, receipt photo | member submits own; admins confirm |
| `settings/payment` | bank account, amount, due day, tracking start month | admins |
| `counters/members` | `next` member number | admins |
| `cars/{id}` | model name, caster/maker, notes, up to 3 photos, owner | owner, admins |
| `events/{id}` + `rsvps/{uid}` | title, date, place, details; one RSVP doc per member | admins create events; each member their own RSVP |
| `messages/{id}` | contact-form messages: name, contact, topic, message, status (new/done), sender uid & email | signed-in users create; admins read/manage |
| `listings/{id}` | type (sell/trade/wanted), title, price, condition, photos, status, owner contact | owner, admins |

Collections are created automatically the first time something is saved. Only **approved** members can read any of it — see `firestore.rules`.

**Photos:** resized in the browser (max 1000 px, ~200 KB) and stored inside the Firestore document, so everything runs on the free **Spark** plan without Cloud Storage (which now needs the paid Blaze plan). Free tier is roughly 1 GB of data and 50k reads/day — plenty for a community. If the gallery grows large, move photos to Cloud Storage later.

## Local preview
```bash
firebase emulators:start   # or simply: npx serve public
```

## Files
```
public/index.html      page structure (landing, sign-up gate, members area)
public/css/style.css   design
public/js/app.js       sign-in, approval flow, all features
public/js/i18n.js      Bahasa / English text
public/js/config.js    your Firebase web config
public/js/gallery-data.js  Drive photo/video IDs for the gallery
data/roster.json       member list from the Google Form (private, git-ignored)
data/events.json       events to import
scripts/seed.mjs       imports roster + events into Firestore
firestore.rules        database security rules
firebase.json          hosting + Firestore deploy config
```
