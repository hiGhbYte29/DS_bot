# 测试与开发指南

本文讲**怎么在本地验证改动**，分三种手段，从轻到重：

| 手段 | 需要 QQ | 需要 DSH | 需要网络 | 适合 |
| --- | --- | --- | --- | --- |
| ① 离线回归 | 否 | 否 | 否 | 改纯逻辑、每次提交前 |
| ② 本地全链路（测试小号） | 是 | 是 | 是 | 改桥接调度、会话、发送、人格 |
| ③ 虚拟网关 | 否 | 是 | 是（模型） | 没有可用小号时验证全链路（见 §4） |

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
DSH_HOME=~/.dsh-test dsh plugin --profile web install   # 需要 pnpm；没有的话见 §4.2 ①
DSH_HOME=~/.dsh-test dsh web --host 127.0.0.1 --port 3180 --no-open
```

桥接配置里把 `dsh.baseUrl` 指到 `http://127.0.0.1:3180`。

三个必错点：

1. **忘了 `DSH_HOME`** → 直接写进默认 home，污染现有 DSH；
2. **在错误目录跑 `setup-dsh.mjs`** → 配置里的 MCP 路径指向另一份代码；
3. **整个复制 `~/.dsh`** → 会把原实例的 MCP 路径改写成新目录；只复制 `.credentials.yaml` 就够。

## 4. 虚拟网关（不接 QQ）

[devkit/mock-onebot](../../devkit/mock-onebot/README.md) 是一个本机运行的虚拟 OneBot 网关，顶替 SnowLuma。它零依赖、不引用桥接的代码，生产环境不会运行它。

### 4.1 组成

| 服务 | 地址 | 数据在哪 | 从哪启动 |
| --- | --- | --- | --- |
| 虚拟网关 | HTTP `127.0.0.1:3010`（含聊天界面）/ WS `127.0.0.1:3011` | 内存，重启即清空 | `devkit/mock-onebot` |
| 测试 DSH | `127.0.0.1:3180` | `~/.dsh-test` | 任意目录，`DSH_HOME=~/.dsh-test` |
| 测试桥接 | 控制台 `127.0.0.1:3110` | 本仓库 `qq-bridge/state/` | 本仓库 `qq-bridge` |

三者靠两个环境变量串起来，不用改 `config.json` 里的网关地址：

| 变量 | 作用 |
| --- | --- |
| `QQ_BRIDGE_ONEBOT_WS_URL` | 替换 `snowluma.wsUrl` |
| `QQ_BRIDGE_ONEBOT_HTTP_URL` | 替换 `snowluma.httpUrl` |

规则（实现见 `qq-bridge/src/onebot-route.js`）：两个都不设时不生效；必须同时设置且只能指向本机，否则桥接 / MCP 启动失败；生效时不做鉴权，并关闭 token 自愈与 `config.json` 写回。

`node chain.mjs exec -- <命令>` 会带上这两个变量运行命令。**DSH 和桥接都要用它启动**：MCP 工具是 DSH 拉起的子进程，只给桥接设，收消息走虚拟网关、工具却连真实网关。

> **不能直接用日常的 `~/.dsh`。** 它的 MCP 工具指向 `setup-dsh` 当初运行时所在的那份代码（可能是另一个目录），工具会读那份代码的白名单和控制台端口，把消息交给另一个桥接。测试 DSH 必须在**本仓库**的 `qq-bridge` 里跑 `setup-dsh`。

### 4.2 首次准备（只做一次）

**① 测试 DSH 的数据目录**

```bash
mkdir -p ~/.dsh-test && chmod 700 ~/.dsh-test
cp ~/.dsh/.credentials.yaml ~/.dsh-test/ && chmod 600 ~/.dsh-test/.credentials.yaml   # 只复制凭据

cd qq-bridge                                         # 必须是本仓库的 qq-bridge
DSH_HOME=~/.dsh-test node scripts/setup-dsh.mjs      # 装 preset + MCP，路径指向本仓库
```

`setup-dsh` 最后会自动执行 `dsh plugin --profile web install`，这一步需要 `pnpm`。没有 `pnpm` 时，跳过它再手工补两处（`setup-dsh` 已经建好了插件链接，`plugin install` 剩下的就是这两处）：

```bash
DSH_HOME=~/.dsh-test QQ_BRIDGE_SKIP_DSH_INSTALL=1 node scripts/setup-dsh.mjs
cp ~/.dsh/profiles/web/cordis.yml ~/.dsh-test/profiles/web/cordis.yml
node -e "
const f=require('os').homedir()+'/.dsh-test/profiles/web/package.json', fs=require('fs');
const j=JSON.parse(fs.readFileSync(f,'utf8'));
j.dsh.profile.bundles=['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app',...j.dsh.profile.bundles.filter(b=>!b.startsWith('@deepseek-ai/'))];
fs.writeFileSync(f,JSON.stringify(j,null,2)+'\n');"
```

漏了这一步的表现：DSH 启动时提示 `mcp-snowluma … pending (waiting for service: tools)`，工具一直不加载。

**② 测试桥接的配置** `qq-bridge/config.json`（已被 git 忽略）：

```json
{
  "consolePort": 3110,
  "consoleToken": "<随便生成 16 位以上>",
  "ownerQQ": 20001,
  "allow": { "private": ["20001"], "groups": ["999001"] },
  "dsh": { "baseUrl": "http://127.0.0.1:3180", "provider": "deepseek-official", "model": "deepseek-flash", "reasoningEffort": "low" },
  "snowluma": { "wsUrl": "ws://127.0.0.1:3011", "httpUrl": "http://127.0.0.1:3010", "accessToken": "", "homeDir": "", "followDiscoveredEndpoint": false },
  "agentPreset": "qq-chat",
  "slang": { "enabled": false }
}
```

- `allow` 里是虚拟网关的默认号码（群 `999001`、用户 `20001`）；在聊天界面新建别的群 / 私聊时，也要加进来再重启桥接；
- `snowluma` 段也直接写虚拟网关的地址：万一忘了用 `exec` 启动，桥接也只会连虚拟网关，碰不到真实 QQ；
- `reasoningEffort: low` 省 token，模型调用是真实计费的。

`consoleToken` 可以这样生成：`node -e "console.log(require('crypto').randomBytes(18).toString('base64url'))"`。

### 4.3 每次启动

按 **虚拟网关 → DSH → 桥接** 的顺序。下面的命令都在 `devkit/mock-onebot` 里执行，DSH 和桥接各占一个终端。

**① 虚拟网关**（后台运行）

```bash
cd devkit/mock-onebot
node chain.mjs up
```

输出 `虚拟网关已启动（pid …）` 和聊天界面地址。日志在 `devkit/mock-onebot/.run/mock.log`。

**② 测试 DSH**（终端 A，前台）

```bash
DSH_HOME=~/.dsh-test node chain.mjs exec -- dsh web --host 127.0.0.1 --port 3180 --no-open
```

确认：

- 输出里有 `[snowluma-safe] ⚠️ OneBot 路由已被环境变量覆盖` 和 `[snowluma-host] ⚠️ …`（说明 MCP 工具拿到了变量）；
- 最后一行是 `dsh web: http://127.0.0.1:3180/?token=…`。**要在浏览器里看 DSH，必须打开这个带 token 的链接**；直接开 `http://127.0.0.1:3180` 会提示 `authentication required`。token 每次启动都会变。
- `[qq-tool-restrict] restrict 失败 78/82` 是正常的，日常 DSH 也一样（那些工具本来就不在全局层）。

**③ 测试桥接**（终端 B，前台）

```bash
DSH_HOME=~/.dsh-test node chain.mjs exec -- node ../../qq-bridge/src/bridge.js
```

`DSH_HOME` 也要给桥接：它用这个目录里的凭据登录 DSH。确认日志依次出现：

```
⚠️ OneBot 路由已被环境变量覆盖：WS ws://127.0.0.1:3011，HTTP http://127.0.0.1:3010 …
SnowLuma 已连接：ws://127.0.0.1:3011
机器人昵称: 测试机器人
DSH 已就绪（模式: reserved2）
```

**④ 检查一遍**

```bash
node chain.mjs status        # 应显示「WS 客户端 1 个」，即桥接已连上
```

### 4.4 开始测试

**浏览器**：打开 <http://127.0.0.1:3010>（或 `node chain.mjs ui`）。像聊天软件一样用：切换身份扮演不同群成员、勾「@机器人」、鼠标移到消息上「回复」、选图或直接粘贴图片、拍一拍。左下角可以切换机器人账号的在线 / 收消息状态，或「断开桥接」测重连。

**命令行**：

```bash
node chain.mjs send group:999001 "你好" --at-self     # 群里有人 @ 机器人
node chain.mjs send private:20001 "私聊一下"          # 私聊
node chain.mjs out -f                                # 持续看机器人回了什么
```

机器人不一定每条都回：二代模式下它自己决定说不说话，@ 它最稳。回复一般要等几秒到几十秒。

### 4.5 停止

```bash
# 终端 A、B 里 Ctrl+C，停掉 DSH 和桥接
node chain.mjs down          # 停虚拟网关
```

之后**不带** `chain.mjs exec` 启动，就回到正常路由。测试数据想清掉：删 `qq-bridge/state/`（本仓库的）和 `~/.dsh-test/sessions/`；彻底不要了就删整个 `~/.dsh-test`。

### 4.6 验收

1. 桥接日志出现 4.3 ③ 里的四行；
2. 发消息后桥接日志出现 `[reserved2] 唤醒 group:999001`，聊天界面 / `out` 里出现机器人的回复；
3. 「断开桥接」或 `node chain.mjs drop` 后，桥接几秒内自动重连；
4. `node chain.mjs calls --unhandled` 为空（有内容说明桥接用到了虚拟网关还没实现的动作）。

### 4.7 常见问题

| 现象 | 原因 |
| --- | --- |
| 聊天界面左上角「桥接未连接」 | 桥接没起，或没用 `chain.mjs exec` 启动（连到了别处） |
| 发了消息机器人一直不回，桥接日志也没有「唤醒」 | 号码不在 `config.json` 的 `allow` 里 |
| 桥接日志有「唤醒」，但界面里没有回复 | 看 DSH 终端：MCP 工具是否加载（4.2 ① 漏了补两处）；或者模型选择了不说话 |
| 桥接回复「系统服务重启中，消息已排队」 | DSH 没起，或 `dsh.baseUrl` 不是 `3180` |
| 浏览器打开 DSH 提示 `authentication required` | 要用 DSH 启动时打印的带 `?token=` 的链接 |
| DSH 启动后 MCP `pending (waiting for service: tools)` | 4.2 ① 没执行 `plugin install` 也没手工补那两处 |

## 5. 开发循环建议

| 阶段 | 动作 |
| --- | --- |
| 改代码 | 小步改 → `npm run test:audit` → 通过再继续 |
| 需要看真实行为 | 起测试小号全链路（§2）或虚拟网关（§4） |
| 改 preset / 人格 | `node scripts/build-agent-preset-patches.mjs` → `setup-dsh.mjs` → 重启 DSH；**已有会话不会重建 system prompt**，要用新会话验证 |
| 改 MCP 工具 | 先重启桥接，再重启 DSH（工具清单握手时枚举） |
| 提交前 | `python3 scripts/check-publication.py`、`npm run privacy-scan` |

## 6. 测试环境的数据边界

- 测试环境的 `state/` 是**测试数据**：会话映射、记忆、表情库都在里面，**不要**拷回生产；
- `config.json` 里有账号与令牌，不要提交；
- 不要用生产号做测试，也不要让测试桥接指向生产的 OneBot / DSH —— 会出现双回复和会话污染；
- 测试产生的 token 消耗是真实的，联调时可用更低的 `reasoningEffort` 或便宜模型。
