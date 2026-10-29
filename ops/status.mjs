#!/usr/bin/env node
// AI-assisted, read-only health checks. Never send chat messages or print tokens.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { discoverDshSessionCookie } from '../qq-bridge/src/dsh-client.js';
import { readOneBotRouteOverride } from '../qq-bridge/src/onebot-route.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let cfg;
try {
  cfg = JSON.parse(fs.readFileSync(path.join(root, 'qq-bridge/config.json'), 'utf8'));
} catch {
  console.error('Cannot read qq-bridge/config.json; create a valid private configuration first.');
  process.exit(1);
}

// 开发用的 OneBot 路由覆盖（见 qq-bridge/src/onebot-route.js）：本终端设了变量时，网关检查跟着走。
let route = null;
try {
  route = readOneBotRouteOverride(process.env);
} catch (error) {
  console.error(`OneBot route override is invalid: ${error.message}`);
  process.exit(1);
}

function localBase(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)
      || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      || url.username || url.password) {
    throw new Error('Only local service URLs are supported by this health check.');
  }
  return url.toString().replace(/\/+$/, '');
}

function consoleToken() {
  const configured = String(cfg.consoleToken ?? '').trim();
  if (/^[A-Za-z0-9_-]{16,128}$/.test(configured)) return configured;
  try {
    return fs.readFileSync(path.join(root, 'qq-bridge/state/console-token'), 'utf8').trim();
  } catch { return ''; }
}

async function read(url, options = {}) {
  const response = await fetch(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

async function check(name, action) {
  try { return [name, await action()]; }
  catch { return [name, { ok: false, error: 'Unavailable, unauthenticated, or invalid local configuration' }]; }
}

const result = Object.fromEntries(await Promise.all([
  check('gateway', async () => {
    const base = localBase(route?.httpUrl || cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000');
    const token = route ? route.accessToken : (cfg.snowluma?.accessToken || '');
    const r = await read(base + '/get_status', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
      body: '{}'
    });
    return { ok: r.retcode === 0 && r.data?.online === true && r.data?.good === true,
      online: r.data?.online, good: r.data?.good, ...(route ? { routeOverride: true } : {}) };
  }),
  check('dsh', async () => {
    const base = localBase(cfg.dsh?.baseUrl || 'http://127.0.0.1:3080');
    const cookie = discoverDshSessionCookie(base);
    if (!cookie) throw new Error('local authentication unavailable');
    const r = await read(base + '/api/settings/describe', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'ds-bot-health',
        method: 'settings/describe', payload: { args: {} } })
    });
    if (!r.result?.ok) throw new Error('settings unavailable');
    const q = r.result.value.namespaces?.find(n => n.ns === 'qq-mode');
    return { ok: !!q, mode: q?.user?.mode ?? q?.value?.mode };
  }),
  check('bridge', async () => {
    const port = Number(cfg.consolePort) || 3100;
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid port');
    const r = await read(`http://127.0.0.1:${port}/api/status`, {
      headers: { 'x-console-token': consoleToken() }
    });
    return { ok: r.dshReady === true && r.snowluma?.connected === true && r.snowluma?.good === true,
      mode: r.mode, dshReady: r.dshReady, connected: r.snowluma?.connected,
      online: r.snowluma?.accountOnline, good: r.snowluma?.good,
      ...(r.snowluma?.routeOverride ? { routeOverride: true } : {}),
      privateCount: r.allowPrivate?.length, groupCount: r.allowGroups?.length };
  })
]));
console.log(JSON.stringify({ checked_at: new Date().toISOString(), ...result }, null, 2));
if (Object.values(result).some(r => !r.ok)) process.exitCode = 1;
