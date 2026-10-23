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
      transportTitle: 'Where the subscription lives',
      modeDirect: 'This machine talks to Anthropic directly',
      modeServer: 'Through a claude-server deployment',
      modeHint:
        'Direct holds the OAuth grant here. claude-server keeps the grant on another machine: this process presents a bearer and never sees the Claude token.',
      serverUrl: 'Server address',
      serverUrlHint: 'Bare http(s) origin, for example http://127.0.0.1:4710. Applied live.',
      serverBearer: 'Client bearer',
      serverBearerHint: 'The CLIENT_BEARER that server was started with. Stored as a credential, never in the config file.',
      serverBearerSaved: 'A bearer is stored. Paste a new one to replace it.',
      serverBearerMissing: 'No bearer stored yet.',
      saveBearer: 'Save bearer',
      clearBearer: 'Clear',
      bearerSaved: 'Bearer stored.',
      bearerCleared: 'Bearer cleared.',
      modeSaved: 'Transport switched. Applied live — no restart needed.',
      serverBackendOn: 'Requests go to {url}',
      serverBackendOff: 'Requests go to Anthropic from this machine',
      saveServerUrl: 'Save address',
      serverUrlSaved: 'Server address saved. Applied live.',
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
      transportTitle: '订阅在哪里',
      modeDirect: '本机直接连 Anthropic',
      modeServer: '通过 claude-server 部署',
      modeHint:
        '直连模式由本进程持有 OAuth 凭据；claude-server 模式把凭据留在另一台机器上，本进程只出示通信密钥，永远看不到 Claude 令牌。',
      serverUrl: '服务器地址',
      serverUrlHint: '纯 http(s) 源地址，例如 http://127.0.0.1:4710。实时生效。',
      serverBearer: '通信密钥',
      serverBearerHint: '服务端启动时使用的 CLIENT_BEARER。以凭据形式保存，不写入配置文件。',
      serverBearerSaved: '已存有通信密钥。粘贴新值即可替换。',
      serverBearerMissing: '尚未保存通信密钥。',
      saveBearer: '保存密钥',
      clearBearer: '清除',
      bearerSaved: '密钥已保存。',
      bearerCleared: '密钥已清除。',
      modeSaved: '传输方式已切换，实时生效，无需重启。',
      serverBackendOn: '请求发往 {url}',
      serverBackendOff: '请求由本机直接发往 Anthropic',
      saveServerUrl: '保存地址',
      serverUrlSaved: '服务器地址已保存，实时生效。',
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
.ccsub-settings-row{display:grid;grid-template-columns:220px 1fr;gap:8px;align-items:start;margin:8px 0}
.ccsub-settings-row .ccsub-label{min-width:0;padding-top:5px}
.ccsub-settings-row .ccsub-hint{grid-column:2;font-size:11px}
.ccsub-settings-row textarea{resize:vertical;font-family:inherit}
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
      // Transport controls on the card. The URL draft and bearer draft are
      // local because the settings read never echoes the bearer and the card
      // must not write a half-typed URL on every keystroke.
      const [transportBusy, setTransportBusy] = React.useState(false);
      const [transportMsg, setTransportMsg] = React.useState(null);
      const [serverUrlDraft, setServerUrlDraft] = React.useState('');
      const [bearerDraft, setBearerDraft] = React.useState('');
      /**
       * The mode the operator has selected, which is not always the mode the
       * host reports.
       *
       * The server fields below render on this value rather than on
       * `status.mode`, because the two diverge exactly when it matters: the
       * write that switches the host to `claude-server` can fail (a refused
       * settings request, an unmounted settings service), and gating the URL
       * and bearer inputs on the *reported* mode then hides the only controls
       * that could be used to configure the deployment. Selecting the mode
       * shows the fields immediately; persisting is a separate concern.
       */
      const [modeDraft, setModeDraft] = React.useState(null);

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

      // Mirror the host's URL into the draft whenever the card reloads, but
      // leave it alone while the operator is typing (only seed when empty).
      React.useEffect(() => {
        const live = status?.claudeServer?.url;
        if (typeof live !== 'string') return;
        setServerUrlDraft((current) => (current.length === 0 ? live : current));
      }, [status?.claudeServer?.url]);

      // Adopt the host's mode until the operator picks one, then keep their
      // choice: a failed write must not silently snap the select back and hide
      // the fields they were about to fill in.
      React.useEffect(() => {
        const reported = status?.mode;
        if (typeof reported !== 'string') return;
        setModeDraft((current) => current ?? reported);
      }, [status?.mode]);

      /** The mode to render: the operator's choice when they made one. */
      const selectedMode = modeDraft ?? status?.mode ?? 'direct';

      /**
       * Write the transport block. `mode` and `claudeServer` both go through the
       * settings endpoint; the bearer does not, because it is a credential.
       * @param patch - fields to persist.
       */
      const writeTransport = async (patch, okText) => {
        setTransportBusy(true);
        setTransportMsg(null);
        try {
          const r = await fetch(`${API}/settings`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(patch),
          });
          const body = await r.json().catch(() => null);
          if (!r.ok) {
            setTransportMsg({ error: body?.error ?? `HTTP ${r.status}` });
            return false;
          }
          // The write landed, so this value is confirmed — hold it even if the
          // status re-read below fails, which would otherwise snap the select
          // back to a stale mode and hide the fields just revealed.
          if (patch.mode !== undefined) setModeDraft(String(patch.mode));
          await reloadStatus();
          setTransportMsg({ ok: okText });
          return true;
        } catch (e) {
          setTransportMsg({ error: String(e?.message ?? e) });
          return false;
        } finally {
          setTransportBusy(false);
        }
      };

      const switchMode = (next) => {
        // Show the server fields for the chosen mode before the host confirms:
        // an unpersisted selection is still the one the operator is editing.
        setModeDraft(next);
        return writeTransport({ mode: next }, t.modeSaved);
      };

      const saveServerUrl = async () => {
        const value = serverUrlDraft.trim();
        const ok = await writeTransport(
          { claudeServer: { url: value, bearerRecord: status?.claudeServer?.bearerRecord ?? 'claude-server' } },
          t.serverUrlSaved,
        );
        if (ok) setServerUrlDraft(value);
      };

      const saveBearerKey = async () => {
        setTransportBusy(true);
        setTransportMsg(null);
        try {
          const r = await fetch(`${API}/server/bearer`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ bearer: bearerDraft.trim() }),
          });
          const body = await r.json().catch(() => null);
          if (!r.ok) {
            setTransportMsg({ error: body?.error ?? `HTTP ${r.status}` });
            return;
          }
          setBearerDraft('');
          await reloadStatus();
          setTransportMsg({ ok: t.bearerSaved });
        } catch (e) {
          setTransportMsg({ error: String(e?.message ?? e) });
        } finally {
          setTransportBusy(false);
        }
      };

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

        // Transport lives on the card itself, not behind the "Route settings"
        // disclosure: it decides where every request goes and whether this
        // machine needs a Claude sign-in at all, so folding it away made the
        // claude-server option effectively undiscoverable.
        React.createElement(
          'div',
          { className: 'ccsub-section' },
          React.createElement('h3', { className: 'ccsub-h3' }, t.transportTitle),
          React.createElement(
            'div',
            { className: 'ccsub-row' },
            React.createElement(
              'select',
              {
                className: 'ccsub-input',
                value: selectedMode,
                disabled: transportBusy,
                onChange: (e) => void switchMode(e.target.value),
              },
              React.createElement('option', { value: 'direct' }, t.modeDirect),
              React.createElement('option', { value: 'claude-server' }, t.modeServer),
            ),
            React.createElement(
              'span',
              { className: 'ccsub-hint' },
              selectedMode === 'claude-server'
                ? t.serverBackendOn.replace('{url}', status?.claudeServer?.url || '—')
                : t.serverBackendOff,
            ),
          ),
          selectedMode === 'claude-server'
            ? React.createElement(
                'div',
                null,
                React.createElement(
                  'div',
                  { className: 'ccsub-row' },
                  React.createElement('span', { className: 'ccsub-label' }, t.serverUrl),
                  React.createElement('input', {
                    className: 'ccsub-input',
                    value: serverUrlDraft,
                    placeholder: 'http://127.0.0.1:4710',
                    disabled: transportBusy,
                    onChange: (e) => setServerUrlDraft(e.target.value),
                  }),
                  React.createElement(
                    'button',
                    { className: 'ccsub-btn small', disabled: transportBusy, onClick: () => void saveServerUrl() },
                    t.saveServerUrl,
                  ),
                ),
                React.createElement(
                  'div',
                  { className: 'ccsub-row' },
                  React.createElement('span', { className: 'ccsub-label' }, t.serverBearer),
                  React.createElement('input', {
                    className: 'ccsub-input',
                    type: 'password',
                    value: bearerDraft,
                    autoComplete: 'off',
                    placeholder: status?.claudeServer?.bearerConfigured ? '••••••••' : '',
                    disabled: transportBusy,
                    onChange: (e) => setBearerDraft(e.target.value),
                  }),
                  React.createElement(
                    'button',
                    {
                      className: 'ccsub-btn small',
                      disabled: transportBusy || bearerDraft.trim().length === 0,
                      onClick: () => void saveBearerKey(),
                    },
                    t.saveBearer,
                  ),
                ),
                React.createElement(
                  'p',
                  { className: 'ccsub-hint' },
                  status?.claudeServer?.bearerConfigured === true ? t.serverBearerSaved : t.serverBearerMissing,
                ),
                React.createElement('p', { className: 'ccsub-note' }, t.serverBearerHint),
              )
            : null,
          transportMsg === null
            ? null
            : React.createElement(
                'p',
                { className: transportMsg.error === undefined ? 'ccsub-hint' : 'ccsub-error' },
                transportMsg.error ?? transportMsg.ok,
              ),
        ),

        error !== null
          ? React.createElement('p', { className: 'ccsub-error', role: 'alert' }, error)
          : null,

        status !== null && status.quotaThrottle !== undefined && (status.quotaThrottle.over ?? []).length > 0
          ? React.createElement(
              'div',
              { className: 'ccsub-row' },
              React.createElement(
                'span',
                { className: 'ccsub-error' },
                'Quota throttle active: window(s) at ≥' + status.quotaThrottle.threshold + '% — requests park until reset' +
                  ((status.quotaThrottle.waiting ?? 0) > 0 ? ' (' + status.quotaThrottle.waiting + ' parked)' : ''),
              ),
              (status.quotaThrottle.waiting ?? 0) > 0
                ? React.createElement('button', {
                    className: 'ccsub-btn small',
                    onClick: () => void fetch(`${API}/throttle/release`, { method: 'POST' }).then(() => void reloadStatus()),
                  }, 'Skip wait')
                : null,
            )
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

    /**
     * Full settings page in the Settings sidebar (not just the Plugins tab):
     * every editable option of the route, saved through the settings service.
     */
    function ClaudeSubscriptionSettings(props) {
      const [form, setForm] = React.useState(null);
      const [busy, setBusy] = React.useState(false);
      const [msg, setMsg] = React.useState(null);
      const [error, setError] = React.useState(null);

      React.useEffect(() => {
        void (async () => {
          try {
            const r = await fetch(`${API}/settings`, { headers: { accept: 'application/json' } });
            const body = await r.json();
            if (r.ok) setForm(body);
            else setError(body?.error ?? `HTTP ${r.status}`);
          } catch (e) {
            setError(String(e?.message ?? e));
          }
        })();
      }, []);

      const setField = (patch) => setForm((f) => (f === null ? f : { ...f, ...patch }));
      const setProxy = (patch) => setForm((f) => (f === null ? f : { ...f, proxy: { ...f.proxy, ...patch } }));
      const setServer = (patch) =>
        setForm((f) => (f === null ? f : { ...f, claudeServer: { ...(f.claudeServer ?? {}), ...patch } }));

      // The bearer is not part of the settings form: it has its own endpoint,
      // because it is a credential and the settings read must never echo it.
      const [bearer, setBearer] = React.useState('');
      const [bearerBusy, setBearerBusy] = React.useState(false);
      const [bearerMsg, setBearerMsg] = React.useState(null);

      const saveBearer = async (value) => {
        setBearerBusy(true);
        setBearerMsg(null);
        try {
          const r = await fetch(`${API}/server/bearer`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ bearer: value }),
          });
          const body = await r.json().catch(() => null);
          if (!r.ok) {
            setBearerMsg({ error: body?.error ?? `HTTP ${r.status}` });
            return;
          }
          // Re-read so `bearerConfigured` reflects what the host actually stored.
          const s = await fetch(`${API}/settings`, { headers: { accept: 'application/json' } });
          const sb = await s.json().catch(() => null);
          if (s.ok && sb !== null) setForm((f) => (f === null ? f : { ...f, claudeServer: sb.claudeServer }));
          setBearer('');
          setBearerMsg({ ok: value.length === 0 ? t.bearerCleared : t.bearerSaved });
        } catch (e) {
          setBearerMsg({ error: String(e?.message ?? e) });
        } finally {
          setBearerBusy(false);
        }
      };

      const save = async () => {
        setBusy(true);
        setError(null);
        setMsg(null);
        try {
          const r = await fetch(`${API}/settings`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              mode: form.mode,
              claudeServer: {
                url: form.claudeServer?.url ?? '',
                bearerRecord: form.claudeServer?.bearerRecord ?? 'claude-server',
              },
              claudeCliVersion: form.claudeCliVersion,
              contextWindowOverride: Number(form.contextWindowOverride) || 0,
              refreshSkewMs: Number(form.refreshSkewMs) || 300000,
              quotaPollMs: Number(form.quotaPollMs) || 180000,
              quotaThrottlePercent: Number(form.quotaThrottlePercent) || 0,
              quotaWatchPollMs: Number(form.quotaWatchPollMs) || 600000,
              proxy: form.proxy,
            }),
          });
          const body = await r.json().catch(() => null);
          if (!r.ok) setError(body?.error ?? `HTTP ${r.status}`);
          else setMsg(t.modeSaved + ' Context window and proxy URL still apply after the next restart.');
        } catch (e) {
          setError(String(e?.message ?? e));
        } finally {
          setBusy(false);
        }
      };

      if (form === null) {
        return React.createElement('p', { className: 'ccsub-hint' }, error ?? 'Loading…');
      }
      const row = (label, control, hint) =>
        React.createElement(
          'div',
          { className: 'ccsub-settings-row' },
          React.createElement('label', { className: 'ccsub-label' }, label),
          control,
          hint === undefined ? null : React.createElement('span', { className: 'ccsub-hint' }, hint),
        );

      return React.createElement(
        'div',
        { className: 'ccsub-card' },
        React.createElement('h2', { className: 'ccsub-title' }, 'Claude Subscription — Route Settings'),
        React.createElement('p', { className: 'ccsub-sub' }, 'Options of the claude-sub route. Saved through the host settings service.'),

        error !== null ? React.createElement('p', { className: 'ccsub-error' }, error) : null,
        msg !== null ? React.createElement('p', { className: 'ccsub-hint' }, msg) : null,

        // ---- Transport -----------------------------------------------------
        React.createElement(
          'div',
          { className: 'ccsub-section' },
          React.createElement('h3', { className: 'ccsub-h3' }, t.transportTitle),
          row(
            'Transport',
            React.createElement(
              'select',
              {
                className: 'ccsub-input',
                value: form.mode ?? 'direct',
                onChange: (e) => setField({ mode: e.target.value }),
              },
              React.createElement('option', { value: 'direct' }, t.modeDirect),
              React.createElement('option', { value: 'claude-server' }, t.modeServer),
            ),
            t.modeHint,
          ),
          (form.mode ?? 'direct') === 'claude-server'
            ? React.createElement(
                'div',
                null,
                row(
                  t.serverUrl,
                  React.createElement('input', {
                    className: 'ccsub-input',
                    value: form.claudeServer?.url ?? '',
                    placeholder: 'http://127.0.0.1:4710',
                    onChange: (e) => setServer({ url: e.target.value }),
                  }),
                  t.serverUrlHint,
                ),
                row(
                  t.serverBearer,
                  React.createElement('input', {
                    className: 'ccsub-input',
                    type: 'password',
                    value: bearer,
                    autoComplete: 'off',
                    placeholder: form.claudeServer?.bearerConfigured ? '••••••••' : '',
                    onChange: (e) => setBearer(e.target.value),
                  }),
                  form.claudeServer?.bearerConfigured ? t.serverBearerSaved : t.serverBearerMissing,
                ),
                React.createElement(
                  'div',
                  { className: 'ccsub-row' },
                  React.createElement(
                    'button',
                    {
                      className: 'ccsub-btn small',
                      disabled: bearerBusy || bearer.trim().length === 0,
                      onClick: () => void saveBearer(bearer.trim()),
                    },
                    bearerBusy ? '…' : t.saveBearer,
                  ),
                  form.claudeServer?.bearerConfigured
                    ? React.createElement(
                        'button',
                        {
                          className: 'ccsub-btn small ghost',
                          disabled: bearerBusy,
                          onClick: () => void saveBearer(''),
                        },
                        t.clearBearer,
                      )
                    : null,
                ),
                bearerMsg === null
                  ? null
                  : React.createElement(
                      'p',
                      { className: bearerMsg.error === undefined ? 'ccsub-hint' : 'ccsub-error' },
                      bearerMsg.error ?? bearerMsg.ok,
                    ),
                React.createElement('p', { className: 'ccsub-note' }, t.serverBearerHint),
              )
            : null,
        ),

        React.createElement(
          'div',
          { className: 'ccsub-section' },
          React.createElement('h3', { className: 'ccsub-h3' }, 'Proxy & egress'),
          row('Proxy URL', React.createElement('input', {
            className: 'ccsub-input', value: form.proxy.url ?? '',
            onChange: (e) => setProxy({ url: e.target.value }),
          }), 'Mandatory transport; empty means refuse to send. Restart to apply.'),
          row('Egress allowlist (one per line)', React.createElement('textarea', {
            className: 'ccsub-input', rows: 2, value: (form.proxy.egressAllow ?? []).join('\n'),
            onChange: (e) => setProxy({ egressAllow: e.target.value.split(/\n|,/).map((s) => s.trim()).filter(Boolean) }),
          }), 'Empty = pin the first observed IP for this session.'),
          row('Refuse on unverifiable egress', React.createElement('input', {
            type: 'checkbox', checked: form.proxy.requireEgressCheck !== false,
            onChange: (e) => setProxy({ requireEgressCheck: e.target.checked }),
          })),
        ),

        React.createElement(
          'div',
          { className: 'ccsub-section' },
          React.createElement('h3', { className: 'ccsub-h3' }, 'Identity & context'),
          row('Claude CLI version', React.createElement('input', {
            className: 'ccsub-input', value: form.claudeCliVersion ?? 'auto',
            onChange: (e) => setField({ claudeCliVersion: e.target.value }),
          }), `'auto' tracks the latest npm release (currently ${form.resolved?.claudeCliVersion ?? '…'}). Restart to apply.`),
          row('Declared context window (tokens)', React.createElement('input', {
            className: 'ccsub-input', type: 'number', value: form.contextWindowOverride ?? 0,
            onChange: (e) => setField({ contextWindowOverride: Number(e.target.value) || 0 }),
          }), '0 = catalog default. Higher defers pressure compaction; restart to apply.'),
        ),

        React.createElement(
          'div',
          { className: 'ccsub-section' },
          React.createElement('h3', { className: 'ccsub-h3' }, 'Timing & quota'),
          row('Quota throttle (%)', React.createElement('input', {
            className: 'ccsub-input', type: 'number', value: form.quotaThrottlePercent ?? 90,
            onChange: (e) => setField({ quotaThrottlePercent: Number(e.target.value) || 0 }),
          }), '0 = off. At/above this window usage, requests park until the window resets.'),
          row('Usage watch interval (ms)', React.createElement('input', {
            className: 'ccsub-input', type: 'number', value: form.quotaWatchPollMs ?? 600000,
            onChange: (e) => setField({ quotaWatchPollMs: Number(e.target.value) || 600000 }),
          })),
          row('Refresh skew (ms)', React.createElement('input', {
            className: 'ccsub-input', type: 'number', value: form.refreshSkewMs ?? 300000,
            onChange: (e) => setField({ refreshSkewMs: Number(e.target.value) || 300000 }),
          })),
          row('Quota poll interval (ms)', React.createElement('input', {
            className: 'ccsub-input', type: 'number', value: form.quotaPollMs ?? 180000,
            onChange: (e) => setField({ quotaPollMs: Number(e.target.value) || 180000 }),
          })),
        ),

        React.createElement(
          'div',
          { className: 'ccsub-row' },
          React.createElement('button', { className: 'ccsub-btn', disabled: busy, onClick: () => void save() }, busy ? 'Saving…' : 'Save settings'),
        ),
      );
    }

    /**
     * Sidebar section: the frequently-checked surface (sign-in state, quota
     * windows, egress health) first, with the set-and-forget route options
     * folded away behind a disclosure at the bottom.
     */
    function ClaudeSubscriptionSection(props) {
      const [settingsOpen, setSettingsOpen] = React.useState(false);
      return React.createElement(
        'div',
        { className: 'ccsub-card' },
        React.createElement(ClaudeSubscriptionCard, props),
        React.createElement(
          'button',
          {
            className: 'ccsub-btn ghost',
            onClick: () => setSettingsOpen((v) => !v),
          },
          settingsOpen ? 'Hide route settings' : 'Route settings (proxy, context window, timing)',
        ),
        settingsOpen ? React.createElement(ClaudeSubscriptionSettings, props) : null,
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
      // Sidebar section: status & quota first (the frequently-checked surface),
      // route settings folded inside.
      ctx.effect(() =>
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            {
              name: 'settings.section',
              id: 'claude-sub',
              order: 42,
              locale: LOCALE_NS,
              label: () => 'Claude Subscription',
              inject: () => ({ t }),
            },
            ClaudeSubscriptionSection,
          ),
        ),
      );
    }

    return { inject, apply };
  },
});
