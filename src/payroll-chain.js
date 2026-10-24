import { coinWithBalance, Transaction } from "@mysten/sui/transactions";
import { decryptWallet, getWallet } from "./wallets.js";
import { closeTatum, getTatumClient } from "./tatum.js";

const MIN_GAS_BUDGET_MIST = 3_000_000n;
const SIMULATION_GAS_BUDGET_MIST = 10_000_000n;
const GAS_PRICE_TTL_MS = 30_000;
const TREASURY_BALANCE_TTL_MS = 5_000;
let gasPriceCache;
let gasPriceInFlight;
let treasuryBalanceCache;
let treasuryBalanceInFlight;

async function getReferenceGasPrice() {
  if (gasPriceCache && Date.now() < gasPriceCache.expiresAt) return gasPriceCache.value;
  if (!gasPriceInFlight) {
    gasPriceInFlight = getTatumClient().getReferenceGasPrice()
      .then((value) => {
        gasPriceCache = { value, expiresAt: Date.now() + GAS_PRICE_TTL_MS };
        return value;
      })
      .finally(() => { gasPriceInFlight = undefined; });
  }
  return gasPriceInFlight;
}

export async function getPayrollBalance(address) {
  const { totalBalance } = await getPayrollBalanceBreakdown(address);
  return totalBalance;
}

export async function getPayrollBalanceBreakdown(address) {
  const treasury = getWallet("treasury", "treasury");
  if (treasury?.address === address && treasuryBalanceCache && Date.now() < treasuryBalanceCache.expiresAt) {
    return { ...treasuryBalanceCache.value };
  }
  if (treasury?.address === address && treasuryBalanceInFlight) return { ...(await treasuryBalanceInFlight) };
  const readBalance = async () => {
    const response = await getTatumClient().getBalance({ owner: address, coinType: "0x2::sui::SUI" });
    const balance = response.balance;
    return {
      totalBalance: BigInt(balance.balance),
      coinBalance: BigInt(balance.coinBalance ?? "0"),
      addressBalance: BigInt(balance.addressBalance ?? "0"),
    };
  };
  if (treasury?.address === address) {
    treasuryBalanceInFlight = readBalance()
      .then((value) => {
        treasuryBalanceCache = { value, expiresAt: Date.now() + TREASURY_BALANCE_TTL_MS };
        return value;
      })
      .finally(() => { treasuryBalanceInFlight = undefined; });
    return { ...(await treasuryBalanceInFlight) };
  }
  return readBalance();
}

export async function getTransactionByDigest(digest) {
  return getTatumClient().getTransaction({ digest, include: { effects: true, transaction: true } });
}

export async function verifyTransaction(digest) {
  const result = await getTransactionByDigest(digest);
  const transaction = result.Transaction ?? result.FailedTransaction;
  if (!transaction) throw new Error(`Tatum returned no transaction for digest ${digest}`);
  const success = result.$kind === "Transaction" && transaction.status?.success === true;
  return {
    digest: transaction.digest,
    status: success ? "success" : "failed",
    error: success ? null : transaction.status?.error?.message ?? "Sui transaction execution failed",
    sender: transaction.transaction?.sender ?? null,
    timestamp: transaction.timestampMs === null ? null : new Date(transaction.timestampMs).toISOString(),
  };
}

export async function transferSui(wallet, toAddress, amountMist, { onStage } = {}) {
  const amount = BigInt(amountMist);
  if (amount <= 0n) throw new Error("Transfer amount must be positive");
  const runStage = async (name, action) => {
    const started = Date.now();
    try {
      const result = await action();
      onStage?.({ stage: name, durationMs: Date.now() - started, result });
      return result;
    } catch (error) {
      error.stage = name;
      onStage?.({ stage: name, durationMs: Date.now() - started, error });
      throw error;
    }
  };
  const keypair = await runStage("load_wallet", async () => decryptWallet(wallet));
  const sender = keypair.toSuiAddress();
  const gasPrice = await runStage("get_gas_price", getReferenceGasPrice);
  const parsedGasPrice = BigInt(gasPrice.referenceGasPrice);
  const transaction = new Transaction();
  transaction.setSender(sender);
  transaction.setGasPrice(parsedGasPrice);
  transaction.setGasBudget(SIMULATION_GAS_BUDGET_MIST);
  transaction.setGasPayment([]);
  const [coin] = transaction.add(coinWithBalance({ balance: amount, type: "0x2::sui::SUI", useGasCoin: false }));
  transaction.transferObjects([coin], toAddress);
  let tx = await runStage("build_tx", async () => {
    try {
      return await transaction.build({ client: getTatumClient() });
    } catch (error) {
      const message = String(error?.message ?? "");
      if (!/no valid gas coins found|could not resolve gas payment/i.test(message)) throw error;
      if (!transaction.getData().gasData.budget) transaction.setGasBudget(MIN_GAS_BUDGET_MIST);
      return transaction.build({ client: getTatumClient() });
    }
  });
  const dryRun = await runStage("dry_run", async () => {
    const result = await getTatumClient().simulateTransaction({ transaction: tx, include: { effects: true }, doGasSelection: false });
    const execution = result.Transaction ?? result.FailedTransaction;
    const effects = execution?.effects;
    if (result.$kind !== "Transaction" || effects?.status?.success !== true) {
      throw new Error(effects?.status?.error ?? "Sui transaction simulation failed");
    }
    const gasUsed = effects.gasUsed;
    if (!gasUsed) throw new Error("Simulation succeeded but returned no gas estimate");
    const netGas = BigInt(gasUsed.computationCost) + BigInt(gasUsed.storageCost) - BigInt(gasUsed.storageRebate);
    const budget = netGas * 130n / 100n + (netGas * 130n % 100n ? 1n : 0n);
    const marginBudget = budget > MIN_GAS_BUDGET_MIST ? budget : MIN_GAS_BUDGET_MIST;
    const sdkBudget = BigInt(transaction.getData().gasData.budget ?? "0");
    const chosenGasBudget = marginBudget;
    if (sdkBudget !== chosenGasBudget) {
      transaction.setGasBudget(chosenGasBudget);
      tx = await transaction.build({ client: getTatumClient() });
      const finalSimulation = await getTatumClient().simulateTransaction({ transaction: tx, include: { effects: true }, doGasSelection: false });
      const finalExecution = finalSimulation.Transaction ?? finalSimulation.FailedTransaction;
      const finalEffects = finalExecution?.effects;
      if (finalSimulation.$kind !== "Transaction" || finalEffects?.status?.success !== true) {
        throw new Error(finalEffects?.status?.error ?? "Sui transaction simulation failed with chosen gas budget");
      }
    }
    return {
      status: effects.status,
      gasUsed: {
        computationCost: gasUsed.computationCost,
        storageCost: gasUsed.storageCost,
        storageRebate: gasUsed.storageRebate,
        nonRefundableStorageFee: gasUsed.nonRefundableStorageFee,
      },
      sdkGasBudgetMist: sdkBudget.toString(),
      chosenGasBudgetMist: chosenGasBudget.toString(),
      finalSimulationPassed: true,
    };
  });
  const { signature } = await runStage("sign", async () => keypair.signTransaction(tx));
  // Do not automatically retry submission: a transport failure may happen after the chain accepted it.
  const submitted = await runStage("execute", async () => {
    return getTatumClient().executeTransaction({ transaction: tx, signatures: [signature], include: { effects: true } });
  });
  const executed = submitted.Transaction ?? submitted.FailedTransaction;
  if (!executed?.digest) {
    const error = new Error("Tatum returned no transaction digest after execution");
    error.stage = "execute";
    throw error;
  }
  const confirmation = await runStage("confirm", async () => verifyTransaction(executed.digest));
  if (confirmation.status !== "success") {
    const error = new Error(confirmation.error ?? "Sui transaction execution failed");
    error.digest = confirmation.digest;
    error.confirmedAt = confirmation.timestamp;
    error.stage = "confirm";
    throw error;
  }
  return confirmation;
}

export function closePayrollChain() {
  closeTatum();
}

export function formatMist(mist) {
  const amount = BigInt(mist);
  const whole = amount / 1_000_000_000n;
  const fraction = (amount % 1_000_000_000n).toString().padStart(9, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

export function suiToMist(value) {
  const text = String(value);
  const match = /^(\d+)(?:\.(\d{1,9}))?$/.exec(text);
  if (!match) throw new Error("SUI amount must be a non-negative decimal with at most 9 decimal places");
  return BigInt(match[1]) * 1_000_000_000n + BigInt((match[2] ?? "").padEnd(9, "0") || "0");
}
