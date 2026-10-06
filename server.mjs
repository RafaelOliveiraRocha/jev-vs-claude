import http from 'node:http';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { FACETS, FIELD_KEYS, DEFAULT_MODELS, LIMITS, DEFAULT_RATES, listCases, buildRequests, conservativeClaudeBound, extractChoices, validateChoices, scoreChoices, normalizeUsage, estimateUsageCost, runPool, requestOnce } from './benchmark-lib.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const ARTIFACTS = path.join(ROOT, 'run-artifacts');
const PORT = Number(process.env.PORT ?? 43193);
const models = { jev: process.env.JEV_MODEL ?? DEFAULT_MODELS.jev, claude: process.env.CLAUDE_MODEL ?? DEFAULT_MODELS.claude };
const rates = structuredClone(DEFAULT_RATES);
for (const [provider, prefix] of [['jev', 'JEV'], ['claude', 'CLAUDE']]) {
  for (const [field, suffix] of [['inputPerMillionUsd', 'INPUT_RATE'], ['outputPerMillionUsd', 'OUTPUT_RATE']]) {
    const value = process.env[`${prefix}_${suffix}`];
    if (value !== undefined && Number.isFinite(Number(value)) && Number(value) >= 0) rates[provider][field] = Number(value);
  }
  rates[provider].verified = process.env[`${prefix}_RATES_VERIFIED`] === '1';
  if (rates[provider].verified) rates[provider].source = process.env[`${prefix}_RATE_SOURCE`] ?? 'Published provider rates verified by the operator.';
}
const keys = { jev: process.env.TYPESAFE_API_KEY ?? '', claude: process.env.ANTHROPIC_API_KEY ?? '' };
const anthropicWorkspaceId = process.env.ANTHROPIC_WORKSPACE_ID ?? '';
const subscribers = new Set();
const processStarted = performance.now();
const history = [];
const state = { status: 'idle', activeRunId: null, phase: null, progress: { completed: 0, total: 0, byProvider: { jev: 0, claude: 0 } }, providerMetrics: {}, lastError: null };
let documents;
let ledgers = [];
let results = [];
let eventId = 0;
let dispatchInProgress = false;

const redact = (value) => {
  let serialized = typeof value === 'string' ? value : JSON.stringify(value);
  for (const secret of Object.values(keys)) if (secret) serialized = serialized.split(secret).join('[REDACTED]');
  return typeof value === 'string' ? serialized : JSON.parse(serialized);
};
const snapshot = () => ({ ...structuredClone(state), limits: LIMITS, consumed: consumed(), history: history.slice(-200) });
const consumed = () => ({ calls: Object.fromEntries(['jev', 'claude'].map((provider) => [provider, ledgers.reduce((sum, item) => sum + (item.reservedCalls?.[provider] ?? 0), 0)])), claudeReservedUsd: ledgers.reduce((sum, item) => sum + (item.claudeBoundUsd ?? 0), 0), batchDispatched: ledgers.some((item) => item.phase === 'benchmark') });
function emit(type, data) {
  const event = { id: ++eventId, type, timestamp: new Date().toISOString(), monotonicMs: performance.now() - processStarted, ...data };
  history.push(event);
  const message = `id: ${event.id}\nevent: ${type}\ndata: ${JSON.stringify(redact(event))}\n\n`;
  for (const response of subscribers) response.write(message);
}
function respond(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  response.end(JSON.stringify(redact(body)));
}
async function readJson(filename) { return JSON.parse(await readFile(path.join(ROOT, filename), 'utf8')); }
async function loadDocuments() {
  const [datasetText, questionsText, gold] = await Promise.all([readFile(path.join(ROOT, 'dataset.json'), 'utf8'), readFile(path.join(ROOT, 'questions.json'), 'utf8'), readJson('ground-truth.json')]);
  const dataset = JSON.parse(datasetText), questions = JSON.parse(questionsText);
  const datasetSha256 = createHash('sha256').update(datasetText).digest('hex');
  const questionsSha256 = createHash('sha256').update(questionsText).digest('hex');
  if (gold.dataset_sha256 && gold.dataset_sha256 !== datasetSha256) throw new Error('Frozen dataset digest does not match the prepared answer key.');
  const cases = listCases(dataset);
  for (const entry of cases) buildRequests(entry, questions, models);
  if (cases.filter((entry) => entry.split === 'benchmark').length !== 50 || cases.filter((entry) => entry.split === 'preflight').length !== 2) throw new Error('Dataset must have fifty benchmark and two separate preflight cases.');
  documents = { dataset, questions, gold, cases, datasetSha256, questionsSha256 };
  return documents;
}
async function restoreArtifacts() {
  await mkdir(ARTIFACTS, { recursive: true, mode: 0o700 });
  for (const name of await readdir(ARTIFACTS)) {
    if (name.endsWith('.ledger.json')) {
      try { ledgers.push(JSON.parse(await readFile(path.join(ARTIFACTS, name), 'utf8'))); } catch { throw new Error('A persisted run ledger is unreadable; refusing paid work.'); }
    }
    if (name.endsWith('.result.json')) {
      try { results.push(JSON.parse(await readFile(path.join(ARTIFACTS, name), 'utf8'))); } catch { /* An incomplete result cannot free reserved calls. */ }
    }
  }
  results.sort((a, b) => a.completedAt.localeCompare(b.completedAt));
}
async function inputBody(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) { size += chunk.length; if (size > 64_000) throw new Error('Request is too large.'); chunks.push(chunk); }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}
function liveProblems() {
  const problems = [];
  if (!keys.jev || !keys.claude) problems.push('Both provider keys must be present in the server process environment.');
  if (process.env.BENCHMARK_ENABLE_LIVE !== '1') problems.push('Live execution has not been enabled by the operator.');
  if (process.env.CLAUDE_MODEL_VERIFIED !== '1' || !rates.claude.verified) problems.push('Claude model and published rates must be verified before live execution.');
  return problems;
}
async function startRun(phase, body) {
  if (state.status === 'running') return { status: 409, error: 'A run is already active.', code: 'ACTIVE_RUN' };
  const problems = liveProblems();
  if (problems.length) return { status: 400, error: problems.join(' '), code: 'PREFLIGHT_GUARD' };
  if (phase === 'benchmark' && body.recordingStarted !== true) return { status: 400, error: 'Start recording before dispatching the measured batch.', code: 'RECORDING_REQUIRED' };
  if (phase === 'benchmark' && consumed().batchDispatched) return { status: 409, error: 'The measured batch has already been dispatched. Its ledger prevents accidental repetition.', code: 'ALREADY_DISPATCHED' };
  const successfulPreflight = ledgers.findLast((ledger) => ledger.phase === 'preflight' && ledger.status === 'completed' && ledger.validResults === 4);
  if (phase === 'benchmark' && !successfulPreflight) return { status: 400, error: 'A successful two-case preflight is required before the benchmark.', code: 'PREFLIGHT_REQUIRED' };
  const doc = await loadDocuments();
  if (phase === 'benchmark' && (successfulPreflight.datasetSha256 !== doc.datasetSha256 || successfulPreflight.questionsSha256 !== doc.questionsSha256)) return { status: 400, error: 'The frozen inputs changed after preflight; repeat preflight within the hard budgets.', code: 'INPUTS_CHANGED' };
  const expectedCount = phase === 'preflight' ? 2 : 50;
  const selected = doc.cases.filter((entry) => entry.split === phase);
  if (body.caseIds !== undefined && (!Array.isArray(body.caseIds) || body.caseIds.length !== expectedCount || new Set(body.caseIds).size !== expectedCount || selected.some((entry) => !body.caseIds.includes(entry.id)))) return { status: 400, error: `Use all ${expectedCount} cases assigned to ${phase}.`, code: 'INVALID_CASES' };
  const requests = new Map(selected.map((entry) => [entry.id, buildRequests(entry, doc.questions, models)]));
  const used = consumed();
  if (['jev', 'claude'].some((provider) => used.calls[provider] + selected.length > LIMITS.maxCallsPerProvider)) return { status: 400, error: 'The hard call limit would be exceeded.', code: 'CALL_BUDGET' };
  const tokenBudget = await readJson('token-budget.json');
  const reserves = selected.map(entry => {
    const request = requests.get(entry.id).claude;
    const fingerprint = createHash('sha256').update(JSON.stringify(request)).digest('hex');
    const counted = tokenBudget.cases.find(c => c.id === entry.id);
    if (!counted || counted.requestSha256 !== fingerprint || !Number.isFinite(counted.inputTokens)) throw Error('Token count missing or inputs changed.');
    return ((counted.inputTokens + 256) * rates.claude.inputPerMillionUsd + request.max_tokens * rates.claude.outputPerMillionUsd) / 1_000_000;
  });
  const claudeBoundUsd = reserves.reduce((a,b)=>a+b,0);
  if (used.claudeReservedUsd + claudeBoundUsd > LIMITS.claudeBudgetUsd) return { status: 400, error: 'The token-count Claude cost reserve would exceed $0.50.', code: 'COST_BUDGET' };
  const runId = `${phase}-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
  const ledger = { runId, phase, status: 'running', createdAt: new Date().toISOString(), models, datasetSha256: doc.datasetSha256, questionsSha256: doc.questionsSha256, caseIds: selected.map((entry) => entry.id), reservedCalls: { jev: selected.length, claude: selected.length }, claudeBoundUsd, costBoundMethod: 'Free Anthropic token-count estimate + 256 input-token margin per call, plus 384 maximum output tokens; requests hashed and full batch reserved before execution. Estimate is not a mathematically guaranteed billing bound.', rates, validResults: 0 };
  // Exclusive creation happens before any provider call. Reserved calls survive process crashes.
  if (phase === 'benchmark') {
    try { await writeFile(path.join(ARTIFACTS, 'benchmark-dispatch.lock'), JSON.stringify({ runId, createdAt: ledger.createdAt }), { flag: 'wx', mode: 0o600 }); }
    catch (error) { if (error.code === 'EEXIST') return { status: 409, error: 'The measured batch dispatch is already locked.', code: 'ALREADY_DISPATCHED' }; throw error; }
  }
  await writeFile(path.join(ARTIFACTS, `${runId}.ledger.json`), JSON.stringify(ledger, null, 2), { flag: 'wx', mode: 0o600 });
  ledgers.push(ledger);
  Object.assign(state, { status: 'running', activeRunId: runId, phase, startedAt: ledger.createdAt, lastError: null, providerMetrics: {}, progress: { completed: 0, total: selected.length * 2, byProvider: { jev: 0, claude: 0 } } });
  emit('state', { state: snapshot(), runId, phase });
  executeRun(ledger, selected, requests, doc.gold).catch(async () => {
    ledger.status = 'failed'; ledger.completedAt = new Date().toISOString();
    state.status = 'failed'; state.lastError = 'The local run could not complete. Calls remain reserved.';
    await writeFile(path.join(ARTIFACTS, `${runId}.ledger.json`), JSON.stringify(redact(ledger), null, 2), { mode: 0o600 }).catch(() => {});
    emit('completed', { runId, phase, state: snapshot() });
  });
  return { status: 202, body: { runId, state: snapshot() } };
}
async function guardedStartRun(phase, body) {
  if (dispatchInProgress) return { status: 409, error: 'A run dispatch is already being reserved.', code: 'ACTIVE_DISPATCH' };
  dispatchInProgress = true;
  try { return await startRun(phase, body); }
  finally { dispatchInProgress = false; }
}
async function executeRun(ledger, selected, requests, gold) {
  const batchStarted = performance.now();
  ledger.providers = {};
  const providerOutcomes = await Promise.allSettled(['jev', 'claude'].map(async (provider) => {
    let lastResponseElapsedMs = 0;
    await runPool(selected, LIMITS.concurrencyPerProvider, async (entry) => {
    const request = requests.get(entry.id)[provider];
    const artifactBase = path.join(ARTIFACTS, `${ledger.runId}.${provider}.${entry.id}`);
    const startedAt = new Date().toISOString();
    await writeFile(`${artifactBase}.input.json`, JSON.stringify(request, null, 2), { flag: 'wx', mode: 0o600 });
    emit('request', { runId: ledger.runId, phase: ledger.phase, provider, caseId: entry.id, startedAt });
    const fetched = await requestOnce({ url: provider === 'jev' ? 'https://api.typesafe.ai/v1/systemone' : 'https://api.anthropic.com/v1/messages', body: request, headers: provider === 'jev' ? { 'Content-Type': 'application/json', Authorization: `Bearer ${keys.jev}` } : { 'Content-Type': 'application/json', 'x-api-key': keys.claude, 'anthropic-version': '2023-06-01', ...(anthropicWorkspaceId ? { 'anthropic-workspace-id': anthropicWorkspaceId } : {}) } });
    lastResponseElapsedMs = performance.now() - batchStarted;
    await writeFile(`${artifactBase}.raw.json`, JSON.stringify(redact({ startedAt, completedAt: new Date().toISOString(), httpStatus: fetched.httpStatus, elapsedMs: fetched.elapsedMs, response: fetched.raw ?? null, rawText: fetched.rawText ?? null, transportStatus: fetched.status }), null, 2), { flag: 'wx', mode: 0o600 });
    let normalized = null;
    let validation = { valid: false, errors: [] };
    let status = fetched.status;
    let error = fetched.error ?? null;
    if (fetched.status === 'received') {
      try {
        normalized = extractChoices(provider, fetched.raw);
        validation = validateChoices(normalized, requests.get(entry.id).questions, entry);
        status = validation.valid ? 'success' : 'invalid_response';
        if (!validation.valid) error = 'Provider returned invalid classification fields.';
      } catch { status = 'malformed_response'; error = 'Provider response did not contain the required structured fields.'; }
    }
    const usage = normalizeUsage(fetched.raw);
    const result = { runId: ledger.runId, phase: ledger.phase, caseId: entry.id, provider, requestedModel: models[provider], returnedModel: fetched.raw?.model ?? null, status, elapsedMs: fetched.elapsedMs, startedAt, completedAt: new Date().toISOString(), httpStatus: fetched.httpStatus, usage, estimatedCostUsd: estimateUsageCost(usage, rates[provider]), rateVerified: rates[provider].verified, costLabel: 'Estimated from reported token usage and configured published rates; not an invoice.', normalized, validation, score: validation.valid ? scoreChoices(normalized, gold.cases?.find((candidate) => candidate.id === entry.id)) : null, error, artifactPrefix: path.basename(artifactBase) };
    await writeFile(`${artifactBase}.result.json`, JSON.stringify(redact(result), null, 2), { flag: 'wx', mode: 0o600 });
    results.push(result);
    if (validation.valid) ledger.validResults++;
    state.progress.completed++;
    state.progress.byProvider[provider]++;
    emit('result', { result });
    emit('progress', { runId: ledger.runId, phase: ledger.phase, progress: structuredClone(state.progress) });
    });
    const providerResults = results.filter((result) => result.runId === ledger.runId && result.provider === provider);
    const times = providerResults.map((result) => result.elapsedMs).sort((a, b) => a - b);
    const medianRequestMs = times.length % 2 ? times[Math.floor(times.length / 2)] : (times[times.length / 2 - 1] + times[times.length / 2]) / 2;
    const metrics = { batchElapsedMs: lastResponseElapsedMs, startedAt: ledger.createdAt, completedAt: new Date().toISOString(), completed: providerResults.length, total: selected.length, medianRequestMs, estimatedCostUsd: providerResults.every((result) => result.estimatedCostUsd !== null) ? providerResults.reduce((sum, result) => sum + result.estimatedCostUsd, 0) : null, categoryCorrect: providerResults.reduce((sum, result) => sum + (result.score?.categories.correct ?? 0), 0), categoryTotal: providerResults.reduce((sum, result) => sum + (result.score?.categories.total ?? 0), 0), evidenceCorrect: providerResults.reduce((sum, result) => sum + (result.score?.evidence.correct ?? 0), 0), evidenceTotal: providerResults.reduce((sum, result) => sum + (result.score?.evidence.total ?? 0), 0), validationFailures: providerResults.filter((result) => !result.validation.valid).length, successful: providerResults.filter((result) => result.status === 'success').length, inputTokens: providerResults.every((result) => result.usage.inputTokens !== null) ? providerResults.reduce((sum, result) => sum + result.usage.inputTokens, 0) : null, outputTokens: providerResults.every((result) => result.usage.outputTokens !== null) ? providerResults.reduce((sum, result) => sum + result.usage.outputTokens, 0) : null, returnedModels: [...new Set(providerResults.map((result) => result.returnedModel).filter(Boolean))], timingDefinition: 'Common batch dispatch to last response body received; concurrency two, no retries or reused responses.' };
    ledger.providers[provider] = metrics;
    state.providerMetrics[provider] = metrics;
    emit('provider_completed', { runId: ledger.runId, phase: ledger.phase, provider, metrics });
  }));
  const failedProvider = providerOutcomes.find((item) => item.status === 'rejected');
  if (failedProvider) throw failedProvider.reason;
  ledger.status = 'completed';
  ledger.completedAt = new Date().toISOString();
  ledger.batchElapsedMs = performance.now() - batchStarted;
  await writeFile(path.join(ARTIFACTS, `${ledger.runId}.ledger.json`), JSON.stringify(redact(ledger), null, 2), { mode: 0o600 });
  Object.assign(state, { status: 'completed', activeRunId: null });
  emit('completed', { runId: ledger.runId, phase: ledger.phase, ledger, state: snapshot() });
}

await restoreArtifacts();
const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://127.0.0.1:${PORT}`);
    if (request.method === 'GET' && url.pathname === '/api/events') {
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      response.write(`event: state\ndata: ${JSON.stringify({ state: snapshot() })}\n\n`);
      subscribers.add(response);
      const heartbeat = setInterval(() => response.write(': heartbeat\n\n'), 15_000);
      request.on('close', () => { clearInterval(heartbeat); subscribers.delete(response); });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/state') return respond(response, 200, snapshot());
    if (request.method === 'GET' && url.pathname === '/api/results') return respond(response, 200, { runs: ledgers, results });
    if (request.method === 'GET' && url.pathname === '/api/config') {
      const doc = await loadDocuments();
      return respond(response, 200, { cases: doc.cases, questions: doc.questions.questions, datasetVersion: doc.dataset.version, models, limits: LIMITS, rates, keyPresence: { jev: Boolean(keys.jev), claude: Boolean(keys.claude) }, liveEnabled: process.env.BENCHMARK_ENABLE_LIVE === '1', liveProblems: liveProblems(), schemas: { fieldKeys: FIELD_KEYS, facets: FACETS, output: buildRequests(doc.cases[0], doc.questions, models).schema }, consumed: consumed() });
    }
    if (request.method === 'POST' && ['/api/preflight', '/api/run'].includes(url.pathname)) {
      if (!request.headers['content-type']?.startsWith('application/json')) return respond(response, 415, { error: 'Use application/json.', code: 'CONTENT_TYPE' });
      if (request.headers.origin && ![`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`].includes(request.headers.origin)) return respond(response, 403, { error: 'This action requires the local application origin.', code: 'ORIGIN' });
      const outcome = await guardedStartRun(url.pathname === '/api/preflight' ? 'preflight' : 'benchmark', await inputBody(request));
      return respond(response, outcome.status, outcome.body ?? { error: outcome.error, code: outcome.code });
    }
    if (request.method === 'GET' && ['/', '/index.html'].includes(url.pathname)) {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      return response.end(await readFile(path.join(ROOT, 'index.html')));
    }
    return respond(response, 404, { error: 'Not found.', code: 'NOT_FOUND' });
  } catch (error) {
    const expectedInputError = error instanceof SyntaxError;
    return respond(response, expectedInputError ? 400 : 500, { error: expectedInputError ? 'Invalid JSON input.' : 'Local configuration or persistence failed. Check the operator log.', code: expectedInputError ? 'INVALID_JSON' : 'LOCAL_ERROR' });
  }
});
server.listen(PORT, '127.0.0.1', () => console.log(`Comparison server ready at http://127.0.0.1:${PORT} (live execution ${process.env.BENCHMARK_ENABLE_LIVE === '1' ? 'enabled' : 'disabled'}).`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { for (const subscriber of subscribers) subscriber.end(); server.close(() => process.exit(0)); });
