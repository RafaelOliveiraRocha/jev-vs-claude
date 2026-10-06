import { Buffer } from 'node:buffer';

export const FACETS = ['need', 'difficulty', 'resolution', 'positive_evaluation', 'negative_evaluation', 'transfer_reason'];
export const FIELD_KEYS = FACETS.flatMap((facet) => [facet, `${facet}_evidence`]);
export const DEFAULT_MODELS = { jev: 'jev-1.13.0', claude: 'claude-haiku-4-5-20251001' };
export const LIMITS = Object.freeze({ concurrencyPerProvider: 2, timeoutMs: 45_000, maxOutputTokens: 384, maxCallsPerProvider: 54, claudeBudgetUsd: 0.50 });
export const DEFAULT_RATES = Object.freeze({ claude: { inputPerMillionUsd: 1, outputPerMillionUsd: 5, verified: false, source: 'Provisional published rates; verify before live execution.' }, jev: { inputPerMillionUsd: null, outputPerMillionUsd: null, verified: false, source: 'Supply verified published rates before reporting a cost.' } });

export function listCases(dataset) {
  const cases = Array.isArray(dataset) ? dataset : dataset.cases;
  if (!Array.isArray(cases) || !cases.length) throw new Error('Dataset must contain cases.');
  const ids = new Set();
  for (const entry of cases) {
    if (!entry.id || ids.has(entry.id)) throw new Error('Case IDs must be unique.');
    ids.add(entry.id);
    if (!Array.isArray(entry.messages) || !entry.messages.length) throw new Error(`Case ${entry.id} needs messages.`);
    const messageIds = new Set();
    for (const message of entry.messages) {
      if (!message.id || messageIds.has(message.id) || typeof message.text !== 'string') throw new Error(`Case ${entry.id} has invalid messages.`);
      if (!['customer', 'agent'].includes(message.author)) throw new Error(`Case ${entry.id} has unsupported author.`);
      messageIds.add(message.id);
    }
  }
  return cases;
}

export function compileQuestions(questionDocument, entry) {
  const list = questionDocument.questions;
  if (!Array.isArray(list) || list.length !== FIELD_KEYS.length) throw new Error('Exactly twelve shared questions are required.');
  const output = {};
  for (const q of list) {
    const key = q.key ?? q.id;
    if (!FIELD_KEYS.includes(key) || output[key]) throw new Error('Question keys must match the twelve shared fields.');
    let criteria;
    if (q.type === 'evidence' || key.endsWith('_evidence')) {
      const customerOnly = ['resolution_evidence', 'positive_evaluation_evidence', 'negative_evaluation_evidence'].includes(key);
      const allowedAuthors = customerOnly ? ['customer'] : (q.candidate_authors ?? ['customer', 'agent']);
      criteria = Object.fromEntries(entry.messages.flatMap((m, index) => allowedAuthors.includes(m.author) ? [[m.id, `state.messages[${index}] (author=${m.author}${m.actor_type ? `, actor_type=${m.actor_type}` : ''})`]] : []));
      criteria.insufficient = 'No single permitted message supports this classification; evidence is insufficient.';
    } else {
      if (!q.criteria || typeof q.criteria !== 'object' || Array.isArray(q.criteria) || !Object.keys(q.criteria).length) throw new Error(`Question ${key} needs a descriptive criteria dictionary.`);
      criteria = { ...q.criteria };
      if (Object.keys(criteria).some((id) => !id) || Object.values(criteria).some((label) => typeof label !== 'string' || !label.trim())) throw new Error(`Question ${key} has invalid choices.`);
    }
    const instructions = [q.instructions, typeof q.criteria === 'string' ? q.criteria : null].filter(Boolean).join('\n');
    if (!instructions) throw new Error(`Question ${key} needs instructions.`);
    output[key] = { type: 'choice', instructions, criteria };
  }
  if (FIELD_KEYS.some((key) => !output[key])) throw new Error('A shared field is missing.');
  return output;
}

export function sharedState(entry) {
  // Only dialogue fields enter either provider request. Never spread dataset or gold objects.
  return { messages: entry.messages.map(({ id, author, actor_type, name, time, text }) => ({ id, author, ...(actor_type ? { actor_type } : {}), ...(name ? { name } : {}), ...(time ? { time } : {}), text })) };
}

export function buildRequests(entry, questionDocument, models = DEFAULT_MODELS) {
  const state = sharedState(entry);
  const questions = compileQuestions(questionDocument, entry);
  const properties = Object.fromEntries(Object.entries(questions).map(([key, q]) => [key, { type: 'string', enum: Object.keys(q.criteria) }]));
  const schema = { type: 'object', properties, required: FIELD_KEYS, additionalProperties: false };
  return {
    questions,
    schema,
    jev: { model: models.jev, state, questions },
    claude: {
      model: models.claude,
      max_tokens: LIMITS.maxOutputTokens,
      system: 'Analyze every message in the supplied dialogue. Answer every question independently from its instructions and criteria. For each question choose exactly one criterion ID. Submit the twelve selected IDs with classify_dialogue. Follow evidence author restrictions. Do not add explanations or probabilities.',
      messages: [{ role: 'user', content: JSON.stringify({ state, questions }) }],
      tools: [{ name: 'classify_dialogue', description: 'Return the twelve selected criterion IDs.', input_schema: schema }],
      tool_choice: { type: 'tool', name: 'classify_dialogue' },
    },
  };
}

export function conservativeClaudeBound(request, rates = DEFAULT_RATES.claude) {
  // Every UTF-8 byte counts as one possible input token, plus protocol overhead.
  // This intentionally overstates likely usage and reserves all allowed output tokens.
  const inputTokenBound = Buffer.byteLength(JSON.stringify(request), 'utf8') + 512;
  const outputTokenBound = request.max_tokens;
  const estimatedCostUsd = (inputTokenBound * rates.inputPerMillionUsd + outputTokenBound * rates.outputPerMillionUsd) / 1_000_000;
  return { inputTokenBound, outputTokenBound, estimatedCostUsd };
}

export function extractChoices(provider, response) {
  if (provider === 'jev') {
    if (!response?.answers || typeof response.answers !== 'object' || Array.isArray(response.answers)) throw new Error('Jev response has no answers object.');
    return Object.fromEntries(Object.entries(response.answers).map(([key, answer]) => [key, answer?.choice]));
  }
  const toolUses = response?.content?.filter((content) => content.type === 'tool_use' && content.name === 'classify_dialogue') ?? [];
  if (toolUses.length === 1) return toolUses[0].input;
  // Strict JSON text is accepted for a future configured model that uses native JSON.
  const text = response?.content?.filter((content) => content.type === 'text').map((content) => content.text).join('') ?? '';
  if (!text) throw new Error('Claude response has no structured classification.');
  return JSON.parse(text);
}

export function validateChoices(choices, questions, entry) {
  const errors = [];
  if (!choices || typeof choices !== 'object' || Array.isArray(choices)) return { valid: false, errors: ['Classification must be an object.'] };
  const actualKeys = Object.keys(choices);
  for (const key of FIELD_KEYS) {
    if (!Object.hasOwn(choices, key)) errors.push(`Missing field: ${key}.`);
    else if (typeof choices[key] !== 'string' || !Object.hasOwn(questions[key].criteria, choices[key])) errors.push(`Invalid criterion ID for ${key}.`);
  }
  for (const key of actualKeys) if (!FIELD_KEYS.includes(key)) errors.push(`Unexpected field: ${key}.`);
  for (const key of ['resolution_evidence', 'positive_evaluation_evidence', 'negative_evaluation_evidence']) {
    const id = choices[key];
    if (id && id !== 'insufficient' && entry.messages.find((m) => m.id === id)?.author !== 'customer') errors.push(`${key} must reference a customer message.`);
  }
  return { valid: errors.length === 0, errors };
}

export function deriveSatisfaction(positive, negative) {
  if (positive === 'present' && negative === 'present') return 'mixed';
  if (positive === 'present' && negative === 'absent') return 'satisfied';
  if (positive === 'absent' && negative === 'present') return 'dissatisfied';
  return 'insufficient';
}

export const derivesatisfaction = deriveSatisfaction;

export function scoreChoices(choices, goldEntry) {
  if (!goldEntry?.expected || !choices) return null;
  const fields = {};
  for (const key of FIELD_KEYS) {
    const acceptable = goldEntry.expected[key]?.acceptable;
    fields[key] = Array.isArray(acceptable) ? acceptable.includes(choices[key]) : null;
  }
  const count = (keys) => ({ correct: keys.filter((key) => fields[key] === true).length, total: keys.filter((key) => fields[key] !== null).length });
  return { categories: count(FACETS), evidence: count(FACETS.map((facet) => `${facet}_evidence`)), fields, interpretation: 'Agreement with this illustrative, locally reviewed answer key; independent from structural validation.' };
}

export function normalizeUsage(response) {
  const usage = response?.usage;
  const read = (key) => Number.isFinite(usage?.[key]) && usage[key] >= 0 ? usage[key] : null;
  return { inputTokens: read('input_tokens'), outputTokens: read('output_tokens'), cacheCreationInputTokens: read('cache_creation_input_tokens'), cacheReadInputTokens: read('cache_read_input_tokens') };
}

export function estimateUsageCost(usage, rate) {
  if (!rate || usage.inputTokens === null || usage.outputTokens === null || !Number.isFinite(rate.inputPerMillionUsd) || !Number.isFinite(rate.outputPerMillionUsd)) return null;
  return (usage.inputTokens * rate.inputPerMillionUsd + usage.outputTokens * rate.outputPerMillionUsd) / 1_000_000;
}

export async function runPool(items, concurrency, work) {
  let next = 0;
  const results = new Array(items.length);
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await work(items[index], index);
    }
  });
  const settled = await Promise.allSettled(workers);
  const failed = settled.find((item) => item.status === 'rejected');
  if (failed) throw failed.reason;
  return results;
}

export async function requestOnce({ url, body, headers, timeoutMs = LIMITS.timeoutMs, fetchImpl = globalThis.fetch }) {
  const started = performance.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal });
    const rawText = await response.text();
    const elapsedMs = performance.now() - started;
    let raw;
    try { raw = JSON.parse(rawText); } catch { return { status: 'malformed_response', httpStatus: response.status, elapsedMs, rawText, error: 'Provider returned a non-JSON response.' }; }
    if (!response.ok) return { status: 'http_error', httpStatus: response.status, elapsedMs, raw, rawText, error: `Provider HTTP ${response.status}.` };
    return { status: 'received', httpStatus: response.status, elapsedMs, raw, rawText };
  } catch (error) {
    return { status: controller.signal.aborted ? 'timeout' : 'network_error', httpStatus: null, elapsedMs: performance.now() - started, raw: null, error: controller.signal.aborted ? 'Request exceeded its timeout.' : 'Provider request failed.' };
  } finally { clearTimeout(timeout); }
}
