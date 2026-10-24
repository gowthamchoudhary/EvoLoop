import { closePayrollChain, verifyTransaction } from "../src/payroll-chain.js";

const digest = process.argv[2];
if (!digest) {
  console.error("Usage: npm run debug:confirm -- <digest>");
  process.exitCode = 1;
} else {
  const started = Date.now();
  try {
    const result = await verifyTransaction(digest, { onPoll: () => console.log("PENDING: transaction not indexed yet") });
    console.log(`Status: ${result.status}`);
    console.log(`Checkpoint: ${result.checkpoint ?? "unavailable"}`);
    console.log(`Sender: ${result.sender ?? "unavailable"}`);
    console.log(`Elapsed: ${Date.now() - started} ms`);
    if (result.error) console.log(`On-chain error: ${result.error}`);
  } catch (error) {
    console.error(`FAIL confirmation: ${error.constructor?.name ?? "Error"}: ${error.message}`);
    process.exitCode = 1;
  } finally {
    closePayrollChain();
  }
}
