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
      expiresAt: 'Access token expires {time}',
      signIn: 'Sign in with browser',
      signOut: 'Sign out',
      signingIn: 'Waiting for you in the browser…',
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
      egressInactive:
        'Inactive: requests go through the claude-server deployment, so this process never connects to Anthropic and the proxy setting does not apply.',
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
      serverBearerHint:
        'A token issued on that server (Users page). Stored as a credential, never in the config file.',
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
      compatDrift:
        'Dependency drift: pi-ai {pi} does not satisfy {range}, which dsh-llm-pi-ai {adapter} requires. Model requests will fail until this plugin is reinstalled against this harness.',
      compatUnknown:
        'Cannot verify the pi-ai version this route loads ({pi}) against dsh-llm-pi-ai ({adapter}); model requests may fail if they disagree.',
      settingsShow: 'Route settings',
      settingsShowHint: 'Proxy, context window, timing',
      settingsHide: 'Hide route settings',
      settingsSubtitle: 'Set-and-forget options for this route, saved through the host settings service.',
      saveSettings: 'Save settings',
      savingSettings: 'Saving…',
      settingsSaved: 'Settings saved. Context window and proxy URL still apply after the next restart.',
      skipWait: 'Skip wait',
      serverConnected: 'Connected',
      serverUnreachable: 'No backend configured',
      serverUnreachableHint:
        'Set the server address below. The deployment holding the grant must be reachable before this route can send anything.',
      loading: 'Loading…',
      expiresUnknown: 'Access token expiry not reported',
      notSignedInHint: 'Sign in here, or point the route at a claude-server deployment that holds the grant.',
      throttleTitle: 'Quota throttle active',
      throttleBody: 'A window is at or above {threshold}% — requests park until it resets.',
      throttleParked: '{count} parked',
      proxySectionTitle: 'Proxy & egress',
      proxyUrlLabel: 'Proxy URL',
      proxyUrlHint: 'Mandatory transport; empty means refuse to send. Restart to apply.',
      egressAllowLabel: 'Egress allowlist (one per line)',
      egressAllowHint: 'Empty means pin the first observed IP for this session.',
      requireCheckLabel: 'Refuse on unverifiable egress',
      identitySectionTitle: 'Identity & context',
      cliVersionHint: "'auto' tracks the latest npm release (currently {version}). Restart to apply.",
      contextWindowLabel: 'Declared context window (tokens)',
      contextWindowHint: '0 = catalog default. Higher defers pressure compaction; restart to apply.',
      timingSectionTitle: 'Timing & quota',
      throttleLabel: 'Quota throttle (%)',
      throttleHint: '0 = off. At or above this window usage, requests park until the window resets.',
      refreshSkewLabel: 'Refresh skew (ms)',
      quotaPollLabel: 'Quota poll interval (ms)',
    };

    const zh = {
      title: 'Claude 订阅',
      subtitle: '通过官方浏览器登录，使用 Claude Pro/Max 订阅。',
      notSignedIn: '未登录',
      signedIn: '已登录',
      expiresAt: '访问令牌将于 {time} 过期',
      signIn: '使用浏览器登录',
      signOut: '退出登录',
      signingIn: '正在等待浏览器完成…',
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
      egressInactive:
        '未启用：请求经由 claude-server 部署转发，本进程不会直接连接 Anthropic，代理设置在此模式下不生效。',
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
      serverBearerHint: '在该服务端的 Users（用户）页签发的令牌。以凭据形式保存，不写入配置文件。',
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
      compatDrift:
        '依赖版本不匹配：pi-ai {pi} 不满足 dsh-llm-pi-ai {adapter} 要求的 {range}。在按当前 harness 重装本插件之前，模型请求会失败。',
      compatUnknown:
        '无法确认本路由加载的 pi-ai 版本（{pi}）与 dsh-llm-pi-ai（{adapter}）是否匹配；两者不一致时模型请求可能失败。',
      settingsShow: '路由设置',
      settingsShowHint: '代理、上下文窗口、时序',
      settingsHide: '收起路由设置',
      settingsSubtitle: '本路由一次配置、长期生效的选项，通过宿主设置服务保存。',
      saveSettings: '保存设置',
      savingSettings: '保存中…',
      settingsSaved: '设置已保存。上下文窗口与代理 URL 仍需在下次重启后生效。',
      skipWait: '跳过等待',
      serverConnected: '已连接',
      serverUnreachable: '未配置后端',
      serverUnreachableHint:
        '在下方填写服务器地址。持有凭据的部署必须可达，此路由才能发送请求。',
      loading: '加载中…',
      expiresUnknown: '未返回访问令牌过期时间',
      notSignedInHint: '可在此登录，或把路由指向持有凭据的 claude-server 部署。',
      throttleTitle: '额度限流已启用',
      throttleBody: '有窗口已达或超过 {threshold}%——请求会暂存到窗口重置。',
      throttleParked: '暂存 {count} 个',
      proxySectionTitle: '代理与出口',
      proxyUrlLabel: '代理 URL',
      proxyUrlHint: '强制使用的传输方式；留空即拒绝发送。重启后生效。',
      egressAllowLabel: '出口 IP 白名单（每行一个）',
      egressAllowHint: '留空则在本次会话中锁定首个观测到的 IP。',
      requireCheckLabel: '出口无法验证时拒绝发送',
      identitySectionTitle: '身份与上下文',
      cliVersionHint: "'auto' 跟随 npm 最新版本（当前 {version}）。重启后生效。",
      contextWindowLabel: '声明的上下文窗口（token）',
      contextWindowHint: '0 = 目录默认值。调高可延后压力压缩；重启后生效。',
      timingSectionTitle: '时序与额度',
      throttleLabel: '额度限流阈值（%）',
      throttleHint: '0 = 关闭。窗口用量达到或超过该值时，请求会暂存到窗口重置。',
      refreshSkewLabel: '刷新提前量（毫秒）',
      quotaPollLabel: '额度轮询间隔（毫秒）',
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
.ccsub-card{display:flex;flex-direction:column;min-width:0;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.12));border-radius:12px;background:var(--dsw-alias-bg-layer-1,#161a23);color:var(--dsw-alias-label-primary,#e9ecf1);font-size:13px;line-height:1.45;overflow:hidden}
.ccsub-main{display:flex;flex-direction:column;min-width:0}
.ccsub-head{display:flex;flex-direction:column;gap:3px;padding:16px 16px 14px}
.ccsub-title{margin:0;font-size:16px;line-height:1.3;font-weight:600;color:var(--dsw-alias-label-primary,#e9ecf1)}
.ccsub-sub{margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary,#a3abba)}
.ccsub-alert{display:flex;flex-direction:column;gap:2px;margin:0 16px 12px;padding:10px 12px;border-radius:8px;border:1px solid rgba(248,81,73,.38);border-color:color-mix(in srgb,var(--dsw-alias-label-error,#f85149) 38%,transparent);background:rgba(248,81,73,.1);background:color-mix(in srgb,var(--dsw-alias-label-error,#f85149) 10%,transparent);color:var(--dsw-alias-label-primary,#e9ecf1);font-size:12px;line-height:1.5}
.ccsub-alert.warn{border-color:rgba(210,153,34,.4);border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#e3a008) 40%,transparent);background:rgba(210,153,34,.1);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#e3a008) 10%,transparent);color:var(--dsw-alias-label-primary,#e9ecf1)}
.ccsub-alert-text{margin:0;font-size:12px;line-height:1.5}
.ccsub-alert-row{display:flex;align-items:flex-start;gap:8px;flex-wrap:wrap}
.ccsub-alert-row>.ccsub-stack{flex:1 1 150px;align-self:flex-start;gap:2px}
.ccsub-alert-row>.ccsub-btn{flex:0 0 auto}
.ccsub-error{margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-error,#f85149)}
.ccsub-ok{margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-state-success-primary,#3fb950)}
.ccsub-section{display:flex;flex-direction:column;gap:12px;min-width:0;padding:14px 16px;border-top:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.07))}
.ccsub-section.ccsub-status{gap:14px;background:var(--dsw-alias-bg-layer-2,#1b202b)}
.ccsub-status-main{display:flex;align-items:flex-start;gap:10px;min-width:0}
.ccsub-dot{flex:none;width:8px;height:8px;margin-top:6px;border-radius:50%;background:var(--dsw-alias-state-idle-primary,#6b7280);box-shadow:0 0 0 3px rgba(107,114,128,.2);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-state-idle-primary,#6b7280) 22%,transparent)}
.ccsub-dot.ok{background:var(--dsw-alias-state-success-primary,#3fb950);box-shadow:0 0 0 3px rgba(63,185,80,.2);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-state-success-primary,#3fb950) 22%,transparent)}
.ccsub-status-text{display:flex;flex-direction:column;gap:2px;min-width:0}
.ccsub-status-label{margin:0;font-size:15px;line-height:1.3;font-weight:600;color:var(--dsw-alias-label-primary,#e9ecf1)}
.ccsub-status-fact{margin:0;font-size:11px;line-height:1.5;color:var(--dsw-alias-label-tertiary,#838c9d);overflow-wrap:anywhere}
.ccsub-actions{display:flex;flex-wrap:wrap;gap:8px}
.ccsub-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;box-sizing:border-box;min-height:32px;padding:7px 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l3,rgba(255,255,255,.18));background:var(--dsw-alias-bg-layer-3,#232936);color:var(--dsw-alias-label-primary,#e9ecf1);font:inherit;font-size:12px;font-weight:500;line-height:1.2;cursor:pointer;transition:background-color .15s ease,color .15s ease,border-color .15s ease,opacity .15s ease}
.ccsub-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.06))}
.ccsub-btn:active:not(:disabled){background:var(--dsw-alias-interactive-bg-active,rgba(255,255,255,.1))}
.ccsub-btn:disabled{opacity:.45;cursor:not-allowed}
.ccsub-btn.small{min-height:28px;padding:5px 10px;border-radius:7px;font-size:11px}
.ccsub-btn.primary{background:var(--dsw-alias-brand-primary,#5b9bff);border-color:transparent;color:var(--dsw-alias-toast-label,#ffffff)}
.ccsub-btn.primary:hover:not(:disabled){background:var(--dsw-alias-state-business-primary,#4c8dff)}
.ccsub-btn.ghost{background:transparent;border-color:transparent;color:var(--dsw-alias-label-secondary,#a3abba)}
.ccsub-btn.ghost:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.06));color:var(--dsw-alias-label-primary,#e9ecf1)}
.ccsub-btn.ghost.danger{color:var(--dsw-alias-label-error,#f85149)}
.ccsub-btn.ghost.danger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger,rgba(248,81,73,.12))}
.ccsub-btn:focus-visible,.ccsub-disclosure-btn:focus-visible,.ccsub-link:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#5b9bff);outline-offset:2px}
.ccsub-group-head{display:flex;align-items:center;justify-content:space-between;gap:8px;min-height:28px}
.ccsub-group-title{margin:0;font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary,#e9ecf1)}
.ccsub-meters{display:flex;flex-direction:column;gap:2px}
.ccsub-meter{display:flex;flex-direction:column;gap:5px;padding:6px 0}
.ccsub-meter+.ccsub-meter{border-top:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.07))}
.ccsub-meter-head{display:flex;align-items:baseline;gap:8px;min-width:0}
.ccsub-meter-name{min-width:0;font-size:12px;font-weight:500;color:var(--dsw-alias-label-primary,#e9ecf1);overflow-wrap:anywhere}
.ccsub-meter-pct{flex:none;margin-left:auto;font-size:12px;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary,#a3abba)}
.ccsub-meter-track{height:6px;border-radius:999px;overflow:hidden;background:var(--dsw-alias-bg-layer-3,#232936)}
.ccsub-meter-fill{height:100%;border-radius:999px;background:var(--dsw-alias-state-business-primary,#4c8dff);transition:background-color .2s ease}
.ccsub-meter-fill.warn{background:var(--dsw-alias-state-warn-primary,#e3a008)}
.ccsub-meter-fill.critical{background:var(--dsw-alias-state-error-primary,#f85149)}
.ccsub-meter-reset{font-size:11px;line-height:1.4;color:var(--dsw-alias-label-tertiary,#838c9d)}
.ccsub-login{display:flex;flex-direction:column;gap:10px;padding:12px;border-radius:8px;background:var(--dsw-alias-bg-base,#10141b)}
.ccsub-login-title{margin:0;font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary,#e9ecf1)}
.ccsub-notices{display:flex;flex-direction:column;gap:8px;min-width:0}
.ccsub-notice{display:flex;flex-direction:column;gap:2px;min-width:0}
.ccsub-notice p{margin:0;display:flex;flex-wrap:wrap;align-items:baseline;gap:6px}
.ccsub-link{color:var(--dsw-alias-state-business-primary,#4c8dff);font-size:11px;word-break:break-all;text-decoration:none;border-radius:4px}
.ccsub-link:hover{text-decoration:underline}
.ccsub-stack{display:flex;flex-direction:column;gap:12px;min-width:0}
.ccsub-field{display:flex;flex-direction:column;gap:4px;min-width:0}
.ccsub-field-label{font-size:11px;font-weight:500;color:var(--dsw-alias-label-secondary,#a3abba)}
.ccsub-input,.ccsub-select{box-sizing:border-box;width:100%;min-height:32px;padding:6px 9px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.12));background:var(--dsw-alias-bg-base,#10141b);color:var(--dsw-alias-label-primary,#e9ecf1);font:inherit;font-size:12px;line-height:1.4}
.ccsub-input::placeholder{color:var(--dsw-alias-label-dimmed,#5c6473)}
.ccsub-input:hover:not(:disabled),.ccsub-select:hover:not(:disabled){border-color:var(--dsw-alias-border-l3,rgba(255,255,255,.18))}
.ccsub-input:focus-visible,.ccsub-select:focus-visible{outline:none;border-color:var(--dsw-alias-brand-primary,#5b9bff);box-shadow:0 0 0 2px color-mix(in srgb,var(--dsw-alias-brand-primary,#5b9bff) 30%,transparent)}
.ccsub-select{appearance:none;-webkit-appearance:none;padding-right:28px;cursor:pointer}
.ccsub-select-wrap{position:relative;display:block;min-width:0}
.ccsub-select-wrap>.ccsub-chevron{position:absolute;top:50%;right:9px;transform:translateY(-50%);pointer-events:none;color:var(--dsw-alias-label-tertiary,#838c9d)}
.ccsub-textarea{min-height:52px;resize:vertical;font-family:inherit}
.ccsub-inline{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}
.ccsub-inline>.ccsub-input{flex:1 1 140px;width:auto;min-width:0}
.ccsub-inline>.ccsub-btn{flex:0 0 auto}
.ccsub-hint{margin:0;font-size:11px;line-height:1.5;color:var(--dsw-alias-label-secondary,#a3abba)}
.ccsub-note{margin:0;font-size:11px;line-height:1.55;color:var(--dsw-alias-label-tertiary,#838c9d)}
.ccsub-code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;line-height:1.5;padding:2px 6px;border-radius:5px;background:var(--dsw-alias-bg-layer-3,#232936);color:var(--dsw-alias-label-primary,#e9ecf1);overflow-wrap:anywhere}
.ccsub-code.bad{background:rgba(248,81,73,.12);background:color-mix(in srgb,var(--dsw-alias-label-error,#f85149) 12%,transparent);color:var(--dsw-alias-label-error,#f85149)}
.ccsub-kv{display:flex;flex-direction:column;gap:3px;min-width:0}
.ccsub-kv-label{font-size:11px;color:var(--dsw-alias-label-secondary,#a3abba)}
.ccsub-kv-value{font-size:12px;color:var(--dsw-alias-label-primary,#e9ecf1);overflow-wrap:anywhere}
.ccsub-check{display:flex;align-items:flex-start;gap:8px;font-size:12px;color:var(--dsw-alias-label-primary,#e9ecf1);cursor:pointer}
.ccsub-check input{flex:none;margin:2px 0 0;accent-color:var(--dsw-alias-brand-primary,#5b9bff)}
.ccsub-check input:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#5b9bff);outline-offset:2px}
.ccsub-facts{display:flex;flex-direction:column;gap:6px;padding:12px 16px;border-top:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.07))}
.ccsub-fact{display:flex;align-items:baseline;justify-content:space-between;gap:12px;min-width:0;flex-wrap:wrap}
.ccsub-fact-label{min-width:0;font-size:11px;color:var(--dsw-alias-label-tertiary,#838c9d)}
.ccsub-fact-value,.ccsub-fact .ccsub-code{min-width:0;font-size:11px;color:var(--dsw-alias-label-secondary,#a3abba);overflow-wrap:anywhere;text-align:right}
.ccsub-fact .ccsub-code{padding:0;background:none;font-size:11px;color:var(--dsw-alias-label-secondary,#a3abba)}
.ccsub-disclosure{border-top:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.07))}
.ccsub-disclosure-btn{display:flex;align-items:center;gap:8px;width:100%;min-height:40px;padding:10px 16px;border:0;background:transparent;color:var(--dsw-alias-label-secondary,#a3abba);font:inherit;font-size:12px;text-align:left;cursor:pointer;transition:background-color .15s ease,color .15s ease}
.ccsub-disclosure-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.06));color:var(--dsw-alias-label-primary,#e9ecf1)}
.ccsub-disclosure-label{display:flex;flex-direction:column;gap:1px;flex:1;min-width:0}
.ccsub-disclosure-text{font-size:12px;font-weight:500;color:var(--dsw-alias-label-secondary,#a3abba)}
.ccsub-disclosure-btn:hover .ccsub-disclosure-text{color:var(--dsw-alias-label-primary,#e9ecf1)}
.ccsub-disclosure-sub{font-size:11px;line-height:1.4;color:var(--dsw-alias-label-tertiary,#838c9d)}
.ccsub-chevron{flex:none;display:block;color:currentColor;transition:transform .15s ease}
.ccsub-chevron.open{transform:rotate(180deg)}
.ccsub-disclosure-body{border-top:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.07));background:var(--dsw-alias-bg-base,#10141b)}
.ccsub-settings{display:flex;flex-direction:column;gap:16px;min-width:0;padding:14px 16px 16px}
.ccsub-settings-group{display:flex;flex-direction:column;gap:12px;min-width:0}
.ccsub-settings-group+.ccsub-settings-group{padding-top:16px;border-top:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.07))}
.ccsub-settings-actions{display:flex;justify-content:flex-end;gap:8px}
@media (prefers-reduced-motion:reduce){.ccsub-card .ccsub-btn,.ccsub-card .ccsub-meter-fill,.ccsub-card .ccsub-chevron,.ccsub-card .ccsub-disclosure-btn{transition:none}}
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

    /**
     * One fetch against the Host surface, returning parsed JSON or a failure.
     *
     * Never throws: a refused fence, an unloaded host route, or a dead socket
     * all become `{ ok: false, error }`. Callers are UI handlers, and an
     * unhandled rejection in one of them leaves the card stuck on its busy
     * state with no feedback.
     */
    async function call(path, init) {
      let response;
      try {
        response = await fetch(`${API}${path}`, {
          headers: { accept: 'application/json' },
          ...init,
        });
      } catch (error) {
        return { ok: false, error: String(error?.message ?? error), status: 0 };
      }
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

    /**
     * A small single-stroke chevron, used as the select and disclosure glyph.
     * Inline SVG keeps the module dependency-free; `currentColor` makes it
     * follow the surrounding text colour in both themes.
     */
    function chevron(open) {
      return React.createElement(
        'svg',
        {
          className: `ccsub-chevron${open ? ' open' : ''}`,
          width: 12,
          height: 12,
          viewBox: '0 0 16 16',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          focusable: 'false',
        },
        React.createElement('path', { d: 'M4 6l4 4 4-4' }),
      );
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
      /** Severity of one window: the bar's colour shifts at 70% and 90%. */
      const level = (window) => (percent(window) >= 90 ? 'critical' : percent(window) >= 70 ? 'warn' : '');
      const resetText = (window) =>
        typeof window.resetsAt === 'number'
          ? format(t.quotaResets, { time: new Date(window.resetsAt).toLocaleString() })
          : t.quotaResetUnknown;
      /**
       * One quota window: name, percentage, bar, reset caption.
       *
       * The percentage is text in its own right (the bar is `aria-hidden`), so
       * the meter reads the same in a screen reader and at 320px wide.
       */
      const meter = (window, key) =>
        React.createElement(
          'div',
          { key, className: 'ccsub-meter' },
          React.createElement(
            'div',
            { className: 'ccsub-meter-head' },
            React.createElement('span', { className: 'ccsub-meter-name' }, windowLabel(t, window)),
            React.createElement(
              'span',
              { className: 'ccsub-meter-pct' },
              format(t.quotaUsed, { percent: Math.round(percent(window)) }),
            ),
          ),
          React.createElement(
            'div',
            { className: 'ccsub-meter-track', 'aria-hidden': 'true' },
            React.createElement('div', {
              className: `ccsub-meter-fill ${level(window)}`.trim(),
              style: { width: `${percent(window)}%` },
            }),
          ),
          React.createElement('span', { className: 'ccsub-meter-reset' }, resetText(window)),
        );

      const grant = status?.grant;
      const proxy = status?.proxy;
      const compat = status?.compat;
      const signedIn = grant?.configured === true;
      /**
       * Whether *this* process needs its own Claude sign-in.
       *
       * Not the same as `signedIn`. In `claude-server` mode the local grant is
       * blank by design — the deployment holds it — so `grant.configured` is
       * false on a route that is working perfectly. Reading the state through
       * that field alone announced "Not signed in" on every healthy
       * claude-server install and offered a browser sign-in the route never
       * uses. The state that matters there is whether the backend is reachable
       * and holds a bearer.
       */
      const selfSignedIn = selectedMode === 'claude-server' ? status?.claudeServer?.valid === true : signedIn;
      /** The state the status header reports, and the tone its dot takes. */
      const stateLabel =
        selectedMode === 'claude-server'
          ? status?.claudeServer?.valid === true
            ? t.serverConnected
            : t.serverUnreachable
          : signedIn
            ? t.signedIn
            : t.notSignedIn;
      /** The secondary fact beside the state label: the backend, or the expiry. */
      const statusFact =
        selectedMode === 'claude-server'
          ? format(t.serverBackendOn, { url: status?.claudeServer?.url || '—' })
          : signedIn
            ? typeof grant.expiresAt === 'number'
              ? format(t.expiresAt, { time: new Date(grant.expiresAt).toLocaleString() })
              : t.expiresUnknown
            : t.notSignedInHint;
      const throttle = status?.quotaThrottle;
      const throttled = throttle !== undefined && throttle !== null && (throttle.over ?? []).length > 0;
      const parked = throttled ? (throttle.waiting ?? 0) : 0;

      return React.createElement(
        'div',
        { className: 'ccsub-main' },

        // ---- Title ---------------------------------------------------------
        React.createElement(
          'div',
          { className: 'ccsub-head' },
          React.createElement('h2', { className: 'ccsub-title' }, t.title),
          React.createElement('p', { className: 'ccsub-sub' }, t.subtitle),
        ),

        // Dependency drift is the failure that surfaces as an opaque stream
        // error later, so it belongs here rather than only in the host log: the
        // check already resolves the loaded copies, and reporting it on the
        // card is what makes it actionable before a request fails.
        compat !== undefined && compat !== null && compat.compatible === false
          ? React.createElement(
              'div',
              { className: 'ccsub-alert' },
              React.createElement(
                'p',
                { className: 'ccsub-alert-text' },
                t.compatDrift
                  .replace('{pi}', String(compat.piAiVersion ?? '?'))
                  .replace('{range}', String(compat.piAiRequiredByAdapter ?? '?'))
                  .replace('{adapter}', String(compat.adapterVersion ?? '?')),
              ),
            )
          : compat !== undefined && compat !== null && compat.compatible === undefined
            ? React.createElement(
                'div',
                { className: 'ccsub-alert warn' },
                React.createElement(
                  'p',
                  { className: 'ccsub-alert-text' },
                  t.compatUnknown
                    .replace('{pi}', String(compat.piAiVersion ?? '?'))
                    .replace('{adapter}', String(compat.adapterVersion ?? 'not resolvable')),
                ),
              )
            : null,

        // ---- Status & sign-in ----------------------------------------------
        // The state the operator checks most: it opens the card, and it is the
        // only section on a tinted layer so the eye lands on it first.
        React.createElement(
          'div',
          { className: 'ccsub-section ccsub-status' },
          React.createElement(
            'div',
            { className: 'ccsub-status-main' },
            React.createElement('span', {
              className: selfSignedIn ? 'ccsub-dot ok' : 'ccsub-dot',
              'aria-hidden': 'true',
            }),
            React.createElement(
              'div',
              { className: 'ccsub-status-text' },
              React.createElement('p', { className: 'ccsub-status-label' }, stateLabel),
              React.createElement('p', { className: 'ccsub-status-fact' }, statusFact),
            ),
          ),

          login !== null && login.active === true
            ? React.createElement(
                'div',
                { className: 'ccsub-login' },
                React.createElement('p', { className: 'ccsub-login-title' }, t.signingIn),
                React.createElement(
                  'div',
                  { className: 'ccsub-notices' },
                  (login.notices ?? []).map((notice, index) =>
                    React.createElement(
                      'div',
                      { key: `n${index}`, className: 'ccsub-notice' },
                      notice.url !== undefined
                        ? React.createElement(
                            'a',
                            { className: 'ccsub-link', href: notice.url, target: '_blank', rel: 'noreferrer' },
                            notice.url,
                          )
                        : null,
                      notice.message !== undefined
                        ? React.createElement('p', { className: 'ccsub-hint' }, notice.message)
                        : null,
                      notice.code !== undefined
                        ? React.createElement(
                            'p',
                            { className: 'ccsub-hint' },
                            React.createElement('code', { className: 'ccsub-code' }, notice.code),
                          )
                        : null,
                    ),
                  ),
                ),
                login.prompt !== null
                  ? React.createElement(
                      'div',
                      { className: 'ccsub-field' },
                      React.createElement(
                        'label',
                        { className: 'ccsub-field-label', htmlFor: 'ccsub-login-code' },
                        t.enterCode,
                      ),
                      React.createElement(
                        'div',
                        { className: 'ccsub-inline' },
                        React.createElement('input', {
                          id: 'ccsub-login-code',
                          className: 'ccsub-input',
                          placeholder: login.prompt.message || t.enterCode,
                          value: code,
                          onChange: (event) => setCode(event.target.value),
                        }),
                        React.createElement(
                          'button',
                          { className: 'ccsub-btn small primary', onClick: () => void answer() },
                          t.submitCode,
                        ),
                      ),
                    )
                  : null,
                React.createElement(
                  'div',
                  { className: 'ccsub-actions' },
                  React.createElement(
                    'button',
                    { className: 'ccsub-btn small ghost', onClick: () => void cancelLogin() },
                    t.cancelSignIn,
                  ),
                ),
              )
            : React.createElement(
                'div',
                { className: 'ccsub-actions' },
                // A browser sign-in binds the grant to *this* process. In
                // claude-server mode the route never reads a local grant, so
                // offering it here would start a flow whose result nothing uses;
                // the backend's own console owns that sign-in instead.
                selectedMode === 'claude-server'
                  ? null
                  : React.createElement(
                      'button',
                      {
                        className: 'ccsub-btn primary',
                        disabled: busy || status?.loginAvailable !== true,
                        onClick: () => void startLogin(),
                      },
                      t.signIn,
                    ),
                signedIn
                  ? React.createElement(
                      'button',
                      { className: 'ccsub-btn ghost danger', disabled: busy, onClick: () => void signOut() },
                      t.signOut,
                    )
                  : null,
                selectedMode === 'claude-server' && status?.claudeServer?.valid !== true
                  ? React.createElement('p', { className: 'ccsub-hint' }, t.serverUnreachableHint)
                  : null,
              ),

          error !== null
            ? React.createElement('p', { className: 'ccsub-error', role: 'alert' }, error)
            : null,
        ),

        // ---- Transport -----------------------------------------------------
        // Transport lives on the card itself, not behind the "Route settings"
        // disclosure: it decides where every request goes and whether this
        // machine needs a Claude sign-in at all, so folding it away made the
        // claude-server option effectively undiscoverable.
        React.createElement(
          'div',
          { className: 'ccsub-section' },
          React.createElement(
            'div',
            { className: 'ccsub-group-head' },
            React.createElement('h3', { className: 'ccsub-group-title' }, t.transportTitle),
          ),
          React.createElement(
            'div',
            { className: 'ccsub-field' },
            React.createElement(
              'div',
              { className: 'ccsub-select-wrap' },
              React.createElement(
                'select',
                {
                  className: 'ccsub-select',
                  'aria-label': t.transportTitle,
                  value: selectedMode,
                  disabled: transportBusy,
                  onChange: (e) => void switchMode(e.target.value),
                },
                React.createElement('option', { value: 'direct' }, t.modeDirect),
                React.createElement('option', { value: 'claude-server' }, t.modeServer),
              ),
              chevron(false),
            ),
            React.createElement(
              'p',
              { className: 'ccsub-hint' },
              selectedMode === 'claude-server'
                ? format(t.serverBackendOn, { url: status?.claudeServer?.url || '—' })
                : t.serverBackendOff,
            ),
          ),
          selectedMode === 'claude-server'
            ? React.createElement(
                'div',
                { className: 'ccsub-stack' },
                React.createElement(
                  'div',
                  { className: 'ccsub-field' },
                  React.createElement(
                    'label',
                    { className: 'ccsub-field-label', htmlFor: 'ccsub-card-server-url' },
                    t.serverUrl,
                  ),
                  React.createElement(
                    'div',
                    { className: 'ccsub-inline' },
                    React.createElement('input', {
                      id: 'ccsub-card-server-url',
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
                  React.createElement('p', { className: 'ccsub-hint' }, t.serverUrlHint),
                ),
                React.createElement(
                  'div',
                  { className: 'ccsub-field' },
                  React.createElement(
                    'label',
                    { className: 'ccsub-field-label', htmlFor: 'ccsub-card-bearer' },
                    t.serverBearer,
                  ),
                  React.createElement(
                    'div',
                    { className: 'ccsub-inline' },
                    React.createElement('input', {
                      id: 'ccsub-card-bearer',
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
                ),
              )
            : null,
          transportMsg === null
            ? null
            : transportMsg.error === undefined
              ? React.createElement('p', { className: 'ccsub-ok', role: 'status' }, transportMsg.ok)
              : React.createElement('p', { className: 'ccsub-error', role: 'alert' }, transportMsg.error),
        ),

        // ---- Quota ---------------------------------------------------------
        React.createElement(
          'div',
          { className: 'ccsub-section' },
          React.createElement(
            'div',
            { className: 'ccsub-group-head' },
            React.createElement('h3', { className: 'ccsub-group-title' }, t.quotaTitle),
            React.createElement(
              'button',
              { className: 'ccsub-btn small ghost', onClick: () => void reloadUsage() },
              t.quotaRefresh,
            ),
          ),
          throttled
            ? React.createElement(
                'div',
                { className: 'ccsub-alert warn' },
                React.createElement(
                  'div',
                  { className: 'ccsub-alert-row' },
                  React.createElement(
                    'div',
                    { className: 'ccsub-stack' },
                    React.createElement('p', { className: 'ccsub-alert-text' }, t.throttleTitle),
                    React.createElement(
                      'p',
                      { className: 'ccsub-alert-text' },
                      format(t.throttleBody, { threshold: throttle.threshold }) +
                        (parked > 0 ? ` · ${format(t.throttleParked, { count: parked })}` : ''),
                    ),
                  ),
                  parked > 0
                    ? React.createElement(
                        'button',
                        {
                          className: 'ccsub-btn small',
                          // Routed through `call` like every other request: a
                          // bare fetch here left the one control that unsticks a
                          // parked turn with no error handling at all.
                          onClick: async () => {
                            const r = await call('/throttle/release', { method: 'POST' });
                            if (!r.ok) setError(r.error);
                            await reloadStatus();
                          },
                        },
                        t.skipWait,
                      )
                    : null,
                ),
              )
            : null,
          usageError !== null
            ? React.createElement(
                'p',
                { className: 'ccsub-error', role: 'alert' },
                format(t.quotaFailed, { message: usageError }),
              )
            : usage === null
              ? React.createElement('p', { className: 'ccsub-hint' }, t.quotaRefreshing)
              : (usage.windows ?? []).length === 0
                ? React.createElement('p', { className: 'ccsub-hint' }, t.quotaEmpty)
                : React.createElement(
                    'div',
                    { className: 'ccsub-meters' },
                    (usage.windows ?? []).map((window, index) => meter(window, `w${index}`)),
                  ),
        ),

        // ---- Egress --------------------------------------------------------
        // The proxy block only governs `direct` mode. In claude-server mode
        // nothing here egresses to Anthropic, so rendering the proxy value and
        // a "check egress" button invites the operator to fix a setting that is
        // inert and then read the resulting probe failure as a real fault.
        proxy?.active === false
          ? React.createElement(
              'div',
              { className: 'ccsub-section' },
              React.createElement(
                'div',
                { className: 'ccsub-group-head' },
                React.createElement('h3', { className: 'ccsub-group-title' }, t.egressTitle),
              ),
              React.createElement('p', { className: 'ccsub-hint' }, t.egressInactive),
            )
          : React.createElement(
              'div',
              { className: 'ccsub-section' },
              React.createElement(
                'div',
                { className: 'ccsub-group-head' },
                React.createElement('h3', { className: 'ccsub-group-title' }, t.egressTitle),
              ),
              React.createElement(
                'div',
                { className: 'ccsub-kv' },
                React.createElement('span', { className: 'ccsub-kv-label' }, t.egressProxy),
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
                { className: 'ccsub-kv' },
                React.createElement('span', { className: 'ccsub-kv-label' }, t.egressAllow),
                React.createElement(
                  'span',
                  { className: 'ccsub-kv-value' },
                  (proxy?.allow ?? []).length === 0 ? '—' : (proxy?.allow ?? []).join(', '),
                ),
              ),
              proxy?.requireEgressCheck === true
                ? React.createElement('p', { className: 'ccsub-hint' }, t.egressRequire)
                : null,
              React.createElement(
                'div',
                { className: 'ccsub-actions' },
                React.createElement(
                  'button',
                  { className: 'ccsub-btn small', disabled: egressBusy, onClick: () => void checkEgress() },
                  egressBusy ? t.egressChecking : t.egressCheckNow,
                ),
              ),
              egress !== null
                ? React.createElement(
                    'div',
                    { className: 'ccsub-kv' },
                    React.createElement('span', { className: 'ccsub-kv-label' }, t.egressObserved),
                    React.createElement(
                      'span',
                      { className: 'ccsub-kv-value' },
                      `${egress.observed ?? t.egressUnknown}` +
                        (egress.allowed === null || egress.allowed === undefined
                          ? ''
                          : egress.allowed
                            ? ` · ${t.egressAllowed}`
                            : ` · ${t.egressNotAllowed}`),
                    ),
                  )
                : null,
              egress?.error != null
                ? React.createElement('p', { className: 'ccsub-error', role: 'alert' }, egress.error)
                : null,
              React.createElement('p', { className: 'ccsub-note' }, t.egressNote),
            ),

        // ---- Facts ---------------------------------------------------------
        React.createElement(
          'div',
          { className: 'ccsub-facts' },
          React.createElement(
            'div',
            { className: 'ccsub-fact' },
            React.createElement('span', { className: 'ccsub-fact-label' }, t.cliVersion),
            React.createElement('code', { className: 'ccsub-code' }, status?.claudeCliVersion ?? '—'),
          ),
          React.createElement(
            'div',
            { className: 'ccsub-fact' },
            React.createElement('span', { className: 'ccsub-fact-label' }, t.modelsTitle),
            React.createElement(
              'span',
              { className: 'ccsub-fact-value' },
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
      // The section renders this component with the same props, and every label
      // below is `t.*`. Without this binding the whole panel threw a
      // ReferenceError the moment the disclosure was opened.
      const t = props.t;
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
              proxy: form.proxy,
            }),
          });
          const body = await r.json().catch(() => null);
          if (!r.ok) setError(body?.error ?? `HTTP ${r.status}`);
          else setMsg(t.settingsSaved);
        } catch (e) {
          setError(String(e?.message ?? e));
        } finally {
          setBusy(false);
        }
      };

      if (form === null) {
        return React.createElement('p', { className: 'ccsub-hint' }, error ?? t.loading);
      }
      /** One labelled control: label above, full-width control, quiet caption. */
      const field = (id, label, control, hint) =>
        React.createElement(
          'div',
          { className: 'ccsub-field' },
          React.createElement('label', { className: 'ccsub-field-label', htmlFor: id }, label),
          control,
          hint === undefined ? null : React.createElement('p', { className: 'ccsub-hint' }, hint),
        );

      return React.createElement(
        'div',
        { className: 'ccsub-settings' },
        // The disclosure row above already names this panel, so it opens with
        // one explanatory line rather than repeating its own heading.
        React.createElement('p', { className: 'ccsub-sub' }, t.settingsSubtitle),

        error !== null ? React.createElement('p', { className: 'ccsub-error', role: 'alert' }, error) : null,
        msg !== null ? React.createElement('p', { className: 'ccsub-ok', role: 'status' }, msg) : null,

        // ---- Transport -----------------------------------------------------
        React.createElement(
          'div',
          { className: 'ccsub-settings-group' },
          React.createElement('h4', { className: 'ccsub-group-title' }, t.transportTitle),
          React.createElement(
            'div',
            { className: 'ccsub-field' },
            React.createElement(
              'div',
              { className: 'ccsub-select-wrap' },
              React.createElement(
                'select',
                {
                  className: 'ccsub-select',
                  'aria-label': t.transportTitle,
                  value: form.mode ?? 'direct',
                  onChange: (e) => setField({ mode: e.target.value }),
                },
                React.createElement('option', { value: 'direct' }, t.modeDirect),
                React.createElement('option', { value: 'claude-server' }, t.modeServer),
              ),
              chevron(false),
            ),
            React.createElement('p', { className: 'ccsub-hint' }, t.modeHint),
          ),
          (form.mode ?? 'direct') === 'claude-server'
            ? React.createElement(
                'div',
                { className: 'ccsub-stack' },
                field(
                  'ccsub-set-server-url',
                  t.serverUrl,
                  React.createElement('input', {
                    id: 'ccsub-set-server-url',
                    className: 'ccsub-input',
                    value: form.claudeServer?.url ?? '',
                    placeholder: 'http://127.0.0.1:4710',
                    onChange: (e) => setServer({ url: e.target.value }),
                  }),
                  t.serverUrlHint,
                ),
                React.createElement(
                  'div',
                  { className: 'ccsub-field' },
                  React.createElement(
                    'label',
                    { className: 'ccsub-field-label', htmlFor: 'ccsub-set-bearer' },
                    t.serverBearer,
                  ),
                  React.createElement(
                    'div',
                    { className: 'ccsub-inline' },
                    React.createElement('input', {
                      id: 'ccsub-set-bearer',
                      className: 'ccsub-input',
                      type: 'password',
                      value: bearer,
                      autoComplete: 'off',
                      placeholder: form.claudeServer?.bearerConfigured ? '••••••••' : '',
                      onChange: (e) => setBearer(e.target.value),
                    }),
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
                            className: 'ccsub-btn small ghost danger',
                            disabled: bearerBusy,
                            onClick: () => void saveBearer(''),
                          },
                          t.clearBearer,
                        )
                      : null,
                  ),
                  React.createElement(
                    'p',
                    { className: 'ccsub-hint' },
                    form.claudeServer?.bearerConfigured ? t.serverBearerSaved : t.serverBearerMissing,
                  ),
                  React.createElement('p', { className: 'ccsub-note' }, t.serverBearerHint),
                ),
                bearerMsg === null
                  ? null
                  : React.createElement(
                      'p',
                      { className: bearerMsg.error === undefined ? 'ccsub-ok' : 'ccsub-error', role: 'status' },
                      bearerMsg.error ?? bearerMsg.ok,
                    ),
              )
            : null,
        ),

        // ---- Proxy & egress ------------------------------------------------
        React.createElement(
          'div',
          { className: 'ccsub-settings-group' },
          React.createElement('h4', { className: 'ccsub-group-title' }, t.proxySectionTitle),
          field(
            'ccsub-set-proxy-url',
            t.proxyUrlLabel,
            React.createElement('input', {
              id: 'ccsub-set-proxy-url',
              className: 'ccsub-input',
              value: form.proxy.url ?? '',
              onChange: (e) => setProxy({ url: e.target.value }),
            }),
            t.proxyUrlHint,
          ),
          field(
            'ccsub-set-allow',
            t.egressAllowLabel,
            React.createElement('textarea', {
              id: 'ccsub-set-allow',
              className: 'ccsub-input ccsub-textarea',
              rows: 2,
              value: (form.proxy.egressAllow ?? []).join('\n'),
              onChange: (e) =>
                setProxy({
                  egressAllow: e.target.value
                    .split(/\n|,/)
                    .map((s) => s.trim())
                    .filter(Boolean),
                }),
            }),
            t.egressAllowHint,
          ),
          React.createElement(
            'label',
            { className: 'ccsub-check' },
            React.createElement('input', {
              type: 'checkbox',
              checked: form.proxy.requireEgressCheck !== false,
              onChange: (e) => setProxy({ requireEgressCheck: e.target.checked }),
            }),
            React.createElement('span', null, t.requireCheckLabel),
          ),
        ),

        // ---- Identity & context --------------------------------------------
        React.createElement(
          'div',
          { className: 'ccsub-settings-group' },
          React.createElement('h4', { className: 'ccsub-group-title' }, t.identitySectionTitle),
          field(
            'ccsub-set-cli',
            t.cliVersion,
            React.createElement('input', {
              id: 'ccsub-set-cli',
              className: 'ccsub-input',
              value: form.claudeCliVersion ?? 'auto',
              onChange: (e) => setField({ claudeCliVersion: e.target.value }),
            }),
            format(t.cliVersionHint, { version: form.resolved?.claudeCliVersion ?? '…' }),
          ),
          field(
            'ccsub-set-context',
            t.contextWindowLabel,
            React.createElement('input', {
              id: 'ccsub-set-context',
              className: 'ccsub-input',
              type: 'number',
              value: form.contextWindowOverride ?? 0,
              onChange: (e) => setField({ contextWindowOverride: Number(e.target.value) || 0 }),
            }),
            t.contextWindowHint,
          ),
        ),

        // ---- Timing & quota -------------------------------------------------
        React.createElement(
          'div',
          { className: 'ccsub-settings-group' },
          React.createElement('h4', { className: 'ccsub-group-title' }, t.timingSectionTitle),
          field(
            'ccsub-set-throttle',
            t.throttleLabel,
            React.createElement('input', {
              id: 'ccsub-set-throttle',
              className: 'ccsub-input',
              type: 'number',
              value: form.quotaThrottlePercent ?? 90,
              onChange: (e) => setField({ quotaThrottlePercent: Number(e.target.value) || 0 }),
            }),
            t.throttleHint,
          ),
          field(
            'ccsub-set-skew',
            t.refreshSkewLabel,
            React.createElement('input', {
              id: 'ccsub-set-skew',
              className: 'ccsub-input',
              type: 'number',
              value: form.refreshSkewMs ?? 300000,
              onChange: (e) => setField({ refreshSkewMs: Number(e.target.value) || 300000 }),
            }),
          ),
          field(
            'ccsub-set-poll',
            t.quotaPollLabel,
            React.createElement('input', {
              id: 'ccsub-set-poll',
              className: 'ccsub-input',
              type: 'number',
              value: form.quotaPollMs ?? 180000,
              onChange: (e) => setField({ quotaPollMs: Number(e.target.value) || 180000 }),
            }),
          ),
        ),

        React.createElement(
          'div',
          { className: 'ccsub-settings-actions' },
          React.createElement(
            'button',
            { className: 'ccsub-btn primary', disabled: busy, onClick: () => void save() },
            busy ? t.savingSettings : t.saveSettings,
          ),
        ),
      );
    }

    /**
     * Sidebar section: the frequently-checked surface (sign-in state, quota
     * windows, egress health) first, with the set-and-forget route options
     * folded away behind a disclosure at the bottom.
     */
    function ClaudeSubscriptionSection(props) {
      const t = props.t;
      const [settingsOpen, setSettingsOpen] = React.useState(false);
      // One bordered card: the live status and quota first, then the
      // set-and-forget route options behind a disclosure that reads as a footer
      // row rather than as another identical box.
      return React.createElement(
        'div',
        { className: 'ccsub-card' },
        React.createElement(ClaudeSubscriptionCard, props),
        React.createElement(
          'div',
          { className: 'ccsub-disclosure' },
          React.createElement(
            'button',
            {
              className: 'ccsub-disclosure-btn',
              type: 'button',
              'aria-expanded': settingsOpen ? 'true' : 'false',
              'aria-controls': 'ccsub-route-settings',
              onClick: () => setSettingsOpen((v) => !v),
            },
            React.createElement(
              'span',
              { className: 'ccsub-disclosure-label' },
              React.createElement(
                'span',
                { className: 'ccsub-disclosure-text' },
                settingsOpen ? t.settingsHide : t.settingsShow,
              ),
              React.createElement('span', { className: 'ccsub-disclosure-sub' }, t.settingsShowHint),
            ),
            chevron(settingsOpen),
          ),
          settingsOpen
            ? React.createElement(
                'div',
                { className: 'ccsub-disclosure-body', id: 'ccsub-route-settings', role: 'group', 'aria-label': t.settingsShow },
                React.createElement(ClaudeSubscriptionSettings, props),
              )
            : null,
        ),
      );
    }

    const inject = ['slots', 'locale'];

    function apply(ctx) {
      injectStyles();
      // The host locale service owns the active language and its fallback chain,
      // so the card registers its dictionaries there and asks it for copy. The
      // inline `en` stays as the final fallback for the case where the service
      // is missing or has changed lookup semantics across versions — that is
      // what kept every label rendering as `undefined` in an earlier host.
      const hostT = typeof ctx.locale?.bind === 'function' ? ctx.locale.bind(LOCALE_NS) : null;
      if (typeof ctx.locale?.register === 'function') {
        try {
          ctx.effect(() => ctx.locale.register(LOCALE_NS, { en, zh }), 'dsh-ccsub: card copy');
        } catch {
          /* registration is best-effort; the local dictionary below is authoritative */
        }
      }
      /**
       * Resolve one key at access time.
       *
       * Not a snapshot: the host can switch language while the card is mounted,
       * and a dictionary copied once at apply time would never follow it. The
       * host returns the key itself for a miss, which is how a miss is detected
       * (a key can legitimately translate to an empty-looking string, not to
       * its own name).
       */
      const translate = (key) => {
        const host = hostT === null ? undefined : hostT(key);
        if (typeof host === 'string' && host !== key) return host;
        return en[key];
      };
      // The card reads copy as properties (t.title) while slot labels call it
      // (t('title')); one callable proxy serves both and stays live. Unknown
      // keys resolve to `undefined` rather than to their own name so a typo
      // shows as missing copy instead of as a plausible-looking label. `then`
      // is forced absent because any thenable would make this object async.
      const t = new Proxy((key) => translate(key), {
        get: (target, key) => {
          if (typeof key !== 'string' || key === 'then') return undefined;
          return translate(key);
        },
      });
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
