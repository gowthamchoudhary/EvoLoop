/**
 * Question bank for the research agent cycle.
 *
 * Two categories:
 *  - `finance_qa` (live): SUI price questions in USD/INR/EUR with several phrasings, plus
 *    balance questions for public addresses supplied by the caller (the runner reads the
 *    treasury and vendor addresses from the database at run time).
 *  - `general_knowledge` (static): stable facts with expected keywords for the grader.
 *
 * Each entry: { id, category, kind: 'price'|'balance'|'static', text, symbol?, currency?,
 * address?, keywords? }. Period 1 takes `finance.slice(0, 10)` and `general.slice(0, 4)`;
 * period 2 takes `finance.slice(12, 22)` and `general.slice(4, 8)` so the second period
 * uses different phrasings/currencies and different facts.
 */

const PRICE_PHRASINGS = [
  (currency) => `What is the current price of SUI in ${currency}?`,
  (currency) => `How much is one SUI worth in ${currency} right now?`,
  (currency) => `Can you tell me today's SUI to ${currency} exchange rate?`,
  (currency) => `I need the SUI price in ${currency} for a report — what is it?`,
];

const BALANCE_PHRASINGS = [
  (address) => `What is the balance of address ${address}?`,
  (address) => `How much SUI does ${address} hold right now?`,
  (address) => `Check the wallet ${address} — how many SUI are in it?`,
  (address) => `Tell me the total SUI balance for ${address} on Sui testnet.`,
];

const GENERAL_QUESTIONS = [
  { text: "What does RPC stand for?", keywords: ["remote procedure call"] },
  { text: "Which blockchain does Walrus run with?", keywords: ["sui"] },
  { text: "What is the capital of France?", keywords: ["paris"] },
  { text: "What does HTTP stand for?", keywords: ["hypertext transfer protocol"] },
  { text: "What is H2O commonly known as?", keywords: ["water"] },
  { text: "What is the largest planet in the solar system?", keywords: ["jupiter"] },
  { text: "Who wrote the novel 1984?", keywords: ["orwell"] },
  { text: "How many days are in a leap year?", keywords: ["366"] },
  { text: "What is the chemical symbol for gold?", keywords: ["au"] },
  { text: "Which planet is known as the Red Planet?", keywords: ["mars"] },
  { text: "What is the currency of Japan?", keywords: ["yen"] },
  { text: "Who wrote Romeo and Juliet?", keywords: ["shakespeare"] },
  { text: "What does WWW stand for?", keywords: ["world wide web"] },
  { text: "Which is the largest ocean on Earth?", keywords: ["pacific"] },
  { text: "What is the tallest mountain above sea level?", keywords: ["everest"] },
  { text: "What language is primarily spoken in Brazil?", keywords: ["portuguese"] },
];

/**
 * @param {{ addresses: Array<{ label: string, address: string }> }} options
 * @returns {{ finance: object[], general: object[] }}
 */
export function buildQuestionBank({ addresses = [] } = {}) {
  const finance = [];
  for (let phrasing = 0; phrasing < PRICE_PHRASINGS.length; phrasing += 1) {
    for (const currency of ["USD", "INR", "EUR"]) {
      finance.push({
        id: `price-${currency.toLowerCase()}-p${phrasing}`,
        category: "finance_qa",
        kind: "price",
        symbol: "SUI",
        currency,
        text: PRICE_PHRASINGS[phrasing](currency),
      });
    }
    for (const entry of addresses) {
      finance.push({
        id: `balance-${entry.label}-p${phrasing}`,
        category: "finance_qa",
        kind: "balance",
        address: entry.address,
        text: BALANCE_PHRASINGS[phrasing](entry.address),
      });
    }
  }

  const general = GENERAL_QUESTIONS.map((question, index) => ({
    id: `general-${index}`,
    category: "general_knowledge",
    kind: "static",
    keywords: question.keywords,
    text: question.text,
  }));

  return { finance, general };
}
