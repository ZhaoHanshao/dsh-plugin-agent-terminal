/**
 * dsh-plugin-agent-shell — 让 agent 执行命令时使用你为「当前会话」选择的终端，
 * 与标准/PTC/minimal 等模式选择完全独立。
 *
 * ## 为什么不能用 preset 实现
 * preset 是「模式」，一个会话只能选一个 preset。把终端做成 preset 就意味着
 * 「标准模式 + cmd」不可共存 —— 正是要避免的。而且 `agentPresets.select()`
 * 在会话首轮后抛 `agent-preset/locked`，无法改已在运行的会话。
 *
 * ## 实际使用的机制（均已实测）
 * `ctx.tools.register` 在 **agent 作用域**注册同名工具会**遮蔽**全局同名工具，
 * 且只对该会话生效。因此：
 *   - 未选择时：什么都不做，原生 `pwsh` 工具照常工作（零影响）。
 *   - 选择 cmd/bash 时：在该会话作用域注册对应工具，并 `restrict({deny:['pwsh']})`
 *     隐藏原生工具，模型只会看到正确的那个。
 *   - 选择 powershell 时：注册同名 `pwsh` 遮蔽原生，换成绑定到所选可执行文件的实现。
 * 会话切换终端时销毁旧注册、重建，不需要重启、不需要 preset。
 *
 * 执行走 `ctx.subprocess` + `ctx.sandbox`（profile 插件可直接使用，已实测
 * `spawn exit: 0`、`enforcement: partial`），因此不需要 import 任何 DSH 内部包
 * （profile 插件 import 会 ERR_MODULE_NOT_FOUND）。
 *
 * @module dsh-plugin-agent-shell
 */

import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, readFileSync, statSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve as resolvePath } from 'node:path'

export const name = 'agent-shell'
export const inject = ['webServer']

// #region 常量

const API_PREFIX = '/agent-shell/api'
const TOKEN_META_NAME = 'dsh-agent-shell'
const TOKEN_HEADER = 'x-agent-shell-token'
const MAX_BODY_BYTES = 64 * 1024
const CMD_SCRIPT_NAME = 'agent-shell-command.cmd'

/** Windows 上按 PATHEXT 补全扩展名。 */
const DEFAULT_PATHEXT = ['.COM', '.EXE', '.BAT', '.CMD', '.VBS', '.JS', '.PS1']

/**
 * 终端候选清单。`family` 决定命令如何拼成 argv，`sources` 是发现它的位置。
 * 顺序即 UI 中的默认排序。
 */
const SHELL_CANDIDATES = [
  // —— Windows ——
  { id: 'cmd', label: '命令提示符', family: 'cmd', program: 'cmd.exe', known: ['%SystemRoot%\\System32\\cmd.exe'] },
  { id: 'powershell', label: 'Windows PowerShell 5.1', family: 'powershell', program: 'powershell.exe', known: ['%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'] },
  { id: 'pwsh', label: 'PowerShell 7', family: 'powershell', program: 'pwsh.exe', known: ['%ProgramFiles%\\PowerShell\\7\\pwsh.exe', '%ProgramFiles(x86)%\\PowerShell\\7\\pwsh.exe', '%LOCALAPPDATA%\\Microsoft\\WindowsApps\\pwsh.exe'] },
  { id: 'gitbash', label: 'Git Bash', family: 'posix', program: 'bash.exe', known: ['%ProgramFiles%\\Git\\bin\\bash.exe', '%ProgramFiles(x86)%\\Git\\bin\\bash.exe', '%LOCALAPPDATA%\\Programs\\Git\\bin\\bash.exe'] },
  { id: 'wsl', label: 'WSL', family: 'wsl', program: 'wsl.exe', known: ['%SystemRoot%\\System32\\wsl.exe'] },
  // —— POSIX ——
  { id: 'bash', label: 'bash', family: 'posix', program: 'bash', known: ['/bin/bash', '/usr/bin/bash'] },
  { id: 'zsh', label: 'zsh', family: 'posix', program: 'zsh', known: ['/bin/zsh', '/usr/bin/zsh'] },
  { id: 'sh', label: 'sh', family: 'posix', program: 'sh', known: ['/bin/sh', '/usr/bin/sh'] },
  { id: 'fish', label: 'fish', family: 'posix', program: 'fish', known: ['/usr/bin/fish', '/usr/local/bin/fish'] },
]

/** 各家族在 UI 上的语法提示。 */
const FAMILY_HINT = {
  cmd: 'cmd 语法：%VAR%、dir、copy；原生 C:\\ 路径',
  powershell: 'PowerShell 语法：$env:NAME、Get-ChildItem；原生 C:\\ 路径',
  posix: 'POSIX 语法：$VAR、ls、cp；Windows 盘符为 /c/...',
  wsl: 'WSL bash：$VAR、ls；C:\\code 为 /mnt/c/code',
}

// #endregion

// #region 配置

/** 插件配置。 */
export function resolveConfig(config = {}) {
  return {
    /** 默认终端 id；未选择会话时使用。`null` 表示保持原生工具不动。 */
    defaultShellId: typeof config.defaultShellId === 'string' ? config.defaultShellId : null,
    /** 命令默认超时。 */
    timeoutMs: Number.isFinite(config.timeoutMs) ? config.timeoutMs : 120_000,
    /** 单流输出上限。 */
    maxOutputBytes: Number.isFinite(config.maxOutputBytes) ? config.maxOutputBytes : 262_144,
    /** 是否在发现时实际启动一次以确认可用。 */
    verify: config.verify !== false,
    /** 校验单次超时。 */
    verifyTimeoutMs: Number.isFinite(config.verifyTimeoutMs) ? config.verifyTimeoutMs : 8_000,
    /** 额外手工添加的终端路径。 */
    extraShells: Array.isArray(config.extraShells) ? config.extraShells : [],
  }
}

// #endregion

// #region 终端发现

/** 展开 `%VAR%` 与 `~`。 */
function expandPath(entry, env) {
  if (typeof entry !== 'string') return undefined
  let out = entry.trim()
  if (out.length === 0) return undefined
  if (out.startsWith('~')) out = join(env.HOME ?? homedir(), out.slice(1))
  out = out.replace(/%([^%]+)%/g, (whole, key) => env[key] ?? whole)
  return out
}

/** PATH 目录列表。 */
function pathDirectories(env) {
  const raw = env.PATH ?? env.Path ?? ''
  const separator = raw.includes(';') ? ';' : ':'
  return raw.split(separator)
    .map((entry) => entry.trim().replace(/^"|"$/g, ''))
    .filter((entry) => entry.length > 0)
}

/**
 * 判断是否为可执行文件。
 *
 * Windows Store 的 app execution alias（如 `WindowsApps\pwsh.exe`）是
 * reparse point：`statSync` 会因目标 ACL 抛 `EACCES`，但 `lstatSync` 能读到它
 * 本身，且 `CreateProcess` 能正常解析。因此用 `lstat`，并把 reparse point
 * 视作可执行；普通目录永远不算。
 */
function isExecutableFile(path) {
  try {
    const stat = statSync(path)
    if (stat.isDirectory()) return false
    return true
  } catch {
    // stat 失败（reparse point 的 EACCES）时退回 lstat。
    try {
      const link = lstatSync(path)
      return link.isFile() || link.isSymbolicLink()
    } catch {
      return false
    }
  }
}

/**
 * 规范化一个绝对路径。
 *
 * 用户手输或经 JSON 转义后，同一路径可能带重复分隔符（`D:\\\\App` 与 `D:\\App`）。
 * 若不规范化，同一个终端会以不同 id 重复出现，并在持久化文件里堆积。
 * @returns 规范化后的路径；非绝对路径原样返回。
 */
function normalizePath(candidate) {
  if (typeof candidate !== 'string') return candidate
  const trimmed = candidate.trim()
  if (trimmed === '') return trimmed
  try {
    return isAbsolute(trimmed) ? resolvePath(trimmed) : trimmed
  } catch {
    return trimmed
  }
}

/** 去重后的路径列表，按规范化形式合并。 */
function uniquePaths(paths) {
  const seen = new Set()
  const out = []
  for (const entry of paths) {
    const normalized = normalizePath(entry)
    if (typeof normalized !== 'string' || normalized === '') continue
    const key = normalized.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(normalized)
  }
  return out
}

/**
 * 自定义终端显示名的统一推导：版本串里通常带产品名，
 * 例如 `Niubash 1.4.4 — bash-compatible shell for Windows` ⇒ `Niubash (niu.exe)`。
 * 纯文件名做标签太难认，所有入口共用这一处以免标签不一致。
 */
function brandLabel(entry) {
  if (entry?.kind !== 'custom' || typeof entry.version !== 'string') return entry
  const branded = /^([A-Za-z][\w.+-]*)\s+\d+\.\d+/.exec(entry.version)
  if (branded === null) return entry
  return { ...entry, label: `${branded[1]} (${basename(entry.path)})` }
}

/**
 * 在 PATH 与已知位置中解析一个可执行文件。
 * @param program 程序名，如 `pwsh.exe`。
 * @param known 已知绝对位置（可含 `%VAR%`）。
 * @returns 第一个存在的位置。
 */
function resolveExecutable(program, known, env) {
  for (const candidate of known) {
    const expanded = expandPath(candidate, env)
    if (expanded !== undefined && isAbsolute(expanded) && isExecutableFile(expanded)) return expanded
  }
  if (process.platform !== 'win32') {
    for (const dir of pathDirectories(env)) {
      const full = join(dir, program)
      if (isExecutableFile(full)) return full
    }
    return undefined
  }
  const extensions = (env.PATHEXT ?? DEFAULT_PATHEXT.join(';')).split(';').filter((e) => e.length > 0)
  const hasExtension = extensions.some((ext) => program.toLowerCase().endsWith(ext.toLowerCase()))
  const names = hasExtension ? [program] : extensions.map((ext) => program + ext.toLowerCase())
  for (const dir of pathDirectories(env)) {
    for (const candidate of names) {
      const full = join(dir, candidate)
      if (isExecutableFile(full)) return full
    }
  }
  return undefined
}

/**
 * 枚举 WSL 发行版。
 *
 * 两个 Windows 特有的坑，都必须处理，否则一个发行版都列不出来：
 *  1. `wsl.exe --list` 输出是 **UTF-16LE**，按 UTF-8 读会得到 `U b u n t u`。
 *  2. Node 的 `spawnSync` 在 Windows 上经管道读取该输出时会拿到空串
 *     （实测 exit 0 但 stdout 为空），因此改为重定向到临时文件再按 UTF-16LE 读。
 */
function discoverWslDistros(env) {
  if (process.platform !== 'win32') return []
  const wsl = join(env.SystemRoot ?? 'C:\\Windows', 'System32', 'wsl.exe')
  if (!isExecutableFile(wsl)) return []
  const tmpFile = join(process.env.TEMP ?? process.env.TMP ?? homedir(), `agent-shell-wsl-${Date.now()}.txt`)
  try {
    const result = spawnSync(wsl, ['--list', '--quiet'], {
      timeout: 10_000,
      windowsHide: true,
      // 关键：让子进程直接把输出写进文件，绕开管道编码问题。
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'buffer',
    })
    let buffer = result.stdout ?? Buffer.alloc(0)
    if (buffer.length === 0) {
      // 兜底：用 cmd 重定向到文件再读。
      spawnSync('cmd.exe', ['/d', '/s', '/c', `"${wsl}" --list --quiet > "${tmpFile}" 2>nul`], {
        timeout: 10_000,
        windowsHide: true,
        stdio: 'ignore',
      })
      if (existsSync(tmpFile)) buffer = readFileSync(tmpFile)
    }
    if (buffer.length === 0) return []
    const looksUtf16 = buffer.length > 2 && buffer[1] === 0
    const text = looksUtf16 ? buffer.toString('utf16le') : buffer.toString('utf8')
    return text.split(/\r?\n/)
      .map((line) => line.replace(/\0/g, '').replace(/^\s*\*?\s*/, '').trim())
      // `docker-desktop` 之类的内部发行版不是可用终端，跳过。
      .filter((line) => line.length > 0 && !/^docker-desktop/.test(line))
  } catch {
    return []
  } finally {
    try { if (existsSync(tmpFile)) rmSync(tmpFile, { force: true }) } catch {}
  }
}

/**
 * 解码子进程输出。Windows 原生命令常输出 UTF-16LE（`wsl --version` 就是），
 * 直接按 UTF-8 读会得到 `W S L   版本` 这样的插零字符。
 * @param text 已按 UTF-8 解码的字符串。
 * @returns 去除插零后的可读文本。
 */
function normalizeProbeText(text) {
  if (typeof text !== 'string' || text.length === 0) return ''
  // 插零判定：可打印字符之间有大量 U+0000。
  const zeros = (text.match(/\u0000/g) ?? []).length
  if (zeros > text.length * 0.2) {
    return text.replace(/\u0000/g, '')
  }
  return text
}

/** 版本探测命令（拿不到就省略）。 */
function versionArgv(family, path) {
  switch (family) {
    // cmd 没有版本参数，用一条无害命令确认它真能执行。
    case 'cmd': return [path, '/d', '/s', '/c', 'echo ok']
    case 'powershell': return [path, '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()']
    case 'posix': return [path, '--version']
    case 'wsl': return [path, '--version']
    default: return undefined
  }
}

/**
 * 实际启动一次以确认终端可用，并尽量取版本号。
 * 这是「探查」的核心：只列真正跑得起来的终端，而不是文件存在就列。
 * @param subprocess 子进程服务；不可用时退化为存在性判断。
 */
async function verifyShell(subprocess, shell, config) {
  const argv = versionArgv(shell.family, shell.path)
  if (argv === undefined || subprocess === undefined) return { verified: undefined }
  // 带发行版参数的 WSL 探测要保留 -d。
  const effective = shell.family === 'wsl' && shell.distro !== undefined
    ? [shell.path, '-d', shell.distro, '--exec', 'echo', 'ok']
    : argv
  let handle
  try {
    handle = subprocess.spawn({
      argv: effective,
      cwd: shell.cwd ?? process.cwd(),
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: 4096 },
        stderr: { maxBytes: 4096 },
      },
      graceMs: 2000,
    })
    let timerHandle
    const timer = new Promise((resolve) => {
      timerHandle = setTimeout(resolve, config.verifyTimeoutMs, 'timeout')
    })
    const outcome = await Promise.race([handle.done, timer])
    clearTimeout(timerHandle)
    if (outcome === 'timeout') {
      try { handle.kill?.() } catch {}
      return { verified: false, reason: '启动超时' }
    }
    const stdout = normalizeProbeText(handle.collected?.stdout?.readFrom(0)?.text ?? '')
    const stderr = normalizeProbeText(handle.collected?.stderr?.readFrom(0)?.text ?? '')
    const firstLine = (stdout.trim() || stderr.trim()).split(/\r?\n/)[0]?.trim() ?? ''
    const spawnFailed = /spawn failed|ENOENT|EPERM|EACCES/i.test(stderr)
    return {
      verified: !spawnFailed,
      version: firstLine.length > 0 && firstLine.length < 120 ? firstLine : undefined,
      ...spawnFailed ? { reason: stderr.split(/\r?\n/)[0] } : {},
    }
  } catch (error) {
    try { handle?.kill?.() } catch {}
    return { verified: false, reason: String(error?.message ?? error) }
  }
}

/**
 * 发现本机可用终端。
 * @returns 每个候选终端及其可用性、版本与语法提示。
 */
export async function discoverShells({ subprocess, config, env = process.env, log }) {
  const found = []
  const seen = new Set()
  const push = (entry) => {
    const key = entry.path.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    found.push(entry)
  }

  for (const candidate of SHELL_CANDIDATES) {
    const path = resolveExecutable(candidate.program, candidate.known, env)
    if (path === undefined) continue
    // `%SystemRoot%\System32\bash.exe` 是 WSL 启动器，不是独立的 POSIX bash；
    // 它由下面的 WSL 发行版枚举代表，重复列出只会让用户选到同一个东西。
    if (process.platform === 'win32' && candidate.id === 'bash') continue
    push({
      id: candidate.id,
      name: candidate.program,
      label: candidate.label,
      family: candidate.family,
      path,
      hint: FAMILY_HINT[candidate.family],
      kind: 'builtin',
    })
  }

  // WSL 的每个发行版都是独立可选项；没有枚举到发行版时退回通用 wsl 项。
  const wslPath = resolveExecutable('wsl.exe', ['%SystemRoot%\\System32\\wsl.exe'], env)
  if (wslPath !== undefined) {
    const distros = discoverWslDistros(env)
    if (distros.length === 0) {
      push({
        id: 'wsl',
        name: 'wsl.exe',
        label: 'WSL',
        family: 'wsl',
        path: wslPath,
        hint: FAMILY_HINT.wsl,
        kind: 'wsl',
      })
    } else {
      for (const distro of distros) {
        push({
          id: `wsl:${distro}`,
          name: `wsl · ${distro}`,
          label: `WSL · ${distro}`,
          family: 'wsl',
          path: wslPath,
          distro,
          hint: FAMILY_HINT.wsl,
          kind: 'wsl',
        })
      }
    }
  }

  // 用户手工添加的路径（输入可能带重复分隔符，先规范化）。
  for (const extra of config.extraShells) {
    const expanded = normalizePath(expandPath(extra, env))
    if (expanded === undefined || !isAbsolute(expanded) || !isExecutableFile(expanded)) continue
    push({
      id: `custom:${expanded}`,
      name: basename(expanded),
      label: basename(expanded),
      family: inferFamily(expanded),
      path: expanded,
      hint: FAMILY_HINT[inferFamily(expanded)],
      kind: 'custom',
    })
  }

  if (config.verify) {
    await Promise.all(found.map(async (entry) => {
      const result = await verifyShell(subprocess, entry, config)
      entry.verified = result.verified
      if (result.version !== undefined) entry.version = result.version
      if (result.reason !== undefined) entry.reason = result.reason
      // 自定义终端只有文件名做标签时可读性很差；版本串里通常带产品名，
      // 例如 `Niubash 1.4.4 — bash-compatible shell for Windows`。
      if (entry.kind === 'custom' && result.version !== undefined) {
        Object.assign(entry, brandLabel({ ...entry, version: result.version }))
      }
    }))
    log?.info?.(`agent-shell: discovered ${found.length} terminals`)
  }
  return found
}

/** 由可执行文件名推断家族。 */
export function inferFamily(path) {
  const lower = basename(path).toLowerCase()
  if (lower.includes('cmd')) return 'cmd'
  if (lower.includes('powershell') || lower.includes('pwsh')) return 'powershell'
  if (lower === 'wsl.exe') return 'wsl'
  return 'posix'
}

// #endregion

// #region 执行

/**
 * 构造一次调用的 argv。
 *
 * - `powershell`：`-EncodedCommand`（UTF-16LE base64），避免任意引号被二次解析；
 *   前置语句把控制台输出固定为 UTF-8，否则中文在 Windows PowerShell 5.1 下乱码。
 * - `posix`：`-lc`（登录 shell）让 PATH 等环境就绪。
 * - `wsl`：`wsl [-d distro] --exec bash -lc`。
 * - `cmd`：由 {@link writeCmdScript} 写脚本后以相对名调用，见该函数说明。
 */
export function buildInvocation(shell, command) {
  switch (shell.family) {
    case 'powershell': {
      const preamble = [
        "$ProgressPreference = 'SilentlyContinue'",
        'try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false) } catch { }',
        '',
      ].join('\n')
      const encoded = Buffer.from(`${preamble}${command}`, 'utf16le').toString('base64')
      return [shell.path, '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded]
    }
    case 'wsl': {
      const distro = shell.distro === undefined ? [] : ['-d', shell.distro]
      return [shell.path, ...distro, '--exec', 'bash', '-lc', command]
    }
    case 'posix':
      return [shell.path, '-lc', command]
    case 'cmd':
    default:
      return [shell.path, '/d', '/s', '/c', command]
  }
}

/**
 * 把 cmd 命令写成临时脚本。
 *
 * `cmd /c` 会二次解析参数：绝对临时路径若含空格（用户名目录常常含），会在空格处
 * 断开并报「不是内部或外部命令」；加引号又会被当成程序名的一部分。
 * 因此脚本以**相对名**运行、cwd 设为脚本所在目录，脚本内部再 `cd /d` 回用户目录。
 */
function writeCmdScript(directory, command, cwd) {
  const scriptPath = join(directory, CMD_SCRIPT_NAME)
  const body = [
    '@echo off',
    'chcp 65001>nul',
    `cd /d "${cwd}"`,
    command,
    '',
  ].join('\r\n')
  writeFileSync(scriptPath, body, 'utf8')
  return scriptPath
}

/** 截断到上限并标记。 */
function tailWithin(text, limit) {
  if (typeof text !== 'string') return { text: '', truncated: false }
  if (text.length <= limit) return { text, truncated: false }
  return { text: text.slice(text.length - limit), truncated: true }
}

/**
 * 在指定终端中执行一条命令。
 * @returns 结构化结果，包含退出码、输出、超时与沙箱事实。
 */
export async function runCommand({ subprocess, sandbox, policy, shell, command, cwd, config, signal, log }) {
  const started = Date.now()
  const workdir = cwd ?? shell.cwd ?? process.cwd()

  let argv = buildInvocation(shell, command)
  let scriptDirectory
  if (shell.family === 'cmd') {
    scriptDirectory = join(process.env.TEMP ?? process.env.TMP ?? workdir, `agent-shell-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
    mkdirSync(scriptDirectory, { recursive: true })
    writeCmdScript(scriptDirectory, command, workdir)
    argv = [shell.path, '/d', '/s', '/c', CMD_SCRIPT_NAME]
  }

  try {
    // 沙箱：full-access 直接跑，其余交给 ctx.sandbox 包装 argv。
    let facts
    if (policy !== undefined && policy.mode !== 'danger-full-access' && sandbox !== undefined) {
      const confined = await sandbox.confine(argv, policy)
      argv = confined.argv ?? argv
      facts = {
        mode: policy.mode,
        enforcement: confined.enforcement,
        denied: false,
      }
    }

    const handle = subprocess.spawn({
      argv,
      cwd: scriptDirectory ?? workdir,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: config.maxOutputBytes },
        stderr: { maxBytes: config.maxOutputBytes },
      },
      graceMs: 3000,
      ...signal === undefined ? {} : { signal },
    })

    let timedOut = false
    const timer = new Promise((resolve) => setTimeout(resolve, config.timeoutMs, 'timeout'))
    const outcome = await Promise.race([handle.done, timer])
    if (outcome === 'timeout') {
      timedOut = true
      try { handle.kill?.() } catch {}
    }

    const stdout = tailWithin(handle.collected?.stdout?.readFrom(0)?.text ?? '', config.maxOutputBytes)
    const stderr = tailWithin(handle.collected?.stderr?.readFrom(0)?.text ?? '', config.maxOutputBytes)
    return {
      ok: true,
      stdout: stdout.text,
      stderr: stderr.text,
      truncated: stdout.truncated || stderr.truncated,
      exitCode: timedOut ? null : outcome.exitCode ?? null,
      signal: timedOut ? null : outcome.signal ?? null,
      timedOut,
      durationMs: Date.now() - started,
      shell: { id: shell.id, name: shell.name, family: shell.family, path: shell.path },
      cwd: workdir,
      ...facts === undefined ? {} : { sandbox: facts },
    }
  } catch (error) {
    log?.warn?.(`agent-shell: run failed: ${String(error)}`)
    return {
      ok: false,
      error: { code: 'run-failed', message: String(error?.message ?? error) },
      durationMs: Date.now() - started,
      shell: { id: shell.id, name: shell.name, family: shell.family, path: shell.path },
    }
  }
}

// #endregion

// #region 选择存储

/** 选择存储文件。 */
function selectionFile() {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'agent-shell-selection.json')
}

/** 读取持久化选择。 */
function loadSelection() {
  try {
    const parsed = JSON.parse(readFileSync(selectionFile(), 'utf8'))
    return {
      defaultShellId: typeof parsed.defaultShellId === 'string' ? parsed.defaultShellId : null,
      bySession: typeof parsed.bySession === 'object' && parsed.bySession !== null ? parsed.bySession : {},
      // 用户添加过的自定义终端路径，重启后仍要能发现。
      // 顺手规范化并去重：历史文件里可能已有 `D:\\App` 与 `D:\App` 这类同一路径的重复项。
      customPaths: Array.isArray(parsed.customPaths)
        ? uniquePaths(parsed.customPaths.filter((entry) => typeof entry === 'string'))
        : [],
    }
  } catch {
    return { defaultShellId: null, bySession: {}, customPaths: [] }
  }
}

/** 写入持久化选择（失败不影响运行）。 */
function saveSelection(selection) {
  try {
    mkdirSync(dirname(selectionFile()), { recursive: true })
    writeFileSync(selectionFile(), JSON.stringify(selection, null, 2), 'utf8')
    return true
  } catch {
    return false
  }
}

// #endregion

// #region 工具描述

/** 工具名：与家族一致，便于模型判断语法。 */
function toolNameFor(shell) {
  switch (shell.family) {
    case 'powershell': return 'pwsh'
    case 'cmd': return 'cmd'
    default: return 'bash'
  }
}

/** 面向模型的工具描述，写明真实终端与方言。 */
function toolDescription(shell) {
  const dialect = shell.family === 'powershell'
    ? 'PowerShell syntax ($env:NAME, Get-ChildItem) and native C:\\ paths.'
    : shell.family === 'cmd'
      ? 'cmd syntax (%VAR%, dir, copy) and native C:\\ paths.'
      : shell.family === 'wsl'
        ? 'bash inside WSL; Windows drives are under /mnt/c.'
        : 'POSIX bash syntax ($VAR, ls, cp, &&, |, >) and MSYS-style paths (C:\\code is /c/code).'
  // 对 bash 家族（含自带的 bash 兼容终端）明确禁止 cmd / PowerShell 惯用法：
  // 只说「用 bash 语法」不够，模型看到 Windows 路径仍会写出 `dir`、`copy`。
  const forbidden = shell.family === 'cmd' || shell.family === 'powershell'
    ? ''
    : ' This is NOT cmd.exe and NOT PowerShell: never emit `dir`, `copy`, `del`, `move`, '
      + '`type`, `set VAR=`, `%VAR%`, `$env:VAR`, `Get-ChildItem`, or `Select-Object` — '
      + 'use `ls`, `cp`, `rm`, `mv`, `cat`, `export VAR=`, and `$VAR` instead.'
  return `Execute a command in this session's terminal: ${shell.label} (${shell.path}). `
    + `Use ${dialect}${forbidden} `
    + 'Each call is a fresh process; no cwd or variables persist between calls — pass `workdir` instead of `cd`. '
    + 'Non-zero exits are reported as `[exit code: N]`. '
    + 'Commands may run under a file sandbox; a blocked operation is reported as `[sandbox: file access denied under <mode> mode]` — a policy denial, not a command bug. '
    + 'Long output is truncated to its tail.'
}

/**
 * 面向模型的 system prompt 段落文本。
 *
 * 工具描述只在工具被选中时才起作用，而模型往往在写第一行命令前就已经按
 * 「Windows ⇒ cmd」的惯性决定写法。一段简短的 prompt 能更早纠正这个惯性。
 * @returns 该终端家族的方言约定。
 */
function promptSectionText(shell) {
  if (shell.family === 'cmd') {
    return 'The shell tool runs cmd.exe. Use cmd built-ins and %VAR% expansion; '
      + 'paths are native Windows (C:\\code).'
  }
  if (shell.family === 'powershell') {
    return 'The shell tool runs PowerShell. Use cmdlets (Get-ChildItem) and $env:VAR; '
      + 'paths are native Windows (C:\\code).'
  }
  const base = `The shell tool runs bash (${shell.label}). `
    + 'Write POSIX shell: ls, cp, rm, mv, cat, grep, sed, awk, and $VAR for variables. '
    + 'Do NOT use cmd.exe built-ins or PowerShell cmdlets — no dir, copy, del, type, '
    + 'set VAR=, %VAR%, $env:VAR, or Get-ChildItem.'
  return shell.family === 'wsl'
    ? `${base} Windows drives are mounted under /mnt (C:\\code is /mnt/c/code).`
    : `${base} Windows drives appear as MSYS paths (C:\\code is /c/code).`
}

// #endregion

// #region 插件

/**
 * 注册路由、按会话装配终端工具。
 */
export function apply(ctx, rawConfig = {}) {
  const config = resolveConfig(rawConfig)
  const log = ctx.logger?.('agent-shell') ?? console
  const token = Math.random().toString(36).slice(2) + Date.now().toString(36)
  const selection = loadSelection()

  /** 每个会话已注册的工具与限制，用于切换时精确撤销。 */
  const registrations = new Map()

  /** 读取某会话当前生效的终端 id。 */
  const shellIdFor = (sessionId) => selection.bySession[sessionId] ?? selection.defaultShellId ?? null

  /** 缓存发现结果，避免每次请求都全量探测。 */
  let discoveryCache
  const shells = async (force = false) => {
    if (!force && discoveryCache !== undefined) return discoveryCache
    // 持久化的自定义终端与配置里的 extraShells 合并，让它们重启后仍然可发现。
    const persisted = Array.isArray(selection.customPaths) ? selection.customPaths : []
    const merged = [...config.extraShells, ...persisted]
    discoveryCache = await discoverShells({
      subprocess: ctx.get('subprocess'),
      config: { ...config, extraShells: [...new Set(merged)] },
      log,
    })
    return discoveryCache
  }

  /**
   * 登记一个自定义终端。
   *
   * 这是「自定义路径添加不了」的根因修复点：曾经 `/verify` 只做验证、不登记，
   * 而 `/selection` 只接受发现列表里的 id，于是验证通过后仍然选中失败
   * （`unknown-shell`）。现在验证成功即登记进缓存，并把路径持久化到选择文件，
   * 重启后由 `config.extraShells` 一并带回来。
   */
  const rememberCustom = async (shell) => {
    const list = await shells()
    // 统一规范化路径，避免 `D:\\\\App` 与 `D:\\App` 变成两个终端。
    const normalized = normalizePath(shell.path)
    const entry = brandLabel({ ...shell, path: normalized, id: `custom:${normalized}` })
    const key = normalized.toLowerCase()
    const existing = list.findIndex((candidate) => candidate.path.toLowerCase() === key)
    let result
    if (existing === -1) {
      list.push(entry)
      result = entry
    } else {
      // 合并而不是覆盖：保留已有条目的验证/版本信息，别让兜底路径把好标签冲掉。
      result = brandLabel({ ...list[existing], ...entry })
      list[existing] = result
    }
    // 持久化，使下次启动也能发现它。
    const paths = uniquePaths([...(selection.customPaths ?? []), normalized])
    if (paths.length !== (selection.customPaths ?? []).length) {
      selection.customPaths = paths
      saveSelection(selection)
    } else {
      selection.customPaths = paths
    }
    return result
  }

  const findShell = async (shellId) => {
    const list = await shells()
    return list.find((entry) => entry.id === shellId)
  }

  /**
   * 为一个会话重建终端工具。
   *
   * 安全性：先装新工具、成功后才撤销旧的。若新终端装配失败（例如校验没过、
   * 注册抛错），旧工具与原生工具都保持原样，会话不会失去执行能力 ——
   * 切换终端绝不能把会话变成哑的。
   */
  const rebuild = async (agent) => {
    const sessionId = String(agent.id)
    const existing = registrations.get(sessionId)
    const shellId = shellIdFor(sessionId)

    // 目标为「原生」：直接撤销我们装过的东西。
    if (shellId === null) {
      if (existing !== undefined) {
        for (const dispose of existing.disposers) {
          try { dispose() } catch {}
        }
        registrations.delete(sessionId)
      }
      return
    }

    const shell = await findShell(shellId)
    if (shell === undefined) return
    if (shell.verified === false) {
      log.warn?.(`agent-shell: ${shell.id} failed verification, keeping previous tool (${shell.reason ?? ''})`)
      return
    }
    // 已经是这个终端且装好了，无需重建。
    if (existing !== undefined && existing.shellId === shellId) return

    const toolName = toolNameFor(shell)
    const pending = []
    try {
      const agentTools = agent.ctx.tools
      // 先把新工具装上；同名遮蔽原生工具，无需先删。
      pending.push(agentTools.register({
        name: toolName,
        description: toolDescription(shell),
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'The command to execute.' },
            description: { type: 'string', description: 'Clear, concise description of what this command does in active voice.' },
            timeoutMs: { type: 'number', description: 'Timeout in milliseconds.' },
            workdir: { type: 'string', description: 'Working directory; defaults to the session workspace.' },
          },
          required: ['command'],
          additionalProperties: false,
        },
        output: {
          schema: { type: 'string' },
          render: (_args, value) => [{ type: 'text', text: String(value) }],
        },
        execute: async (args, exec) => {
          const input = args ?? {}
          if (typeof input.command !== 'string' || input.command.trim() === '') {
            throw new Error('invalid command: expected a non-empty string')
          }
          const workdir = typeof input.workdir === 'string' ? input.workdir : undefined
          const timeoutMs = Number.isFinite(input.timeoutMs) ? input.timeoutMs : config.timeoutMs
          const sandbox = ctx.get('sandbox')
          const sandboxPolicy = ctx.get('sandboxPolicy')
          const policy = sandboxPolicy?.resolve?.({ session: exec.agent?.session })
          const result = await runCommand({
            subprocess: ctx.get('subprocess'),
            sandbox,
            policy,
            shell,
            command: input.command,
            cwd: workdir === undefined
              ? undefined
              : isAbsolute(workdir) ? workdir : resolvePath(process.cwd(), workdir),
            config: { ...config, timeoutMs },
            signal: exec.signal,
            log,
          })
          if (result.ok !== true) {
            throw new Error(result.error?.message ?? 'command failed')
          }
          const marker = result.timedOut
            ? `[timed out after ${timeoutMs}ms]`
            : result.exitCode !== null && result.exitCode !== 0
              ? `[exit code: ${result.exitCode}]`
              : undefined
          const body = `${result.stdout ?? ''}${result.stderr ?? ''}`
          return [body.trimEnd(), marker].filter(Boolean).join('\n') || '(no output)'
        },
      }))

      // 新工具就位后，才隐藏不同名的原生 shell 工具。
      for (const name of ['pwsh', 'bash', 'cmd']) {
        if (name === toolName) continue
        try {
          pending.push(agentTools.restrict({ deny: [name] }))
        } catch {
          // 该平台上没有这个全局工具，忽略。
        }
      }

      // 方言约定写进该会话的 system prompt：比工具描述更早影响模型的写法选择，
      // 否则模型会按「Windows ⇒ cmd」的惯性生成 `dir`、`copy`。
      const prompt = agent.ctx?.systemPrompt
      let promptRegistered = false
      if (prompt !== undefined) {
        try {
          // 先单独解析排序位次：名字非法时不能让整段注册被跳过。
          let order = 0
          try {
            order = prompt.getSectionOrder?.('TOOL_PWSH') ?? 0
          } catch {
            order = 0
          }
          // 用与内置 shell 段落不同的名字，避免与 tool:pwsh 互相覆盖。
          pending.push(prompt.section({
            name: 'agent-terminal:dialect',
            order,
            text: promptSectionText(shell),
          }))
          promptRegistered = true
        } catch (error) {
          log.warn?.(`agent-shell: could not add prompt section for ${sessionId}: ${String(error)}`)
        }
      }

      // 成功：撤销旧注册。
      if (existing !== undefined) {
        for (const dispose of existing.disposers) {
          try { dispose() } catch {}
        }
      }
      registrations.set(sessionId, {
        disposers: pending,
        shellId,
        toolName,
        promptRegistered,
        promptText: promptRegistered ? promptSectionText(shell) : null,
        description: toolDescription(shell),
      })
      log.info?.(`agent-shell: session ${sessionId} → ${shell.label} as tool "${toolName}"`)
    } catch (error) {
      // 失败：只撤销本次新装的，旧注册保持有效。
      for (const dispose of pending) {
        try { dispose() } catch {}
      }
      log.warn?.(`agent-shell: failed to install tool for ${sessionId}, kept previous: ${String(error)}`)
    }
  }

  // 新会话创建时装配；已有会话在插件加载时补装。
  ctx.on('agent/created', async (payload) => {
    const agent = payload?.agent
    if (agent !== undefined) await rebuild(agent)
  })
  ctx.effect(() => {
    const agents = ctx.get('agents')
    for (const agent of agents?.list?.() ?? []) void rebuild(agent)
    return () => {
      for (const { disposers } of registrations.values()) {
        for (const dispose of disposers) { try { dispose() } catch {} }
      }
      registrations.clear()
    }
  }, 'agent-shell: install terminal tools')

  // #region 路由

  const sendJson = (res, status, body) => {
    const payload = JSON.stringify(body)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(payload),
    })
    res.end(payload)
  }

  const readBody = async (req) => {
    const chunks = []
    let total = 0
    for await (const chunk of req) {
      total += chunk.length
      if (total > MAX_BODY_BYTES) throw new Error('请求体过大')
      chunks.push(chunk)
    }
    if (chunks.length === 0) return {}
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  }

  /** 同源 + 令牌校验。 */
  const authorize = (req) => {
    const provided = req.headers[TOKEN_HEADER]
    if (provided !== token) return false
    const site = req.headers['sec-fetch-site']
    if (site !== undefined && site !== 'same-origin' && site !== 'none') return false
    const origin = req.headers.origin
    if (origin !== undefined) {
      try {
        if (new URL(origin).origin !== ctx.webServer.getOrigin()) return false
      } catch {
        return false
      }
    }
    return true
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: API_PREFIX,
    handler: async (req, res) => {
      const url = new URL(req.url ?? '/', ctx.webServer.getOrigin())
      const route = url.pathname.slice(API_PREFIX.length) || '/'

      if (route === '/token' && req.method === 'GET') {
        return sendJson(res, 200, { token })
      }
      if (!authorize(req)) return sendJson(res, 403, { ok: false, error: { code: 'forbidden', message: '未授权' } })

      try {
        if (route === '/shells' && req.method === 'GET') {
          const force = url.searchParams.get('refresh') === '1'
          const list = await shells(force)
          return sendJson(res, 200, {
            ok: true,
            platform: process.platform,
            cwd: process.cwd(),
            shells: list,
          })
        }

        // 注入内容自检：便于确认「模型到底被告知了哪种方言」，
        // 而不是只能从界面猜测。
        if (route === '/diagnostics' && req.method === 'GET') {
          const session = url.searchParams.get('session') ?? undefined
          const record = session === undefined ? undefined : registrations.get(session)
          return sendJson(res, 200, {
            ok: true,
            session: session ?? null,
            shellId: session === undefined ? selection.defaultShellId : shellIdFor(session),
            toolName: record?.toolName ?? null,
            installed: record !== undefined,
            promptRegistered: record?.promptRegistered ?? false,
            promptSection: record?.promptText ?? null,
            toolDescription: record?.description ?? null,
          })
        }

        if (route === '/selection' && req.method === 'GET') {
          const session = url.searchParams.get('session') ?? undefined
          const effectiveId = session === undefined ? selection.defaultShellId : shellIdFor(session)
          const shell = effectiveId === null ? undefined : await findShell(effectiveId)
          return sendJson(res, 200, {
            ok: true,
            session: session ?? null,
            defaultShellId: selection.defaultShellId,
            shellId: effectiveId,
            shell: shell ?? null,
            installed: session === undefined ? null : registrations.has(session),
          })
        }

        if (route === '/selection' && req.method === 'POST') {
          const body = await readBody(req)
          const session = typeof body.session === 'string' ? body.session : undefined
          const shellId = body.shellId === null || body.shellId === undefined
            ? null
            : String(body.shellId)
          let chosen = shellId === null ? undefined : await findShell(shellId)
          // 兜底：调用方直接给了 custom:<绝对路径> 但尚未登记时，就地验证并登记，
          // 而不是用 unknown-shell 拒绝一个确实存在的终端。
          if (shellId !== null && chosen === undefined && shellId.startsWith('custom:')) {
            const candidate = normalizePath(shellId.slice('custom:'.length))
            if (isAbsolute(candidate) && isExecutableFile(candidate)) {
              const probe = await verifyShell(ctx.get('subprocess'), {
                id: `custom:${candidate}`,
                name: basename(candidate),
                label: basename(candidate),
                family: inferFamily(candidate),
                path: candidate,
                hint: FAMILY_HINT[inferFamily(candidate)],
                kind: 'custom',
              }, config)
              chosen = await rememberCustom({
                id: `custom:${candidate}`,
                name: basename(candidate),
                label: basename(candidate),
                family: inferFamily(candidate),
                path: candidate,
                hint: FAMILY_HINT[inferFamily(candidate)],
                kind: 'custom',
                ...probe,
              })
            }
          }
          if (shellId !== null && chosen === undefined) {
            return sendJson(res, 400, { ok: false, error: { code: 'unknown-shell', message: `未知终端：${shellId}` } })
          }
          // 兜底登记可能改写了 id（路径被规范化），以登记结果为准。
          const effectiveShellId = chosen?.id ?? shellId
          if (body.scope === 'default') {
            selection.defaultShellId = effectiveShellId
          } else if (session !== undefined) {
            if (effectiveShellId === null) delete selection.bySession[session]
            else selection.bySession[session] = effectiveShellId
          } else {
            return sendJson(res, 400, { ok: false, error: { code: 'missing-session', message: '缺少会话 id' } })
          }
          const persisted = saveSelection(selection)
          // 立刻对运行中的会话生效。
          const agents = ctx.get('agents')
          if (session !== undefined) {
            const agent = agents?.get?.(session)
            if (agent !== undefined) await rebuild(agent)
          } else if (body.scope === 'default') {
            for (const agent of agents?.list?.() ?? []) {
              if (selection.bySession[String(agent.id)] === undefined) await rebuild(agent)
            }
          }
          return sendJson(res, 200, { ok: true, persisted, shellId: effectiveShellId })
        }

        if (route === '/verify' && req.method === 'POST') {
          const body = await readBody(req)
          // 规范化：用户可能带引号、重复分隔符或前后空格。
          const candidate = normalizePath(
            typeof body.path === 'string' ? body.path.trim().replace(/^"|"$/g, '') : '',
          )
          if (candidate === '' || !isAbsolute(candidate)) {
            return sendJson(res, 400, { ok: false, error: { code: 'invalid-path', message: '需要一个绝对路径' } })
          }
          if (!isExecutableFile(candidate)) {
            return sendJson(res, 400, { ok: false, error: { code: 'missing-shell', message: '该路径不存在或不可执行' } })
          }
          const shell = {
            id: `custom:${candidate}`,
            name: basename(candidate),
            label: basename(candidate),
            family: inferFamily(candidate),
            path: candidate,
            hint: FAMILY_HINT[inferFamily(candidate)],
            kind: 'custom',
          }
          const probe = await verifyShell(ctx.get('subprocess'), shell, config)
          const verified = brandLabel({ ...shell, ...probe })
          // 验证通过就登记，否则随后的 /selection 会以 unknown-shell 拒绝它 ——
          // 这正是自定义终端「加不进去」的原因。
          if (verified.verified !== false) {
            await rememberCustom(verified)
          }
          return sendJson(res, 200, {
            ok: true,
            shell: verified,
          })
        }

        return sendJson(res, 404, { ok: false, error: { code: 'not-found', message: '未知路由' } })
      } catch (error) {
        return sendJson(res, 500, { ok: false, error: { code: 'internal', message: String(error?.message ?? error) } })
      }
    },
  }), 'agent-shell: routes')

  // 页面早于插件加载时，客户端从 meta 拿令牌的兜底之外再注入一次。
  ctx.effect(() => ctx.webServer.tapIndex((html) => {
    if (html.includes(`name="${TOKEN_META_NAME}"`)) return html
    const meta = `<meta name="${TOKEN_META_NAME}" content="${token}">`
    const head = html.indexOf('</head>')
    return head === -1 ? meta + html : html.slice(0, head) + meta + html.slice(head)
  }), 'agent-shell: token meta')

  // #endregion
}
