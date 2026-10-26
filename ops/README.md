# Linux 运维示例

本目录为 AI 辅助生成并整理的公开示例，不是原部署的完整副本。脚本按自身位置定位项目；systemd 模板约定仓库位于 `~/Project/DS_bot`，只管理 DSH 与 qq-bridge，不安装、启动或停止 QQ / SnowLuma。

## 使用前提

先按项目说明安装 Node.js、DSH 和 qq-bridge 依赖，创建私有的 `qq-bridge/config.json`，配置 DSH 模型凭据与 QQ 会话预设。由使用者按 SnowLuma 官方方式独立启动 SnowLuma，并在本机 QQ 完成登录，在 SnowLuma 面板手动对目标 QQ 进程点击“加载”。QQ 重启后通常需要再次加载。

本示例默认 Node 与 DSH 可执行文件分别在 `~/.local/bin/node` 和 `~/.local/bin/dsh`。可先运行 `command -v node`、`command -v dsh` 核对，再修改模板中的 `ExecStart`、`PATH`、`WorkingDirectory` 与 `DSH_HOME`。`%h` 由 systemd 展开为当前用户的主目录；服务运行时不会读取交互式 shell 的 nvm 初始化脚本。

服务依赖只控制启动顺序，不保证 DSH、QQ 或网关已就绪。配置各管理界面和 OneBot 监听回环地址，例如 `127.0.0.1`；端口和鉴权必须与私有配置一致。模板不替你改变 DSH 的监听配置。

## 安装与启动

以下命令从仓库根目录运行。先编辑 `.example` 模板，使路径匹配你的安装位置。如果已经存在同名用户服务，请先自行备份并比较，复制命令会覆盖目标文件。

```bash
mkdir -p "$HOME/.config/systemd/user"
cp ops/systemd/ds-bot-dsh.service.example "$HOME/.config/systemd/user/ds-bot-dsh.service"
cp ops/systemd/ds-bot-bridge.service.example "$HOME/.config/systemd/user/ds-bot-bridge.service"
cp ops/systemd/ds-bot.target.example "$HOME/.config/systemd/user/ds-bot.target"
systemctl --user daemon-reload
systemctl --user start ds-bot.target
```

常用操作：

```bash
systemctl --user status ds-bot-dsh.service ds-bot-bridge.service
node ops/status.mjs
systemctl --user restart ds-bot.target
systemctl --user stop ds-bot.target
```

如需用户会话启动时自动拉起 DSH 与桥接，可自行执行 `systemctl --user enable ds-bot.target`；取消用 `systemctl --user disable ds-bot.target`。这不会自动登录 QQ，也不会自动注入 SnowLuma，不等于无人值守开机恢复。

`status.mjs` 只请求本机只读状态接口，输出连接状态、模式和白名单数量，不发送 QQ 消息或调用模型。任一检查失败时退出码为 1。它依赖 qq-bridge 的已安装依赖和 DSH 本地鉴权；失败不等于已经定位故障根因，也不能代替实际消息收发验收。本文示例仅完成离线检查，没有承诺在所有发行版上通过在线验收。

## 私有配置备份

`maintenance.py` 使用 Python 3 标准库，适用于 Linux。它不会启动服务，不会安装定时任务，不会清理应用日志。执行前应已创建 `qq-bridge/config.json`。

```bash
python3 ops/maintenance.py --dry-run
python3 ops/maintenance.py
python3 ops/maintenance.py --include-dsh --dry-run
python3 ops/maintenance.py --include-dsh
python3 ops/maintenance.py --verify-backup backups/实际备份文件名.tar.gz
```

默认备份范围：

- `qq-bridge/config.json`、角色 Markdown，以及 `mode.json`、`current-role.json`、`initial-prompts.json`、`console-token` 等少量设置文件。
- 本目录的公开运维脚本和 systemd 模板。
- 当前用户安装的 `ds-bot.target`、`ds-bot-dsh.service`、`ds-bot-bridge.service` 与各自 `.d/*.conf`；它们可能包含自定义路径或环境变量。

`--include-dsh` 额外备份 `$DSH_HOME`（默认 `~/.dsh`）中的 `.credentials.yaml`、顶层 Cordis patch，以及 profile 的 Cordis 配置、包清单和锁文件。不存在的可选文件跳过，不要求 SnowLuma 启动脚本或 DSH 凭据存在。符号链接及其下的文件不会备份。

备份**含私有令牌、角色或提示词**，必须留在本机或安全存储，不能提交仓库或公开分享。目录权限为 `0700`，文件为 `0600`；这些是访问权限，不是加密。脚本先校验归档清单和 SHA-256，再保留最近 7 个符合自身命名规则的备份。手动命名的其他文件不会清理。

未包含：QQ / SnowLuma 程序和登录态、SnowLuma 配置、聊天历史、DSH sessions、会话映射、记忆、图片和表情、语音、日志、依赖目录。它不是全系统恢复备份，也不提供自动恢复或解压覆盖。需要恢复时先校验并在临时目录检查内容，再按你当前的安装路径有选择地复制配置。
