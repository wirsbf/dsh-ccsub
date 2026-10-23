/**
 * The console's stylesheet.
 *
 * ## Why a string, and why no framework
 *
 * This page is a credential surface: it can replace the Claude grant. Keeping
 * it dependency-free means no build step in the image, no npm tree to audit,
 * and a Content-Security-Policy that forbids every external load
 * (`default-src 'none'`). A component framework would buy reactivity this page
 * does not need — it has five regions and no routing.
 *
 * ## Structure
 *
 * Everything visual is expressed through custom properties declared on `:root`,
 * so a theme is a token override rather than a set of selector rewrites. Both
 * color schemes are authored explicitly (dark first, light as an override)
 * because `light-dark()` is not available in every browser this console may be
 * opened from, and a silent fallback would leave unreadable text.
 *
 * @module claude-server/admin-style
 */

export const ADMIN_STYLE = `
  /* ---- tokens ---------------------------------------------------------- */
  :root {
    color-scheme: dark;

    /* Surfaces, from furthest back to closest. */
    --bg: #0b0d12;
    --surface: #14171e;
    --surface-raised: #1a1e27;
    --surface-input: #0e1116;

    /* Lines. */
    --border: #262c38;
    --border-strong: #333b4a;

    /* Text, in decreasing emphasis. */
    --text: #e7eaf0;
    --text-muted: #9aa3b2;
    --text-faint: #6b7382;

    /* Accents. Blue is action, green is healthy, amber is a warning, red is a
       failure. Each has a translucent fill for backgrounds. */
    --accent: #4f86f7;
    --accent-hover: #6a9aff;
    --accent-contrast: #ffffff;
    --accent-soft: rgba(79, 134, 247, 0.14);

    --ok: #4ade80;
    --ok-soft: rgba(74, 222, 128, 0.13);
    --warn: #fbbf24;
    --warn-soft: rgba(251, 191, 36, 0.13);
    --danger: #f87171;
    --danger-soft: rgba(248, 113, 113, 0.13);

    /* Geometry. One scale, used everywhere. */
    --r-sm: 6px;
    --r-md: 9px;
    --r-lg: 13px;
    --r-full: 999px;

    /* Spacing, on a 4px rhythm. */
    --s-1: 0.25rem;
    --s-2: 0.5rem;
    --s-3: 0.75rem;
    --s-4: 1rem;
    --s-5: 1.5rem;
    --s-6: 2rem;

    /* Type. */
    --font: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto,
            "Helvetica Neue", Arial, "Noto Sans SC", sans-serif;
    --font-mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas,
                 "Liberation Mono", monospace;
    --fs-xs: 0.75rem;
    --fs-sm: 0.8125rem;
    --fs-base: 0.875rem;
    --fs-lg: 1rem;
    --fs-xl: 1.375rem;

    /* Elevation. Deliberately shallow: this is a dense admin surface. */
    --shadow: 0 1px 2px rgba(0, 0, 0, 0.30);
    --shadow-lg: 0 8px 24px rgba(0, 0, 0, 0.28);

    --ease: cubic-bezier(0.32, 0.72, 0, 1);
  }

  @media (prefers-color-scheme: light) {
    :root {
      color-scheme: light;
      --bg: #f4f6f9;
      --surface: #ffffff;
      --surface-raised: #fbfcfd;
      --surface-input: #ffffff;
      --border: #e2e6ed;
      --border-strong: #cdd4df;
      --text: #1a1f28;
      --text-muted: #5a6474;
      --text-faint: #8b95a5;
      --accent: #2563eb;
      --accent-hover: #1d4ed8;
      --accent-soft: rgba(37, 99, 235, 0.09);
      --ok: #15803d;
      --ok-soft: #e8f7ee;
      --warn: #b45309;
      --warn-soft: #fdf4e3;
      --danger: #b91c1c;
      --danger-soft: #fdecec;
      --shadow: 0 1px 2px rgba(16, 24, 40, 0.06);
      --shadow-lg: 0 8px 24px rgba(16, 24, 40, 0.10);
    }
  }

  /* ---- reset ----------------------------------------------------------- */
  *, *::before, *::after { box-sizing: border-box; }
  html { -webkit-text-size-adjust: 100%; }
  body {
    margin: 0;
    padding: var(--s-6) var(--s-4) var(--s-6);
    font: var(--fs-base)/1.6 var(--font);
    background: var(--bg);
    color: var(--text);
    -webkit-font-smoothing: antialiased;
    text-rendering: optimizeLegibility;
  }
  :focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
    border-radius: var(--r-sm);
  }

  /* ---- shell ----------------------------------------------------------- */
  main { max-width: 46rem; margin: 0 auto; }

  .masthead { margin: 0 0 var(--s-5); }
  .masthead h1 {
    display: flex; align-items: center; gap: var(--s-2);
    margin: 0; font-size: var(--fs-xl); font-weight: 650;
    letter-spacing: -0.018em;
  }
  /* A small mark stands in for a logo: it has to read at 18px and needs no
     asset request under default-src 'none'. */
  .mark {
    width: 1.5rem; height: 1.5rem; flex: none;
    border-radius: var(--r-sm);
    background: linear-gradient(140deg, var(--accent), #8b5cf6);
    box-shadow: var(--shadow);
  }
  .masthead p {
    margin: var(--s-1) 0 0;
    color: var(--text-muted);
    font-size: var(--fs-sm);
  }

  /* ---- card ------------------------------------------------------------ */
  .card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--r-lg);
    padding: var(--s-4) var(--s-5) var(--s-5);
    margin: 0 0 var(--s-4);
    box-shadow: var(--shadow);
  }
  .card > h2 {
    display: flex; align-items: center; justify-content: space-between;
    gap: var(--s-3);
    margin: 0 0 var(--s-4);
    font-size: var(--fs-xs);
    font-weight: 650;
    letter-spacing: 0.07em;
    text-transform: uppercase;
    color: var(--text-faint);
  }
  .card > h2 .actions { display: flex; gap: var(--s-2); align-items: center; }

  /* ---- data list ------------------------------------------------------- */
  dl.facts {
    display: grid;
    grid-template-columns: minmax(7rem, auto) 1fr;
    gap: var(--s-2) var(--s-4);
    margin: 0;
    align-items: baseline;
  }
  dl.facts dt { color: var(--text-muted); font-size: var(--fs-sm); }
  dl.facts dd { margin: 0; font-variant-numeric: tabular-nums; }

  /* ---- status pills ---------------------------------------------------- */
  .pill {
    display: inline-flex; align-items: center; gap: var(--s-1);
    padding: 0.1rem var(--s-2);
    border-radius: var(--r-full);
    font-size: var(--fs-xs);
    font-weight: 600;
    line-height: 1.7;
  }
  .pill::before {
    content: ""; width: 0.375rem; height: 0.375rem; border-radius: 50%;
    background: currentColor;
  }
  .pill.on { background: var(--ok-soft); color: var(--ok); }
  .pill.off { background: var(--danger-soft); color: var(--danger); }
  .pill.warn { background: var(--warn-soft); color: var(--warn); }

  /* ---- forms ----------------------------------------------------------- */
  .field { margin: 0 0 var(--s-3); }
  .field:last-of-type { margin-bottom: 0; }
  .field > label {
    display: block;
    margin: 0 0 var(--s-1);
    font-size: var(--fs-sm);
    color: var(--text-muted);
  }
  input[type="text"], input[type="password"], input[type="search"], select {
    width: 100%;
    padding: var(--s-2) var(--s-3);
    border: 1px solid var(--border-strong);
    border-radius: var(--r-md);
    background: var(--surface-input);
    color: var(--text);
    font: inherit;
    transition: border-color 0.15s var(--ease), box-shadow 0.15s var(--ease);
  }
  input:hover:not(:disabled), select:hover:not(:disabled) { border-color: var(--text-faint); }
  input:focus, select:focus {
    outline: none;
    border-color: var(--accent);
    box-shadow: 0 0 0 3px var(--accent-soft);
  }
  input:disabled, select:disabled { opacity: 0.5; cursor: not-allowed; }
  input::placeholder { color: var(--text-faint); }

  /* ---- buttons --------------------------------------------------------- */
  button {
    display: inline-flex; align-items: center; justify-content: center; gap: var(--s-1);
    padding: var(--s-2) var(--s-3);
    border: 1px solid var(--border-strong);
    border-radius: var(--r-md);
    background: var(--surface-raised);
    color: var(--text);
    font: inherit;
    font-weight: 500;
    cursor: pointer;
    transition: background 0.15s var(--ease), border-color 0.15s var(--ease),
                transform 0.06s var(--ease);
  }
  button:hover:not(:disabled) { background: var(--border); }
  button:active:not(:disabled) { transform: translateY(0.5px); }
  button:disabled { opacity: 0.45; cursor: not-allowed; }
  button.primary {
    background: var(--accent);
    border-color: var(--accent);
    color: var(--accent-contrast);
  }
  button.primary:hover:not(:disabled) { background: var(--accent-hover); border-color: var(--accent-hover); }
  button.ghost { background: transparent; }
  button.danger { color: var(--danger); border-color: color-mix(in srgb, var(--danger) 40%, var(--border-strong)); }
  button.danger:hover:not(:disabled) { background: var(--danger-soft); }
  button.small { padding: var(--s-1) var(--s-2); font-size: var(--fs-sm); }

  .row { display: flex; gap: var(--s-2); flex-wrap: wrap; align-items: center; margin-top: var(--s-3); }
  .row.top { margin-top: 0; }

  /* ---- meters ---------------------------------------------------------- */
  .meter {
    height: 7px;
    border-radius: var(--r-full);
    background: var(--border);
    overflow: hidden;
  }
  .meter > span {
    display: block; height: 100%;
    border-radius: inherit;
    background: var(--accent);
    transition: width 0.4s var(--ease), background 0.2s var(--ease);
  }
  .meter > span.warn { background: var(--warn); }
  .meter > span.over { background: var(--danger); }

  /* One quota window: label above, meter and figure on one line. */
  .window { margin: 0 0 var(--s-4); }
  .window:last-child { margin-bottom: 0; }
  .window-head {
    display: flex; align-items: baseline; justify-content: space-between;
    gap: var(--s-3); margin: 0 0 var(--s-2);
  }
  .window-name { font-weight: 600; font-size: var(--fs-sm); text-transform: capitalize; }
  .window-figure { font-variant-numeric: tabular-nums; font-size: var(--fs-sm); color: var(--text-muted); }
  .window-reset { font-size: var(--fs-xs); color: var(--text-faint); margin: var(--s-1) 0 0; }

  /* ---- tables ---------------------------------------------------------- */
  table.grid { width: 100%; border-collapse: collapse; font-size: var(--fs-sm); }
  table.grid th {
    text-align: left;
    padding: 0 var(--s-2) var(--s-1);
    font-size: var(--fs-xs);
    font-weight: 600;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    color: var(--text-faint);
    border-bottom: 1px solid var(--border);
  }
  table.grid th.num, table.grid td.num { text-align: right; }
  table.grid td {
    padding: var(--s-2);
    border-bottom: 1px solid var(--border);
    font-variant-numeric: tabular-nums;
  }
  table.grid tbody tr:last-child td { border-bottom: none; }
  table.grid tbody tr:hover td { background: var(--surface-raised); }
  table.grid td.name { font-variant-numeric: normal; }

  /* ---- lists ----------------------------------------------------------- */
  ul.plain { list-style: none; margin: 0; padding: 0; }
  ul.plain > li {
    display: flex; align-items: baseline; gap: var(--s-3);
    padding: var(--s-2) 0;
    border-bottom: 1px solid var(--border);
  }
  ul.plain > li:last-child { border-bottom: none; }
  ul.plain .grow { flex: 1; min-width: 0; }

  .subhead {
    margin: var(--s-5) 0 var(--s-2);
    font-size: var(--fs-xs);
    font-weight: 650;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--text-faint);
  }

  /* ---- text ------------------------------------------------------------ */
  .hint { margin: var(--s-2) 0 0; font-size: var(--fs-sm); color: var(--text-muted); }
  .note { margin: var(--s-3) 0 0; font-size: var(--fs-xs); color: var(--text-faint); line-height: 1.6; }
  code {
    font-family: var(--font-mono);
    font-size: 0.9em;
    padding: 0.1em 0.35em;
    border-radius: var(--r-sm);
    background: var(--accent-soft);
    word-break: break-all;
  }
  .empty { margin: 0; padding: var(--s-3) 0; color: var(--text-muted); font-size: var(--fs-sm); }

  /* ---- messages -------------------------------------------------------- */
  .msg {
    display: flex; gap: var(--s-2);
    margin: 0 0 var(--s-4);
    padding: var(--s-3);
    border-radius: var(--r-md);
    font-size: var(--fs-sm);
    border: 1px solid transparent;
  }
  .msg.ok { background: var(--ok-soft); color: var(--ok); border-color: color-mix(in srgb, var(--ok) 30%, transparent); }
  .msg.err { background: var(--danger-soft); color: var(--danger); border-color: color-mix(in srgb, var(--danger) 30%, transparent); }

  /* ---- disclosure ------------------------------------------------------ */
  details.disclosure > summary {
    cursor: pointer;
    padding: var(--s-2) 0;
    color: var(--text-muted);
    font-size: var(--fs-sm);
    list-style: none;
    user-select: none;
  }
  details.disclosure > summary::-webkit-details-marker { display: none; }
  details.disclosure > summary::before {
    content: "▸ ";
    display: inline-block;
    transition: transform 0.15s var(--ease);
  }
  details.disclosure[open] > summary::before { content: "▾ "; }

  /* ---- responsive ------------------------------------------------------ */
  @media (max-width: 34rem) {
    body { padding: var(--s-4) var(--s-3); }
    .card { padding: var(--s-4); }
    dl.facts { grid-template-columns: 1fr; gap: 0; }
    dl.facts dt { margin-top: var(--s-2); }
    dl.facts dt:first-child { margin-top: 0; }
    .window-head { flex-direction: column; gap: var(--s-1); align-items: flex-start; }
  }

  /* Respect a reduced-motion preference: the meters animate, nothing here is
     load-bearing on the transition. */
  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after { transition-duration: 0.01ms !important; animation-duration: 0.01ms !important; }
  }
`;
