// Renders tools/plakat/out/*.html to print PDFs and PNG previews in plakat-out/ (run by .github/workflows/render-plakat.yml).
import { chromium } from "playwright";
import { readdirSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const dir = path.dirname(fileURLToPath(import.meta.url)), src = path.join(dir, "out"), out = "plakat-out";
mkdirSync(out, { recursive: true });
const b = await chromium.launch();
for (const f of readdirSync(src).filter(f => f.endsWith(".html"))) {
  const name = f.replace(".html", ""), cert = name.startsWith("certificate") || name.startsWith("sponsor");
  const pg = await b.newPage({ viewport: cert ? { width: 1123, height: 794 } : { width: 559, height: 794 }, deviceScaleFactor: 2 });
  await pg.goto("file://" + path.join(src, f), { waitUntil: "networkidle" });
  await pg.evaluate(() => document.fonts.ready); await pg.waitForTimeout(500);
  await pg.pdf({ path: `${out}/RCMI-Photo-Contest-${name}.pdf`, preferCSSPageSize: true, printBackground: true });
  await pg.screenshot({ path: `${out}/${name}.png` });
  console.log("rendered", name); await pg.close();
}
await b.close();
