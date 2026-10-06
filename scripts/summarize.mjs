import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const root = new URL('../', import.meta.url);
const read = (name) => readFile(new URL(name, root), 'utf8');
const json = async (name) => JSON.parse(await read(name));
const digest = async (name) => createHash('sha256').update(await read(name)).digest('hex');
const [data, gold, history] = await Promise.all([
  json('dataset.json'), json('ground-truth.json'), json('results.json'),
]);
const datasetHash = await digest('dataset.json');
const questionHash = await digest('questions.json');
assert.equal(datasetHash, gold.dataset_sha256, 'Hash do conjunto difere do gabarito.');
assert.equal(questionHash, gold.questions_sha256, 'Hash dos critérios difere do gabarito.');
assert.equal(data.cases.filter((c) => c.split === 'benchmark').length, 50);
assert.equal(data.cases.filter((c) => c.split === 'preflight').length, 2);
assert.equal(history.results.length, 104);
const run = history.runs.find((r) => r.phase === 'benchmark');
assert.ok(run, 'Registro do benchmark ausente.');
assert.equal(run.datasetSha256, datasetHash);
assert.equal(run.questionsSha256, questionHash);
const summary = [];
for (const provider of ['jev', 'claude']) {
  const results = history.results.filter((r) => r.runId === run.runId && r.provider === provider);
  assert.equal(results.length, 50);
  assert.equal(new Set(results.map((r) => r.caseId)).size, 50);
  const sum = (f) => results.reduce((total, r) => total + f(r), 0);
  const cost = sum((r) => r.estimatedCostUsd);
  const categories = sum((r) => r.score.categories.correct);
  const evidence = sum((r) => r.score.evidence.correct);
  const recorded = run.providers[provider];
  assert.ok(Math.abs(cost - recorded.estimatedCostUsd) < 1e-10);
  assert.equal(categories, recorded.categoryCorrect);
  assert.equal(evidence, recorded.evidenceCorrect);
  summary.push({
    provedor: provider,
    conversas: results.length,
    categorias: `${categories}/${sum((r) => r.score.categories.total)}`,
    evidencias: `${evidence}/${sum((r) => r.score.evidence.total)}`,
    custo_estimado_usd: Number(cost.toFixed(9)),
    tempo_lote_s: Number((recorded.batchElapsedMs / 1000).toFixed(4)),
  });
}
console.table(summary);
console.log('Hashes e totais conferidos. Foram lidos apenas arquivos locais.');
