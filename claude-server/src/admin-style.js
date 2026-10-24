/**
 * The console's stylesheet.
 *
 * ## Why a string, and why no framework
 *
 * This page is a credential surface: it can replace the Claude grant and issue
 * access tokens. Keeping it dependency-free means no build step in the image, no
 * npm tree to audit, and a Content-Security-Policy that forbids every external
 * load (`default-src 'none'`). A component framework would buy reactivity this
 * console does not need — it has five static pages and one form.
 *
 * ## Structure
 *
 * Everything visual is expressed through custom properties declared on `:root`,
 * so a theme is a token override rather than a set of selector rewrites. Both
 * color schemes are authored explicitly (dark first, light as an override)
 * because `light-dark()` is not available in every browser this console may be
 * opened from, and a silent fallback would leave unreadable text.
 *
 * ## Why a sidebar
 *
 * The console outgrew a single column. Stacking five unrelated cards on one page
 * flattened the hierarchy — the grant state, the quota, the user list, and the
 * model catalog all competed for the same attention. A persistent rail gives
 * each concern a place, keeps the active location visible, and leaves the
 * content column free to use whatever width the window has.
 *
 * @module claude-server/admin-style
 */

export const ADMIN_STYLE = `
  /* ---- tokens ---------------------------------------------------------- */
  :root {
    color-scheme: dark;

    /* Surfaces, from furthest back to closest. The page sits on --bg, a card on
       --surface, and anything the operator can type into or click on --raised,
       so interactive affordances are identifiable without an extra border. */
    --bg: #0a0c11;
    --surface: #12151c;
    --surface-raised: #191d26;
    --surface-input: #0d1014;

    /* Lines. --border is for separation, --border-strong for edges that carry
       meaning (inputs, buttons, focus targets). */
    --border: #232936;
    --border-strong: #333c4c;

    /* Text, in decreasing emphasis. */
    --text: #e7eaf0;
    --text-muted: #99a3b3;
    --text-faint: #6b7484;

    /* Accents. Blue is action, green is healthy, amber is a warning, red is a
       failure. Each has a translucent fill for backgrounds. */
    --accent: #5b8cff;
    --accent-hover: #7aa2ff;
    --accent-contrast: #ffffff;
    --accent-soft: rgba(91, 140, 255, 0.14);
    --brand-2: #a78bfa;

    --ok: #4ade80;
    --ok-soft: rgba(74, 222, 128, 0.13);
    --warn: #fbbf24;
    --warn-soft: rgba(251, 191, 36, 0.13);
    --danger: #f87171;
    --danger-soft: rgba(248, 113, 113, 0.13);

    /* Geometry. One scale, used everywhere. */
    --r-sm: 6px;
    --r-md: 9px;
    --r-lg: 12px;
    --r-xl: 16px;
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
    --fs-caption: 0.75rem;
    --fs-body: 0.875rem;
    --fs-body-lg: 0.9375rem;
    --fs-title: 1.25rem;
    --fs-figure: 1.375rem;

    /* Elevation. Deliberately shallow: this is a dense operator surface. */
    --shadow: 0 1px 2px rgba(0, 0, 0, 0.32);
    --shadow-lg: 0 12px 32px rgba(0, 0, 0, 0.34);

    --ease: cubic-bezier(0.32, 0.72, 0, 1);

    --rail: 15.5rem;
    --measure: 66rem;
  }

  @media (prefers-color-scheme: light) {
    :root {
      color-scheme: light;
      --bg: #f5f6f9;
      --surface: #ffffff;
      --surface-raised: #f2f4f8;
      --surface-input: #ffffff;
      --border: #e3e7ee;
      --border-strong: #c9d1de;
      --text: #171c24;
      --text-muted: #566173;
      --text-faint: #8792a3;
      --accent: #2563eb;
      --accent-hover: #1d4ed8;
      --accent-contrast: #ffffff;
      --accent-soft: rgba(37, 99, 235, 0.09);
      --brand-2: #7c3aed;
      --ok: #15803d;
      --ok-soft: #e7f7ee;
      --warn: #a16207;
      --warn-soft: #fdf4e0;
      --danger: #b91c1c;
      --danger-soft: #fdecec;
      --shadow: 0 1px 2px rgba(16, 24, 40, 0.06);
      --shadow-lg: 0 12px 32px rgba(16, 24, 40, 0.12);
    }
  }

  /* ---- reset ----------------------------------------------------------- */
  *, *::before, *::after { box-sizing: border-box; }
  html { -webkit-text-size-adjust: 100%; }
  /* The hidden attribute must win over the display a component rule gives an
     element: without this an empty error slot renders as a coloured bar. */
  [hidden] { display: none !important; }
  body {
    margin: 0;
    font: var(--fs-body)/1.6 var(--font);
    background: var(--bg);
    color: var(--text);
    -webkit-font-smoothing: antialiased;
    text-rendering: optimizeLegibility;
  }
  /* Every figure in this console is compared against another, so numerals are
     tabular by default rather than per-table. */
  body { font-variant-numeric: tabular-nums; }
  h1, h2, h3, h4, p, dl, dd { margin: 0; }
  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: underline; }

  :focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
    border-radius: var(--r-sm);
  }
  /* A visible ring is the keyboard contract; the mouse gets the border/color
     change instead, so the console does not flash outlines on click. */
  .skip-link {
    position: absolute; left: -999px; top: var(--s-3);
    z-index: 10; padding: var(--s-2) var(--s-3);
    background: var(--surface-raised); border: 1px solid var(--border-strong);
    border-radius: var(--r-md); color: var(--text);
  }
  .skip-link:focus { left: var(--s-4); }
  .sr-only {
    position: absolute; width: 1px; height: 1px;
    margin: -1px; padding: 0; overflow: hidden;
    clip: rect(0 0 0 0); white-space: nowrap; border: 0;
  }

  /* ---- shell ----------------------------------------------------------- */
  .shell {
    display: grid;
    grid-template-columns: var(--rail) minmax(0, 1fr);
    /* Pin the rows to the top: once the rail becomes a second row (narrow
       widths), the default stretch with min-height: 100vh would push the
       content down the page instead of leaving the page short. */
    align-content: start;
    min-height: 100vh;
  }

  .sidebar {
    position: sticky;
    top: 0;
    align-self: start;
    height: 100vh;
    display: flex;
    flex-direction: column;
    gap: var(--s-5);
    padding: var(--s-5) var(--s-3) var(--s-4);
    background: var(--surface);
    border-right: 1px solid var(--border);
  }

  .brand {
    display: flex; align-items: center; gap: var(--s-2);
    padding: 0 var(--s-2);
    color: var(--text); text-decoration: none;
  }
  .brand:hover { text-decoration: none; }
  /* A small mark stands in for a logo: it has to read at 18px and needs no
     asset request under default-src 'none'. */
  .mark {
    width: 1.625rem; height: 1.625rem; flex: none;
    border-radius: var(--r-sm);
    background: linear-gradient(140deg, var(--accent), var(--brand-2));
    box-shadow: var(--shadow);
  }
  .brand-name { font-size: var(--fs-body-lg); font-weight: 650; letter-spacing: -0.015em; line-height: 1.2; }
  .brand-sub {
    display: block;
    font-size: 0.6875rem; font-weight: 500; letter-spacing: 0.06em;
    text-transform: uppercase; color: var(--text-faint);
  }

  .nav { display: flex; flex-direction: column; gap: 2px; }
  .nav-link {
    display: flex; align-items: center; gap: var(--s-2);
    padding: var(--s-2) var(--s-3);
    border-radius: var(--r-md);
    color: var(--text-muted);
    font-size: var(--fs-body);
    font-weight: 500;
    text-decoration: none;
    transition: background 0.14s var(--ease), color 0.14s var(--ease);
  }
  .nav-link:hover { background: var(--surface-raised); color: var(--text); text-decoration: none; }
  .nav-link[aria-current="page"] {
    background: var(--accent-soft);
    color: var(--accent);
    /* A left marker rather than a fill alone: colour alone is not a reliable
       location cue for everybody. */
    box-shadow: inset 2px 0 0 var(--accent);
  }
  .nav-link svg { width: 1rem; height: 1rem; flex: none; }

  .sidebar-foot {
    margin-top: auto;
    padding: var(--s-3) var(--s-2) 0;
    border-top: 1px solid var(--border);
    display: flex; flex-direction: column; gap: var(--s-2);
  }
  .sidebar-foot .who {
    font-size: var(--fs-caption);
    color: var(--text-faint);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }

  .workspace { min-width: 0; display: flex; flex-direction: column; }
  .content {
    width: 100%;
    max-width: var(--measure);
    margin: 0 auto;
    padding: var(--s-6) var(--s-6) 4rem;
  }

  .page-head {
    display: flex; align-items: flex-start; justify-content: space-between;
    gap: var(--s-4);
    margin: 0 0 var(--s-5);
  }
  .page-title {
    font-size: var(--fs-title);
    font-weight: 600;
    letter-spacing: -0.014em;
    line-height: 1.3;
  }
  .page-sub { margin: var(--s-1) 0 0; color: var(--text-muted); font-size: var(--fs-body); }
  .page-actions { display: flex; align-items: center; gap: var(--s-2); flex-wrap: wrap; }

  /* ---- cards ----------------------------------------------------------- */
  .card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--r-lg);
    box-shadow: var(--shadow);
    overflow: hidden;
  }
  .card + .card, .stack + .card, .card + .stack { margin-top: var(--s-4); }
  .stack { display: flex; flex-direction: column; gap: var(--s-4); }
  .card-head {
    display: flex; align-items: center; justify-content: space-between;
    gap: var(--s-3);
    padding: var(--s-3) var(--s-4);
    border-bottom: 1px solid var(--border);
    min-height: 3rem;
  }
  /* Section headings are eyebrows: uppercase and tracked, so they recede and let
     the data inside the card hold the visual weight. */
  .card-head h2 {
    font-size: var(--fs-caption);
    font-weight: 650;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--text-faint);
  }
  .card-head .actions { display: flex; align-items: center; gap: var(--s-2); }
  .card-body { padding: var(--s-4); }
  .card-body.flush { padding: 0; }
  .card-body + .card-body { border-top: 1px solid var(--border); }

  /* ---- stat tiles ------------------------------------------------------ */
  /* The page has five tiles now (sign-in, accounts, quota, users, calls). A
     fixed 12rem minimum fits four across a wide window and orphans the fifth on
     a line of its own, so the track is allowed to shrink: five fit until the
     window is genuinely narrow, then the grid reflows in even rows. */
  .tiles {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(9.5rem, 1fr));
    gap: var(--s-3);
    margin: 0 0 var(--s-4);
  }
  .tile {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--r-lg);
    padding: var(--s-4);
    box-shadow: var(--shadow);
    /* The state border is the affordance: a tile that is warning or over says so
       before the number is read. */
    border-left: 3px solid transparent;
  }
  .tile-label {
    font-size: var(--fs-caption);
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--text-faint);
  }
  .tile-value {
    margin: var(--s-2) 0 0;
    font-size: var(--fs-figure);
    font-weight: 600;
    letter-spacing: -0.02em;
    line-height: 1.2;
  }
  .tile-meta {
    margin: var(--s-2) 0 0;
    font-size: var(--fs-caption);
    color: var(--text-muted);
    min-height: 1.15em;
  }
  .tile.warn { border-left-color: var(--warn); }
  .tile.warn .tile-value { color: var(--warn); }
  .tile.over { border-left-color: var(--danger); }
  .tile.over .tile-value { color: var(--danger); }
  .tile.ok { border-left-color: var(--ok); }

  /* ---- definition grid ------------------------------------------------- */
  dl.facts {
    display: grid;
    grid-template-columns: minmax(8rem, 12rem) minmax(0, 1fr);
    gap: var(--s-3) var(--s-4);
    align-items: baseline;
  }
  dl.facts dt { color: var(--text-muted); font-size: var(--fs-body); }
  dl.facts dd { color: var(--text); min-width: 0; overflow-wrap: anywhere; }
  dl.facts dd code { background: none; padding: 0; }

  /* ---- status pills ---------------------------------------------------- */
  .pill {
    display: inline-flex; align-items: center; gap: var(--s-1);
    padding: 0.05rem var(--s-2);
    border-radius: var(--r-full);
    font-size: var(--fs-caption);
    font-weight: 600;
    line-height: 1.8;
    white-space: nowrap;
  }
  .pill::before {
    content: ""; width: 0.375rem; height: 0.375rem; border-radius: 50%;
    background: currentColor; flex: none;
  }
  .pill.on { background: var(--ok-soft); color: var(--ok); }
  .pill.off { background: var(--danger-soft); color: var(--danger); }
  .pill.warn { background: var(--warn-soft); color: var(--warn); }
  .pill.muted { background: var(--surface-raised); color: var(--text-muted); }
  .pill.accent { background: var(--accent-soft); color: var(--accent); }

  /* ---- forms ----------------------------------------------------------- */
  .field { margin: 0 0 var(--s-3); }
  .field:last-child { margin-bottom: 0; }
  .field > label {
    display: block;
    margin: 0 0 var(--s-1);
    font-size: var(--fs-body);
    color: var(--text-muted);
  }
  .field .field-hint { margin: var(--s-1) 0 0; font-size: var(--fs-caption); color: var(--text-faint); }
  .field-hint { margin: 0; font-size: var(--fs-caption); color: var(--text-faint); line-height: 1.5; }
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
  input:disabled, select:disabled { opacity: 0.55; cursor: not-allowed; }
  input::placeholder { color: var(--text-faint); }
  fieldset { border: 0; margin: 0; padding: 0; }

  .form-inline { display: flex; gap: var(--s-3); align-items: flex-end; flex-wrap: wrap; }
  .form-inline .field { margin: 0; flex: 1 1 12rem; }
  .form-inline .field.compact { flex: 0 1 13rem; }
  .form-inline .form-submit { flex: none; padding-bottom: 1px; }
  /* A hint that follows an inline form sits below the whole row of controls, so
     it needs a real gap: flush against the inputs it reads as clipped text
     rather than as an explanation of them. */
  .form-inline + .field-hint { margin: var(--s-3) 0 0; }
  .field-hint + .field-hint { margin-top: var(--s-2); }

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
    line-height: 1.4;
    cursor: pointer;
    transition: background 0.14s var(--ease), border-color 0.14s var(--ease),
                color 0.14s var(--ease), transform 0.06s var(--ease);
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
  button.ghost { background: transparent; border-color: transparent; color: var(--text-muted); }
  button.ghost:hover:not(:disabled) { background: var(--surface-raised); color: var(--text); }
  button.danger { color: var(--danger); border-color: var(--border-strong); }
  button.danger:hover:not(:disabled) { background: var(--danger-soft); border-color: var(--danger); }
  button.danger[data-armed="true"] { background: var(--danger); border-color: var(--danger); color: #fff; }
  button.small { padding: var(--s-1) var(--s-2); font-size: var(--fs-caption); }
  button.block { width: 100%; }

  .row { display: flex; gap: var(--s-2); flex-wrap: wrap; align-items: center; margin-top: var(--s-3); }
  .row.top { margin-top: 0; }

  /* Icons inside controls are decoration beside a label, so they are sized to
     the text rather than allowed to inherit an SVG's default 300px box. */
  button svg, .nav-link svg, .sidebar-foot button svg {
    width: 1em; height: 1em; flex: none;
  }
  button svg { margin-right: 0.1em; }
  /* The rail icons are fixed-size: they are the only content in the collapsed
     strip, so they must not scale with the caption text there. */
  .nav-link svg { width: 1.05rem; height: 1.05rem; }

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

  .windows { display: grid; gap: var(--s-4); }
  .window-head {
    display: flex; align-items: baseline; justify-content: space-between;
    gap: var(--s-3); margin: 0 0 var(--s-2);
  }
  .window-name { font-weight: 600; font-size: var(--fs-body); text-transform: capitalize; }
  .window-figure { font-size: var(--fs-body); color: var(--text-muted); }
  .window-figure.hot { color: var(--warn); }
  .window-figure.critical { color: var(--danger); }
  .window-reset { font-size: var(--fs-caption); color: var(--text-faint); margin: var(--s-2) 0 0; }

  /* ---- tables ---------------------------------------------------------- */
  .table-wrap { width: 100%; overflow-x: auto; }
  table.data { width: 100%; border-collapse: collapse; font-size: var(--fs-body); }
  table.data th {
    text-align: left;
    padding: var(--s-2) var(--s-4);
    font-size: var(--fs-caption);
    font-weight: 600;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    color: var(--text-faint);
    border-bottom: 1px solid var(--border);
    background: var(--surface);
    white-space: nowrap;
  }
  table.data th.num, table.data td.num { text-align: right; }
  table.data td {
    padding: var(--s-3) var(--s-4);
    border-bottom: 1px solid var(--border);
    vertical-align: middle;
  }
  table.data tbody tr:last-child td { border-bottom: none; }
  table.data tbody tr:hover td { background: var(--surface-raised); }
  table.data td.strong { font-weight: 500; }
  table.data td.when { white-space: nowrap; }
  /* A role or status token is a single short word; breaking it mid-word reads as
     a typo. Long cells (a model id) still wrap via the global rule. */
  table.data td code { white-space: nowrap; }
  table.data td.mono, table.data th.mono { font-family: var(--font-mono); font-size: var(--fs-caption); }
  table.data td.actions { text-align: right; white-space: nowrap; }
  table.data td.actions button + button { margin-left: var(--s-1); }
  table.data caption { text-align: left; padding: 0 0 var(--s-2); }

  .subhead {
    margin: 0 0 var(--s-2);
    font-size: var(--fs-caption);
    font-weight: 650;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--text-faint);
  }
  .section + .section { margin-top: var(--s-5); }
  .section { padding: var(--s-4); }
  .section + .table-wrap { border-top: 1px solid var(--border); }

  /* ---- text ------------------------------------------------------------ */
  .hint { margin: 0; font-size: var(--fs-body); color: var(--text-muted); }
  .note { margin: var(--s-2) 0 0; font-size: var(--fs-caption); color: var(--text-faint); line-height: 1.6; }
  code {
    font-family: var(--font-mono);
    font-size: 0.9em;
    padding: 0.1em 0.35em;
    border-radius: var(--r-sm);
    background: var(--accent-soft);
    overflow-wrap: anywhere;
  }
  .empty { margin: 0; padding: var(--s-3) 0; color: var(--text-muted); font-size: var(--fs-body); }
  .card-body > .empty:only-child { padding: var(--s-2) 0; }
  /* ---- account rows ---------------------------------------------------- */
  /* A disabled row still has to be readable: muting the whole row while keeping
     the state pill at full strength is how the operator sees "this one is off"
     without the numbers becoming unreadable. */
  table.data tbody tr.row-muted td { color: var(--text-faint); }
  table.data tbody tr.row-muted td .pill { opacity: 1; }
  /* State cell: the pill and the sentence that explains it stack, so the
     difference between "signed out" and "disabled" is a reason, not a colour. */
  .state-cell { display: flex; flex-direction: column; gap: var(--s-1); align-items: flex-start; }
  .state-note { font-size: var(--fs-caption); color: var(--text-faint); white-space: nowrap; }
  /* An absent value is a deliberate empty, not a missing cell: a dash reads as
     "none" where a blank cell reads as a rendering bug. */
  .dash { color: var(--text-faint); }
  /* A link inside a table cell that should not look like a call to action. */
  .link-quiet { color: var(--text-muted); text-decoration: none; border-bottom: 1px dotted var(--border-strong); }
  .link-quiet:hover { color: var(--text); }
  /* The add-account panel: a card body that appears below the table when the
     header button is pressed, so the list stays the page's subject. */
  .card-panel { padding: var(--s-4); border-top: 1px solid var(--border); background: var(--surface-input); }
  .card-panel[hidden] { display: none; }
  /* An explanation sitting above its form needs a gap of its own: .hint has no
     margin by default, which is right inline but reads as clipped here. */
  .card-panel .panel-intro { margin: 0 0 var(--s-3); }
  /* A secondary action that must not compete with the primary one. */
  button.small.ghost { background: transparent; border-color: transparent; color: var(--text-faint); }
  button.small.ghost:hover:not(:disabled) { background: var(--surface-raised); color: var(--text-muted); }


  /* ---- messages -------------------------------------------------------- */
  .msg {
    display: flex; gap: var(--s-2);
    margin: 0;
    padding: var(--s-2) var(--s-3);
    border-radius: var(--r-md);
    font-size: var(--fs-body);
    border: 1px solid transparent;
  }
  .msg + .msg { margin-top: var(--s-2); }
  .msg.ok { background: var(--ok-soft); color: var(--ok); border-color: var(--ok); border-color: color-mix(in srgb, var(--ok) 32%, transparent); }
  .msg.err { background: var(--danger-soft); color: var(--danger); border-color: color-mix(in srgb, var(--danger) 32%, transparent); }
  .msg.warn { background: var(--warn-soft); color: var(--warn); border-color: color-mix(in srgb, var(--warn) 32%, transparent); }

  /* ---- token reveal ---------------------------------------------------- */
  /* This panel is the only place a token is ever displayed. It is loud on
     purpose: the secret cannot be recovered after the operator dismisses it. */
  .reveal {
    border: 1px solid var(--warn);
    border-radius: var(--r-lg);
    background: var(--warn-soft);
    padding: var(--s-4);
  }
  .reveal h2 {
    font-size: var(--fs-caption);
    font-weight: 650;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--warn);
  }
  .reveal p { margin: var(--s-2) 0 0; font-size: var(--fs-body); color: var(--text); }
  .reveal .token-line { display: flex; gap: var(--s-2); align-items: stretch; flex-wrap: wrap; margin-top: var(--s-3); }
  .reveal code.token {
    flex: 1 1 18rem;
    display: block;
    padding: var(--s-2) var(--s-3);
    background: var(--surface-input);
    border: 1px solid var(--border-strong);
    border-radius: var(--r-md);
    color: var(--text);
    font-size: var(--fs-body);
    user-select: all;
  }

  /* ---- lock page ------------------------------------------------------- */
  .lock-shell {
    min-height: 100vh;
    display: grid;
    place-items: center;
    padding: var(--s-5) var(--s-4);
  }
  .lock {
    width: 100%;
    max-width: 24rem;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--r-xl);
    box-shadow: var(--shadow-lg);
    padding: var(--s-6) var(--s-5) var(--s-5);
  }
  .lock .brand { padding: 0; margin-bottom: var(--s-5); }
  .lock h1 {
    font-size: var(--fs-title);
    font-weight: 600;
    letter-spacing: -0.014em;
  }
  .lock .lede { margin: var(--s-2) 0 var(--s-5); color: var(--text-muted); font-size: var(--fs-body); }

  /* ---- disclosure ------------------------------------------------------ */
  details.disclosure { border-top: 1px solid var(--border); }
  details.disclosure > summary {
    cursor: pointer;
    padding: var(--s-3) var(--s-4);
    color: var(--text-muted);
    font-size: var(--fs-body);
    list-style: none;
    user-select: none;
  }
  details.disclosure > summary::-webkit-details-marker { display: none; }
  details.disclosure > summary::before {
    content: "";
    display: inline-block;
    width: 0.4rem; height: 0.4rem;
    margin-right: var(--s-2);
    border-right: 1.5px solid currentColor;
    border-bottom: 1.5px solid currentColor;
    transform: rotate(-45deg) translateY(-1px);
    transition: transform 0.15s var(--ease);
  }
  details.disclosure[open] > summary::before { transform: rotate(45deg) translateX(-1px); }
  details.disclosure .disclosure-body { padding: 0 var(--s-4) var(--s-4); }

  /* ---- responsive ------------------------------------------------------ */
  @media (max-width: 52rem) {
    .shell { grid-template-columns: minmax(0, 1fr); }
    .sidebar {
      position: sticky;
      top: 0;
      z-index: 5;
      height: auto;
      flex-direction: row;
      align-items: center;
      gap: var(--s-3);
      padding: var(--s-2) var(--s-3);
      border-right: none;
      border-bottom: 1px solid var(--border);
      overflow-x: auto;
    }
    .brand { padding: 0 var(--s-1) 0 0; flex: none; }
    .brand-sub { display: none; }
    .nav { flex-direction: row; gap: var(--s-1); }
    .nav-link { padding: var(--s-2); font-size: var(--fs-caption); white-space: nowrap; }
    .nav-link span { display: none; }
    .nav-link[aria-current="page"] { box-shadow: inset 0 -2px 0 var(--accent); }
    /* The icon-only strip still needs a text alternative, which the anchor
       carries via aria-label. */
    .sidebar-foot { margin: 0 0 0 auto; padding: 0; border: none; flex-direction: row; align-items: center; gap: var(--s-2); }
    .sidebar-foot .who { display: none; }
    .content { padding: var(--s-5) var(--s-4) 3rem; }
    .page-head { flex-direction: column; gap: var(--s-3); }
    dl.facts { grid-template-columns: minmax(0, 1fr); gap: var(--s-1); }
    dl.facts dt { margin-top: var(--s-2); }
    dl.facts dt:first-of-type { margin-top: 0; }
    .form-inline { flex-direction: column; align-items: stretch; }
    /* In a column flex container the row-direction growth factors would make
       each field stretch vertically; reset them so the form stays a stack. */
    .form-inline .field, .form-inline .field.compact { flex: 0 0 auto; }
    .form-inline .form-submit { padding: 0; }
    /* Let a wide table scroll rather than squeeze its columns until timestamps
       stack one word per line; the wrapper already scrolls horizontally. */
    table.data { min-width: 36rem; }
    .window-head { flex-direction: column; gap: var(--s-1); align-items: flex-start; }
  }

  /* Respect a reduced-motion preference: the meters and buttons animate, and
     nothing here is load-bearing on the transition. */
  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after { transition-duration: 0.01ms !important; animation-duration: 0.01ms !important; }
  }
`;
