import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {buildRequests,DEFAULT_MODELS,LIMITS,runPool} from './benchmark-lib.mjs';
const dataset=JSON.parse(await fs.readFile(new URL('./dataset.json',import.meta.url),'utf8'));
const questions=JSON.parse(await fs.readFile(new URL('./questions.json',import.meta.url),'utf8'));
const cases=await runPool(dataset.cases,2,async c=>{
  const request=buildRequests(c,questions,DEFAULT_MODELS).claude;
  const {max_tokens,tool_choice,...body}=request;
  const response=await fetch('https://api.anthropic.com/v1/messages/count_tokens',{method:'POST',headers:{'content-type':'application/json','x-api-key':process.env.ANTHROPIC_API_KEY,'anthropic-version':'2023-06-01','anthropic-workspace-id':process.env.ANTHROPIC_WORKSPACE_ID},body:JSON.stringify(body),signal:AbortSignal.timeout(30000)});
  if(!response.ok)throw Error(`Free token counting failed: HTTP ${response.status}; no paid calls started.`);
  const data=await response.json();
  if(!Number.isFinite(data.input_tokens))throw Error('Invalid token-count response.');
  return {id:c.id,split:c.split,inputTokens:data.input_tokens,requestSha256:createHash('sha256').update(JSON.stringify(request)).digest('hex')};
});
const report={createdAt:new Date().toISOString(),method:'Anthropic free count_tokens endpoint, complete state/questions/tools; no model generation',inputMarginPerCall:256,outputTokensPerCall:LIMITS.maxOutputTokens,estimatedReserveUsd:cases.reduce((s,c)=>s+(c.inputTokens+256+LIMITS.maxOutputTokens*5)/1e6,0),calls:cases.length,cases};
await fs.writeFile(new URL('./token-budget.json',import.meta.url),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({freeTokenCountCalls:cases.length,inputTokens:cases.reduce((s,c)=>s+c.inputTokens,0),estimatedReserveUsd:report.estimatedReserveUsd,paidCalls:0}));
