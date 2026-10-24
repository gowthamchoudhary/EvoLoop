import { initDatabase } from "../src/db.js";
import { createWallet } from "../src/wallets.js";

initDatabase();
const treasury = createWallet("treasury", "treasury");
console.log(treasury.address);
console.log("Fund this treasury address from the Sui testnet faucet before running payroll.");
