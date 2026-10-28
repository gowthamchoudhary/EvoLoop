import { ChannelCredentials } from "@grpc/grpc-js";
import { GrpcTransport } from "@protobuf-ts/grpc-transport";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { getConfig } from "./config.js";

const MIN_START_INTERVAL_MS = 450;
const MAX_RETRIES = 4;
const activity = [];
const HTTP_RESPONSE = Symbol("tatumHttpResponse");
let client;
let transport;
let queue = [];
let draining = false;
let lastStartAt = 0;
let totalCalls = 0;
let total429Retries = 0;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function methodName(method) {
  return `${method.service.typeName}/${method.name}`;
}

function record(entry) {
  if (!entry.at) entry.at = new Date().toISOString();
  activity.push(entry);
  if (activity.length > 200) activity.splice(0, activity.length - 200);
}

function retryAfterMs(error) {
  const meta = error?.meta ?? error?.metadata ?? {};
  const raw = error?.retryAfter ?? error?.retryAfterMs
    ?? meta["retry-after"] ?? meta["Retry-After"] ?? meta["retry_after"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined || value === null) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(String(value));
  return Number.isNaN(date) ? 0 : Math.max(0, date - Date.now());
}

function retryable(error) {
  const code = String(error?.code ?? error?.status ?? "").toUpperCase();
  const message = String(error?.message ?? "").toUpperCase();
  return code === "RESOURCE_EXHAUSTED" || code === "UNAVAILABLE"
    || message.includes("429") || message.includes("RESOURCE_EXHAUSTED") || message.includes("UNAVAILABLE");
}

function cleanMessage(error) {
  let message = String(error?.message ?? error);
  try {
    const config = getConfig();
    for (const secret of [config.TATUM_API_KEY, config.MEMWAL_KEY, config.ADMIN_TOKEN, config.WALLET_ENC_KEY]) {
      if (secret) message = message.split(secret).join("[REDACTED]");
    }
  } catch {}
  return message.replace(/(x-api-key\s*[:=]\s*)[^\s,;]+/gi, "$1[REDACTED]");
}

async function waitForStart() {
  const elapsed = Date.now() - lastStartAt;
  if (lastStartAt && elapsed < MIN_START_INTERVAL_MS) await sleep(MIN_START_INTERVAL_MS - elapsed);
  lastStartAt = Date.now();
}

async function invokeWithLimit(name, invoke) {
  const start = Date.now();
  let retries = 0;
  let outcome = "success";
  while (true) {
    await waitForStart();
    totalCalls += 1;
    try {
      const result = await invoke();
      if (result?.[HTTP_RESPONSE]) {
        outcome = result.response.ok ? "success" : `http:${result.response.status}`;
        record({ method: name, latencyMs: Date.now() - start, outcome, retryCount: retries });
        return result.response;
      }
      record({ method: name, latencyMs: Date.now() - start, outcome, retryCount: retries });
      return result;
    } catch (error) {
      if (!retryable(error) || retries >= MAX_RETRIES) {
        outcome = `error:${String(error?.code ?? error?.status ?? error?.name ?? "Error")}`;
        record({ method: name, latencyMs: Date.now() - start, outcome, retryCount: retries });
        const message = retries >= MAX_RETRIES && retryable(error)
          ? `Tatum ${name} failed after ${MAX_RETRIES} retries: ${cleanMessage(error)}`
          : cleanMessage(error);
        const finalError = new Error(message, { cause: error });
        finalError.name = error?.name || "Error";
        finalError.originalErrorClass = error?.constructor?.name ?? "Error";
        if (error?.code !== undefined) finalError.code = error.code;
        if (error?.details !== undefined) finalError.details = cleanMessage({ message: error.details });
        throw finalError;
      }
      retries += 1;
      if (String(error?.code ?? error?.status ?? "").toUpperCase() === "RESOURCE_EXHAUSTED" || String(error?.message ?? "").includes("429")) {
        total429Retries += 1;
      }
      const backoffMs = 1000 * (2 ** (retries - 1));
      await sleep(Math.max(backoffMs, retryAfterMs(error)));
    }
  }
}

function enqueue(name, invoke) {
  return new Promise((resolve, reject) => {
    queue.push({ name, invoke, resolve, reject });
    drainQueue();
  });
}

async function drainQueue() {
  if (draining) return;
  draining = true;
  while (queue.length) {
    const task = queue.shift();
    try {
      task.resolve(await invokeWithLimit(task.name, task.invoke));
    } catch (error) {
      task.reject(error);
    }
  }
  draining = false;
}

class LimitedGrpcTransport extends GrpcTransport {
  unary(method, input, options) {
    const headers = deferred();
    const response = deferred();
    const status = deferred();
    const trailers = deferred();
    const call = {
      method,
      requestHeaders: options.meta ?? {},
      request: input,
      headers: headers.promise,
      response: response.promise,
      status: status.promise,
      trailers: trailers.promise,
      promiseFinished() {
        return Promise.all([this.headers, this.response, this.status, this.trailers]).then(([resolvedHeaders, resolvedResponse, resolvedStatus, resolvedTrailers]) => ({
          method: this.method,
          requestHeaders: this.requestHeaders,
          request: this.request,
          headers: resolvedHeaders,
          response: resolvedResponse,
          status: resolvedStatus,
          trailers: resolvedTrailers,
        }));
      },
      then(resolve, reject) {
        return this.promiseFinished().then(resolve, reject);
      },
    };
    enqueue(methodName(method), async () => {
      const finished = await super.unary(method, input, options);
      return finished;
    }).then((finished) => {
      headers.resolve(finished.headers);
      response.resolve(finished.response);
      status.resolve(finished.status);
      trailers.resolve(finished.trailers);
    }, (error) => {
      headers.reject(error);
      response.reject(error);
      status.reject(error);
      trailers.reject(error);
    });
    return call;
  }

  serverStreaming() { throw new Error("Tatum streaming RPCs are not enabled through the rate-limited transport"); }
  clientStreaming() { throw new Error("Tatum streaming RPCs are not enabled through the rate-limited transport"); }
  duplex() { throw new Error("Tatum streaming RPCs are not enabled through the rate-limited transport"); }
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  promise.catch(() => {});
  return { promise, resolve, reject };
}

export function getTatumClient() {
  if (client) return client;
  const config = getConfig();
  transport = new LimitedGrpcTransport({
    host: config.TATUM_GRPC_HOST,
    channelCredentials: ChannelCredentials.createSsl(),
    meta: { "x-api-key": config.TATUM_API_KEY },
  });
  client = new SuiGrpcClient({ network: config.SUI_NETWORK, transport });
  return client;
}

export function getTatumActivity(limit = 200) {
  const boundedLimit = Math.max(1, Math.min(200, Number(limit) || 200));
  return {
    totalCalls,
    retries429: total429Retries,
    calls: activity.slice(-boundedLimit).map((entry) => ({ ...entry })),
  };
}

export async function tatumHttpRequest({ url, apiKey, method, params }) {
  const parsedUrl = new URL(url);
  const name = `HTTP POST ${parsedUrl.host}${parsedUrl.pathname} ${method}`;
  return enqueue(name, async () => {
    const response = await fetch(url, {
      method: "POST",
      headers: { "x-api-key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const bodyText = await response.text();
    if (response.status === 429 || response.status === 503) {
      const error = new Error(`HTTP ${response.status}: ${bodyText}`);
      error.code = response.status === 429 ? "RESOURCE_EXHAUSTED" : "UNAVAILABLE";
      error.retryAfter = response.headers.get("retry-after");
      throw error;
    }
    let payload;
    try { payload = bodyText ? JSON.parse(bodyText) : null; } catch {}
    return { [HTTP_RESPONSE]: true, response: { status: response.status, ok: response.ok, body: bodyText, payload } };
  });
}

export async function tatumHttpJsonRpc(options) {
  const response = await tatumHttpRequest(options);
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.body}`);
  return response.payload;
}

const RATES_URL = "https://api.tatum.io/v4/data/rate/symbol";
const RATE_TTL_MS = 20_000;
const rateCache = new Map();

/**
 * Current exchange rate for one symbol against a base pair, through the same queue, retry policy
 * and activity log as the gRPC calls (method name `rest:GET /v4/data/rate/symbol`).
 * Each pair is cached for RATE_TTL_MS seconds.
 */
export async function getRate(symbol, basePair) {
  const symbolKey = String(symbol ?? "").trim().toUpperCase();
  const pairKey = String(basePair ?? "").trim().toUpperCase();
  const cacheKey = `${symbolKey}/${pairKey}`;
  const cached = rateCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) return cached.value;

  const config = getConfig();
  const url = `${RATES_URL}?symbol=${encodeURIComponent(symbolKey)}&basePair=${encodeURIComponent(pairKey)}`;
  const response = await enqueue("rest:GET /v4/data/rate/symbol", async () => {
    const result = await fetch(url, {
      method: "GET",
      headers: { "x-api-key": config.TATUM_API_KEY, Accept: "application/json" },
    });
    const body = await result.text();
    if (result.status === 429 || result.status === 503) {
      const error = new Error(`HTTP ${result.status}: ${body}`);
      error.code = result.status === 429 ? "RESOURCE_EXHAUSTED" : "UNAVAILABLE";
      error.retryAfter = result.headers.get("retry-after");
      throw error;
    }
    return { [HTTP_RESPONSE]: true, response: { status: result.status, ok: result.ok, body } };
  });

  if (!response.ok) throw new Error(`Tatum rates request failed: HTTP ${response.status} ${cleanMessage(response.body ?? "").slice(0, 300)}`);
  let payload;
  try { payload = JSON.parse(response.body); } catch { throw new Error("Tatum rates returned a non-JSON body"); }
  const value = Number(payload?.value);
  if (!Number.isFinite(value)) throw new Error(`Tatum rates returned no usable value for ${cleanMessage(cacheKey)}`);

  const rate = {
    symbol: payload.symbol ?? symbolKey,
    basePair: payload.basePair ?? pairKey,
    value,
    timestamp: typeof payload.timestamp === "number" ? payload.timestamp : null,
    source: "tatum-rates",
  };
  rateCache.set(cacheKey, { value: rate, expiresAt: Date.now() + RATE_TTL_MS });
  return rate;
}

export function closeTatum() {
  transport?.close();
  transport = undefined;
  client = undefined;
}
