/**
 * dsh-plugin-agent-terminal — 客户端半。
 *
 * 在**会话头部**放一个终端选择器（下拉），为当前会话选择 agent 执行命令时
 * 使用的终端。不占用左侧栏入口，也没有独立的终端页面 —— 选择就发生在
 * 会话本身里，与模式选择相互独立。
 *
 * 模块自包含：只依赖平台种子 `react` 与 `react/jsx-runtime`。
 */

window.__ModuleLoader__.load({
  id: 'dsh-plugin-agent-terminal',
  factory: (require) => {
    const React = require('react')

    const NS = 'agent-terminal'
    const API = '/agent-shell/api'
    const TOKEN_META = 'dsh-agent-shell'

    // #region 文案

    const zh = {
      'picker.title': '选择 agent 执行命令使用的终端',
      'picker.loading': '探测中…',
      'picker.native': '跟随默认',
      'picker.nativeHint': '不接管，使用内置 shell',
      'picker.failed': '探测失败',
      'picker.retry': '重试',
      'picker.verified': '已验证',
      'picker.unverified': '未验证',
      'picker.unavailable': '不可用',
      'picker.scope': '仅本会话',
      'picker.scopeDefault': '新会话默认',
      'picker.custom': '自定义路径…',
      'picker.add': '添加',
      'picker.active': '使用中',
    }

    const en = {
      'picker.title': 'Choose the terminal the agent runs commands in',
      'picker.loading': 'Scanning…',
      'picker.native': 'Follow default',
      'picker.nativeHint': 'Do not override; use the built-in shell',
      'picker.failed': 'Scan failed',
      'picker.retry': 'Retry',
      'picker.verified': 'verified',
      'picker.unverified': 'unverified',
      'picker.unavailable': 'unavailable',
      'picker.scope': 'This session',
      'picker.scopeDefault': 'New sessions',
      'picker.custom': 'Custom path…',
      'picker.add': 'Add',
      'picker.active': 'active',
    }

    // #endregion

    // #region 令牌与请求

    let cachedToken

    /** 从页面 meta 读令牌；插件晚于页面加载时退回路由获取。 */
    async function token() {
      if (cachedToken !== undefined) return cachedToken
      const meta = document.querySelector(`meta[name="${TOKEN_META}"]`)
      if (meta !== null) {
        const value = meta.getAttribute('content')
        if (value !== null && value.length > 0) {
          cachedToken = value
          return cachedToken
        }
      }
      const response = await fetch(`${API}/token`, { credentials: 'same-origin' })
      if (!response.ok) throw new Error(`token ${response.status}`)
      cachedToken = (await response.json()).token
      return cachedToken
    }

    /** 统一请求；非 2xx 抛错并带上服务端消息。 */
    async function api(path, options = {}) {
      const headers = { 'x-agent-shell-token': await token() }
      if (options.payload !== undefined) headers['content-type'] = 'application/json'
      const response = await fetch(`${API}${path}`, {
        method: options.method ?? 'GET',
        headers,
        credentials: 'same-origin',
        signal: options.signal,
        ...options.payload === undefined ? {} : { body: JSON.stringify(options.payload) },
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(payload?.error?.message ?? `HTTP ${response.status}`)
      return payload
    }

    // #endregion

    // #region 图标

    /** 终端提示符图标。 */
    function TerminalGlyph({ size = 15 }) {
      return React.createElement('svg', {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true,
      },
      React.createElement('rect', {
        x: 2.5, y: 4.5, width: 19, height: 15, rx: 2.5,
        stroke: 'currentColor', strokeWidth: 1.8,
      }),
      React.createElement('path', {
        d: 'M6.8 9.6 9.6 12l-2.8 2.4',
        stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round',
      }),
      React.createElement('path', {
        d: 'M12.2 15h4.6',
        stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round',
      }))
    }

    /** 小箭头。 */
    function Caret() {
      return React.createElement('svg', {
        width: 10, height: 10, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true,
      }, React.createElement('path', {
        d: 'm6 9 6 6 6-6',
        stroke: 'currentColor', strokeWidth: 2.2, strokeLinecap: 'round', strokeLinejoin: 'round',
      }))
    }

    /** 选中标记。 */
    function Check() {
      return React.createElement('svg', {
        width: 13, height: 13, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true,
      }, React.createElement('path', {
        d: 'm4 12.5 5 5L20 6.5',
        stroke: 'currentColor', strokeWidth: 2.6, strokeLinecap: 'round', strokeLinejoin: 'round',
      }))
    }

    // #endregion

    // 与同区域的系统按钮（open-in-app / schedule-catalog）保持同一套 token 与尺寸：
    // 高 24px、字号 11px、0.5px 边框、--dsw-radius-sm，悬停用 interactive-bg-hover。
    const STYLE = `
.at-wrap { position: relative; display: inline-flex; flex: none; align-self: center; }
.at-trigger {
  box-sizing: border-box; display: inline-flex; align-items: center; gap: 4px;
  height: 24px; padding: 3px 6px; max-width: 190px;
  border: .5px solid var(--dsw-alias-border-l4); border-radius: var(--dsw-radius-sm);
  background: 0 0; color: var(--dsw-alias-label-primary);
  font-family: var(--dsw-font-family); font-size: 11px; line-height: 16px;
  white-space: nowrap; cursor: pointer;
}
.at-trigger:hover { background: var(--dsw-alias-interactive-bg-hover); }
.at-trigger:focus-visible { background: var(--dsw-alias-interactive-bg-hover); outline: none; }
.at-trigger[data-open="true"] { border-color: var(--dsw-alias-border-l2); background: var(--dsw-alias-interactive-bg-hover); }
.at-trigger[data-active="true"] { color: var(--dsw-alias-brand-primary); }
.at-icon { flex: none; display: inline-flex; align-items: center; opacity: .9; }
.at-name { overflow: hidden; text-overflow: ellipsis; }
.at-caret { flex: none; display: inline-flex; align-items: center; color: var(--dsw-alias-label-secondary); transition: transform .12s ease; }
.at-trigger[data-open="true"] .at-caret { transform: rotate(180deg); }
.at-menu {
  position: absolute; top: calc(100% + 5px); right: 0; z-index: 60;
  min-width: 268px; max-width: 340px; padding: 4px;
  border: .5px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-bg-overlay); box-shadow: 0 8px 24px rgba(0,0,0,.16);
}
.at-head { padding: 5px 8px 6px; font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-secondary); }
.at-item { display: flex; align-items: flex-start; gap: 6px; padding: 6px 8px; border-radius: var(--dsw-radius-sm); cursor: pointer; }
.at-item:hover { background: var(--dsw-alias-interactive-bg-hover); }
.at-item[data-checked="true"] { background: var(--dsw-alias-interactive-bg-hover); }
.at-item[data-disabled="true"] { opacity: .45; cursor: not-allowed; }
.at-item[data-disabled="true"]:hover { background: 0 0; }
.at-check { width: 12px; flex: none; margin-top: 2px; color: var(--dsw-alias-brand-primary); display: inline-flex; }
.at-body { flex: 1; min-width: 0; }
.at-title { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-primary); }
.at-sub { margin-top: 1px; font-size: 10px; line-height: 14px; color: var(--dsw-alias-label-secondary); word-break: break-all; font-family: var(--dsw-font-family); }
.at-badge { padding: 0 4px; border-radius: var(--dsw-radius-xs); font-size: 9.5px; line-height: 14px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary); }
.at-badge[data-tone="ok"] { color: var(--dsw-alias-state-success-primary); }
.at-badge[data-tone="bad"] { color: var(--dsw-alias-state-error-primary); }
.at-sep { height: .5px; margin: 4px 2px; background: var(--dsw-alias-border-l1); }
.at-foot { display: flex; align-items: center; gap: 6px; padding: 5px 8px; font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-secondary); }
.at-link { cursor: pointer; }
.at-link:hover { color: var(--dsw-alias-brand-primary); }
.at-input {
  flex: 1; min-width: 0; box-sizing: border-box;
  padding: 3px 6px; border: .5px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-sm);
  background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary);
  font-family: var(--dsw-font-family); font-size: 11px; line-height: 16px;
}
.at-input:focus { outline: none; border-color: var(--dsw-alias-brand-primary); }
.at-btn {
  padding: 3px 8px; border: .5px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-sm);
  background: 0 0; color: var(--dsw-alias-label-primary);
  font-family: var(--dsw-font-family); font-size: 11px; line-height: 16px; cursor: pointer;
}
.at-btn:hover { background: var(--dsw-alias-interactive-bg-hover); }
.at-btn:disabled { opacity: .5; cursor: default; }
.at-err { padding: 3px 8px 6px; font-size: 10.5px; line-height: 15px; color: var(--dsw-alias-state-error-primary); }
/* 新会话行更紧凑：隐去版本徽标，只用图标 + 名称。 */
.at-trigger[data-compact="true"] .at-badge { display: none; }
`

    // #region 选择器

    /**
     * 终端选择器。
     *
     * 同一组件用于两处：会话头部工具区（有会话，选择绑定该会话）与
     * 新会话落地页那一行（无可绑定会话，选择写入「新会话默认」）。
     * @param props 标准会话 props、`t`，以及可选的 `compact`。
     */
    function TerminalPicker({ sessionId, t, compact }) {
      const [open, setOpen] = React.useState(false)
      const [shells, setShells] = React.useState({ phase: 'loading' })
      const [currentId, setCurrentId] = React.useState(null)
      const [attempt, setAttempt] = React.useState(0)
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState()
      const [customPath, setCustomPath] = React.useState('')
      const [showCustom, setShowCustom] = React.useState(false)
      const rootRef = React.useRef(null)

      // 探测终端（首次打开时再探测，避免占用会话头部初始化时间）。
      React.useEffect(() => {
        if (!open && shells.phase !== 'loading') return undefined
        const controller = new AbortController()
        api('/shells', { signal: controller.signal }).then((payload) => {
          if (controller.signal.aborted) return
          setShells({ phase: 'ready', list: payload.shells ?? [] })
        }, (reason) => {
          if (controller.signal.aborted) return
          setShells({ phase: 'failed', message: reason instanceof Error ? reason.message : String(reason) })
        })
        return () => { controller.abort() }
      }, [attempt, open])

      // 没有会话时（新会话落地页尚无可绑定的会话），退回「新会话默认」，
      // 这样同一个组件在两个位置都能用。
      const hasSession = sessionId !== undefined && sessionId !== null

      // 读当前选择：有会话读该会话，否则读默认。
      React.useEffect(() => {
        const controller = new AbortController()
        const query = hasSession ? `?session=${encodeURIComponent(String(sessionId))}` : ''
        api(`/selection${query}`, { signal: controller.signal })
          .then((payload) => {
            if (controller.signal.aborted) return
            setCurrentId(payload.shellId ?? null)
          }, () => {})
        return () => { controller.abort() }
      }, [sessionId, attempt, hasSession])

      // 点击外部或 Esc 关闭。
      React.useEffect(() => {
        if (!open) return undefined
        const onPointerDown = (event) => {
          if (rootRef.current !== null && !rootRef.current.contains(event.target)) setOpen(false)
        }
        const onKeyDown = (event) => {
          if (event.key === 'Escape') setOpen(false)
        }
        document.addEventListener('pointerdown', onPointerDown)
        document.addEventListener('keydown', onKeyDown)
        return () => {
          document.removeEventListener('pointerdown', onPointerDown)
          document.removeEventListener('keydown', onKeyDown)
        }
      }, [open])

      const list = shells.phase === 'ready' ? shells.list : []
      const active = list.find((entry) => entry.id === currentId)
      const label = currentId === null ? t('picker.native') : (active?.label ?? currentId)

      /** 写入选择：有会话写该会话，否则写新会话默认。 */
      const choose = async (shellId) => {
        setBusy(true)
        setError(undefined)
        try {
          await api('/selection', {
            method: 'POST',
            payload: hasSession
              ? { scope: 'session', session: String(sessionId), shellId }
              : { scope: 'default', shellId },
          })
          setCurrentId(shellId)
          setOpen(false)
        } catch (reason) {
          setError(reason instanceof Error ? reason.message : String(reason))
        } finally {
          setBusy(false)
        }
      }

      /** 验证并添加自定义终端，然后立即选中。 */
      const addCustom = async () => {
        const candidate = customPath.trim()
        if (candidate === '') return
        setBusy(true)
        setError(undefined)
        try {
          const payload = await api('/verify', { method: 'POST', payload: { path: candidate } })
          const shell = payload.shell
          setShells((state) => {
            if (state.phase !== 'ready') return state
            const rest = state.list.filter((entry) => entry.path !== shell.path)
            return { ...state, list: [...rest, shell] }
          })
          setCustomPath('')
          setShowCustom(false)
          await choose(shell.id)
        } catch (reason) {
          setError(reason instanceof Error ? reason.message : String(reason))
        } finally {
          setBusy(false)
        }
      }

      /** 渲染一个终端行。 */
      const renderRow = (entry) => {
        const checked = currentId !== null && currentId === entry.id
        const disabled = busy || entry.verified === false
        const tone = entry.verified === true ? 'ok' : entry.verified === false ? 'bad' : undefined
        return React.createElement('div', {
          key: entry.id ?? entry.path,
          className: 'at-item',
          'data-checked': String(checked),
          'data-disabled': String(disabled),
          role: 'menuitemradio',
          'aria-checked': checked,
          onClick: () => { if (!disabled) void choose(entry.id) },
        },
        React.createElement('span', { className: 'at-check' }, checked ? React.createElement(Check) : null),
        React.createElement('div', { className: 'at-body' },
          React.createElement('div', { className: 'at-title' },
            entry.label ?? entry.name,
            React.createElement('span', { className: 'at-badge', 'data-tone': tone },
              entry.verified === true ? t('picker.verified')
                : entry.verified === false ? t('picker.unavailable')
                  : t('picker.unverified')),
            entry.version !== undefined && React.createElement('span', { className: 'at-badge' }, entry.version)),
          React.createElement('div', { className: 'at-sub' }, entry.path)))
      }

      return React.createElement('div', { className: 'at-wrap', ref: rootRef },
        React.createElement('style', null, STYLE),
        React.createElement('button', {
          type: 'button',
          className: 'at-trigger',
          'data-open': String(open),
          'data-active': String(currentId !== null),
          'data-compact': String(compact === true),
          title: `${t('picker.title')} — ${label}`,
          'aria-haspopup': 'menu',
          'aria-expanded': open,
          onClick: () => { setOpen((value) => !value) },
        },
        React.createElement('span', { className: 'at-icon' }, React.createElement(TerminalGlyph, { size: 13 })),
        React.createElement('span', { className: 'at-name' }, label),
        currentId !== null && React.createElement('span', {
          className: 'at-badge',
          'data-tone': active?.verified === true ? 'ok' : undefined,
        }, active?.version ?? t('picker.active')),
        React.createElement('span', { className: 'at-caret' }, React.createElement(Caret))),

        open && React.createElement('div', { className: 'at-menu', role: 'menu' },
          React.createElement('div', { className: 'at-head' },
            hasSession ? t('picker.scope') : t('picker.scopeDefault')),

          // 「跟随默认」：退回原生行为。
          React.createElement('div', {
            className: 'at-item',
            'data-checked': String(currentId === null),
            role: 'menuitemradio',
            'aria-checked': currentId === null,
            onClick: () => { if (!busy) void choose(null) },
          },
          React.createElement('span', { className: 'at-check' },
            currentId === null ? React.createElement(Check) : null),
          React.createElement('div', { className: 'at-body' },
            React.createElement('div', { className: 'at-title' }, t('picker.native')),
            React.createElement('div', { className: 'at-sub' }, t('picker.nativeHint')))),

          shells.phase === 'loading' && React.createElement('div', { className: 'at-foot' }, t('picker.loading')),
          shells.phase === 'failed' && React.createElement('div', { className: 'at-err' },
            `${t('picker.failed')}: ${shells.message}`,
            React.createElement('button', {
              type: 'button',
              className: 'at-btn',
              style: { marginLeft: 8 },
              onClick: () => { setAttempt((value) => value + 1) },
            }, t('picker.retry'))),

          list.map(renderRow),

          React.createElement('div', { className: 'at-sep' }),
          showCustom
            ? React.createElement('div', { className: 'at-foot' },
              React.createElement('input', {
                className: 'at-input',
                type: 'text',
                value: customPath,
                placeholder: 'C:\\Program Files\\Git\\bin\\bash.exe',
                spellCheck: false,
                onChange: (event) => { setCustomPath(event.target.value) },
                onKeyDown: (event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    if (!busy) void addCustom()
                  }
                },
              }),
              React.createElement('button', {
                type: 'button',
                className: 'at-btn',
                disabled: busy,
                onClick: () => { void addCustom() },
              }, t('picker.add')))
            : React.createElement('div', {
              className: 'at-foot at-link',
              onClick: () => { setShowCustom(true) },
            }, `+ ${t('picker.custom')}`),

          error !== undefined && React.createElement('div', { className: 'at-err' }, error)))
    }

    // #endregion

    // #region 插件

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'agent-terminal: dictionaries')
        const t = ctx.locale.bind(NS)

        // 会话头部右侧工具区：选择器天然绑定当前会话，不占侧栏、无独立页面。
        ctx.effect(() => ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
          name: 'conversation.session.header.utilities',
          id: 'agent-terminal',
          order: -8,
          locale: NS,
        }, TerminalPicker)), 'agent-terminal: header picker')

        // 新会话落地页那一行：紧跟 workspace 与 preset（模式）控件之后。
        // 这一项只在会话存在时渲染；模式选择器就在它左边，正好体现
        // 「终端独立于模式」—— 换终端不必换模式。
        ctx.effect(() => ctx.slots.inject('conversation.hero.options', () => ctx.slots.register({
          name: 'conversation.hero.options',
          id: 'agent-terminal-hero',
          order: 10,
          locale: NS,
        }, (props) => React.createElement(TerminalPicker, { ...props, compact: true }))),
        'agent-terminal: hero picker')
      },
    }
  },
})
