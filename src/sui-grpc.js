import { formatMist } from "./payroll-chain.js";
import { getTatumClient } from "./tatum.js";

export async function getSuiBalance(address) {
  const { balance } = await getTatumClient().getBalance({ owner: address, coinType: "0x2::sui::SUI" });
  return formatMist(BigInt(balance.balance));
}
