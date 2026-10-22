// Renders the contest posters to JPG for the website (run by .github/workflows/render-posters.yml).
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import path from "node:path";
const dir = path.dirname(fileURLToPath(import.meta.url));
const b = await chromium.launch();
const pg = await b.newPage({ viewport: { width: 1080, height: 1350 }, deviceScaleFactor: 1 });
for (const n of ["r32", "f40"]) {
  await pg.goto("file://" + path.join(dir, n + ".html"), { waitUntil: "networkidle" });
  await pg.evaluate(() => document.fonts.ready);
  await pg.waitForTimeout(500);
  await pg.screenshot({ path: path.join(dir, "../../public/img/contest/poster-" + n + ".jpg"), type: "jpeg", quality: 88 });
  console.log("rendered", n);
}
await b.close();
