# 本地部署指南（从零到可用）

本文面向**第一次独立部署**的开发者：在一台机器上装好 DSH、桥接、网关，把 QQ 消息接进来，并确认整条链路能收发。

> 版本对应：本仓库桥接 `v0.2.1-r1` 适配 **DSH 0.2.1-rc.2**（0.2.0-rc.2 亦兼容）。DSH 大版本不匹配时先看 [DSH_021_ADAPTATION.md](../qq-bridge/docs/guides/DSH_021_ADAPTATION.md)。
>
> 本文不包含任何账号、令牌或私有配置；下文出现 `<...>` 的地方都需要替换成你自己的值。

## 0. 架构与前置条件

```
QQ 客户端 ←(注入)→ SnowLuma ←(OneBot v11)→ qq-bridge ←(Web API/事件流)→ DSH ←→ 模型 API
                                              ↘ (MCP 工具) ↗-
```

需要准备：

| 项 | 要求 | 说明 |
| --- | --- | --- |
| 操作系统 | Linux（推荐）或 Windows | 下文命令以 Linux 为主，Windows 差异见 §9 |
| Node.js | ≥ 22.13 | `node -v`、`npm -v` |
| QQ | 桌面客户端，已登录 | 建议先用小号试 |
| SnowLuma | 自行从官方 Release 获取 | 本仓库不打包、不代装（见 [snowluma/README.md](../snowluma/README.md)） |
| 模型凭据 | DeepSeek API Key 或 DSH 支持的 provider | 交给 DSH 管理，不要写进桥接配置 |
| 端口 | 3080 / 3100 / 3000 / 3001 / 5099 | 均可改，但要与配置一致 |

## 1. 获取代码

```bash
git clone https://github.com/hiGhbYte29/DS_bot.git
cd DS_bot/qq-bridge
npm ci
```

`postinstall` 会修补 `@snowluma/sdk` 的 ESM 打包问题，正常输出形如 `[patch-snowluma] … 合计 13 个文件`。

## 2. 安装并运行 DSH

```bash
# 安装（版本需与桥接匹配，见文首）
npm i -g @deepseek-ai/dsh
dsh --version

# 配置模型凭据（首次会引导；也可编辑 $DSH_HOME/.credentials.yaml）
dsh web --host 127.0.0.1 --port 3080 --no-open
```

DSH 默认 home 为 `~/.dsh`，可用 `DSH_HOME` 覆盖。启动后浏览器打开 `http://127.0.0.1:3080` 应能看到界面。

> 桥接不需要 DSH 的进程启动 token：它用 `$DSH_HOME/.credentials.yaml` 里持久化的签名密钥离线铸造会话 Cookie，因此 `config.json` 的 `dsh.authToken` 一般留空。

## 3. 创建桥接配置

```bash
cp config.example.json config.json      # Windows: copy config.example.json config.json
```

`config.json` 不会入库（已被 `.gitignore` 忽略）。至少需要改这些字段：

| 字段 | 说明 |
| --- | --- |
| `dsh.baseUrl` | DSH 地址，默认 `http://127.0.0.1:3080` |
| `dsh.provider` / `dsh.model` | 桥接为每个 QQ 会话固定使用的模型；填 DSH 里可用的值 |
| `snowluma.wsUrl` | OneBot **WebSocket** 地址，如 `ws://127.0.0.1:3001` |
| `snowluma.httpUrl` | OneBot **HTTP API** 地址，如 `http://127.0.0.1:3000`（**不要**填 WS 端口） |
| `snowluma.accessToken` | OneBot HTTP token；未配置鉴权可留空 |
| `snowluma.homeDir` | SnowLuma 安装目录，用于 token 自愈（见 §5） |
| `ownerQQ` | 你的 QQ 号，用于审批与管理员命令 |
| `allow.private` / `allow.groups` | 白名单；**留空且 `allowAllWhenEmpty=false` 时机器人不响应任何消息** |
| `consolePort` / `consoleToken` | 本地控制台端口 / 访问令牌（留空自动生成并写入 `state/console-token`） |

## 4. 安装 DSH 端（preset + MCP）

这一步最容易漏，漏了 QQ 上会「毫无反应」：

```bash
node scripts/setup-dsh.mjs
dsh plugin --profile web install
```

它会：

1. 安装 `qq-chat` / `qq-chat-v2` 两个 agent preset（`plugins/qq-agent-presets`）；
2. 在 `$DSH_HOME/profiles/web/cordis.patch.yml` 挂载三个 MCP server（QQ 工具、网关探活、安全联网搜索）；
3. 在 profile 里注册 `qq-mode-console` 与 `qq-agent-presets` 两个 bundle；
4. 把默认运行模式设为 `reserved2`（二代仿真）。

装完**必须重启 DSH**（preset 与 MCP 在启动时枚举）。

> `dsh plugin install` 需要 `pnpm` 在 PATH 中；没有就 `npm i -g pnpm`。
> 仓库目录移动过、或换机器重新 clone 后，要**重跑一次** `setup-dsh.mjs`——`cordis.patch.yml` 里写的是绝对路径。

## 5. 接入 QQ（SnowLuma）

1. 启动 QQ 并登录，保持在线。
2. 按 SnowLuma 官方说明启动它（Linux `./launcher.sh`，Windows `launcher.bat`），浏览器打开 `http://127.0.0.1:5099`，用启动日志里的初始密码登录，完成协议同意与改密。
3. 进程页选中本机 QQ 进程 → 点「加载」。日志出现 `pipe connected` 才算注入成功。
4. OneBot 页面开启 **WebSocket 服务端**（默认 3001）与 **HTTP API**（默认 3000），设置 accessToken。
5. 把地址和 token 填进 `config.json`。

已知行为：

- **同一账号的 HTTP token 与 WS token 不同**，所以桥接首次连接常出现 `code=1006` 后自动自愈重连，打出 `SnowLuma 已连接` 即正常；
- 自愈依赖 `snowluma.homeDir` 指向真正的安装目录（读取其中 `config/onebot_<QQ号>.json`）；
- 若「已连接但收不到消息」，先看 SnowLuma 日志里的 `[Hook]` 行，那是它的原生注入层，不是桥接的问题；
- Linux 上若注入报 `COMPONENT_LOAD_FAILED`，通常是内核 YAMA 限制，见 §8 排错表。

## 6. 启动与验收

```bash
cd qq-bridge
npm start            # 前台运行；Windows 可用 start.bat（崩溃自动重启）
```

另一个终端：

```bash
cd ..
node ops/status.mjs
```

期望输出三项均正常：

```json
{
  "gateway": { "ok": true, "online": true, "good": true },
  "dsh":     { "ok": true, "mode": "reserved2" },
  "bridge":  { "ok": true, "connected": true, "online": true }
}
```

然后做一次真实往返：用白名单内的 QQ 给机器人发一条消息，日志应出现

```
[bridge] 已投递 private:<你的QQ>: 你好
[bridge] agent 回复 (private:<你的QQ>) N 字
```

`reserved2`（二代仿真）模式下，模型的普通文本**不会**自动转发到 QQ，必须调用 `qq_send_message` 等工具才发言——所以「模型跑了但没消息」通常是它没调发送工具。

## 7. 常驻运行（Linux，可选）

仓库提供用户级 systemd 模板：[ops/systemd](../ops/systemd)。先按实际路径修改 `.example` 里的 `ExecStart` / `WorkingDirectory` / `DSH_HOME`，再复制到 `~/.config/systemd/user/`，`systemctl --user daemon-reload && systemctl --user start ds-bot.target`。

注意：模板只管理 DSH 与桥接；SnowLuma 与 QQ 登录需要你自己保证。**不要同时运行 systemd 服务和手动启动的第二份桥接**（有单实例锁，但排查时容易混乱）。

## 8. 排错

| 现象 | 排查方向 |
| --- | --- |
| 桥接启动即退出 | 是否已有实例（`state/bridge.lock`）；`config.json` 是否缺字段 |
| 控制台打不开 / 401 | 令牌在 `state/console-token`；请求头是 `x-console-token`（或 `?token=`） |
| 发送报 401 / `unauthorized` | `snowluma.accessToken` 与 OneBot 的 HTTP token 不一致 |
| 发送报 426 | `httpUrl` 填成了 WebSocket 端口 |
| QQ 上完全没反应 | ① 桥接有没有「已投递」；② 白名单是否命中；③ DSH 是否装了 preset |
| 能唤醒但没回复 | 会话是否挂在 `qq-chat-v2`；模型是否调用了发送工具 |
| MCP 工具列表里没有新工具 | 先重启桥接，再重启 DSH（工具在握手时枚举） |
| 改了 preset 不生效 | `node scripts/build-agent-preset-patches.mjs` → `setup-dsh.mjs` → 重启 DSH；已有会话不会重建 system prompt |
| Linux `[Hook] load failed … COMPONENT_LOAD_FAILED` | 内核禁止跨进程 ptrace：`sudo sysctl -w kernel.yama.ptrace_scope=0`，或给 SnowLuma 的 node `setcap cap_sys_ptrace+ep` |
| 面板显示已连接但无账号信息 | 注入发生在登录之后，登录事件不会重放：打开 hookAutoLoad 后重启 SnowLuma |
| Linux QQ 双击无反应 | Electron 沙箱校验失败：`--no-sandbox` 启动，或 `sudo chown root:root chrome-sandbox && sudo chmod 4755 chrome-sandbox` |

更多失效模式见 [known-issues.md](known-issues.md)。

## 9. 平台差异（Windows）

| Linux | Windows |
| --- | --- |
| `cp config.example.json config.json` | `copy config.example.json config.json` |
| `npm start` | `start.bat`（守护模式）或 `npm start` |
| 手动 `kill` | `restart.bat`（杀旧实例 + 清锁 + 重启） |
| `snowluma/launcher.sh` | SnowLuma 目录下 `launcher.bat` |

其余配置字段完全一致；端口与路径按本机实际情况填。

## 10. 数据与安全

- **不进仓库**：`config.json`、`state/`、`roles/*.md`（个人角色卡）、`snowluma/`、`node_modules/`。提交前可跑 `python3 scripts/check-publication.py` 与 `npm run privacy-scan`。
- **默认 fail-closed**：白名单为空且 `allowAllWhenEmpty=false` 时机器人不响应任何消息。接入真实群前先填白名单。
- **QQ 账号即权限**：把 agent 接进群等于把账号发言权交给模型，建议先在小号/测试群验证。
- **数据出机**：QQ 消息会经 DSH 发送给模型服务方；搜索类工具会把关键词发给你配置的搜索后端。公开部署前请自行评估。
- **控制台令牌**等同管理权限，不要贴进聊天记录或提交到仓库。

## 11. 升级

```bash
git pull --ff-only
cd qq-bridge && npm ci
# 若仓库目录变过：node scripts/setup-dsh.mjs
```

重启规则：

| 改动 | 重启 |
| --- | --- |
| `qq-bridge/src/*` | 桥接 |
| `plugins/`、`cordis.patch.yml` | DSH |
| `dsh/agent-presets/` | 重新生成 preset + `setup-dsh` + DSH |
| 文档 / README | 不需要 |

验收：`node ops/status.mjs` 全绿 + 一次真实消息往返。
