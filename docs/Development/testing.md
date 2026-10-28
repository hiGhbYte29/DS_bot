# 测试与开发指南

本文讲**怎么在本地验证改动**，分三种手段，从轻到重：

| 手段 | 需要 QQ | 需要 DSH | 需要网络 | 适合 |
| --- | --- | --- | --- | --- |
| ① 离线回归 | 否 | 否 | 否 | 改纯逻辑、每次提交前 |
| ② 本地全链路（测试小号） | 是 | 是 | 是 | 改桥接调度、会话、发送、人格 |
| ③ mock 网关 | 否 | 是 | 是（模型） | 没有可用小号时验证全链路（**尚未实现**，见 §4） |

> 生产部署见 [deployment.md](deployment.md)。本文不涉及生产机操作。

## 1. 离线回归（最常用，零依赖）

```bash
cd qq-bridge
npm run test:audit        # 主回归：临时目录 + 假网关 + 假 DSH，不读真实配置、不发消息
npm run test:hardening    # 安全边界：白名单、发送守卫、提示词注入
npm run test:tokens       # token 账本与峰谷计价
npm run test:console-ui   # 控制台浏览器回归（含看板渲染）
```

`test:audit` 会串跑 35 个子套件，最后汇总一行 `Audit suite: N/35 scripts passed`。**在当前 Linux + DSH 0.2.1 环境下基线是 30/35**，以下 5 个属于环境/版本差异，不是你的改动导致的：

| 失败套件 | 原因 |
| --- | --- |
| `test-audit-setup-guards` | 断言 `start.bat` 必须是 CRLF；Linux 上检出为 LF |
| `test-preset-prompt` | 同类问题：写回时按文件主导行尾断言 |
| `test-console-encoding` | 依赖 Windows 的 `chcp`，Linux 上没有 |
| `test-voice-system` | 仓库里没有 `docs/guides/VOICE.md`，且独立发语音工具在仓库外的 `../voice-tool/`（可用 `QQ_BRIDGE_VOICE_TOOL_DIR` 指定） |
| `test-preset-local-tools` | 工具守卫名单与已安装 DSH 的工具名有 3 个出入（版本漂移，`verify:adaptation` 里同样能看到） |

判断方法：**失败项落在这张表里 → 忽略；不在这张表里 → 是你引入的回归。**

离线用例的实现方式（`scripts/audit-bridge-harness.mjs`）：所有用例在 `os.tmpdir()` 下建临时仓库，**不读** `config.json`、**不连** QQ、**不启** DSH；假 `fetch` 会记录桥接真正要发出的请求体，所以能断言"发了几条、内容是什么、分段对不对"。

按改动选命令：

| 改了什么 | 先跑 |
| --- | --- |
| `src/*.js` 任何逻辑 | `npm run test:audit` |
| 白名单 / 发送 / 审计相关 | `npm run test:hardening` |
| token 账本、控制台 | `npm run test:tokens`、`npm run test:console-ui` |
| 图片/表情处理 | `npm run test:media-search`、`npm run test:media-normalize` |
| 语音 | `npm run test-voice`、`npm run test-voice:system` |
| preset / 提示词 | `npm run verify:persona`、`npm run test:preset-prompt` |

## 2. 本地全链路（真 QQ 小号）

用于验证「消息进来 → 唤醒 → 模型 → 工具发送 → 消息出去」这条完整链路。

### 2.1 准备

1. 一个**测试用 QQ 小号**（不要用生产号），登录桌面客户端；
2. 一套本地 SnowLuma（见 [deployment.md](deployment.md) §5），对它加载小号进程并开启 OneBot；
3. 一份**只属于开发环境**的 `config.json`：

```json
{
  "consolePort": 3110,
  "ownerQQ": <你的号>,
  "allow": { "private": [<你的号>], "groups": [] },
  "snowluma": { "wsUrl": "ws://127.0.0.1:3001", "httpUrl": "http://127.0.0.1:3000" }
}
```

4. 确认与生产环境**不共用**：端口、DSH 实例、`state/` 目录三者至少 DSH 与 state 要分开（见 §5）。

### 2.2 跑起来

```bash
cd qq-bridge
npm start                       # 前台，日志直接看
# 另一个终端
cd .. && node ops/status.mjs     # gateway / dsh / bridge 三项
```

### 2.3 验证清单

| 场景 | 期望 |
| --- | --- |
| 私聊发一句话 | 日志 `已投递` → `agent 回复`；QQ 收到回复 |
| 群里 @ 机器人 | `[reserved2] 唤醒 group:…（atMention）` |
| 群里普通聊天 | 不唤醒或按概率唤醒（看 `wakeConfig`） |
| 发一张图 | 日志 `[media] …→…`；模型能描述图片 |
| 触发发送白名单外目标 | 工具返回拒绝，不发出消息 |
| 重启桥接 | 会话映射保留，`state/sessions.json` 不变 |

### 2.4 清理

测试结束后把小号退出、SnowLuma 卸载进程；`state/` 里的测试会话可直接删除（**只删开发环境的**）。

## 3. 在本机跑第二套 DSH（不影响已有实例）

同一台机器要同时保留"日常用的 DSH"和"测试用 DSH"时，靠 `DSH_HOME` + 端口隔离：

```bash
mkdir -p ~/.dsh-test
cp ~/.dsh/.credentials.yaml ~/.dsh-test/ && chmod 600 ~/.dsh-test/.credentials.yaml

cd qq-bridge
DSH_HOME=~/.dsh-test node scripts/setup-dsh.mjs     # 装 preset + MCP 到测试 home
DSH_HOME=~/.dsh-test dsh plugin --profile web install
DSH_HOME=~/.dsh-test dsh web --host 127.0.0.1 --port 3180 --no-open
```

桥接配置里把 `dsh.baseUrl` 指到 `http://127.0.0.1:3180`。

三个必错点：

1. **忘了 `DSH_HOME`** → 直接写进默认 home，污染现有 DSH；
2. **在错误目录跑 `setup-dsh.mjs`** → 配置里的 MCP 路径指向另一份代码；
3. **整个复制 `~/.dsh`** → 会把原实例的 MCP 路径改写成新目录；只复制 `.credentials.yaml` 就够。

## 4. mock 网关（无 QQ 接入）

> **现状：尚未实现。** 本节是实现规格 + 预期用法；落地后本提示会删除。

### 4.1 为什么值得做

桥接对 QQ 的全部依赖就是 OneBot v11（一条 WS 收事件 + 一组 HTTP 动作）。用一个本地假服务顶替 SnowLuma，就能在没有第二个 QQ 号的情况下跑通"消息 → 唤醒 → 模型 → 工具发送"。

### 4.2 需要实现的协议面

**WS 事件（必须）**

| 事件 | 关键字段 |
| --- | --- |
| 心跳 | `post_type=meta_event, meta_event_type=heartbeat, status={online:true,good:true}, interval=30000` |
| 群消息 | `post_type=message, message_type=group, group_id, user_id, message:[{type:'text',data:{text}}], sender:{user_id,nickname,card}` |
| 私聊消息 | 同上，`message_type=private, sub_type=friend` |
| 拍一拍 | `post_type=notice, notice_type=notify, sub_type=poke, target_id` |

**HTTP 动作（桥接实际调用）**

```
get_login_info   get_status   get_group_list   get_group_member_list
send_group_msg   send_private_msg   get_group_msg_history   get_msg
get_forward_msg  fetch_ptt_text     fetch_custom_face_detail
group_poke
```

未实现的动作统一返回 `{status:'ok',retcode:0,data:[]}`，桥接会优雅降级（表情同步失败、成员列表为空），不影响主链路。

### 4.3 预期形态

```
scripts/mock-onebot.mjs
  --http-port 3010 --ws-port 3011 --token mock-token

控制接口（便于脚本化）：
  POST /__mock/send   {"key":"group:999001","text":"你好"}
  GET  /__mock/out    返回机器人实际发出的消息（JSONL）
```

桥接侧配置：

```json
"snowluma": {
  "wsUrl": "ws://127.0.0.1:3011",
  "httpUrl": "http://127.0.0.1:3010",
  "accessToken": "mock-token",
  "homeDir": "",
  "followDiscoveredEndpoint": false
}
```

`followDiscoveredEndpoint: false` 必须设置，否则桥接连不上时会去读 SnowLuma 配置自愈并改写 URL。

### 4.4 验收标准

1. 桥接日志出现 `SnowLuma 已连接`、`机器人昵称: <mock 返回的昵称>`；
2. `POST /__mock/send` 后日志出现 `已投递`，并在 `/__mock/out` 看到 `send_group_msg`；
3. 断开 mock（`Ctrl+C`）后桥接进入重连循环且不崩溃，重启 mock 后自动恢复。

## 5. 开发循环建议

| 阶段 | 动作 |
| --- | --- |
| 改代码 | 小步改 → `npm run test:audit` → 通过再继续 |
| 需要看真实行为 | 起测试小号全链路（§2）或 mock（§4） |
| 改 preset / 人格 | `node scripts/build-agent-preset-patches.mjs` → `setup-dsh.mjs` → 重启 DSH；**已有会话不会重建 system prompt**，要用新会话验证 |
| 改 MCP 工具 | 先重启桥接，再重启 DSH（工具清单握手时枚举） |
| 提交前 | `python3 scripts/check-publication.py`、`npm run privacy-scan` |

## 6. 测试环境的数据边界

- 测试环境的 `state/` 是**测试数据**：会话映射、记忆、表情库都在里面，**不要**拷回生产；
- `config.json` 里有账号与令牌，不要提交；
- 不要用生产号做测试，也不要让测试桥接指向生产的 OneBot / DSH —— 会出现双回复和会话污染；
- 测试产生的 token 消耗是真实的，联调时可用更低的 `reasoningEffort` 或便宜模型。
