# 扩展开发指南：功能该写在哪一层

> 面向给本桥接加功能、改行为、修问题的人。
> 目标：**先判断代码该写在哪一层，再动手**。放错层是这类项目最主要的返工来源。
>
> 相关：[qq-bridge/docs/guides/DSH_SETUP.md](../qq-bridge/docs/guides/DSH_SETUP.md)（装预设 / 挂 MCP）·
> [qq-bridge/docs/guides/SECURITY_BASELINE.md](../qq-bridge/docs/guides/SECURITY_BASELINE.md)（改安全相关代码前必读）·
> [qq-bridge/docs/FOLDER_MAP.md](../qq-bridge/docs/FOLDER_MAP.md)（目录与脚本命名）·
> [known-issues.md](known-issues.md)（已知失效模式）

---

## 一、四层结构

```text
① SnowLuma（QQ 网关，上游，不修改）
   QQ 客户端注入 → OneBot HTTP / WS
        │ 事件 / 发送
② qq-bridge（本仓库，策略层）
   src/bridge.js      白名单、唤醒调度、提示词拼装、状态、控制台 API、MCP 宿主
   src/mcp-*.js       工具面（模型能调用的 QQ / 联网能力）
   config.json        运行时配置（白名单 / 工具开关 / 策略）
   state/             会话映射、未读、记忆、表情库、日志
        │ HTTP RPC + MCP(stdio)
③ DSH（运行时层，配置化，不写业务代码）
   ~/.dsh/profiles/<profile>/cordis.patch.yml   MCP 注册 / 模型
   agent preset（人格 + 工具面 + 上下文压缩策略）
   会话 / 回合 / 上下文 / 工具注册
        │
④ 模型
```

一句话分工：

- **「消息要不要被响应、什么时候醒、醒来跟谁说话」** → ② bridge
- **「模型该知道什么、能调什么、什么时候能调」** → ③ DSH preset
- **「模型以什么口吻说话」** → ③ preset 的 persona 文案
- **「模型怎么思考」** → ④ 模型 + ③ 的模型配置

---

## 二、决策表

| 需求 | 放哪层 | 主要改哪里 | 生效方式 |
| --- | --- | --- | --- |
| 新的「模型可调用能力」（查天气、发语音、查历史） | ② 实现 + ③ 暴露 | `src/mcp-snowluma-safe.js` + `src/bridge.js` 的执行接口 + `config.json` 开关 + restict 白名单 | 重启 bridge **和** DSH |
| 新的「自动行为」，模型不参与（审计、限流、摘要、风控、定时） | ② bridge | `src/bridge.js` 的事件钩子 / 定时器 | 只重启 bridge |
| 改唤醒 / 回复判定（@、关键词、概率、回复窗口） | ② bridge | `evaluateWakeTriggerV2` / `scheduleReplyCheckV2` 等 | 只重启 bridge |
| 改人格、语气、群聊礼仪、分条规则 | ③ preset | `dsh/agent-presets/qq-chat-v2/agent.cordis.yml` 的 `persona.prefix` | 重建预设 → 重启 DSH → **新会话** |
| 改「模型能看见哪些工具」 | ③ preset | 同上 `plugins` 段 + `qq-tool-restrict.mjs` 白名单 | 重建预设 → 重启 DSH |
| 改模型 / 思考强度 / 上下文压缩阈值 | ③ DSH | profile 的 `cordis.patch.yml` / preset 的 `compaction` 段 | 重启 DSH |
| 新的控制台接口 | ② bridge | `src/bridge.js` 路由 + `public/console.html` | 只重启 bridge |
| 在 DSH GUI 里加界面（不是桥接控制台） | ③ DSH 插件 | `plugins/qq-mode-console` 这类包 | 重装 link + 重启 DSH |
| 接入新平台（微信 / Telegram / Discord） | ② 新 MCP server + ③ 新 preset | 参照 `mcp-snowluma-safe.js` 的形状 | 重启 bridge + DSH |
| 换 QQ 网关 | ① 上游 | 不改本仓库，只改 `config.json` 的 `snowluma.*` | 重启网关 + bridge |

**判断口诀**

1. 要新增一个**模型能调的动作** → bridge 实现 + DSH 暴露（两处都要改）。
2. 只影响模型的**判断 / 口吻**、不新增动作 → DSH preset（改文字，不写代码）。
3. 要在消息**到达模型之前 / 发出之后**做事 → bridge。
4. 要改**会话 / 上下文 / 模型本身** → DSH profile。
5. SnowLuma 是上游 —— 只通过 `config.json` 接入，不改它的代码。

---

## 三、Recipe A：给模型加一个新工具

以 `qq_get_member_history`（查某成员最近发言）为例。

### A1. 配置开一个默认关闭的开关

`config.json` → `socialV2.tools`：

```json
"socialV2": { "tools": { "getMemberHistory": false } }
```

约定：新工具**默认关闭**便于灰度；开关名 camelCase，与工具名解耦。

### A2. 实现工具（`src/mcp-snowluma-safe.js`）

```js
// 1) 工具名 → 开关名 的映射表登记（漏登记 = 工具不注册）
const TOOL_FLAGS = { /* … */ qq_get_member_history: 'getMemberHistory' };

// 2) schema + handler
server.tool(
  'qq_get_member_history',
  '查某个群成员最近说过的话（只读）。userId 从 qq_get_active_members 取。',
  { key: z.string(), token: z.string(), userId: z.string(), limit: z.number().optional() },
  async ({ key, token, userId, limit }) => {
    const data = await agentApi('/api/socialV2/member-history', {
      method: 'POST',
      body: JSON.stringify({ key, token, userId, limit }),
      headers: { 'x-agent-token': token },
    });
    return { content: [{ type: 'text', text: JSON.stringify(data) }] };
  }
);
```

工具**不要直接读 `state/` 下的文件**，一律通过 `agentApi()` 打桥接的 HTTP 接口 —— 鉴权、白名单、审计只在一处。

### A3. 实现执行接口 + 鉴权（`src/bridge.js`）

```js
if (req.method === 'POST' && url.pathname === '/api/socialV2/member-history') {
  const body = await readBody();
  const key = String(body.key ?? '');
  // ① 会话令牌（缺失即 403；不要用控制台令牌代替）
  if (!agentTokenOk(key, body.token)) return sendJson({ ok: false, error: '令牌无效' }, 403);
  // ② 白名单闸门（新接口也必须过，不能只靠工具层）
  if (!modeAllowed(key, kind, id, cfg, currentMode)) return sendJson({ ok: false, error: '不在白名单' }, 403);
  // ③ 业务
  const st = getSocialV2State(key);
  const rows = (st.recentMessages || []).filter((m) => String(m.userId) === String(body.userId));
  // ④ 回给模型的文本一律 clipText()，禁止裸 slice
  return sendJson({ ok: true, messages: rows.slice(-10).map((m) => ({ ...m, text: clipText(m.text, 200) })) });
}
```

### A4. 把工具加进「允许范围」

`plugins/qq-agent-presets/qq-tool-restrict.mjs` 的白名单里加 `qq_get_member_history`；不加 = 注册成功但执行期被 guard 拒掉。

### A5. 生效顺序

```bash
# 1) 先重启桥接（工具实现与新接口就位）
systemctl --user restart <你的桥接服务名>
# 2) 再重启 DSH（MCP 工具清单在启动时枚举，不重启看不到新工具）
systemctl --user restart <你的 DSH 服务名>
# 3) 验收
node ops/status.mjs
grep -c 'qq_get_member_history' ~/.dsh/profiles/<profile>/cordis.patch.yml
```

### A6. 测试

```bash
cd qq-bridge
node scripts/test-mcp-safe.mjs           # 工具 schema / 开关
node scripts/test-tool-surface.mjs       # 工具面与预设是否一致
node scripts/test-preset-local-tools.mjs # 防止本地工具漏进来
```

---

## 四、Recipe B：改人格 / 行为规则（不写代码）

**唯一入口**：`dsh/agent-presets/qq-chat-v2/agent.cordis.yml` 的 `persona.prefix`。

```bash
cd qq-bridge

# 1) 改源文件（不要直接改生成物）
$EDITOR dsh/agent-presets/qq-chat-v2/agent.cordis.yml

# 2) 由脚本生成 DSH 用的预设（手改 plugins/…/presets/*.patch.yml 会被覆盖）
node scripts/build-agent-preset-patches.mjs

# 3) 装进 profile（写 MCP 区块、维护 node_modules link，幂等）
node scripts/setup-dsh.mjs

# 4) 契约测试：防止写入未注册的提示词变量
node scripts/test-qq-preset-contract.mjs
node scripts/test-preset-prompt.mjs

# 5) 重启 DSH
systemctl --user restart <你的 DSH 服务名>
```

**生效范围**：新会话自动用新版；**已有会话不会重建 system prompt** —— 要么等它自然重置，要么对该会话调用桥接的 `POST /api/session/reset {key}`。

**硬规则**

- 不要写 `{{cwd}}` 等未注册变量（新版 DSH 只注册 `provider` / `model`，未知变量 **fail loud**：回合在 `turn/start` 后立刻 error，QQ 上表现为「完全不回」）。
- 不要写 Markdown（`**`、`#`、代码块在 QQ 上是乱码）。
- persona 只描述工具的**用法与边界**，不描述**实现**；实现永远在 bridge。

---

## 五、Recipe C：加桥接侧自动化（模型不参与）

适用：审计、限流、自动摘要、风控、定时提醒、白名单动态维护。

| 想做 | 钩子 |
| --- | --- |
| 消息到达时 | 入站处理函数中、白名单判定之后、落库之前 |
| 决定要不要唤醒 | `evaluateWakeTriggerV2` |
| 唤醒投递前后 | `sendWakePromptV2` / `scheduleWakeV2` |
| 回合结束时 | `turn/end` 处理段（`replayPendingWakeReasonsV2` 附近） |
| 定时 | `setInterval` + `saveSocialV2State()` 持久化 |

要求：

- 状态写进 `state/social-v2.json`（`getSocialV2State(key)`），**不要新开散落文件**；
- 阈值 / 窗口放进 `config.json` 的 `socialV2.*`，默认值集中在 `defaultWakeConfigV2` 附近；
- 新行为必须能在 `state/bridge.log` 里**说清楚为什么没做**（如「因为 XX 跳过」），否则排障只能靠猜。

---

## 六、Recipe D：加控制台接口

```js
if (req.method === 'GET' && url.pathname === '/api/socialV2/foo') {
  // 管理 / 隐私类必须校验控制台令牌（x-console-token 或 ?token=）
  sendJson({ ok: true /* … */ });
}
```

规则：

- 管理 / 隐私接口必须显式列进 `adminOnlyV2Paths`（`src/bridge.js` 路由区）；
- 返回体不要带令牌、本机路径、聊天原文；
- 前端在 `public/console.html`，改完刷新即可；路由改动需重启 bridge。

---

## 七、硬约束（违反过的都出过事故）

| # | 约束 | 违反后果 | 落点 |
| --- | --- | --- | --- |
| 1 | 文本截断**只能用 `clipText()`**，禁止裸 `slice` | 切出半个 emoji（孤立代理项）→ 请求体非法 JSON → 该会话**永久 400** | `bridge.js` 的 `clipText` / `stripLoneSurrogates` |
| 2 | 所有工具调用必须校验**会话令牌** | 可越权操作其他会话 | `agentTokenOk()` |
| 3 | 白名单闸门只能存在**一处** | 双份判定必然漂移 | `allowed()` / `modeAllowed()` |
| 4 | 仿真会话**永不出现本地工具**（命令执行 / 读写文件…） | 群友可驱动本机命令 | `qq-tool-restrict.mjs`；**restrict 失败必须当错误**，不能 fail-open |
| 5 | 不手改 `plugins/*/presets/*.patch.yml` | 下次 `build-agent-preset-patches.mjs` 覆盖 | 改 `dsh/agent-presets/*/agent.cordis.yml` |
| 6 | 不手改 `cordis.patch.yml` 的 MCP 区块 | 被 `scripts/setup-dsh.mjs` 整体替换 | 改 `scripts/setup-dsh.mjs` |
| 7 | persona 禁止未注册的 `{{...}}` 变量 | 回合立即 error，QQ 上「完全不回」 | `agent.cordis.yml` |
| 8 | 系统提示语不得流入 QQ 聊天 | 对方会莫名收到「已停止」这类系统话术 | 发送路径只接受模型明确发出的内容 |

---

## 八、变更生效矩阵

| 改了什么 | 需要重启 | 需要新会话 | 备注 |
| --- | --- | --- | --- |
| `src/bridge.js` | bridge | 否 | 十几秒，QQ 不重登 |
| `src/mcp-*.js`（工具实现 / 清单） | **bridge + DSH** | 否 | MCP 服务由 DSH 启动时拉起 |
| `config.json` 白名单 | 否 | 否 | 控制台接口热生效，注意是**整体替换** |
| `config.json` 工具开关 | **DSH** | 否 | 工具在注册期按开关裁剪 |
| `config.json` 唤醒 / 社交参数 | bridge | 否 | 部分项热读 |
| 预设的 persona 文案 | DSH | **是** | 旧会话不重建 system prompt |
| 预设的工具面 / restrict 名单 | DSH | 否 | 新会话生效 |
| 模型 / reasoningEffort | DSH | 否 | 也可由桥接下发给会话 |
| 控制台前端 `public/console.html` | 否 | 否 | 刷新页面 |

---

## 九、排障入口

```bash
node ops/status.mjs                            # 链路是否通
tail -f qq-bridge/state/bridge.log             # 桥接的判断过程（为什么没醒 / 为什么跳过）
journalctl --user -u <你的 DSH 服务名> -f       # DSH 侧（blocked / 400 / 中止）
```

三种「看起来像机器人不想说话」的真实故障，见 [known-issues.md](known-issues.md)。

---

## 十、提交前自检

- [ ] 代码放在**正确的层**（对照第二节决策表）
- [ ] 文本截断用 `clipText`，没有裸 `slice`
- [ ] 新工具：开关默认关、令牌校验、白名单闸门、进 restrict 名单
- [ ] 新接口：管理类进了 `adminOnlyV2Paths`
- [ ] 没有手改生成物（`presets/*.patch.yml`、`cordis.patch.yml` 的 MCP 区块）
- [ ] 跑了对应的 `scripts/test-*.mjs`
- [ ] 写清两件事：**怎么生效**（重启矩阵）、**怎么确认真的生效**（验收命令）
- [ ] 提交前跑 `python3 scripts/check-publication.py`
