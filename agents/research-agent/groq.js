/**
 * Minimal Groq chat helper for the research agent: fetch only, no dependencies.
 * Never logs or returns the API key; error bodies from Groq do not contain it.
 */

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_DEFAULT_MODEL = "llama-3.3-70b-versatile";
const TIMEOUT_MS = 30_000;
const RETRY_DELAYS_MS = [1_000, 2_000, 4_000];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function extractJsonObject(content) {
  if (typeof content !== "string") return null;
  const trimmed = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
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

/**
 * @param {{ apiKey?: string, model?: string }} options
 * @returns {{ model: string, chat: Function, json: Function }}
 *   `chat(messages, { temperature, json, maxTokens })` resolves to the reply text;
 *   `json(messages, options)` resolves to the parsed JSON object, or null when unparseable.
 */
export function createGroqHelper({ apiKey = process.env.GROQ_API_KEY, model = process.env.GROQ_MODEL } = {}) {
  const key = apiKey?.trim();
  if (!key) throw new Error("GROQ_API_KEY is not set");
  const activeModel = model?.trim() || GROQ_DEFAULT_MODEL;

  async function chat(messages, { temperature = 0, json = false, maxTokens = 500 } = {}) {
    let lastError = null;
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
      let response;
      try {
        response = await fetch(GROQ_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
          body: JSON.stringify({
            model: activeModel,
            temperature,
            max_completion_tokens: maxTokens,
            ...(json ? { response_format: { type: "json_object" } } : {}),
            messages,
          }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (error) {
        lastError = new Error(`Groq request failed: ${error instanceof Error ? error.message : String(error)}`);
        await sleep(RETRY_DELAYS_MS[attempt] ?? 4_000);
        continue;
      }
      if (response.status === 429 || response.status >= 500) {
        const body = await response.text().catch(() => "");
        lastError = new Error(`Groq HTTP ${response.status}: ${body.slice(0, 300)}`);
        if (attempt < RETRY_DELAYS_MS.length) {
          const retryAfter = Number(response.headers.get("retry-after"));
          await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(15_000, retryAfter * 1000) : RETRY_DELAYS_MS[attempt]);
          continue;
        }
        break;
      }
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(`Groq HTTP ${response.status}: ${body.slice(0, 300)}`);
      }
      const payload = await response.json();
      return payload?.choices?.[0]?.message?.content ?? "";
    }
    throw lastError ?? new Error("Groq request failed");
  }

  return {
    model: activeModel,
    chat,
    async json(messages, options = {}) {
      const content = await chat(messages, { ...options, json: true });
      return extractJsonObject(content);
    },
  };
}
