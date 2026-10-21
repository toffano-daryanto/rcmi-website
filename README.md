# RCMI — Resin Car Model Indonesia

Community website for 1:64 resin car model collectors. Public landing page plus a members-only area behind Google sign-in with admin approval.

**Members area:** Member directory & profiles · Collection showcase · Events & meetups (RSVP) · Marketplace (sell / trade / wanted) · Member card & profile · Admin approvals.
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
The 22 numbered members (from *RCMI Membership Registration (Responses)* → *RCMI Member List* and *List Kaos RCMI*), the 5 applicants without a number yet, and the August 2025 64 Fitment Contest event are in `data/`. One command loads them into Firestore:

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

### Gallery photos and videos
The landing-page gallery (`public/js/gallery-data.js`) shows the 74 photos and videos from the RCMI Drive folder directly from Google Drive. Each file has to be shared **Anyone with the link → Viewer**, or its tile stays blank. Share the media files individually — **not the whole folder**, which also holds the registration responses and payment proofs.

### Custom domain (optional)
*Hosting → Add custom domain*, then add the domain under *Authentication → Settings → Authorized domains* so Google sign-in works there too.

---

## Automatic deploys (optional)

`.github/workflows/deploy.yml` redeploys the site and database rules on every push to `main`.

1. Google Cloud console → *IAM & Admin → Service accounts* (same project) → *Create service account*, role **Firebase Admin**, then *Keys → Add key → JSON*.
2. GitHub repo → *Settings → Secrets and variables → Actions → New repository secret*, name `FIREBASE_SERVICE_ACCOUNT`, paste the whole JSON.

Without the secret, the workflow skips deploying instead of failing.

---

## Database structure (Firestore)

| Collection | What's in it | Who can write |
|---|---|---|
| `users/{uid}` | name, city, Instagram, WhatsApp, bio, `status` (pending/approved/rejected), `role` (member/admin), `memberNo` | the member (own profile details only); admins (status, role) |
| `roster/{id}` | imported member record: number, name, city, province, registration date, linked account | admins |
| `rosterPrivate/{id}` | phone, T-shirt size / qty / paid — admin-only | admins |
| `counters/members` | `next` member number | admins |
| `cars/{id}` | model name, caster/maker, notes, up to 3 photos, owner | owner, admins |
| `events/{id}` + `rsvps/{uid}` | title, date, place, details; one RSVP doc per member | admins create events; each member their own RSVP |
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
