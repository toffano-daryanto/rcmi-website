// Plays one full contest round in a real browser against the emulators: create → open → register → photos →
// voting → jury scores → judging → announce. Screenshots go to e2e-out/, a step log to e2e-out/steps.txt.
import { chromium } from "playwright";
import { mkdirSync, writeFileSync, readdirSync } from "node:fs";
import { PEOPLE, PW } from "./people.mjs";
const BASE = "http://127.0.0.1:5055", OUT = "e2e-out";
mkdirSync(OUT, { recursive: true });
const lines = [], log = (s) => { console.log(s); lines.push(s); };
const pics = readdirSync("public/img/news").filter(f => f.endsWith(".jpg"));
const pic = (i) => "public/img/news/" + pics[(i * 7) % pics.length];
let n = 0;
const browser = await chromium.launch();
const pages = {};
async function as(key) {
  if (pages[key]) return pages[key];
  const p = PEOPLE.find(x => x.key === key);
  const ctx = await browser.newContext({ viewport: { width: 430, height: 900 }, serviceWorkers: "block", locale: "en-US" });
  const pg = await ctx.newPage();
  pg.on("dialog", d => { log(`   [${key}] dialog: ${d.message()}`); d.type() === "prompt" ? d.accept("Test: not a 1:64 car") : d.accept(); });
  pg.on("pageerror", e => log(`   [${key}] PAGE ERROR: ${e.message}`));
  await pg.goto(BASE + "/#/");
  await pg.waitForFunction(() => window.__signIn);
  await pg.evaluate(() => { try { localStorage.setItem("rcmi-lang", "en"); } catch (e) {} });
  await pg.evaluate(([e, pw]) => window.__signIn(e, pw), [p.email, PW]);
  await pg.waitForTimeout(2000);
  pages[key] = pg; return pg;
}
const shot = async (pg, name) => { const f = `${OUT}/${String(++n).padStart(2, "0")}-${name}.png`; await pg.screenshot({ path: f, fullPage: true }); log(`   📷 ${f}`); };
const toast = async (pg) => (await pg.locator("#toast").textContent().catch(() => "")) || "";
async function open(pg, id) {
  await pg.evaluate(() => { location.hash = "#/"; }); await pg.waitForTimeout(400);
  await pg.evaluate((id) => { location.hash = "#/contest/" + id; }, id);
  await pg.waitForSelector("#ct-main", { timeout: 15000 }); await pg.waitForTimeout(1200);
}
const step = (s) => log(`\n▶ ${s}`);

try {
  step("Admin creates the contest");
  const admin = await as("admin");
  await pg_goto(admin, "#/contest");
  await admin.click("[data-ct=new]"); await admin.waitForSelector("#f-contest");
  await admin.fill("#f-contest [name=title]", "E2E Test Photo Contest");
  await admin.fill("#f-contest [name=theme]", "JDM at night");
  await admin.fill("#f-contest [name=prizes]", "1st: Rp 1.000.000\n2nd: Rp 500.000\n3rd: Rp 250.000");
  await admin.fill("#f-contest [name=submitEnd]", "2026-11-15T23:59");
  await admin.fill("#f-contest [name=voteEnd]", "2026-11-22T23:59");
  await admin.fill("#f-contest [name=announceAt]", "2026-11-25T20:00");
  const judges = await admin.locator("#f-contest [name=judge]").count();
  log(`   jury members offered in the form: ${judges}`);
  await shot(admin, "admin-new-contest-form");
  await admin.click("#f-contest [type=submit]");
  await admin.waitForFunction(() => /#\/contest\/.+/.test(location.hash), null, { timeout: 15000 });
  const cid = decodeURIComponent((await admin.evaluate(() => location.hash)).split("/")[2]);
  log(`   contest id: ${cid}`);
  await admin.waitForTimeout(1500);
  await shot(admin, "draft");

  step("Admin opens registration");
  await admin.click("[data-ct-phase=open]"); await admin.waitForTimeout(2500);
  await open(admin, cid);
  log(`   status badge: ${await admin.locator(".ct-head .ct-badge").textContent()}`);

  step("Jury member tries to register (should be refused)");
  const j1 = await as("j1"); await open(j1, cid);
  log(`   jury sees: ${(await j1.locator(".ct-box").textContent()).trim().replace(/\s+/g, " ")}`);
  await shot(j1, "jury-cannot-enter");

  const parts = [["m2", "Neon R34 in the rain"], ["m3", "Midnight NSX"], ["g1", "Tokyo AE86"], ["g2", "Wangan Supra"], ["m4", null]];
  for (const [i, [key, title]] of parts.entries()) {
    step(`${PEOPLE.find(p => p.key === key).name} registers${title ? " and sends a photo" : " (no photo)"}`);
    const pg = await as(key); await open(pg, cid);
    await pg.check("#ct-agree"); await pg.click("[data-ct=register]"); await pg.waitForTimeout(2000);
    log(`   toast: ${await toast(pg)} | reg no: ${(await pg.locator(".ct-regno b").textContent().catch(() => "?"))}`);
    if (i === 0) await shot(pg, "registered-step2");
    if (!title) continue;
    await pg.setInputFiles("#f-ct-entry [name=photo]", pic(i));
    await pg.fill("#f-ct-entry [name=title]", title);
    await pg.fill("#f-ct-entry [name=caption]", "E2E test entry");
    await pg.click("#f-ct-entry [type=submit]"); await pg.waitForTimeout(2500);
    log(`   toast: ${await toast(pg)}`);
    if (key === "m3") {
      step("Segy adds a 2nd photo");
      await pg.click('[data-ct=edit][data-slot="2"]'); await pg.waitForSelector("#f-ct-entry");
      await pg.setInputFiles("#f-ct-entry [name=photo]", pic(9));
      await pg.fill("#f-ct-entry [name=title]", "NSX second angle");
      await pg.click("#f-ct-entry [type=submit]"); await pg.waitForTimeout(2500);
      log(`   toast: ${await toast(pg)} | photos shown: ${await pg.locator("#ct-main .ct-card").count()}`);
      await shot(pg, "two-photos-submitted");
    }
  }

  step("Admin checks participants, then starts voting");
  await open(admin, cid);
  log(`   ${(await admin.locator("#ct-admin h3").nth(1).textContent()).trim()}`);
  await shot(admin, "admin-after-registration");
  await admin.click("[data-ct-phase=voting]"); await admin.waitForTimeout(3000);

  step("Public voting");
  const votes = { m2: "m3", m3: "g1", g1: "m3_2", g2: "m3", m4: "g2", v1: "m3", admin: "m2" };
  for (const [voter, target] of Object.entries(votes)) {
    const pg = await as(voter); await open(pg, cid);
    if (voter === "m3") log(`   Segy's own photos have a vote button? ${await pg.locator('[data-ct-vote="m3"], [data-ct-vote="m3_2"]').count() ? "YES (bad)" : "no (correct)"}`);
    await pg.click(`[data-ct-vote="${target}"]`); await pg.waitForTimeout(1500);
    log(`   ${voter} → ${target}: ${await toast(pg)}`);
    if (voter === "m2") await shot(pg, "voting-page");
  }

  step("Jury scores every photo");
  const base = { j1: { m3: 9, m3_2: 8, g1: 7, m2: 6, g2: 5 }, j2: { m3: 9, m3_2: 8, g1: 8, m2: 6, g2: 5 } };
  for (const jk of ["j1", "j2"]) {
    const pg = await as(jk); await open(pg, cid);
    const forms = pg.locator("form[data-score]");
    log(`   ${jk} sees ${await forms.count()} photos to score`);
    for (let k = 0; k < await forms.count(); k++) {
      const f = forms.nth(k), eid = await f.getAttribute("data-score"), v = base[jk][eid] ?? 5;
      await f.evaluate((el, v) => el.querySelectorAll("input[type=range]").forEach(r => { r.value = v; r.dispatchEvent(new Event("input", { bubbles: true })); }), v);
      await f.locator("[type=submit]").click(); await pg.waitForTimeout(1200);
      log(`   ${jk} scored ${eid}: ${await toast(pg)}`);
    }
    if (jk === "j1") await shot(pg, "jury-scoring");
    if (jk === "j2") {
      step("Judge disqualifies an entry, then reinstates it");
      await pg.click('[data-ct-disq="g2"]'); await pg.waitForTimeout(2500);
      log(`   disqualify: ${await toast(pg)} | shown as disqualified: ${await pg.locator(".jury-row.disq").count()}`);
      await shot(pg, "jury-disqualified");
      await pg.click('[data-ct-reinstate="g2"]'); await pg.waitForTimeout(2500);
      log(`   reinstate: ${await toast(pg)} | still disqualified: ${await pg.locator(".jury-row.disq").count()}`);
    }
  }

  step("Admin closes voting (judging), then announces");
  await open(admin, cid);
  await admin.click("[data-ct-phase=judging]"); await admin.waitForTimeout(2500);
  await open(admin, cid);
  await shot(admin, "admin-live-results");
  await admin.click("[data-ct-phase=announce]"); await admin.waitForSelector("#modal-body [data-act=go]");
  await shot(admin, "announce-preview");
  await admin.click("#modal-body [data-act=go]"); await admin.waitForTimeout(4000);
  log(`   toast: ${await toast(admin)}`);

  step("Everyone sees the winners (signed-out visitor)");
  const ctx = await browser.newContext({ viewport: { width: 430, height: 900 }, serviceWorkers: "block", locale: "en-US" });
  const visitor = await ctx.newPage(); await visitor.goto(BASE + "/#/");
  await visitor.waitForTimeout(1500); await open(visitor, cid);
  log(`   podium: ${(await visitor.locator(".podium figcaption").allTextContents()).map(s => s.replace(/\s+/g, " ").trim()).join(" | ")}`);
  await shot(visitor, "winners-public");
  await visitor.evaluate(() => { location.hash = "#/"; }); await visitor.waitForTimeout(2500);
  await visitor.locator("#home-contest").screenshot({ path: `${OUT}/${String(++n).padStart(2, "0")}-home-card.png` }).catch(() => {});

  step("Winner's notification bell");
  const w = await as("m3"); await w.reload(); await w.waitForTimeout(3000);
  await w.click("#btn-bell").catch(() => log("   (bell button not found)"));
  await w.waitForTimeout(1200); await shot(w, "winner-bell");
  const before = Number((await w.locator("#bell-count").textContent()) || 0);
  await w.locator("#bell-list .bell-item.unread").first().click(); await w.waitForTimeout(2500);
  const after = Number((await w.locator("#bell-count").isHidden()) ? 0 : (await w.locator("#bell-count").textContent()) || 0);
  log(`   unread before tapping: ${before}, after tapping one: ${after}`);
  writeFileSync(`${OUT}/bell.txt`, `${before} ${after}`);
  writeFileSync(`${OUT}/contest-id.txt`, cid);
} catch (e) {
  log("\n❌ STOPPED: " + (e.stack || e));
  for (const [k, pg] of Object.entries(pages)) await pg.screenshot({ path: `${OUT}/zz-fail-${k}.png`, fullPage: true }).catch(() => {});
  process.exitCode = 1;
} finally {
  writeFileSync(`${OUT}/steps.txt`, lines.join("\n"));
  await browser.close();
}
async function pg_goto(pg, hash) { await pg.evaluate((h) => { location.hash = h; }, hash); await pg.waitForTimeout(1500); }
