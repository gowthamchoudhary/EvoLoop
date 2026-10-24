import { ChannelCredentials } from "@grpc/grpc-js";
import { GrpcTransport } from "@protobuf-ts/grpc-transport";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { getConfig } from "./config.js";

const minimumIntervalMs = 400;
let lastRequestAt = 0;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function getSuiBalance(address) {
  const config = getConfig();
  const elapsed = Date.now() - lastRequestAt;
  if (lastRequestAt !== 0 && elapsed < minimumIntervalMs) await sleep(minimumIntervalMs - elapsed);
  lastRequestAt = Date.now();

  const transport = new GrpcTransport({
    host: "sui-mainnet-grpc.gateway.tatum.io:443",
    channelCredentials: ChannelCredentials.createSsl(),
  });
  try {
    const client = new SuiGrpcClient({ network: "mainnet", transport });
    const { response } = await client.stateService.getBalance(
      { owner: address, coinType: "0x2::sui::SUI" },
      { meta: { "x-api-key": config.TATUM_API_KEY } },
    );
    const mist = BigInt(response.balance?.totalBalance ?? "0");
    const whole = mist / 1_000_000_000n;
    const fraction = (mist % 1_000_000_000n).toString().padStart(9, "0").replace(/0+$/, "");
    return fraction ? `${whole}.${fraction}` : whole.toString();
  } finally {
    transport.close();
  }
}
