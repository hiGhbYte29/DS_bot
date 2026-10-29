// OneBot 路由的环境变量覆盖（开发用）。
//
// 用途：开发时把桥接临时指向本机的虚拟 OneBot 网关，不改 config.json。
// 两个变量都不设时这里返回 null，调用方什么都不做 —— 生产行为与没有本模块时完全一致。
//
// 读路由的进程有三个，必须拿到同样的环境变量，否则收发会走到不同的网关：
//   - 桥接（src/bridge.js）
//   - DSH 拉起的两个 MCP 子进程（mcp-snowluma-safe.js / mcp-host-server.js）——变量要设在 DSH 进程上
//
// 覆盖生效时一律无鉴权（accessToken 为空），虚拟网关也不应要求鉴权。没有提供令牌变量，是因为
// DSH 给 MCP 子进程传环境变量时会滤掉名字里带 KEY / PASSWORD / SECRET / TOKEN 的变量，
// 令牌只能到达桥接、到不了 MCP，收发两边的鉴权就会不一致。
//
// 覆盖生效时桥接会关闭 token 自愈与 config.json 写回，否则虚拟网关的地址会被持久化进真实配置。

export const ONEBOT_ROUTE_ENV = Object.freeze({
  wsUrl: 'QQ_BRIDGE_ONEBOT_WS_URL',
  httpUrl: 'QQ_BRIDGE_ONEBOT_HTTP_URL'
});

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

function envValue(env, name) {
  const v = env?.[name];
  return typeof v === 'string' ? v.trim() : '';
}

function checkLoopbackUrl(name, value, protocol) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} 不是合法的 URL`);
  }
  if (url.protocol !== protocol) throw new Error(`${name} 必须以 ${protocol}// 开头`);
  // 只允许本机：变量误进生产环境时，宁可启动失败，也不能把机器人静默接到别的机器上。
  if (!LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error(`${name} 只允许本机地址（127.0.0.1 / localhost / [::1]）`);
  }
  if (url.username || url.password) throw new Error(`${name} 不能在 URL 里带账号密码`);
  return value.replace(/\/+$/, '');
}

/**
 * 读取路由覆盖。
 * @returns {null | { wsUrl: string, httpUrl: string, accessToken: '' }}
 *   两个变量都没设（或都是空串）→ null；设了但不完整/不合法 → 抛错。
 */
export function readOneBotRouteOverride(env = process.env) {
  const ws = envValue(env, ONEBOT_ROUTE_ENV.wsUrl);
  const http = envValue(env, ONEBOT_ROUTE_ENV.httpUrl);
  if (!ws && !http) return null;
  // 只设一个 = 收消息（WS）和发消息（HTTP）走到不同的网关，比不设更糟。
  if (!ws || !http) {
    throw new Error(`OneBot 路由覆盖需要同时设置 ${ONEBOT_ROUTE_ENV.wsUrl} 和 ${ONEBOT_ROUTE_ENV.httpUrl}`);
  }
  return {
    wsUrl: checkLoopbackUrl(ONEBOT_ROUTE_ENV.wsUrl, ws, 'ws:'),
    httpUrl: checkLoopbackUrl(ONEBOT_ROUTE_ENV.httpUrl, http, 'http:'),
    accessToken: ''
  };
}

/**
 * 把覆盖套到 config 的 snowluma 段上，返回新对象（不修改入参）。override 为 null 时原样返回入参。
 * 同时清掉 homeDir / launcherPath：覆盖期间不应去读本机真实 SnowLuma 的配置或文件。
 */
export function applyOneBotRouteOverride(snowluma, override) {
  if (!override) return snowluma;
  const { wsUrl, httpUrl, accessToken } = override;
  return {
    ...(snowluma ?? {}),
    wsUrl,
    httpUrl,
    accessToken,
    followDiscoveredEndpoint: false,
    homeDir: '',
    launcherPath: ''
  };
}
