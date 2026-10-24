import { MemWal } from "@mysten-incubation/memwal";
import { getConfig } from "./config.js";

let memory;

export function createMemory(namespace = undefined) {
  const config = getConfig();
  return MemWal.create({
    key: config.MEMWAL_KEY,
    accountId: config.MEMWAL_ACCOUNT_ID,
    serverUrl: config.MEMWAL_SERVER_URL,
    namespace: namespace ?? config.MEMWAL_NAMESPACE,
  });
}

function getMemory() {
  memory ??= createMemory();
  return memory;
}

export function health() {
  return getMemory().health();
}

export async function remember(text) {
  const memwal = getMemory();
  const job = await memwal.remember(text);
  await memwal.waitForRememberJob(job.job_id);
  return job;
}

export async function recall(query) {
  const result = await getMemory().recall({ query });
  return result.results;
}
