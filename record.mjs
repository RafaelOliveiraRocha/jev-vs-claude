#!/usr/bin/env node
/**
 * Continuous, genuine Chrome CDP recording. Node 22+; no npm packages.
 *
 * READ ONLY:
 *   node record.mjs screenshot --output layout-check
 * EXPLICIT API PREFLIGHT (the UI makes its own POST):
 *   node record.mjs preflight --output preflight-check
 * RECORD, THEN AUTHORIZE ONLY AFTER RECORDING_READY:
 *   node record.mjs record --output recording --max-seconds 240
 *   node record.mjs command --output recording --action start-batch
 *   node record.mjs command --output recording --action stop
 * PACK, AFTER RECORDING_STOPPED:
 *   node record.mjs pack --output recording --archive recording.tar.gz
 *
 * `record` never starts a batch by itself. A distinct command checks ready.json
 * and a live recorder PID before it queues the real UI click. All browser
 * non-GET requests are blocked unless the exact preflight/run POST was just
 * authorized. No credentials are read and Node never calls the app's APIs.
 *
 * Frames are lossless Page.startScreencast PNGs, sampled at <=10 fps with their actual
 * CDP timestamps. frames.ffconcat preserves variable inter-frame elapsed time.
 * Render locally with the factual, explicit 1.5x caption treatment:
 *   python render-recording.py --recording recording --results results.json
 * The capture itself retains original timestamps and actual elapsed time.
 * Lossless PNGs allow compact, pixel-exact XOR transfer via compress-capture.py.
 * Do not assign each input image a fixed duration: that would alter real time.
 */
import fs from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createGzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

const args = process.argv.slice(2);
const mode = args[0] && !args[0].startsWith('--') ? args.shift() : 'screenshot';
const opts = {};
while (args.length) {
  const key = args.shift();
  if (!key.startsWith('--')) throw Error(`Unexpected argument: ${key}`);
  opts[key.slice(2)] = args[0] && !args[0].startsWith('--') ? args.shift() : true;
}
const output = path.resolve(String(opts.output || (mode === 'record' || mode === 'command' || mode === 'pack' ? 'recording' : `${mode}-check`)));
const appUrl = String(opts.url || 'http://127.0.0.1:43193');
const origin = new URL(appUrl);
if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1' || origin.port !== '43193') throw Error('Only http://127.0.0.1:43193 is permitted.');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const jsonFile = (file, value) => fs.writeFile(file, JSON.stringify(value, null, 2) + '\n');
const say = (kind, value) => process.stdout.write(`${kind} ${JSON.stringify(value)}\n`);
const number = (value, fallback, min, max) => {
  const n = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(n) || n < min || n > max) throw Error(`Expected a number between ${min} and ${max}; got ${value}`);
  return n;
};

class CDP {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.pending = new Map(); this.listeners = new Map(); this.nextId = 0;
    this.ws.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        clearTimeout(pending.timer); this.pending.delete(message.id);
        message.error ? pending.reject(Error(`${pending.method}: ${message.error.message}`)) : pending.resolve(message.result || {});
      } else {
        for (const listener of this.listeners.get(message.method) || []) {
          Promise.resolve(listener(message.params || {}, message.sessionId)).catch(error => say('CDP_EVENT_ERROR', { method: message.method, error: error.message }));
        }
      }
    });
    this.ws.addEventListener('close', () => {
      for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(Error('CDP disconnected')); }
      this.pending.clear();
    });
  }
  async connect() {
    if (this.ws.readyState === WebSocket.OPEN) return;
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true });
      this.ws.addEventListener('error', reject, { once: true });
    });
  }
  call(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => { this.pending.delete(id); reject(Error(`CDP timeout: ${method}`)); }, 15000);
      this.pending.set(id, { resolve, reject, timer, method });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  on(method, listener) {
    const listeners = this.listeners.get(method) || []; listeners.push(listener); this.listeners.set(method, listeners);
  }
  close() { this.ws.close(); }
}

const stateExpression = `(() => {
  const u = typeof ui === 'undefined' ? null : ui;
  const run = u?.runs?.filter(r => r.phase === 'benchmark').at(-1);
  const preflight = u?.runs?.filter(r => r.phase === 'preflight').at(-1);
  return {
    ready: !!(u?.config && u?.state && u?.connected),
    status: u?.state?.status ?? null, phase: u?.state?.phase ?? null,
    benchmarkStatus: run?.status ?? null, benchmarkRunId: run?.runId ?? null, preflightStatus: preflight?.status ?? null,
    preflightValidResults: preflight?.validResults ?? 0,
    runDisabled: document.querySelector('#run')?.disabled ?? true,
    recordingChecked: document.querySelector('#recording')?.checked ?? false,
    recordingDisabled: document.querySelector('#recording')?.disabled ?? false,
    batchDispatched: !!(u?.state?.consumed?.batchDispatched ?? u?.config?.consumed?.batchDispatched),
    globalStatus: document.querySelector('#global-status')?.textContent ?? '',
    message: document.querySelector('#message')?.textContent ?? '',
    selectedCase: document.querySelector('#case-select')?.value ?? null,
    benchmarkCaseCount: u?.config?.cases?.filter(c => c.split === 'benchmark' || !c.split).length ?? null,
    classificationQuestionsPerCase: u?.config?.schemas?.facets?.length ?? u?.config?.questions?.filter(q => q.type === 'classification').length ?? null,
    providers: [...document.querySelectorAll('[data-lane]')].map(n => ({
      provider: n.dataset.lane, model: n.querySelector('[data-model-name]')?.textContent,
      count: n.querySelector('[data-count]')?.textContent, total: n.querySelector('[data-total]')?.textContent,
      time: n.querySelector('[data-time]')?.textContent, median: n.querySelector('[data-median]')?.textContent,
      cost: n.querySelector('[data-cost]')?.textContent, agreement: n.querySelector('[data-agreement]')?.textContent
    })),
    viewport: {width: innerWidth, height: innerHeight, devicePixelRatio},
    page: {width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight},
    evidence: (() => {const r = document.querySelector('.evidence')?.getBoundingClientRect(); return r && {x:r.x,y:r.y,width:r.width,height:r.height,bottom:r.bottom};})()
  };
})()`;

async function launch() {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'jev-recording-chrome-'));
  const chromeArgs = [
    '--headless=new', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
    `--user-data-dir=${profile}`, '--window-size=1366,768', '--force-device-scale-factor=1',
    '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
    '--disable-component-update', '--disable-sync', '--disable-extensions', '--disable-default-apps',
    '--hide-scrollbars', '--autoplay-policy=no-user-gesture-required', 'about:blank'
  ];
  if (opts['no-sandbox']) chromeArgs.unshift('--no-sandbox');
  const chrome = spawn(String(opts.chrome || '/usr/bin/google-chrome'), chromeArgs, { stdio: ['ignore', 'ignore', 'pipe'] });
  let diagnostic = '', spawnError;
  chrome.on('error', error => { spawnError = error; });
  chrome.stderr.on('data', chunk => { diagnostic = (diagnostic + String(chunk)).slice(-4000); });
  let cdp;
  try {
    let active;
    for (let i = 0; i < 150; i++) {
      if (spawnError) throw spawnError;
      if (chrome.exitCode !== null) throw Error(`Chrome exited (${chrome.exitCode}): ${diagnostic}`);
      try { active = (await fs.readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).trim().split('\n'); break; } catch {}
      await sleep(100);
    }
    if (!active) throw Error(`Chrome did not start: ${diagnostic}`);
    cdp = new CDP(`ws://127.0.0.1:${active[0]}${active[1]}`); await cdp.connect();
    const { targetId } = await cdp.call('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.call('Target.attachToTarget', { targetId, flatten: true });
    const call = (method, params) => cdp.call(method, params, sessionId);
    await call('Page.enable'); await call('Runtime.enable');
    await call('Emulation.setDeviceMetricsOverride', { width: 1366, height: 768, deviceScaleFactor: 1, mobile: false, screenWidth: 1366, screenHeight: 768 });
    const allowedPosts = new Set(), requestAudit = [];
    cdp.on('Fetch.requestPaused', async (event, sid) => {
      if (sid !== sessionId) return;
      const request = event.request, url = new URL(request.url);
      const local = url.origin === origin.origin;
      const method = request.method;
      const allowed = (local && method === 'GET') || ((url.protocol === 'data:' || url.protocol === 'blob:') && method === 'GET') ||
        (local && method === 'POST' && allowedPosts.delete(url.pathname));
      if (method !== 'GET' || !allowed) requestAudit.push({ at: new Date().toISOString(), method, path: local ? url.pathname : url.origin, allowed });
      await call(allowed ? 'Fetch.continueRequest' : 'Fetch.failRequest', { requestId: event.requestId, ...(!allowed ? { errorReason: 'BlockedByClient' } : {}) });
    });
    await call('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
    if (mode === 'record' && !opts['no-click-marker']) {
      // This marker responds only to actual mouse events dispatched by CDP.
      await call('Page.addScriptToEvaluateOnNewDocument', { source: `document.addEventListener('DOMContentLoaded', () => {
        const cursor = document.createElement('div');
        cursor.id = 'cdp-recording-pointer';
        cursor.setAttribute('aria-hidden','true');
        cursor.style.cssText = 'display:none;position:fixed;z-index:2147483647;pointer-events:none;width:16px;height:16px;border:2px solid #fff;background:#a3a9ff88;border-radius:50%;transform:translate(-50%,-50%);box-shadow:0 1px 5px #0009';
        document.body.append(cursor);
        document.addEventListener('pointermove',e => {cursor.style.display='block';cursor.style.left=e.clientX+'px';cursor.style.top=e.clientY+'px';},true);
        document.addEventListener('pointerdown',() => cursor.animate([{boxShadow:'0 0 0 0 #fff9'},{boxShadow:'0 0 0 18px #fff0'}],{duration:450}),true);
      });` });
    }
    await call('Page.navigate', { url: appUrl });
    const evaluate = async expression => {
      const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (result.exceptionDetails) throw Error(`Page evaluation failed: ${result.exceptionDetails.text}`);
      return result.result.value;
    };
    const state = () => evaluate(stateExpression);
    const deadline = Date.now() + 20000;
    while (!(await state())?.ready) {
      if (Date.now() > deadline) throw Error('The UI did not finish its GET-only initial load within 20 seconds.');
      await sleep(150);
    }
    const actions = [];
    const click = async (selector, label) => {
      const box = await evaluate(`(() => {const n=document.querySelector(${JSON.stringify(selector)});if(!n)throw Error('Click target missing');if(n.disabled)throw Error('Click target disabled');const r=n.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,width:r.width,height:r.height};})()`);
      if (box.x < 0 || box.x >= 1366 || box.y < 0 || box.y >= 768 || !box.width || !box.height) throw Error(`Click target is outside the visible viewport: ${selector}`);
      await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y });
      await sleep(120);
      await call('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 });
      await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 });
      actions.push({ at: new Date().toISOString(), action: 'click', label, selector, x: box.x, y: box.y });
    };
    const screenshot = async filename => {
      const { data } = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      await fs.writeFile(path.join(output, filename), Buffer.from(data, 'base64'));
    };
    const close = async () => {
      try { await cdp.call('Browser.close'); } catch {}
      cdp.close();
      if (chrome.exitCode === null) chrome.kill('SIGTERM');
      const until = Date.now() + 3000;
      while (chrome.exitCode === null && Date.now() < until) await sleep(50);
      if (chrome.exitCode === null) chrome.kill('SIGKILL');
      await fs.rm(profile, { recursive: true, force: true });
    };
    return { cdp, sessionId, call, state, evaluate, click, screenshot, close, allowedPosts, actions, requestAudit };
  } catch (error) {
    cdp?.close(); chrome.kill('SIGTERM');
    await fs.rm(profile, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

async function readOnlyScreenshot() {
  await fs.mkdir(output, { recursive: true });
  const browser = await launch();
  try {
    await sleep(400);
    await browser.screenshot('screenshot.png');
    const state = await browser.state();
    const report = { mode: 'screenshot', at: new Date().toISOString(), getOnly: true, state, requestAudit: browser.requestAudit };
    await jsonFile(path.join(output, 'layout.json'), report);
    say('LAYOUT_CHECK_COMPLETE', { output, screenshot: path.join(output, 'screenshot.png'), ...report });
  } finally { await browser.close(); }
}

async function preflight() {
  await fs.mkdir(output, { recursive: true });
  const browser = await launch();
  try {
    if ((await browser.state()).batchDispatched) throw Error('The batch was already dispatched; preflight is locked.');
    browser.allowedPosts.add('/api/preflight');
    await browser.click('#preflight', 'Verificar APIs');
    const deadline = Date.now() + number(opts['max-seconds'], 180, 1, 900) * 1000;
    let state;
    do {
      await sleep(250); state = await browser.state();
      if (state.preflightStatus === 'completed' && state.status !== 'running') break;
      if (state.status !== 'running' && state.message && /erro|recus|falh|bloquead/i.test(state.message)) throw Error(state.message);
      if (Date.now() > deadline) throw Error('Preflight timed out.');
    } while (true);
    await browser.screenshot('preflight.png');
    const report = { mode: 'preflight', at: new Date().toISOString(), valid: state.preflightValidResults === 4, state, actions: browser.actions, requestAudit: browser.requestAudit };
    await jsonFile(path.join(output, 'preflight.json'), report);
    say('PREFLIGHT_COMPLETE', report);
    if (!report.valid) process.exitCode = 2;
  } finally { await browser.close(); }
}

async function record() {
  const maxSeconds = number(opts['max-seconds'], 240, 5, 900);
  const fps = number(opts.fps, 10, 1, 15);
  const quality = number(opts.quality, 75, 30, 100);
  const imageFormat = String(opts.format || 'png');
  if (!['png', 'jpeg'].includes(imageFormat)) throw Error('--format must be png or jpeg.');
  const extension = imageFormat === 'png' ? 'png' : 'jpg';
  const postSeconds = number(opts['post-seconds'], 32, 0, 60);
  await fs.mkdir(path.join(output, 'frames'), { recursive: true });
  if ((await fs.readdir(path.join(output, 'frames'))).length) throw Error('Output already contains frames. Choose a fresh --output directory.');
  await fs.mkdir(path.join(output, 'commands'), { recursive: true });
  await fs.rm(path.join(output, 'ready.json'), { force: true });
  await fs.writeFile(path.join(output, 'control.ndjson'), '');
  const browser = await launch();
  const frames = [], states = [];
  const recordingStartedAt = new Date().toISOString();
  let frameChain = Promise.resolve(), saving = true, lastTimestamp = -Infinity, bytes = 0, dropped = 0, recordingError;
  let batchRequested = false, batchStartAt = null, batchCompletedAt = null, stop = false, stopReason = 'requested';
  let handledCommands = 0, inspectionComplete = false, firstFrameResolve;
  const firstFrame = new Promise(resolve => { firstFrameResolve = resolve; });
  const onSignal = () => { stop = true; stopReason = 'signal'; };
  process.on('SIGINT', onSignal); process.on('SIGTERM', onSignal);
  browser.cdp.on('Page.screencastFrame', (event, sid) => {
    if (sid !== browser.sessionId) return;
    // Always acknowledge actual protocol frames, including samples dropped to cap fps.
    browser.call('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(error => { if (saving) recordingError = error; });
    if (!saving) return;
    const timestamp = event.metadata.timestamp;
    if (!Number.isFinite(timestamp)) { recordingError = Error('Chrome supplied a frame without a protocol timestamp.'); return; }
    if (timestamp - lastTimestamp < 1 / fps - 0.001) { dropped++; return; }
    lastTimestamp = timestamp;
    const receivedAt = new Date().toISOString();
    const file = `frames/${String(frames.length + 1).padStart(6, '0')}.${extension}`;
    const data = Buffer.from(event.data, 'base64');
    const frame = { index: frames.length + 1, file, protocolTimestamp: timestamp, receivedAt, bytes: data.length, metadata: event.metadata };
    frames.push(frame); bytes += data.length;
    frameChain = frameChain.then(async () => {
      await fs.writeFile(path.join(output, file), data);
      await fs.appendFile(path.join(output, 'frames.ndjson'), JSON.stringify(frame) + '\n');
      firstFrameResolve();
    }).catch(error => { recordingError = error; });
  });
  const event = (type, data) => {
    const item = { type, at: new Date().toISOString(), ...data }; states.push(item);
    return fs.appendFile(path.join(output, 'events.ndjson'), JSON.stringify(item) + '\n');
  };
  const inspect = async () => {
    // Genuine UI input, after the actual server completion. No progress is generated.
    await sleep(1700);
    const target = await browser.evaluate(`(() => {
      const all=[...document.querySelectorAll('[data-lane="jev"] [data-case]')];
      return all.find(n=>n.dataset.case!==document.querySelector('#case-select')?.value && n.classList.contains('done'))?.dataset.case;
    })()`);
    if (target) { await browser.click(`[data-lane="jev"] [data-case=${JSON.stringify(target)}]`, 'Selecionar outra conversa concluída'); await sleep(1400); }
    if (await browser.evaluate(`!!document.querySelector('[data-ref-provider]')`)) {
      await browser.click('[data-ref-provider]', 'Abrir referência da classificação'); await sleep(2500);
      await browser.click('#modal-close', 'Fechar referência'); await sleep(1600);
    }
    inspectionComplete = true;
  };
  try {
    await fs.writeFile(path.join(output, 'frames.ndjson'), '');
    await fs.writeFile(path.join(output, 'events.ndjson'), '');
    await browser.call('Page.startScreencast', { format: imageFormat, ...(imageFormat === 'jpeg' ? {quality} : {}), maxWidth: 1366, maxHeight: 768, everyNthFrame: 1 });
    await Promise.race([firstFrame, sleep(15000).then(() => { throw Error('No real screencast frame arrived within 15 seconds.'); })]);
    if (!(await browser.state()).recordingChecked && !(await browser.state()).recordingDisabled) {
      await browser.click('#recording', 'Gravação iniciada'); await sleep(250);
    }
    await frameChain;
    const ready = { schema: 1, pid: process.pid, output, recordingStartedAt, readyAt: new Date().toISOString(), framesSaved: frames.length, viewport: { width: 1366, height: 768 }, source: 'Page.startScreencast', fpsCap: fps, imageFormat, jpegQuality: imageFormat === 'jpeg' ? quality : null, state: await browser.state() };
    await jsonFile(path.join(output, 'ready.json'), ready);
    await event('recording_ready', { framesSaved: frames.length });
    say('RECORDING_READY', ready);
    const deadline = Date.now() + maxSeconds * 1000;
    let lastStatus;
    while (!stop) {
      if (recordingError) throw recordingError;
      const lines = (await fs.readFile(path.join(output, 'control.ndjson'), 'utf8')).split('\n').filter(Boolean);
      while (handledCommands < lines.length) {
        const command = JSON.parse(lines[handledCommands++]);
        let result;
        try {
          if (command.action === 'start-batch') {
            if (batchRequested) throw Error('This recorder has already requested its one batch.');
            const before = await browser.state();
            if (!before.recordingChecked || before.runDisabled || before.batchDispatched) throw Error(`The UI has not enabled Processar lote. ${before.message || before.globalStatus}`);
            await event('batch_authorized', { commandId: command.id, framesSaved: frames.length });
            batchRequested = true; batchStartAt = new Date().toISOString();
            browser.allowedPosts.add('/api/run');
            await browser.click('#run', 'Processar lote');
            await event('batch_click', { commandId: command.id });
            result = { accepted: true, action: command.action, at: new Date().toISOString(), recordingReadyAt: ready.readyAt, framesSavedBeforeBatch: frames.length, state: await browser.state() };
            say('BATCH_CLICKED', result);
          } else if (command.action === 'stop') {
            stop = true; stopReason = 'command'; result = { accepted: true, action: 'stop', at: new Date().toISOString() };
          } else if (command.action === 'inspect-results') {
            const s = await browser.state();
            if (s.benchmarkStatus !== 'completed') throw Error('Inspection is available only after the genuine batch completes.');
            await inspect(); result = { accepted: true, action: command.action, at: new Date().toISOString() };
          } else throw Error(`Unknown command: ${command.action}`);
        } catch (error) { result = { accepted: false, action: command.action, error: error.message, at: new Date().toISOString() }; }
        await jsonFile(path.join(output, 'commands', `${command.id}.json`), result);
      }
      if (stop) break;
      const s = await browser.state();
      const status = `${s.phase}:${s.status}:${s.benchmarkStatus}:${s.providers.map(p => p.count).join('/')}`;
      if (status !== lastStatus) { await event('ui_state', { state: s }); lastStatus = status; }
      if (batchRequested && s.benchmarkStatus === 'completed' && s.status !== 'running') {
        batchCompletedAt ||= new Date().toISOString();
        await event('batch_completed', { state: s });
        if (!opts['no-inspection'] && !inspectionComplete) await inspect();
        const remaining = Date.parse(batchCompletedAt) + postSeconds * 1000 - Date.now();
        if (remaining > 0) await sleep(remaining);
        // An actual final pointer movement produces a fresh CDP frame after the
        // real overview hold, so its elapsed interval has a captured endpoint.
        const beforeFinal = frames.length;
        await browser.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 25, y: 740 });
        browser.actions.push({at:new Date().toISOString(),action:'mouse_move',label:'Visão geral final',x:25,y:740});
        const finalDeadline = Date.now() + 2000;
        while (frames.length === beforeFinal && Date.now() < finalDeadline) await sleep(50);
        stop = true; stopReason = 'batch_completed';
      } else if (Date.now() >= deadline) { stop = true; stopReason = 'max_seconds'; }
      else await sleep(100);
    }
  } catch (error) { recordingError = error; stopReason = 'error'; }
  finally {
    try { await browser.call('Page.stopScreencast'); } catch (error) { recordingError ||= error; }
    saving = false; await frameChain;
    const finalState = await browser.state().catch(() => null);
    const endedAt = new Date().toISOString();
    const recordedSpanSeconds = frames.length > 1 ? frames.at(-1).protocolTimestamp - frames[0].protocolTimestamp : 0;
    // Only intervals between actual captured frames are represented; no repeated tail.
    const concat = ['ffconcat version 1.0'];
    frames.forEach((frame, index) => {
      concat.push(`file '${frame.file}'`);
      if (index < frames.length - 1) concat.push(`duration ${(frames[index + 1].protocolTimestamp - frame.protocolTimestamp).toFixed(6)}`);
    });
    await fs.writeFile(path.join(output, 'frames.ffconcat'), concat.join('\n') + '\n');
    const manifest = {
      schema: 1, source: 'Chrome CDP Page.startScreencast', continuous: true,
      syntheticProgress: false, playbackTimebase: 'actual CDP frame metadata timestamps, seconds',
      viewport: { width: 1366, height: 768 }, fpsCap: fps, imageFormat, jpegQuality: imageFormat === 'jpeg' ? quality : null, postCompletionSeconds: postSeconds,
      recordingStartedAt, endedAt, batchStartAt, batchCompletedAt,
      stopReason, frameCount: frames.length, frameBytes: bytes, droppedForFpsCap: dropped,
      firstProtocolTimestamp: frames[0]?.protocolTimestamp ?? null,
      lastProtocolTimestamp: frames.at(-1)?.protocolTimestamp ?? null,
      recordedSpanSeconds, batchCompleted: !!batchCompletedAt,
      error: recordingError?.message ?? null, finalState, actions: browser.actions,
      requestAudit: browser.requestAudit, events: states,
      framesIndex: 'frames.ndjson', encodingInput: 'frames.ffconcat'
    };
    await jsonFile(path.join(output, 'manifest.json'), manifest);
    await fs.rm(path.join(output, 'ready.json'), { force: true });
    await browser.close();
    process.off('SIGINT', onSignal); process.off('SIGTERM', onSignal);
    say('RECORDING_STOPPED', { output, stopReason, frameCount: frames.length, frameBytes: bytes, recordedSpanSeconds, batchCompleted: !!batchCompletedAt, error: recordingError?.message ?? null });
    if (recordingError || (batchRequested && !batchCompletedAt)) process.exitCode = 2;
  }
}

async function command() {
  const action = String(opts.action || '');
  if (!['start-batch', 'stop', 'inspect-results'].includes(action)) throw Error('--action must be start-batch, stop, or inspect-results.');
  const ready = JSON.parse(await fs.readFile(path.join(output, 'ready.json'), 'utf8'));
  if (!ready.framesSaved || ready.source !== 'Page.startScreencast') throw Error('A real screencast has not reported readiness.');
  try { process.kill(ready.pid, 0); } catch { throw Error('The recorder process is no longer running.'); }
  const id = randomUUID();
  await fs.appendFile(path.join(output, 'control.ndjson'), JSON.stringify({ id, action, at: new Date().toISOString() }) + '\n');
  const deadline = Date.now() + (action === 'inspect-results' ? 20000 : 10000);
  while (Date.now() < deadline) {
    try {
      const result = JSON.parse(await fs.readFile(path.join(output, 'commands', `${id}.json`), 'utf8'));
      say('COMMAND_RESULT', result); if (!result.accepted) process.exitCode = 2; return;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await sleep(100);
  }
  throw Error('Recorder did not acknowledge the command.');
}

async function inspectReference() {
  // A separate CDP client; the active recorder process and its code stay intact.
  const ready = JSON.parse(await fs.readFile(path.join(output, 'ready.json'), 'utf8'));
  process.kill(ready.pid, 0);
  const childIds = (await fs.readFile(`/proc/${ready.pid}/task/${ready.pid}/children`, 'utf8')).trim().split(/\s+/).filter(Boolean);
  let profile;
  for (const pid of childIds) {
    const commandLine = (await fs.readFile(`/proc/${pid}/cmdline`, 'utf8').catch(() => '')).split('\0');
    const argument = commandLine.find(value => value.startsWith('--user-data-dir='));
    if (argument) {
      const candidate = argument.slice('--user-data-dir='.length);
      if (candidate.startsWith(path.join(os.tmpdir(), 'jev-recording-chrome-'))) { profile = candidate; break; }
    }
  }
  if (!profile) throw Error('Could not locate the active recorder’s own isolated Chrome child.');
  const active = (await fs.readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).trim().split('\n');
  const cdp = new CDP(`ws://127.0.0.1:${active[0]}${active[1]}`); await cdp.connect();
  try {
    const {targetInfos} = await cdp.call('Target.getTargets');
    const targets = targetInfos.filter(target => target.type === 'page' && target.url.startsWith(origin.origin));
    if (targets.length !== 1) throw Error('Expected exactly one recorded app page.');
    const {sessionId} = await cdp.call('Target.attachToTarget', {targetId:targets[0].targetId,flatten:true});
    const call = (method, params) => cdp.call(method, params, sessionId);
    await call('Runtime.enable');
    const evaluate = async expression => {
      const result = await call('Runtime.evaluate', {expression,returnByValue:true,awaitPromise:true});
      if(result.exceptionDetails) throw Error(result.exceptionDetails.text);
      return result.result.value;
    };
    const deadline = Date.now() + number(opts['max-seconds'], 180, 1, 300)*1000;
    while ((await evaluate(stateExpression)).benchmarkStatus !== 'completed') {
      if(Date.now()>deadline) throw Error('Waiting for the actual completed batch timed out.');
      await sleep(100);
    }
    const events = (await fs.readFile(path.join(output,'events.ndjson'),'utf8')).split('\n').filter(Boolean).map(line=>JSON.parse(line));
    const completed = events.filter(event=>event.type==='batch_completed').at(-1);
    const observedAt = completed ? Date.parse(completed.at) : Date.now();
    const delay = observedAt + number(opts['after-auto-seconds'],8,0,20)*1000-Date.now();
    if(delay>0) await sleep(delay);
    const click = async (selector,label) => {
      const box = await evaluate(`(() => {const n=document.querySelector(${JSON.stringify(selector)});if(!n||n.disabled)throw Error('Target missing/disabled');const r=n.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
      if(box.x<0||box.x>=1366||box.y<0||box.y>=768) throw Error('Inspection target outside the captured viewport');
      await call('Input.dispatchMouseEvent',{type:'mouseMoved',...box});
      await sleep(100);
      await call('Input.dispatchMouseEvent',{type:'mousePressed',...box,button:'left',clickCount:1});
      await call('Input.dispatchMouseEvent',{type:'mouseReleased',...box,button:'left',clickCount:1});
      const action={at:new Date().toISOString(),action:'click',selector,label,...box,external:true};
      await fs.appendFile(path.join(output,'external-actions.ndjson'),JSON.stringify(action)+'\n');
      say('INSPECTION_ACTION',action);
    };
    const caseId=String(opts.case || 'CN-SIM-0008'), facet=String(opts.facet || 'positive_evaluation'), provider=String(opts.provider || 'jev');
    if(!['jev','claude'].includes(provider)) throw Error('--provider must be jev or claude.');
    if(await evaluate(`document.querySelector('#refs-modal')?.classList.contains('open')`)) await click('#modal-close','Fechar referência anterior');
    await click(`[data-lane="${provider}"] [data-case=${JSON.stringify(caseId)}]`,'Selecionar atendimento para referência');
    await sleep(500);
    await click(`[data-ref-provider="${provider}"][data-ref-facet=${JSON.stringify(facet)}]`,'Abrir evidência específica');
    await sleep(number(opts['hold-seconds'],4,1,10)*1000);
    await click('#modal-close','Fechar evidência específica');
    say('REFERENCE_INSPECTED',{caseId,facet,provider});
    await cdp.call('Target.detachFromTarget',{sessionId});
  } finally { cdp.close(); }
}

function tarHeader(name, size) {
  if (Buffer.byteLength(name) > 100) throw Error(`Archive path too long: ${name}`);
  const header = Buffer.alloc(512);
  header.write(name, 0, 100); header.write('0000644\0', 100, 8); header.write('0000000\0', 108, 8); header.write('0000000\0', 116, 8);
  header.write(size.toString(8).padStart(11, '0') + '\0', 124, 12);
  header.write(Math.floor(Date.now() / 1000).toString(8).padStart(11, '0') + '\0', 136, 12);
  header.fill(32, 148, 156); header.write('0', 156); header.write('ustar\0', 257, 6); header.write('00', 263, 2);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
  return header;
}
async function pack() {
  const manifest = JSON.parse(await fs.readFile(path.join(output, 'manifest.json'), 'utf8'));
  if (!manifest.frameCount) throw Error('No completed frame capture to pack.');
  const archive = path.resolve(String(opts.archive || `${output}.tar.gz`));
  const files = [];
  async function walk(dir, relative = '') {
    for (const item of (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = path.posix.join(relative, item.name);
      if (item.isDirectory()) await walk(path.join(dir, item.name), name);
      else if (item.isFile() && path.resolve(dir, item.name) !== archive) files.push(name);
    }
  }
  await walk(output);
  async function* chunks() {
    for (const file of files) {
      const filename = path.join(output, file), stat = await fs.stat(filename);
      yield tarHeader(file, stat.size);
      for await (const chunk of createReadStream(filename)) yield chunk;
      const remainder = stat.size % 512; if (remainder) yield Buffer.alloc(512 - remainder);
    }
    yield Buffer.alloc(1024);
  }
  await pipeline(Readable.from(chunks()), createGzip({ level: 6 }), createWriteStream(archive));
  say('ARCHIVE_READY', { archive, bytes: (await fs.stat(archive)).size, files: files.length, recordedSpanSeconds: manifest.recordedSpanSeconds });
}

try {
  if (mode === 'screenshot' || mode === 'layout') await readOnlyScreenshot();
  else if (mode === 'preflight') await preflight();
  else if (mode === 'record') await record();
  else if (mode === 'command') await command();
  else if (mode === 'pack') await pack();
  else if (mode === 'inspect-reference') await inspectReference();
  else throw Error('Mode must be screenshot, layout, preflight, record, command, pack, or inspect-reference.');
} catch (error) { say('ERROR', { mode, error: error.message }); process.exitCode = 1; }
