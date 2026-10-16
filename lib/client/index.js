/**
 * Browser card for the Claude Subscription route.
 *
 * The card is a thin view over the Host's HTTP surface: sign-in state, the
 * subscription's rate-limit windows, and the egress policy. The sign-in
 * conversation itself is driven by the Host — this polls for the next notice or
 * question and renders it, because pi-ai's flow races a browser callback
 * against a manually pasted code and only the Host can see which happened.
 *
 * Written with `createElement` rather than JSX so the plugin ships as one plain
 * browser module with no build step.
 *
 * @module dsh-ccsub/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-ccsub',
  factory: (require) => {
    const React = require('react');

    const API = '/plugins/dsh-ccsub';
    const LOCALE_NS = 'settings.claude-sub';

    const en = {
      title: 'Claude Subscription',
      subtitle: 'Use a Claude Pro/Max subscription through the official browser sign-in.',
      notSignedIn: 'Not signed in',
      signedIn: 'Signed in',
      subscription: 'Subscription credential',
      expiresAt: 'Access token expires {time}',
      signIn: 'Sign in with browser',
      signOut: 'Sign out',
      signingIn: 'Waiting for you in the browser…',
      openPage: 'Open the sign-in page',
      enterCode: 'Paste the code shown by the page',
      submitCode: 'Submit',
      cancelSignIn: 'Cancel sign-in',
      signInFailed: 'Sign-in failed: {message}',
      quotaTitle: 'Subscription limits',
      quotaRefresh: 'Refresh',
      quotaRefreshing: 'Refreshing…',
      quotaEmpty: 'The usage endpoint reported no limits.',
      quotaFailed: 'Could not read usage: {message}',
      quotaWindowSession: '5-hour session',
      quotaWindowWeekly: 'Weekly',
      quotaWindowOther: 'Other',
      quotaUsed: '{percent}% used',
      quotaResets: 'Resets {time}',
      quotaResetUnknown: 'Reset time unknown',
      egressTitle: 'Egress protection',
      egressProxy: 'Proxy',
      egressProxyMissing: 'No proxy configured — every request will be refused.',
      egressProxyInvalid: 'This proxy value is not a plain http(s) origin.',
      egressObserved: 'Observed egress IP',
      egressUnknown: 'not observable',
      egressAllow: 'Allowed egress IPs',
      egressAllowed: 'matches the allowlist',
      egressNotAllowed: 'does NOT match the allowlist',
      egressRequire: 'Every request must pass the egress check before it is sent.',
      egressCheckNow: 'Check egress now',
      egressChecking: 'Checking…',
      egressNote:
        "The proxy is mandatory: this route never falls back to a direct connection. The browser step of the sign-in uses your browser's own network settings, which this plugin cannot control.",
      cliVersion: 'Claude Code version presented',
      modelsTitle: 'Available models',
      modelsCount: '{count} models',
    };

    const zh = {
      title: 'Claude 订阅',
      subtitle: '通过官方浏览器登录，使用 Claude Pro/Max 订阅。',
      notSignedIn: '未登录',
      signedIn: '已登录',
      subscription: '订阅凭据',
      expiresAt: '访问令牌将于 {time} 过期',
      signIn: '使用浏览器登录',
      signOut: '退出登录',
      signingIn: '正在等待浏览器完成…',
      openPage: '打开登录页面',
      enterCode: '粘贴页面显示的授权码',
      submitCode: '提交',
      cancelSignIn: '取消登录',
      signInFailed: '登录失败：{message}',
      quotaTitle: '订阅额度',
      quotaRefresh: '刷新',
      quotaRefreshing: '刷新中…',
      quotaEmpty: '用量接口未返回任何限额。',
      quotaFailed: '无法读取用量：{message}',
      quotaWindowSession: '5 小时会话',
      quotaWindowWeekly: '每周',
      quotaWindowOther: '其他',
      quotaUsed: '已用 {percent}%',
      quotaResets: '{time} 重置',
      quotaResetUnknown: '重置时间未知',
      egressTitle: '出口保护',
      egressProxy: '代理',
      egressProxyMissing: '未配置代理——所有请求都将被拒绝。',
      egressProxyInvalid: '该代理值不是纯 http(s) 源地址。',
      egressObserved: '观测到的出口 IP',
      egressUnknown: '无法观测',
      egressAllow: '允许的出口 IP',
      egressAllowed: '与白名单一致',
      egressNotAllowed: '与白名单不一致',
      egressRequire: '每个请求发出前都必须通过出口检测。',
      egressCheckNow: '立即检测出口',
      egressChecking: '检测中…',
      egressNote:
        '代理是强制性的：此路由绝不会回退到直连。登录的浏览器步骤使用你浏览器自身的网络设置，插件无法控制。',
      cliVersion: '对外声明的 Claude Code 版本',
      modelsTitle: '可用模型',
      modelsCount: '{count} 个模型',
    };

    /** Interpolate `{name}` placeholders. */
    function format(template, values) {
      if (values === undefined) return template;
      return String(template).replace(/\{([a-z]+)\}/gi, (whole, key) =>
        values[key] === undefined ? whole : String(values[key]),
      );
    }

    /**
     * Card styles.
     *
     * Inlined and injected once per page: the plugin ships no bundler step, so
     * a stylesheet string is the only artifact the browser module can carry.
     * Every colour resolves through a theme alias with a literal fallback, so
     * the card follows whichever theme is active.
     */
    const CSS = `
.ccsub-card{display:flex;flex-direction:column;gap:14px;padding:4px 2px;max-width:760px}
.ccsub-title{margin:0;font-size:16px;font-weight:600;color:var(--dsw-alias-label-primary,#e6e6e6)}
.ccsub-sub{margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary,#9aa0a6)}
.ccsub-section{display:flex;flex-direction:column;gap:8px;padding:12px;border:1px solid var(--dsw-alias-border-secondary,rgba(255,255,255,.1));border-radius:8px;background:var(--dsw-alias-bg-secondary,rgba(255,255,255,.02))}
.ccsub-h3{margin:0;font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary,#e6e6e6)}
.ccsub-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.ccsub-label{font-size:12px;color:var(--dsw-alias-label-secondary,#9aa0a6);min-width:150px}
.ccsub-hint{font-size:11px;line-height:1.5;color:var(--dsw-alias-label-secondary,#9aa0a6)}
.ccsub-note{margin:0;font-size:11px;line-height:1.6;color:var(--dsw-alias-label-tertiary,#808080)}
.ccsub-error{font-size:12px;line-height:1.5;color:var(--dsw-alias-state-error-primary,#ff6b6b)}
.ccsub-badge{font-size:11px;font-weight:600;padding:2px 8px;border-radius:999px;background:var(--dsw-alias-bg-tertiary,rgba(255,255,255,.08));color:var(--dsw-alias-label-secondary,#9aa0a6)}
.ccsub-badge.ok{background:var(--dsw-alias-state-success-primary,#34a853);color:#fff}
.ccsub-btn{font-size:12px;padding:5px 12px;border-radius:6px;border:1px solid var(--dsw-alias-border-secondary,rgba(255,255,255,.14));background:var(--dsw-alias-bg-tertiary,rgba(255,255,255,.08));color:var(--dsw-alias-label-primary,#e6e6e6);cursor:pointer}
.ccsub-btn:hover:not(:disabled){background:var(--dsw-alias-bg-hover,rgba(255,255,255,.14))}
.ccsub-btn:disabled{opacity:.5;cursor:not-allowed}
.ccsub-btn.small{font-size:11px;padding:3px 9px}
.ccsub-btn.ghost{background:transparent}
.ccsub-input{flex:1;min-width:220px;font-size:12px;padding:5px 9px;border-radius:6px;border:1px solid var(--dsw-alias-border-secondary,rgba(255,255,255,.14));background:var(--dsw-alias-bg-primary,rgba(0,0,0,.2));color:var(--dsw-alias-label-primary,#e6e6e6)}
.ccsub-code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;padding:2px 6px;border-radius:4px;background:var(--dsw-alias-bg-tertiary,rgba(255,255,255,.08));color:var(--dsw-alias-label-primary,#e6e6e6)}
.ccsub-code.bad{color:var(--dsw-alias-state-error-primary,#ff6b6b)}
.ccsub-window{display:flex;flex-direction:column;gap:5px;padding:8px 0}
.ccsub-window-name{font-size:12px;font-weight:500;color:var(--dsw-alias-label-primary,#e6e6e6)}
.ccsub-window-pct{font-size:11px;color:var(--dsw-alias-label-secondary,#9aa0a6);margin-left:auto}
.ccsub-bar{height:6px;border-radius:3px;overflow:hidden;background:var(--dsw-alias-bg-tertiary,rgba(255,255,255,.08))}
.ccsub-bar-fill{height:100%;border-radius:3px;background:var(--dsw-alias-state-business-primary,#4285f4);transition:width .3s ease}
.ccsub-login{display:flex;flex-direction:column;gap:6px;padding:8px;border-radius:6px;background:var(--dsw-alias-bg-primary,rgba(0,0,0,.2))}
.ccsub-login a{font-size:11px;word-break:break-all;color:var(--dsw-alias-state-business-primary,#4285f4)}
.ccsub-login-notice{display:flex;flex-direction:column;gap:2px;padding:4px 0}
.ccsub-login-notice p{margin:0}
`;

    /** Inject the card stylesheet once per page. */
    function injectStyles() {
      if (typeof document === 'undefined') return;
      const tagId = 'dsh-ccsub/card.css';
      if (document.querySelector(`style[data-plugin-css=${JSON.stringify(tagId)}]`) !== null) return;
      const tag = document.createElement('style');
      tag.dataset.plugin = 'dsh-ccsub';
      tag.dataset.pluginCss = tagId;
      tag.textContent = CSS;
      document.head.appendChild(tag);
    }

    /** The dictionary for the active locale id. */
    function dictFor(locale) {
      return String(locale).toLowerCase().startsWith('zh') ? zh : en;
    }

    /** One fetch against the Host surface, returning parsed JSON or a failure. */
    async function call(path, init) {
      const response = await fetch(`${API}${path}`, {
        headers: { accept: 'application/json' },
        ...init,
      });
      let body = null;
      try {
        body = await response.json();
      } catch {
        body = null;
      }
      if (!response.ok || (body !== null && typeof body.error === 'string')) {
        return { ok: false, error: body?.error ?? `HTTP ${response.status}`, status: response.status };
      }
      return { ok: true, value: body };
    }

    /** Human label for one usage window. */
    const windowLabel = (t, window) => {
      const base =
        window.kind === 'session'
          ? t.quotaWindowSession
          : window.kind === 'weekly'
            ? t.quotaWindowWeekly
            : t.quotaWindowOther;
      return window.scope === undefined ? base : `${base} · ${window.scope}`;
    };

    /**
     * The card. Polls the sign-in attempt while one runs, and the quota on the
     * interval the Host reports.
     */
    function ClaudeSubscriptionCard(props) {
      const t = props.t;
      const [status, setStatus] = React.useState(null);
      const [error, setError] = React.useState(null);
      const [usage, setUsage] = React.useState(null);
      const [usageError, setUsageError] = React.useState(null);
      const [busy, setBusy] = React.useState(false);
      const [login, setLogin] = React.useState(null);
      const [code, setCode] = React.useState('');
      const [egress, setEgress] = React.useState(null);
      const [egressBusy, setEgressBusy] = React.useState(false);

      const reloadStatus = React.useCallback(async () => {
        const r = await call('/status');
        if (r.ok) {
          setStatus(r.value);
          setError(null);
        } else {
          setError(r.error);
        }
      }, []);

      const reloadUsage = React.useCallback(async () => {
        const r = await call('/quota');
        if (r.ok) {
          setUsage(r.value);
          setUsageError(null);
        } else {
          setUsageError(r.error);
        }
      }, []);

      React.useEffect(() => {
        void reloadStatus();
        void reloadUsage();
      }, [reloadStatus, reloadUsage]);

      // Usage is refreshed manually via the Refresh button (and once on mount
      // above) — no background polling.

      // While a sign-in runs, poll the Host for the next notice or question.
      React.useEffect(() => {
        if (login === null || login.active !== true) return undefined;
        let stop = false;
        const controller = new AbortController();
        const tick = async () => {
          const r = await call('/login/poll', { signal: controller.signal });
          if (stop) return;
          if (r.ok) {
            setLogin(r.value);
            if (r.value.outcome != null) {
              await reloadStatus();
              await reloadUsage();
            }
          }
        };
        const timer = setInterval(() => void tick(), 1200);
        return () => {
          stop = true;
          controller.abort();
          clearInterval(timer);
        };
      }, [login, reloadStatus, reloadUsage]);

      const startLogin = async () => {
        setBusy(true);
        setError(null);
        try {
          const r = await call('/login', { method: 'POST' });
          if (!r.ok) setError(format(t.signInFailed, { message: r.error }));
          else setLogin(r.value);
        } finally {
          setBusy(false);
        }
      };

      const cancelLogin = async () => {
        await call('/login/cancel', { method: 'POST' });
        setLogin(null);
      };

      const answer = async () => {
        if (login?.prompt == null) return;
        const r = await call('/login/answer', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: login.prompt.id, value: code }),
        });
        if (r.ok) setCode('');
      };

      const signOut = async () => {
        setBusy(true);
        try {
          await call('/logout', { method: 'POST' });
          setUsage(null);
          setLogin(null);
          await reloadStatus();
        } finally {
          setBusy(false);
        }
      };

      const checkEgress = async () => {
        setEgressBusy(true);
        try {
          const r = await call('/egress');
          setEgress(r.ok ? r.value : { error: r.error });
        } finally {
          setEgressBusy(false);
        }
      };

      const percent = (window) => Math.max(0, Math.min(100, Number(window.usedPercent) || 0));
      const bar = (window) =>
        React.createElement(
          'div',
          { className: 'ccsub-bar' },
          React.createElement('div', {
            className: 'ccsub-bar-fill',
            style: { width: `${percent(window)}%` },
          }),
        );
      const resetText = (window) =>
        typeof window.resetsAt === 'number'
          ? format(t.quotaResets, { time: new Date(window.resetsAt).toLocaleString() })
          : t.quotaResetUnknown;

      const grant = status?.grant;
      const proxy = status?.proxy;

      return React.createElement(
        'div',
        { className: 'ccsub-card' },
        React.createElement('h2', { className: 'ccsub-title' }, t.title),
        React.createElement('p', { className: 'ccsub-sub' }, t.subtitle),

        error !== null
          ? React.createElement('p', { className: 'ccsub-error', role: 'alert' }, error)
          : null,

        // ---- Sign-in state -------------------------------------------------
        React.createElement(
          'div',
          { className: 'ccsub-section' },
          React.createElement(
            'div',
            { className: 'ccsub-row' },
            React.createElement(
              'span',
              { className: 'ccsub-badge' + (grant?.configured === true ? ' ok' : '') },
              grant?.configured === true ? t.signedIn : t.notSignedIn,
            ),
            grant?.configured === true && typeof grant.expiresAt === 'number'
              ? React.createElement(
                  'span',
                  { className: 'ccsub-hint' },
                  format(t.expiresAt, { time: new Date(grant.expiresAt).toLocaleString() }),
                )
              : null,
          ),
          login !== null && login.active === true
            ? React.createElement(
                'div',
                { className: 'ccsub-login' },
                React.createElement('p', null, t.signingIn),
                (login.notices ?? []).map((notice, index) =>
                  React.createElement(
                    'div',
                    { key: `n${index}`, className: 'ccsub-login-notice' },
                    notice.url !== undefined
                      ? React.createElement(
                          'a',
                          { href: notice.url, target: '_blank', rel: 'noreferrer' },
                          notice.url,
                        )
                      : null,
                    notice.message !== undefined
                      ? React.createElement('p', { className: 'ccsub-hint' }, notice.message)
                      : null,
                    notice.code !== undefined
                      ? React.createElement('p', { className: 'ccsub-hint' }, React.createElement('code', null, notice.code))
                      : null,
                  ),
                ),
                login.prompt !== null
                  ? React.createElement(
                      'div',
                      { className: 'ccsub-row' },
                      React.createElement('input', {
                        className: 'ccsub-input',
                        placeholder: login.prompt.message || t.enterCode,
                        value: code,
                        onChange: (event) => setCode(event.target.value),
                      }),
                      React.createElement('button', { className: 'ccsub-btn', onClick: () => void answer() }, t.submitCode),
                    )
                  : null,
                React.createElement('button', { className: 'ccsub-btn ghost', onClick: () => void cancelLogin() }, t.cancelSignIn),
              )
            : React.createElement(
                'div',
                { className: 'ccsub-row' },
                React.createElement(
                  'button',
                  { className: 'ccsub-btn', disabled: busy || status?.loginAvailable !== true, onClick: () => void startLogin() },
                  t.signIn,
                ),
                grant?.configured === true
                  ? React.createElement('button', { className: 'ccsub-btn ghost', disabled: busy, onClick: () => void signOut() }, t.signOut)
                  : null,
              ),
        ),

        // ---- Quota ---------------------------------------------------------
        React.createElement(
          'div',
          { className: 'ccsub-section' },
          React.createElement(
            'div',
            { className: 'ccsub-row' },
            React.createElement('h3', { className: 'ccsub-h3' }, t.quotaTitle),
            React.createElement('button', { className: 'ccsub-btn small', onClick: () => void reloadUsage() }, t.quotaRefresh),
          ),
          usageError !== null
            ? React.createElement('p', { className: 'ccsub-error' }, format(t.quotaFailed, { message: usageError }))
            : usage === null
              ? React.createElement('p', { className: 'ccsub-hint' }, t.quotaRefreshing)
              : (usage.windows ?? []).length === 0
                ? React.createElement('p', { className: 'ccsub-hint' }, t.quotaEmpty)
                : (usage.windows ?? []).map((window, index) =>
                    React.createElement(
                      'div',
                      { key: `w${index}`, className: 'ccsub-window' },
                      React.createElement(
                        'div',
                        { className: 'ccsub-row' },
                        React.createElement('span', { className: 'ccsub-window-name' }, windowLabel(t, window)),
                        React.createElement('span', { className: 'ccsub-window-pct' }, format(t.quotaUsed, { percent: Math.round(percent(window)) })),
                      ),
                      bar(window),
                      React.createElement('span', { className: 'ccsub-hint' }, resetText(window)),
                    ),
                  ),
        ),

        // ---- Egress --------------------------------------------------------
        React.createElement(
          'div',
          { className: 'ccsub-section' },
          React.createElement('h3', { className: 'ccsub-h3' }, t.egressTitle),
          React.createElement(
            'div',
            { className: 'ccsub-row' },
            React.createElement('span', { className: 'ccsub-label' }, t.egressProxy),
            React.createElement(
              'code',
              { className: proxy?.valid === true ? 'ccsub-code' : 'ccsub-code bad' },
              proxy?.url ?? t.egressProxyMissing,
            ),
          ),
          status !== null && proxy?.valid !== true
            ? React.createElement(
                'p',
                { className: 'ccsub-hint' },
                proxy === undefined || proxy.url === undefined || proxy.url === null
                  ? t.egressProxyMissing
                  : t.egressProxyInvalid,
              )
            : null,
          React.createElement(
            'div',
            { className: 'ccsub-row' },
            React.createElement('span', { className: 'ccsub-label' }, t.egressAllow),
            React.createElement(
              'span',
              { className: 'ccsub-hint' },
              (proxy?.allow ?? []).length === 0
                ? '—'
                : (proxy?.allow ?? []).join(', '),
            ),
          ),
          proxy?.requireEgressCheck === true
            ? React.createElement('p', { className: 'ccsub-hint' }, t.egressRequire)
            : null,
          React.createElement(
            'div',
            { className: 'ccsub-row' },
            React.createElement(
              'button',
              { className: 'ccsub-btn small', disabled: egressBusy, onClick: () => void checkEgress() },
              egressBusy ? t.egressChecking : t.egressCheckNow,
            ),
            egress !== null
              ? React.createElement(
                  'span',
                  { className: 'ccsub-hint' },
                  `${t.egressObserved}: ${egress.observed ?? t.egressUnknown}` +
                    (egress.allowed === null || egress.allowed === undefined
                      ? ''
                      : egress.allowed
                        ? ` — ${t.egressAllowed}`
                        : ` — ${t.egressNotAllowed}`),
                )
              : null,
          ),
          egress?.error != null ? React.createElement('p', { className: 'ccsub-error' }, egress.error) : null,
          React.createElement('p', { className: 'ccsub-note' }, t.egressNote),
        ),

        // ---- Facts ---------------------------------------------------------
        React.createElement(
          'div',
          { className: 'ccsub-section' },
          React.createElement(
            'div',
            { className: 'ccsub-row' },
            React.createElement('span', { className: 'ccsub-label' }, t.cliVersion),
            React.createElement('code', { className: 'ccsub-code' }, status?.claudeCliVersion ?? '—'),
          ),
          React.createElement(
            'div',
            { className: 'ccsub-row' },
            React.createElement('span', { className: 'ccsub-label' }, t.modelsTitle),
            React.createElement(
              'span',
              { className: 'ccsub-hint' },
              format(t.modelsCount, { count: (status?.models ?? []).length }),
            ),
          ),
        ),
      );
    }

    const inject = ['slots', 'locale'];

    function apply(ctx) {
      injectStyles();
      // Resolve copy locally: the host locale service has changed lookup
      // semantics across versions, which left every label as `undefined`.
      // Prefer the registered namespace when it actually resolves, and fall
      // back to the plugin's own dictionaries keyed off the browser language.
      const hostT = typeof ctx.locale?.bind === 'function' ? ctx.locale.bind(LOCALE_NS) : null;
      if (typeof ctx.locale?.register === 'function') {
        try {
          ctx.effect(() => ctx.locale.register(LOCALE_NS, { en, zh }), 'dsh-ccsub: card copy');
        } catch {
          /* registration is best-effort; the local fallback below is authoritative */
        }
      }
      // Copy is always English — do not follow the browser language.
      const dict = en;
      // The card reads copy as properties (t.title) while slot labels call it
      // (t('title')); expose one callable object carrying every key.
      const t = Object.assign((key) => t[key], dict);
      for (const [key, value] of Object.entries(dict)) {
        const host = hostT === null ? undefined : hostT[key];
        if (host !== undefined && host !== null) t[key] = host;
      }
      // `settings.plugins.tab` is declared at runtime by the feature that owns
      // the Plugins settings section, so register only once it exists.
      ctx.effect(() =>
        ctx.slots.inject('settings.plugins.tab', () =>
          ctx.slots.register(
            {
              name: 'settings.plugins.tab',
              id: 'claude-sub',
              order: 41,
              locale: LOCALE_NS,
              label: () => t('title'),
              inject: () => ({ t }),
            },
            ClaudeSubscriptionCard,
          ),
        ),
      );
    }

    return { inject, apply };
  },
});
