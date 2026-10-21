# RCMI — Resin Car Model Indonesia

Community website for 1:64 resin car model collectors. Public landing page plus a members-only area behind Google sign-in with admin approval.

**Members area:** Collection showcase · Events & meetups (RSVP) · Marketplace (sell / trade / wanted) · Member card & profile · Admin approvals.
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

### Make yourself the first admin
1. Open the site, sign in with Google and submit the profile form.
2. In the Firebase console → *Firestore Database* → `users` → your document, edit:
   - `status` → `approved`
   - `role` → `admin`
   - add field `memberNo` (number) → `1`
3. Reload the site. You now see the **Admin** tab, where you approve everyone else. Member numbers continue automatically (RCMI-0002, RCMI-0003, …). From the Admin tab you can also make other members admins.

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
firestore.rules        database security rules
firebase.json          hosting + Firestore deploy config
```
