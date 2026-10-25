# DSH Agent Terminal

为**当前会话**选择 agent 执行命令时使用的终端，与「标准 / PTC / minimal」等模式选择**完全独立**。

标准模式 + cmd 可以共存；换终端不需要换模式，也不需要重建会话。

> Choose the terminal an agent runs its commands in, per conversation, independently of the agent mode.
> Ships cmd, PowerShell 5.1/7, Git Bash, WSL (per distro) and custom shells, each **actually launched**
> to confirm it works, and tells the model the matching command dialect so it does not emit `dir`
> inside bash or `ls` inside cmd.

## 安装

这是一个 DSH profile 插件包。先克隆，再以本地包目录安装：

```powershell
git clone https://github.com/ZhaoHanshao/dsh-plugin-agent-terminal.git
# 在 DSH 里用 plugin_manager 指向该目录：
#   action: install_bundle
#   target: <克隆出来的绝对路径>
```

安装后刷新页面，会话头部右侧会出现终端按钮。

要求：DSH（DeepSeek Harness）客户端；Windows 上已验证，POSIX 平台的探测逻辑同样适用。

## 界面位置

选择器出现在**两处**，同一个组件：

| 位置 | 槽位 | 作用域 |
|---|---|---|
| 会话头部右侧工具区 | `conversation.session.header.utilities`（order `-8`，夹在「在应用中打开」和「定时任务」之间） | 当前会话 |
| 新会话落地页那一行 | `conversation.hero.options`（order `10`，紧跟 workspace 与预设/模式控件之后） | 新会话默认 |

- 不占用左侧栏入口
- 没有独立的终端页面
- 有会话时写入该会话；新会话页尚无可绑定会话时自动写入「新会话默认」，下拉标题随之显示对应范围
- 新会话行用的是紧凑变体（隐藏版本徽标），以适配该行的密度

新会话页那一行紧邻模式选择器，正好体现核心设计：**换终端不必换模式**。

按钮显示当前终端名；未接管时显示「跟随默认」。展开后列出探测到的终端（含版本与可用性）、「跟随默认」项，以及自定义路径入口。

## 机制

agent 执行命令的链路是 `tool-pwsh` → `ctx.shell` → executor。这条路本身**不能**按会话变化：

- `ctx.shell` 是进程级单例，`ShellExecRequest` 里没有 session/agent 字段
- executor 的可执行文件写死（`bash-local` 是 `['bash','-c',…]`，`pwsh-local` 是 `[pwshPath,…, '-Command', …]`）
- profile 插件无法 import DSH 内部包（实测 `import.meta.resolve` → `ERR_MODULE_NOT_FOUND`），所以也无法子类化

本插件走的是**工具层按会话遮蔽**：

1. 在 `agent.ctx.tools` 里注册同名工具，会**遮蔽**该会话的全局同名工具（实测有效，且不影响其他会话）。
2. 选择 cmd / bash 时注册对应工具，并用 `restrict({deny:['pwsh']})` 隐藏原生工具，模型只会看到方言正确的那一个。
3. 执行走 `ctx.subprocess` + `ctx.sandbox`（profile 插件可直接使用，实测 `spawn exit: 0`、`enforcement: partial`）。

因此**模式（preset）完全不受影响** —— 它决定 agent 有哪些能力，本插件只决定这些能力用哪个终端执行。

## 安全设计

切换时**先装新工具、成功后才撤销旧的**。若新终端校验失败或注册抛错，旧工具与原生工具都保持原样 —— 切换终端绝不会把会话变成哑的。

## 终端探查

按 `PATH` + `PATHEXT` + 已知安装位置逐个解析，然后**实际启动一次**确认可用并取版本号，而不是文件存在就列。

处理了四个 Windows 特有的坑：

| 坑 | 现象 | 处理 |
|---|---|---|
| Store 别名是 reparse point | `statSync` 抛 `EACCES`，pwsh 7 被误判为没装 | `stat` 失败时退回 `lstat` |
| `wsl --list` 输出 UTF-16LE | 得到 `U b u n t u` | 按 `utf16le` 解码 |
| `spawnSync` 读 wsl 输出为空 | exit 0 但 stdout 空 | 重定向到临时文件再读 |
| `%SystemRoot%\System32\bash.exe` 是 WSL 启动器 | 与 Git Bash 重复 | 由发行版枚举代表，不单独列 |

WSL 按发行版展开（`Ubuntu` 等），跳过 `docker-desktop` 这类内部发行版。

## 路由

全部在 `/agent-shell/api` 下，除 `token` 外都要求 `x-agent-shell-token` 头 + 同源校验。

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/token` | 令牌（同时注入页面 `<meta>`） |
| GET | `/shells?refresh=1` | 探测终端列表 |
| GET | `/selection?session=` | 读当前选择 |
| GET | `/diagnostics?session=` | 自检：当前生效的工具名、prompt 段落是否注册、注入的原文 |
| POST | `/selection` | 写选择（`scope: session \| default`，`shellId: null` 表示不接管） |
| POST | `/verify` | 验证自定义终端绝对路径，**成功即登记**并持久化 |

## 让模型用对话言（提示词）

只把工具改名成 `bash` 并不够：模型看到 `D:\...` 这样的 Windows 路径，仍会按
「Windows ⇒ cmd」的惯性写出 `dir`、`copy`、`type`。因此对 bash 家族（含
`niu.exe` 这类自带 bash 的终端）注入两层约束：

1. **工具描述**：明确列出禁止的 cmd / PowerShell 惯用法，并给出对应替代
   （`dir`→`ls`、`copy`→`cp`、`%VAR%`/`$env:VAR`→`$VAR`），同时说明盘符形态
   （MSYS 为 `/c/code`，WSL 为 `/mnt/c/code`）。
2. **system prompt 段落**（`agent-terminal:dialect`，注册在该会话作用域）：
   在模型决定第一行命令写法之前就给出方言约定。cmd / PowerShell 终端则不注入
   禁止项，只陈述自身语法。

可用 `/diagnostics?session=` 核实实际注入内容，例如：

```
tool=bash  promptRegistered=True
prompt: The shell tool runs bash (Niubash (niu.exe)). Write POSIX shell: ls, cp, rm, ...
```

## 自定义终端

添加 `D:\App\Niubash\Bash\niu.exe` 这类自带 bash 的终端时，流程是：

1. `POST /verify` 实际启动一次确认可用（本例返回 `Niubash 1.4.4`）
2. **登记进发现列表**，并把路径写入选择文件的 `customPaths`
3. `POST /selection` 才能接受它

第 2 步曾经缺失：`/verify` 只验证不登记，而 `/selection` 只认发现列表里的 id，于是验证明明通过、选中却返回 `unknown-shell` —— 这就是自定义终端「加不进去」的根因。现在两处都修了，并且 `/selection` 收到未登记的 `custom:<绝对路径>` 时会就地验证并自动登记。

路径会被规范化（`D:\\\\App` 与 `D:\App` 视为同一终端），`customPaths` 读取时
自动合并重复项，因此手输或转义产生的重复不会堆积。

重启后 `customPaths` 与配置的 `extraShells` 合并回发现流程，自定义终端不会丢。

标签取版本串里的产品名，例如 `Niubash (niu.exe)`，比纯文件名易认。

## 配置

```yaml
- id: agent-terminal
  name: 'dsh-plugin-agent-terminal'
  config:
    timeoutMs: 120000        # 命令默认超时
    maxOutputBytes: 262144   # 单流输出上限
    verify: true             # 是否实际启动验证
    defaultShellId: null     # 新会话默认终端；null = 不接管
    extraShells: []          # 额外手工添加的绝对路径
```

## 已验证

- 本机探测到 5 个终端，全部**实际启动验证通过**：cmd、PowerShell 5.1 (5.1.26100.9711)、PowerShell 7 (7.6.8)、Git Bash (5.2.26)、WSL (2.6.3.0)
- 按会话绑定 gitbash 后，本会话的 shell 工具由 `pwsh` 变为 `bash`，真实运行于 Msys Git Bash，中文输出正常
- 切回原生后 `pwsh` 工具恢复，往返无损
- 会话头部选择器已注册（`agent-terminal`，order `-8`，active）；左侧栏与主面板**均已无**本插件入口
- 新会话页选择器已注册（`agent-terminal-hero`，order `10`，active）
- `default` 作用域读写正常（新会话页走这条路径），返回 `defaultShellId` 与完整终端信息
- 自定义终端 `D:\App\Niubash\Bash\niu.exe`：`/verify` 通过 → 出现在发现列表 → `/selection` 返回 200 → 实测 `whoami` 输出 `niu`，中文正常
- 自定义终端跨重启仍被发现（`customPaths` 持久化 + `refresh=1` 实测）
- 切到 `niu.exe` 后模型侧工具确为 `bash`，描述含「NOT cmd.exe / NOT PowerShell」及替代命令表；`/diagnostics` 报 `promptRegistered=True`，段落文本正确
- 重复分隔符路径（`D:\\\\App`）被规范化，`customPaths` 读取时自愈合并没有堆积
- 未知终端返回 400；无令牌/错令牌返回 403

## 已知限制

- 一次调用一个全新进程，**无 PTY**：`vim`、`top` 等交互式程序不可用。
- 会话 id 取自 `agent.id`；尚未开始的会话只能设置「新会话默认」。
- 插件目录名与包名必须一致地叫 `dsh-plugin-agent-terminal`：`clientModules` 会把「不是客户端包」的否定结论按 specifier 缓存到重启，改名是唯一无需重启的补救方式。
