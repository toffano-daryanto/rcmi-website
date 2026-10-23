// Opens a page in a real browser (for sites that need JavaScript), saves its text and a full-page screenshot.
import { chromium } from "playwright";
import { writeFileSync, mkdirSync } from "node:fs";
const url = process.env.URL;
mkdirSync("snap", { recursive: true });
const b = await chromium.launch();
// Raw data (JSON, text): save as-is.
if (/\.json(\?|$)/.test(url)) {
  const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  writeFileSync("snap/text.txt", await r.text()); writeFileSync("snap/links.txt", ""); await b.close(); process.exit(0);
}
const pg = await b.newPage({ viewport: { width: 1280, height: 900 }, locale: "en-US" });
await pg.goto(url, { waitUntil: "networkidle", timeout: 60000 }).catch(() => {});
await pg.waitForTimeout(5000);
for (let i = 0; i < 8; i++) { await pg.mouse.wheel(0, 1500); await pg.waitForTimeout(600); }
writeFileSync("snap/text.txt", await pg.evaluate(() => document.body.innerText));
writeFileSync("snap/links.txt", (await pg.evaluate(() => [...document.querySelectorAll("a")].map(a => a.innerText.trim().slice(0, 80) + " | " + a.href))).join("\n"));
await pg.screenshot({ path: "snap/page.jpg", fullPage: false, type: "jpeg", quality: 60 }).catch(() => {});
await b.close();
