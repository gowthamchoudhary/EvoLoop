import { initDatabase, getDatabase } from "../src/db.js";
import { createWallet } from "../src/wallets.js";

initDatabase();
const vendors = [
  { id: "premium-data-source", label: "premium-data-source", category: "data" },
  { id: "vision-api", label: "vision-api", category: "model" },
];
const db = getDatabase();
const seed = db.transaction(() => {
  for (const vendor of vendors) {
    const wallet = createWallet("vendor", vendor.id);
    db.prepare(`INSERT INTO vendors(id,label,category,address) VALUES(?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET label=excluded.label,category=excluded.category,address=excluded.address`)
      .run(vendor.id, vendor.label, vendor.category, wallet.address);
  }
});
seed();
console.log("Seeded 2 vendor wallets.");
