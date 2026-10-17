// Run the production FireSim shaders without adding browser automation dependencies.
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url));
const profile = await mkdtemp(join(tmpdir(), 'norte-webgl-'));
const children = [];
let logs = '';
function start(command, args) {
  const child = spawn(command, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', data => { logs = (logs + data).slice(-10000); });
  child.stderr.on('data', data => { logs = (logs + data).slice(-10000); });
  child.on('error', error => { logs += String(error); });
  children.push(child); return child;
}
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(action, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (children.some(child => child.exitCode !== null || child.pid === undefined)) throw Error(`Runner exited: ${logs}`);
    try { const result = await action(); if (result) return result; } catch (error) {
      if (error.message?.startsWith('Audit failed')) throw error;
    }
    await pause(200);
  }
  throw Error(`Readiness timeout: ${logs}`);
}
function evaluate(page) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(page.webSocketDebuggerUrl);
    const timer = setTimeout(() => { socket.close(); reject(Error('CDP timeout')); }, 5000);
    socket.onerror = reject;
    socket.onopen = () => socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: {
      expression: 'document.getElementById("result")?.textContent', returnByValue: true,
    } }));
    socket.onmessage = event => {
      const message = JSON.parse(event.data);
      if (message.id === 1) { clearTimeout(timer); socket.close(); resolve(message.result?.result?.value); }
    };
  });
}
try {
  start(join(root, 'web/node_modules/.bin/vite'), ['--config', 'analysis/norte-gpu.config.mjs']);
  await waitFor(async () => (await fetch('http://127.0.0.1:5178/norte-gpu.html')).ok);
  start(process.env.CHROMIUM_BIN ?? 'chromium', ['--headless', '--no-sandbox', '--no-proxy-server', '--disable-background-networking',
    `--user-data-dir=${profile}`, '--remote-debugging-port=9228', '--disable-dev-shm-usage', '--use-gl=angle', '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader', 'http://127.0.0.1:5178/norte-gpu.html']);
  const page = await waitFor(async () => (await (await fetch('http://127.0.0.1:9228/json')).json())
    .find(p => p.type === 'page' && p.url.endsWith('norte-gpu.html')));
  const result = await waitFor(async () => {
    const text = await evaluate(page); if (!text || text === 'RUNNING') return null;
    const result = JSON.parse(text);
    if (result.status !== 'passed') throw Error(`Audit failed: ${text}`);
    return result;
  }, 60000);
  if (!result.seeds || result.seedResults.length !== result.seeds) throw Error('Incomplete GPU seed count');
  const z = 1.96, p = result.hits / result.seeds, d = 1 + z * z / result.seeds;
  const a = (p + z * z / (2 * result.seeds)) / d, b = z * Math.sqrt(p * (1 - p) / result.seeds + z * z / (4 * result.seeds ** 2)) / d;
  result.wilson95 = [Math.max(0, a - b), Math.min(1, a + b)];
  const path = join(root, 'analysis/norte-spotting.json');
  const report = JSON.parse(await readFile(path, 'utf8')); report.gpuCa = result;
  await writeFile(path, JSON.stringify(report, null, 2) + '\n');
  console.log(`WebGL spotting: ${result.hits}/${result.seeds}`);
} finally {
  for (const child of children.reverse()) {
    if (child.exitCode !== null || !child.pid) continue;
    child.kill('SIGTERM');
    await Promise.race([new Promise(resolve => child.once('exit', resolve)), pause(3000)]);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
  await rm(profile, { recursive: true, force: true, maxRetries: 3 });
}
