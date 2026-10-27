/**
 * Automated grader for research-agent answers.
 *
 * Ground truth is supplied by the runner, which fetches it on the admin side at grading time:
 *  - price answers: a fresh Tatum rate (src/tatum.js getRate); correct within 3%;
 *  - balance answers: the live Tatum GetBalance total; correct within 0.0005 SUI;
 *  - static answers: expected keywords, case-insensitive, word-boundary matched.
 *
 * Numbers are parsed from free text robustly: 0x addresses are stripped first, thousands
 * separators and currency symbols are removed, then every candidate number is checked.
 */

const PRICE_TOLERANCE = 0.03;
const BALANCE_TOLERANCE_SUI = 0.0005;

/** All parseable numbers in an answer, with addresses, symbols and separators cleaned up. */
export function extractNumbers(text) {
  const cleaned = String(text ?? "")
    .replace(/0x[0-9a-fA-F]{6,}/g, " ")
    .replace(/[$₹€£¥]|\b(?:USD|INR|EUR|SUI)\b/gi, " ");
  const matches = cleaned.match(/\d[\d,]*(?:\.\d+)?|\.\d+/g) ?? [];
  return matches
    .map((match) => Number(match.replace(/,/g, "")))
    .filter((value) => Number.isFinite(value));
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function keywordMatch(text, keywords) {
  const haystack = String(text ?? "");
  return keywords.every((keyword) => new RegExp(`\\b${escapeRegex(keyword)}\\b`, "i").test(haystack));
}

function format(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return String(value);
  return Number(value.toFixed(6)).toString();
}

/**
 * @param {object} question  entry from questions.js
 * @param {string} answerText the agent's answer
 * @param {*} groundTruth  rate object ({value}), balance in MIST (bigint), or unused for static
 * @returns {{ correct: boolean, expected: string, stated: string|null, detail: string }}
 */
export function gradeAnswer(question, answerText, groundTruth) {
  const text = String(answerText ?? "");

  if (question.kind === "price") {
    const expected = Number(groundTruth?.value);
    if (!Number.isFinite(expected) || expected <= 0) throw new Error(`no rate ground truth for ${question.id}`);
    const candidates = extractNumbers(text);
    const correct = candidates.some((value) => Math.abs(value - expected) / expected <= PRICE_TOLERANCE);
    const stated = candidates.length
      ? candidates.reduce((best, value) => (Math.abs(value - expected) < Math.abs(best - expected) ? value : best))
      : null;
    return {
      correct,
      expected: format(expected),
      stated: stated === null ? null : format(stated),
      detail: correct
        ? `within ${PRICE_TOLERANCE * 100}% of ${format(expected)}`
        : stated === null
          ? `no number parsed (expected ${format(expected)})`
          : `${format(stated)} is ${((Math.abs(stated - expected) / expected) * 100).toFixed(1)}% off ${format(expected)}`,
    };
  }

  if (question.kind === "balance") {
    if (typeof groundTruth !== "bigint") throw new Error(`no balance ground truth for ${question.id}`);
    const expected = Number(groundTruth) / 1e9;
    const candidates = extractNumbers(text);
    const correct = candidates.some((value) => Math.abs(value - expected) <= BALANCE_TOLERANCE_SUI);
    const stated = candidates.length
      ? candidates.reduce((best, value) => (Math.abs(value - expected) < Math.abs(best - expected) ? value : best))
      : null;
    return {
      correct,
      expected: format(expected),
      stated: stated === null ? null : format(stated),
      detail: correct
        ? `within ${BALANCE_TOLERANCE_SUI} SUI of ${format(expected)}`
        : stated === null
          ? `no number parsed (expected ${format(expected)})`
          : `${format(stated)} vs ${format(expected)} SUI`,
    };
  }

  const missing = question.keywords.filter((keyword) => !new RegExp(`\\b${escapeRegex(keyword)}\\b`, "i").test(text));
  return {
    correct: missing.length === 0,
    expected: question.keywords.join(", "),
    stated: missing.length === 0 ? question.keywords.join(", ") : null,
    detail: missing.length === 0 ? "all keywords present" : `missing: ${missing.join(", ")}`,
  };
}

/**
 * The event the runner posts with the agent's key for every graded answer.
 * `details.source = "automated_grader"` is present on every graded event.
 */
export function buildGradedEvent({ question, grade, sessionId }) {
  const base = {
    task_category: question.category,
    session_id: sessionId,
    details: {
      source: "automated_grader",
      question_id: question.id,
      kind: question.kind,
      expected: grade.expected,
    },
  };
  if (grade.correct) {
    return { ...base, type: "task_completed", score: 1, summary: `Graded correct: ${question.text}` };
  }
  const got = grade.stated ?? "no parseable answer";
  return {
    ...base,
    type: "user_corrected",
    score: 0,
    summary: `Graded incorrect: ${question.text}`,
    correction: `expected about ${grade.expected}, got ${got}`,
  };
}
