/** Styles of the management page and the settings section, scoped by the `gk-` class prefix and built on DSH theme tokens. */

export const STYLES = `
.gk-page { height: 100%; overflow: auto; padding: 24px 32px 48px; box-sizing: border-box; color: var(--dsw-alias-label-primary); font-family: var(--dsw-font-family); font: var(--dsw-font-s-14); }
.gk-head { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; margin-bottom: 16px; }
.gk-title { font: var(--dsw-font-xl-24); font-weight: 600; margin: 0; }
.gk-subtitle { color: var(--dsw-alias-label-secondary); font: var(--dsw-font-xs-13); margin-top: 4px; word-break: break-all; }
.gk-tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--dsw-alias-border-l2); margin-bottom: 20px; flex-wrap: wrap; }
.gk-tab { appearance: none; background: none; border: none; padding: 8px 12px; color: var(--dsw-alias-label-secondary); cursor: pointer; font: var(--dsw-font-s-14); border-bottom: 2px solid transparent; margin-bottom: -1px; }
.gk-tab:hover { color: var(--dsw-alias-label-primary); }
.gk-tab[aria-selected="true"] { color: var(--dsw-alias-label-primary); border-bottom-color: var(--dsw-alias-state-business-primary); font-weight: 600; }
.gk-card { background: var(--dsw-alias-settings-card-fill, var(--dsw-alias-bg-layer-1)); border: 1px solid var(--dsw-alias-settings-card-stroke, var(--dsw-alias-border-l1)); border-radius: var(--dsw-radius-md); padding: 16px; margin-bottom: 16px; }
.gk-card h3 { margin: 0 0 12px; font: var(--dsw-font-base-16); font-weight: 600; }
.gk-hint { color: var(--dsw-alias-label-tertiary); font: var(--dsw-font-xs-13); margin: 4px 0 0; }
.gk-table-wrap { overflow-x: auto; }
.gk-table { width: 100%; border-collapse: collapse; font: var(--dsw-font-xs-13); }
.gk-table th { text-align: left; color: var(--dsw-alias-label-secondary); font-weight: 500; padding: 8px; border-bottom: 1px solid var(--dsw-alias-border-l2); white-space: nowrap; }
.gk-table td { padding: 8px; border-bottom: 1px solid var(--dsw-alias-border-l1); vertical-align: middle; white-space: nowrap; }
.gk-table td.gk-num, .gk-table th.gk-num { text-align: right; font-variant-numeric: tabular-nums; }
.gk-table tr.gk-muted td { color: var(--dsw-alias-label-tertiary); }
.gk-mono { font-family: var(--ds-font-family-code, monospace); font-size: 12px; word-break: break-all; }
.gk-form { display: flex; flex-wrap: wrap; gap: 12px; align-items: flex-end; }
.gk-field { display: flex; flex-direction: column; gap: 4px; min-width: 140px; }
.gk-field > span { color: var(--dsw-alias-label-secondary); font: var(--dsw-font-xs-13); }
.gk-input, .gk-select, .gk-textarea { box-sizing: border-box; padding: 6px 10px; border-radius: var(--dsw-radius-sm); border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); font: var(--dsw-font-s-14); }
.gk-textarea { width: 100%; min-height: 72px; resize: vertical; font-family: var(--ds-font-family-code, monospace); font-size: 12px; }
.gk-input:focus, .gk-select:focus, .gk-textarea:focus { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset: -1px; }
.gk-button { appearance: none; padding: 6px 14px; border-radius: var(--dsw-radius-sm); border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); cursor: pointer; font: var(--dsw-font-s-14); white-space: nowrap; }
.gk-button:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.gk-button:disabled { opacity: 0.5; cursor: default; }
.gk-button.gk-primary { background: var(--dsw-alias-button-primary-fill, var(--dsw-alias-state-business-primary)); border-color: transparent; color: var(--dsw-alias-label-primary-inverted, #fff); }
.gk-button.gk-primary:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover, var(--dsw-alias-state-business-primary)); }
.gk-button.gk-danger { color: var(--dsw-alias-state-error-primary); }
.gk-button.gk-small { padding: 2px 8px; font: var(--dsw-font-xs-13); }
.gk-actions { display: flex; gap: 6px; flex-wrap: wrap; }
.gk-tag { display: inline-flex; align-items: center; gap: 6px; padding: 1px 8px; border-radius: 999px; font: var(--dsw-font-xxs-12); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary); white-space: nowrap; }
.gk-tag.gk-ok { color: var(--dsw-alias-state-success-primary); }
.gk-tag.gk-bad { color: var(--dsw-alias-state-error-primary); }
.gk-dot { width: 8px; height: 8px; border-radius: 50%; background: currentColor; display: inline-block; }
.gk-notice { padding: 10px 12px; border-radius: var(--dsw-radius-sm); margin-bottom: 16px; font: var(--dsw-font-xs-13); }
.gk-notice.gk-error { background: var(--dsw-alias-state-error-secondary, var(--dsw-alias-bg-layer-2)); color: var(--dsw-alias-state-error-primary); }
.gk-notice.gk-info { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary); }
.gk-notice.gk-warn { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-state-warn-label, var(--dsw-alias-state-warn-primary)); }
.gk-kv { display: grid; grid-template-columns: max-content 1fr; gap: 8px 24px; font: var(--dsw-font-xs-13); }
.gk-kv dt { color: var(--dsw-alias-label-secondary); }
.gk-kv dd { margin: 0; }
.gk-overlay { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.35); display: flex; align-items: center; justify-content: center; z-index: 1000; }
.gk-dialog { background: var(--dsw-alias-bg-base); border-radius: var(--dsw-radius-lg); padding: 20px; width: min(560px, calc(100vw - 32px)); box-shadow: 0 12px 40px rgba(0,0,0,0.2); }
.gk-dialog h3 { margin: 0 0 8px; font: var(--dsw-font-base-16); font-weight: 600; }
.gk-code { padding: 10px; border-radius: var(--dsw-radius-sm); background: var(--dsw-alias-bg-layer-2); margin: 12px 0; user-select: all; }
.gk-models { display: flex; flex-wrap: wrap; gap: 8px; }
.gk-models label { display: inline-flex; gap: 4px; align-items: center; font: var(--dsw-font-xs-13); }
.gk-section { display: flex; flex-direction: column; gap: 16px; color: var(--dsw-alias-label-primary); font: var(--dsw-font-s-14); }
.gk-section h2 { margin: 0; font: var(--dsw-font-l-20); font-weight: 600; }
.gk-section p { margin: 0; color: var(--dsw-alias-label-secondary); }
.gk-status { display: flex; flex-direction: column; gap: 6px; font: var(--dsw-font-xs-13); }
.gk-status strong { font: var(--dsw-font-s-14); font-weight: 600; }
`
