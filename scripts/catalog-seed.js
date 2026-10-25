import { getDatabase, initDatabase } from "../src/db.js";
import { UPGRADE_CATALOG } from "../src/review-config.js";

initDatabase();
const db = getDatabase();

const seed = db.transaction(() => {
  const upsert = db.prepare(`
    INSERT INTO upgrade_catalog(id,vendor_id,capability_key,fix_type,taxonomy,price_mist,description,active)
    VALUES(?,?,?,?,?,?,?,1)
    ON CONFLICT(id) DO UPDATE SET
      vendor_id=excluded.vendor_id,
      capability_key=excluded.capability_key,
      fix_type=excluded.fix_type,
      taxonomy=excluded.taxonomy,
      price_mist=excluded.price_mist,
      description=excluded.description,
      active=1
  `);
  for (const item of UPGRADE_CATALOG) {
    const vendor = db.prepare("SELECT id FROM vendors WHERE label=?").get(item.vendor_label);
    if (!vendor) throw new Error(`Vendor "${item.vendor_label}" is missing; run npm run vendors:seed first`);
    upsert.run(item.id, vendor.id, item.capability_key, item.fix_type, item.taxonomy, item.price_mist, item.description);
  }
});

seed();
console.log(`Seeded ${UPGRADE_CATALOG.length} upgrade catalog entries.`);
