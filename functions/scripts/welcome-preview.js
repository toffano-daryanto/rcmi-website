// Renders the welcome email + member card with sample data (no Firestore, no sending) into $OUT.
import { writeFileSync, mkdirSync } from "node:fs";
import { welcomeHTML, cardPNG, cardSVG } from "../lib/welcome.js";
const out = process.env.OUT || "welcome-out"; mkdirSync(out, { recursive: true });
const pay = { amount: 50000, dueDay: 10, bank: "BNI", accountNo: "0000000000", accountName: "RCMI TREASURER" };
const samples = [
  { name: "Budi Santoso", no: 12, city: "Jakarta", instagram: "budi.diecast", since: new Date("2026-11-03") },
  { name: "Muhammad Rizky Pratama Wijaya", no: 108, city: "Surabaya", instagram: "", since: new Date("2026-11-03") }
];
for (const [i, s] of samples.entries()) {
  writeFileSync(`${out}/card-${i + 1}.png`, await cardPNG(s));
  writeFileSync(`${out}/card-${i + 1}.svg`, cardSVG(s));
}
writeFileSync(`${out}/email.html`, welcomeHTML({ name: samples[0].name, no: 12, pay }).replace("cid:rcmi-card", "card-1.png"));
console.log("preview written");
