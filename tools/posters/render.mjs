// Renders the contest posters to JPG for the website (run by .github/workflows/render-posters.yml).
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import path from "node:path";
const dir = path.dirname(fileURLToPath(import.meta.url));
const b = await chromium.launch();
const pg = await b.newPage({ viewport: { width: 1080, height: 1350 }, deviceScaleFactor: 1 });
for (const n of ["r32", "f40", "guide"]) {
  await pg.goto("file://" + path.join(dir, n + ".html"), { waitUntil: "networkidle" });
  await pg.evaluate(() => document.fonts.ready);
  await pg.waitForTimeout(500);
  await pg.screenshot({ path: path.join(dir, "../../public/img/contest/poster-" + n + ".jpg"), type: "jpeg", quality: 88 });
  console.log("rendered", n);
}
await b.close();

// New file version for the site, so browsers and the app's cache load the new posters instead of the old ones.
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
const img = (n) => readFileSync(path.join(dir, "../../public/img/contest/poster-" + n + ".jpg"));
const v = createHash("md5").update(img("r32")).update(img("f40")).update(img("guide")).digest("hex").slice(0, 8);
const appFile = path.join(dir, "../../public/js/app.js");
writeFileSync(appFile, readFileSync(appFile, "utf8").replace(/const POSTER_V = "[^"]*"/, `const POSTER_V = "${v}"`));
console.log("poster version", v);
