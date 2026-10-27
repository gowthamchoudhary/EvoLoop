/**
 * Research agent: answers a question through the public agent-key API plus Groq.
 *
 * Flow:
 *  1. `guidance()` — is the `premium_data` capability unlocked with calls remaining on the pass?
 *  2. Groq classifies the question (temperature 0) as needs_live_data true/false and, when live,
 *     extracts { kind, symbol, currency } or { kind, address }. The JSON is validated strictly;
 *     anything invalid is treated as a static question rather than guessed at.
 *  3. Live + capable: fetch the value from the premium endpoint and answer from that value only.
 *     A 402 payment_required is treated as not having the capability.
 *  4. Live + not capable: report a `capability_missing` event (gap_hint knowledge, finance_qa)
 *     and answer best-effort from the model alone.
 *  5. Static: answer from the model.
 *
 * Returns { answer, usedPremium, needsLive }.
 */

const ADDRESS_RE = /^0x[0-9a-fA-F]{64}$/;

function extractJsonObject(content) {
  if (typeof content !== "string") return null;
  const trimmed = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {}
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(trimmed.slice(start, end + 1));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Strictly validate the classifier's JSON. Returns null when anything is off — never a guess. */
function validateClassification(parsed) {
  if (!parsed || typeof parsed.needs_live_data !== "boolean") return null;
  if (!parsed.needs_live_data) return { needsLive: false };
  if (parsed.kind === "price") {
    const symbol = typeof parsed.symbol === "string" ? parsed.symbol.trim().toUpperCase() : "";
    const currency = typeof parsed.currency === "string" ? parsed.currency.trim().toUpperCase() : "";
    if (!/^[A-Z0-9]{2,10}$/.test(symbol) || !/^[A-Z]{3}$/.test(currency)) return null;
    return { needsLive: true, kind: "price", symbol, currency };
  }
  if (parsed.kind === "balance") {
    const address = typeof parsed.address === "string" ? parsed.address.trim() : "";
    if (!ADDRESS_RE.test(address)) return null;
    return { needsLive: true, kind: "balance", address };
  }
  return null;
}

async function classify(groq, question) {
  const parsed = extractJsonObject(await groq.chat(
    [
      {
        role: "system",
        content: [
          "You classify questions for an AI agent that can call a paid data service.",
          "Reply with JSON only: {\"needs_live_data\": boolean, \"kind\": \"price\"|\"balance\"|null, \"symbol\": string|null, \"currency\": string|null, \"address\": string|null}.",
          "needs_live_data is true only when answering requires a current market price or a live on-chain balance.",
          "For a price question set kind=\"price\", symbol (e.g. SUI) and currency (a 3-letter code such as USD, INR, EUR).",
          "For a balance question set kind=\"balance\" and address (0x followed by 64 hex characters) exactly as given.",
          "For everything else needs_live_data is false and the other fields are null.",
        ].join(" "),
      },
      { role: "user", content: question },
    ],
    { temperature: 0, json: true, maxTokens: 200 },
  ));
  return validateClassification(parsed);
}

async function answerFromModel(groq, question) {
  const reply = await groq.chat(
    [
      {
        role: "system",
        content: [
          "You are a precise research assistant. Answer the question directly and concisely.",
          "If you do not know, say what you would need to look up; never invent sources or precise figures you do not have.",
        ].join(" "),
      },
      { role: "user", content: question },
    ],
    { temperature: 0, maxTokens: 400 },
  );
  return reply.trim();
}

/** Capabilities unlocked and usable right now, from the guidance payload. */
function premiumUsable(guidance) {
  const capabilities = Array.isArray(guidance?.capabilities) ? guidance.capabilities : [];
  const unlocked = capabilities.some((entry) => entry.capability_key === "premium_data" && Number(entry.active) === 1);
  const pass = guidance?.premium_pass;
  const usable = Boolean(pass?.active) && Number(pass?.calls_remaining ?? 0) > 0;
  return unlocked && usable;
}

/**
 * @param {{ text: string } | string} question
 * @param {{ client: import("../../sdk/client.js").LayerClient, groq: { chat: Function, model?: string }, sessionId?: string }} ctx
 */
export async function answerQuestion(question, ctx) {
  const { client, groq, sessionId } = ctx;
  const text = typeof question === "string" ? question : question.text;

  const guidanceResult = await client.guidance();
  if (guidanceResult.status !== 200) {
    throw new Error(`guidance() failed: HTTP ${guidanceResult.status} ${JSON.stringify(guidanceResult.data)}`);
  }
  const canUsePremium = premiumUsable(guidanceResult.data);

  const classification = await classify(groq, text);
  if (classification === null) {
    // Unparseable or invalid classification: treat as static instead of guessing what is live.
    return { answer: await answerFromModel(groq, text), usedPremium: false, needsLive: false };
  }

  if (!classification.needsLive) {
    return { answer: await answerFromModel(groq, text), usedPremium: false, needsLive: false };
  }

  if (canUsePremium) {
    const response = classification.kind === "price"
      ? await client.premiumPrice(classification.symbol, classification.currency)
      : await client.premiumBalance(classification.address);
    if (response.status === 402 && response.data?.error === "payment_required") {
      // Pass ran out between guidance() and now: fall through as not capable.
    } else if (response.status === 200) {
      const answer = classification.kind === "price"
        ? `1 ${response.data.symbol} = ${response.data.value} ${response.data.currency} (source: ${response.data.source})`
        : `Address ${response.data.address} holds ${response.data.balance_sui} SUI (coin objects: ${response.data.coin_objects_sui} SUI, address balance: ${response.data.address_balance_sui} SUI; source: ${response.data.source})`;
      return { answer, usedPremium: true, needsLive: true };
    } else {
      throw new Error(`premium data call failed: HTTP ${response.status} ${JSON.stringify(response.data)}`);
    }
  }

  // Live data needed but no capability: record the gap, then answer from the model alone.
  const event = await client.report({
    type: "capability_missing",
    task_category: "finance_qa",
    summary: `needs live data: ${classification.kind}`,
    details: { gap_hint: "knowledge", kind: classification.kind },
    ...(sessionId ? { session_id: sessionId } : {}),
  });
  if (event.status !== 201) {
    throw new Error(`capability_missing report failed: HTTP ${event.status} ${JSON.stringify(event.data)}`);
  }
  return { answer: await answerFromModel(groq, text), usedPremium: false, needsLive: true };
}
