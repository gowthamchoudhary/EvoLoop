import { coinWithBalance, Transaction } from "@mysten/sui/transactions";
import { decryptWallet } from "./wallets.js";
import { closeTatum, getTatumClient } from "./tatum.js";

const MIN_GAS_BUDGET_MIST = 3_000_000n;
const SIMULATION_GAS_BUDGET_MIST = 10_000_000n;
const GAS_PRICE_TTL_MS = 30_000;
const BALANCE_TTL_MS = 5_000;
let gasPriceCache;
let gasPriceInFlight;
const balanceCache = new Map();
const balanceInFlight = new Map();
const balanceGeneration = new Map();

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

export async function getPayrollBalance(address, options) {
  const { totalBalance } = await getPayrollBalanceBreakdown(address, options);
  return totalBalance;
}

export async function getPayrollBalanceBreakdown(address, { bypassCache = false } = {}) {
  const cached = balanceCache.get(address);
  if (!bypassCache && cached && Date.now() < cached.expiresAt) return { ...cached.value };
  if (!bypassCache && balanceInFlight.has(address)) return { ...(await balanceInFlight.get(address)) };

  const generation = balanceGeneration.get(address) ?? 0;
  const request = getTatumClient().getBalance({ owner: address, coinType: "0x2::sui::SUI" })
    .then((response) => {
      const balance = response.balance;
      const value = {
        totalBalance: BigInt(balance.balance),
        coinBalance: BigInt(balance.coinBalance ?? "0"),
        addressBalance: BigInt(balance.addressBalance ?? "0"),
      };
      if ((balanceGeneration.get(address) ?? 0) === generation) {
        balanceCache.set(address, { value, expiresAt: Date.now() + BALANCE_TTL_MS });
      }
      return value;
    })
    .finally(() => {
      if (balanceInFlight.get(address) === request) balanceInFlight.delete(address);
    });
  if (!bypassCache) balanceInFlight.set(address, request);
  return { ...(await request) };
}

function invalidateBalanceCache(...addresses) {
  for (const address of addresses) {
    balanceGeneration.set(address, (balanceGeneration.get(address) ?? 0) + 1);
    balanceCache.delete(address);
    balanceInFlight.delete(address);
  }
}

export async function getTransactionByDigest(digest) {
  return getTatumClient().getTransaction({ digest, include: { effects: true, transaction: true } });
}

function isNotFound(error) {
  return String(error?.code ?? error?.status ?? "").toUpperCase() === "NOT_FOUND"
    || /not[_ ]found|does not exist/i.test(String(error?.message ?? ""));
}

function transactionFromResult(result) {
  const transaction = result.Transaction ?? result.FailedTransaction;
  if (!transaction) return null;
  const status = transaction.status ?? transaction.effects?.status ?? result.status;
  const success = result.$kind === "Transaction" && status?.success === true;
  const checkpoint = transaction.checkpoint ?? result.checkpoint ?? null;
  return {
    digest: transaction.digest ?? result.digest,
    status: success ? "success" : "failed",
    error: success ? null : status?.error?.message ?? status?.error ?? "Sui transaction execution failed",
    sender: transaction.transaction?.sender ?? null,
    timestamp: transaction.timestampMs == null ? null : new Date(Number(transaction.timestampMs)).toISOString(),
    checkpoint: checkpoint == null ? null : String(checkpoint),
  };
}

export async function verifyTransaction(digest, { onPoll } = {}) {
  const deadline = Date.now() + 40_000;
  while (true) {
    try {
      const verified = transactionFromResult(await getTransactionByDigest(digest));
      if (!verified) throw new Error(`Tatum returned no transaction for digest ${digest}`);
      return { ...verified, confirmedAt: new Date().toISOString() };
    } catch (error) {
      if (!isNotFound(error)) throw error;
      onPoll?.({ digest, status: "pending" });
      if (Date.now() >= deadline) {
        return { digest, status: "unconfirmed", error: null, sender: null, timestamp: null, checkpoint: null, confirmedAt: null };
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(2_000, deadline - Date.now())));
    }
  }
}

export async function transferSui(wallet, toAddress, amountMist, { onStage, onExecuted } = {}) {
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
  const balance = await runStage("select_funding", () => getPayrollBalanceBreakdown(sender, { bypassCache: true }));
  const requiredWithGas = amount + SIMULATION_GAS_BUDGET_MIST;
  let fundingSource;
  if (balance.addressBalance >= requiredWithGas) fundingSource = "address_balance";
  else if (balance.coinBalance >= requiredWithGas) fundingSource = "coin_objects";
  else {
    const error = new Error(`Insufficient SUI funds: amount=${amount} MIST, gas_budget=${SIMULATION_GAS_BUDGET_MIST} MIST, required=${requiredWithGas} MIST, total=${balance.totalBalance} MIST, coin_objects=${balance.coinBalance} MIST, address_balance=${balance.addressBalance} MIST`);
    error.stage = "select_funding";
    throw error;
  }
  const gasPrice = await runStage("get_gas_price", getReferenceGasPrice);
  const parsedGasPrice = BigInt(gasPrice.referenceGasPrice);
  const transaction = new Transaction();
  transaction.setSender(sender);
  transaction.setGasPrice(parsedGasPrice);
  transaction.setGasBudget(SIMULATION_GAS_BUDGET_MIST);
  if (fundingSource === "address_balance") {
    transaction.setGasPayment([]);
    transaction.moveCall({
      target: "0x2::balance::send_funds",
      typeArguments: ["0x2::sui::SUI"],
      arguments: [transaction.balance({ balance: amount, useGasCoin: false }), transaction.pure.address(toAddress)],
    });
  } else {
    const [coin] = transaction.add(coinWithBalance({ balance: amount, type: "0x2::sui::SUI", useGasCoin: false }));
    transaction.moveCall({
      target: "0x2::coin::send_funds",
      typeArguments: ["0x2::sui::SUI"],
      arguments: [coin, transaction.pure.address(toAddress)],
    });
  }
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
  const executionStatus = executed.status ?? executed.effects?.status;
  const executionSucceeded = submitted.$kind === "Transaction" && executionStatus?.success === true;
  const executionFailed = submitted.$kind === "FailedTransaction" || executionStatus?.success === false;
  const executionError = executionStatus?.error?.message ?? executionStatus?.error ?? "Sui transaction execution failed";
  await onExecuted?.({
    digest: executed.digest,
    status: executionFailed ? "failed" : "executed",
    error: executionFailed ? String(executionError) : null,
    checkpoint: executed.checkpoint ?? submitted.checkpoint ?? null,
    confirmedAt: null,
  });
  if (executionFailed) {
    const error = new Error(String(executionError));
    error.digest = executed.digest;
    error.stage = "execute";
    throw error;
  }
  invalidateBalanceCache(sender, toAddress);
  const confirmation = await runStage("confirm", async () => verifyTransaction(executed.digest));
  if (confirmation.status !== "success") {
    if (confirmation.status === "unconfirmed") {
      return { ...confirmation, status: "unconfirmed" };
    }
    const error = new Error(confirmation.error ?? "Sui transaction execution failed");
    error.digest = confirmation.digest;
    error.confirmedAt = confirmation.timestamp;
    error.checkpoint = confirmation.checkpoint;
    error.stage = "confirm";
    throw error;
  }
  invalidateBalanceCache(sender, toAddress);
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
