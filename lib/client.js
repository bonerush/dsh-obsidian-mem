/* global window, document */
// Source contracts and measured theme values: docs/obsidian-graph-source.md.
window.__ModuleLoader__.load({
  id: 'dsh-obsidian-mem',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    // `label` is this panel's own setting: app.js has no label-size slider.
    // The default follows the user's revised preference on 2026-09-28.
    const DISPLAY = { arrows: false, text: 0, size: 1, width: 1, label: 0.85 }
    const FORCES = {
      center: 1 - Math.log(0.109) / Math.log(0.01),
      repel: 10,
      link: 1,
      distance: 250,
    }
    const FILTER = { search: '', tags: false, attachments: false, existing: false, orphans: true }
    const initialGroups = () => []
    const forceValue = (value) => (Math.pow(0.01, 1 - value) - 0.01) / 0.99
    // Obsidian resolves every graph colour from the computed style of hidden
    // `.graph-view.color-*` probes (app.js `MQ` + `testCSS`). Keep that contract,
    // and bind the same graph variables to this host's theme tokens so the graph
    // follows the app theme exactly as it follows an Obsidian theme.
    const styles = [
      '.memgraph{--graph-text:var(--dsw-alias-label-primary,var(--text-normal,#dadada));--graph-line:var(--dsw-alias-label-dimmed,var(--color-base-35,#3f3f3f));--graph-node:var(--dsw-alias-label-secondary,var(--text-muted,#b3b3b3));--graph-node-unresolved:var(--dsw-alias-label-tertiary,var(--text-faint,#666666));--graph-node-focused:var(--dsw-alias-link,var(--text-accent,#8a5cf5));--graph-node-tag:var(--dsw-alias-state-success-primary,var(--color-green,#44cf6e));--graph-node-attachment:var(--dsw-alias-state-warn-primary,var(--color-yellow,#e0de71));--interactive-accent:var(--dsw-alias-link,var(--color-accent,#8a5cf5));--menu-background:var(--dsw-alias-bg-layer-2,var(--background-secondary,#262626));--menu-border-color:var(--dsw-alias-border-l2,var(--background-modifier-border,#363636));--menu-border-width:1px;--field-background:var(--dsw-alias-bg-base,var(--background-primary,#1e1e1e));--label-tertiary:var(--dsw-alias-label-tertiary,var(--text-faint,#8b8f96));--hover-background:var(--dsw-alias-interactive-bg-hover,#ffffff14);--track-color:var(--dsw-alias-label-dimmed,var(--menu-border-color,#3f3f3f));--error-color:var(--dsw-alias-state-error-primary,var(--color-red,#fb464c));position:relative;width:100%;height:100%;min-height:240px;overflow:hidden;color:var(--graph-text);font:14px/1.5 ui-sans-serif,-apple-system,BlinkMacSystemFont,system-ui,sans-serif}',
      '.memgraph .graph-view.color-fill{color:var(--graph-node)}',
      '.memgraph .graph-view.color-fill-focused{color:var(--graph-node-focused)}',
      '.memgraph .graph-view.color-fill-tag{color:var(--graph-node-tag)}',
      '.memgraph .graph-view.color-fill-attachment{color:var(--graph-node-attachment)}',
      '.memgraph .graph-view.color-fill-unresolved{color:var(--graph-node-unresolved);opacity:.5}',
      '.memgraph .graph-view.color-fill-1,.memgraph .graph-view.color-fill-2,.memgraph .graph-view.color-fill-3,.memgraph .graph-view.color-fill-4,.memgraph .graph-view.color-fill-5,.memgraph .graph-view.color-fill-6{color:var(--graph-node)}',
      '.memgraph .graph-view.color-arrow{color:var(--graph-text);opacity:.5}',
      '.memgraph .graph-view.color-circle{color:var(--graph-node-focused)}',
      '.memgraph .graph-view.color-line{color:var(--graph-line)}',
      '.memgraph .graph-view.color-text{color:var(--graph-text)}',
      '.memgraph .graph-view.color-fill-highlight{color:var(--interactive-accent)}',
      '.memgraph .graph-view.color-line-highlight{color:var(--interactive-accent)}',
      '.memgraph *{box-sizing:border-box}.memgraph canvas{display:block;width:100%;height:100%;touch-action:none;outline:none}.memgraph button,.memgraph input,.memgraph select{font:inherit}',
      '.memgraph .graph-controls{position:absolute;right:12px;top:12px;width:240px;max-width:calc(100% - 24px);padding:0;overflow:auto;background:var(--menu-background);border-radius:8px;z-index:3}',
      '.memgraph .graph-controls:not(.is-close){max-height:calc(100% - 16px);border:var(--menu-border-width) solid var(--menu-border-color);box-shadow:0 2px 8px #0002}.memgraph .graph-controls::-webkit-scrollbar{display:none}',
      '.memgraph .graph-controls.is-close{width:auto;background:var(--menu-background);border:1px solid transparent;padding:6px}.memgraph .graph-controls.is-close .graph-control-section{display:none}',
      '.memgraph .clickable-icon{display:flex;align-items:center;justify-content:center;border:0;border-radius:4px;padding:4px;background:transparent;color:var(--label-tertiary);cursor:pointer}.memgraph .clickable-icon:hover{background:var(--hover-background)}',
      '.memgraph .clickable-icon svg{width:18px;height:18px;stroke-width:1.7}.memgraph .graph-controls-button{display:none}.memgraph .graph-controls.is-close .mod-open,.memgraph .graph-controls.is-close .mod-animate{display:flex}.memgraph .mod-animate{margin-top:8px}',
      '.memgraph .graph-controls:not(.is-close) .mod-close,.memgraph .graph-controls:not(.is-close) .mod-reset{display:flex;position:absolute;top:6px;right:8px;z-index:1}.memgraph .graph-controls:not(.is-close) .mod-reset{right:36px}',
      '.memgraph .graph-control-section{padding:6px 12px;border-bottom:1px solid var(--menu-border-color)}.memgraph .graph-control-section:last-child{border-bottom:0}.memgraph .graph-control-section:last-child .tree-item-children{padding-bottom:16px}',
      '.memgraph .tree-item-self{display:flex;align-items:center;width:100%;padding:4px 0;border:0;background:none;color:var(--graph-text);cursor:pointer;text-align:left;font-weight:500;gap:6px}.memgraph .tree-item-self svg{width:12px;height:12px;flex-shrink:0;color:var(--label-tertiary)}',
      '.memgraph .tree-item-children{padding:4px 0}.memgraph .setting-item{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:6px 0;margin-bottom:4px}.memgraph .setting-item-name{font-size:14px}',
      '.memgraph .setting-item.mod-slider{display:block}.memgraph .setting-item-control{display:flex;align-items:center;gap:10px}.memgraph .mod-slider .setting-item-control{padding-top:12px;width:100%}.memgraph .mod-slider output{font-variant-numeric:tabular-nums;min-width:28px}',
      '.memgraph input[type=range]{appearance:none;width:100%;height:4px;background:var(--track-color);border-radius:4px;cursor:pointer;margin:8px 0;accent-color:var(--interactive-accent)}.memgraph input[type=range]::-webkit-slider-thumb{appearance:none;width:30px;height:18px;border:0;border-radius:20px;background:#fff;box-shadow:0 1px 5px #0003}.memgraph input[type=range]::-moz-range-thumb{width:30px;height:18px;border:0;border-radius:20px;background:#fff}',
      '.memgraph .checkbox-container{position:relative;width:36px;height:16px;border-radius:20px;background:var(--track-color);flex-shrink:0;cursor:pointer}.memgraph .checkbox-container.is-enabled{background:var(--interactive-accent)}.memgraph .checkbox-container:after{content:"";position:absolute;top:2px;left:2px;width:20px;height:12px;border-radius:12px;background:#fff;pointer-events:none}.memgraph .checkbox-container.is-enabled:after{left:14px}.memgraph .checkbox-container input{opacity:0;width:100%;height:100%;margin:0;cursor:pointer}',
      '.memgraph input[type=text],.memgraph input[type=search],.memgraph select{min-width:0;width:100%;height:30px;border:1px solid var(--menu-border-color);border-radius:5px;background:var(--field-background);color:var(--graph-text);padding:4px 8px;outline:none}.memgraph input::placeholder{color:var(--label-tertiary)}',
      '.memgraph .search-input-container{position:relative;width:100%}.memgraph .search-input-container input{border-radius:18px;padding-left:30px}.memgraph .search-input-container svg{position:absolute;left:9px;top:7px;width:16px;height:16px;color:var(--label-tertiary)}',
      '.memgraph .graph-color-group{display:flex;align-items:center;padding-bottom:6px;gap:0}.memgraph .graph-color-group input[type=color]{appearance:none;width:18px;height:18px;flex-shrink:0;border:0;padding:0;margin:0 2px 0 6px;background:none;cursor:pointer}.memgraph input[type=color]::-webkit-color-swatch-wrapper{padding:0}.memgraph input[type=color]::-webkit-color-swatch{border:0;border-radius:50%}',
      '.memgraph .graph-color-group .clickable-icon{padding:4px}.memgraph .graph-color-group .clickable-icon svg{width:14px;height:14px}.memgraph .graph-color-button-container{margin:6px 0 10px}.memgraph .mod-cta{border:0;border-radius:6px;background:var(--interactive-accent);color:#ffffff;padding:6px 12px;font-weight:600;cursor:pointer}.memgraph .graph-color-button-container .mod-cta{width:100%}',
      '.memgraph .mod-playback{justify-content:flex-end}.memgraph .graph-message{position:absolute;left:20px;right:20px;top:45%;text-align:center;color:var(--label-tertiary);pointer-events:none}.memgraph .graph-message.error{color:var(--error-color)}',
      '.memgraph .graph-truncated{position:absolute;left:12px;right:12px;bottom:10px;text-align:center;color:var(--label-tertiary);font-size:12px;pointer-events:none}',
    ].join('')

    // The panel's stylesheet: one injected <head> sheet, token-only so dark and
    // light need no branch, and one design system for the shell and every view
    // class (the views only supply markup). Radii stay <=16px — a 16px radius on
    // a 30px pill still renders a full capsule — shadows are the two token
    // levels, and no gradient is drawn. The marker comments let
    // test/panel-client.test.js scan exactly this string for literals.
    /* panel-css:start */
    const PANEL_CSS = [
      '.mem-panel{position:relative;display:flex;flex-direction:column;height:100%;min-height:240px;overflow:hidden;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:var(--dsw-font-xxs-12);line-height:1.6;container-type:inline-size}',
      '.mem-panel::before{content:"";position:absolute;top:0;bottom:0;left:0;width:1px;background:var(--dsw-alias-border-l1);pointer-events:none}',
      '.mem-panel *{box-sizing:border-box;min-width:0}',
      '.mem-panel button,.mem-panel input,.mem-panel select{font:inherit;color:inherit}',
      '.mem-panel :focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}',
      '.mem-panel .mem-display{font:var(--dsw-font-s-strong-14);letter-spacing:0}',
      '.mem-panel .mem-masthead{flex:0 0 auto;padding:10px 14px 8px}',
      '.mem-panel .mem-masthead-top{display:flex;align-items:center;justify-content:space-between;gap:8px}',
      '.mem-panel .mem-masthead-name{margin:0;font:var(--dsw-font-s-strong-14);line-height:1.3;letter-spacing:0;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.mem-panel .mem-masthead-sub{display:block;margin-top:2px;font:var(--dsw-font-xxxs-11);line-height:1.6;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.mem-panel .mem-masthead-meta{display:flex;align-items:center;justify-content:space-between;gap:8px;min-height:28px}',
      '.mem-panel .mem-masthead-meta:empty{display:none}',
      '.mem-panel .mem-clock{font:var(--dsw-font-xxxs-11);line-height:1.6;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.mem-panel .mem-refresh{display:inline-flex;flex:0 0 auto;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;transition:background-color 150ms ease,color 150ms ease}',
      '.mem-panel .mem-refresh:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '.mem-panel .mem-refresh svg{width:15px;height:15px}',
      '.mem-panel .mem-stamp{display:inline-flex;flex:none;align-items:center;gap:4px;min-height:19px;padding:0 7px;border:1px solid var(--dsw-alias-border-l1);border-radius:16px;font:var(--dsw-font-xxxs-strong-11);line-height:1;color:var(--dsw-alias-label-secondary);white-space:nowrap;font-variant-numeric:tabular-nums}',
      '.mem-panel .mem-stamp.is-ok{color:var(--dsw-alias-state-success-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 45%,transparent)}',
      '.mem-panel .mem-stamp.is-warn{color:var(--dsw-alias-state-warn-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 45%,transparent)}',
      '.mem-panel .mem-stamp.is-err{color:var(--dsw-alias-state-error-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 45%,transparent)}',
      // The folder strip: three leaves in one row, adjacent leaves overlapping so the
      // row reads as one folded folder, and the active leaf painted in the content
      // surface (with its own bottom border erased and a -1px overlap) so it merges
      // with the page below. The leaves stay 32px tall so the folder look holds; the
      // 44px click target is the leaf plus its own hit extension
      // (`.mem-tab::after`, 12px above the leaf = 44px total), which overhangs into
      // the strip's 6px padding and the 8px gap under the search box. No overflow
      // clipping: the leaves shrink to fit instead, and the active leaf has to
      // overhang the strip's own 1px rule.
      '.mem-panel .mem-tabs{display:flex;flex-wrap:nowrap;flex:0 0 auto;align-items:flex-end;gap:0;padding:6px 8px 0;background:var(--dsw-alias-bg-layer-1);border-bottom:1px solid var(--dsw-alias-border-l1)}',
      '.mem-panel .mem-tab{position:relative;display:flex;flex:0 1 auto;align-items:center;justify-content:center;gap:5px;height:32px;min-width:0;max-width:132px;margin-bottom:-1px;padding:0 10px;border:1px solid var(--dsw-alias-border-l1);border-bottom-color:transparent;border-radius:10px 10px 0 0;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font:var(--dsw-font-xxs-strong-12);line-height:1;white-space:nowrap;cursor:pointer;z-index:0;transition:background-color 150ms ease,color 150ms ease}',
      '.mem-panel .mem-tab::after{content:"";position:absolute;left:0;right:0;top:-12px;bottom:0}',
      '.mem-panel .mem-tab + .mem-tab{margin-left:-8px}',
      '.mem-panel .mem-tab:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '.mem-panel .mem-tab[aria-selected="true"]{z-index:2;background:var(--dsw-alias-bg-base);border-color:var(--dsw-alias-border-l1);border-bottom-color:var(--dsw-alias-bg-base);box-shadow:var(--dsw-shadow-lv1);color:var(--dsw-alias-label-primary)}',
      '.mem-panel .mem-tab-icon{display:inline-flex;flex:0 0 auto;align-items:center;justify-content:center;width:15px;height:15px}',
      '.mem-panel .mem-tab-icon svg{width:15px;height:15px}',
      '.mem-panel .mem-tab-label{overflow:hidden;text-overflow:ellipsis}',
      '.mem-panel .mem-view{flex:1;overflow:auto;padding:14px 14px 28px;scrollbar-width:thin;scrollbar-color:color-mix(in srgb,var(--dsw-alias-label-secondary) 35%,transparent) transparent}',
      '.mem-panel .mem-view::-webkit-scrollbar{width:8px;height:8px}',
      '.mem-panel .mem-view::-webkit-scrollbar-thumb{background:color-mix(in srgb,var(--dsw-alias-label-secondary) 35%,transparent);border-radius:16px}',
      '.mem-panel .mem-view::-webkit-scrollbar-track{background:transparent}',
      '.mem-panel .mem-ledger{display:flex;flex-direction:column}',
      '.mem-panel .mem-ledger>*{animation:mem-enter 160ms cubic-bezier(.2,.7,.3,1) both}',
      '.mem-panel .mem-ledger>:nth-child(2){animation-delay:20ms}.mem-panel .mem-ledger>:nth-child(3){animation-delay:40ms}.mem-panel .mem-ledger>:nth-child(4){animation-delay:60ms}.mem-panel .mem-ledger>:nth-child(5){animation-delay:80ms}',
      '@keyframes mem-enter{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:translateY(0)}}',
      '@media (prefers-reduced-motion:reduce){.mem-panel .mem-ledger>*{animation:none}.mem-panel .mem-tab,.mem-panel .mem-refresh,.mem-panel .mem-btn,.mem-panel .mem-action,.mem-panel .mem-search-submit,.mem-panel .mem-filter-option{transition:none}}',
      '.mem-panel .mem-viewhead{display:flex;align-items:baseline;justify-content:space-between;gap:8px;padding:2px 0 10px;border-bottom:1px solid var(--dsw-alias-border-l1)}',
      '.mem-panel .mem-viewhead-title{margin:0;font:var(--dsw-font-s-strong-14);line-height:1.3;letter-spacing:0}',
      '.mem-panel .mem-viewhead-meta{font:var(--dsw-font-xxxs-11);line-height:1.6;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;text-align:right}',
      '.mem-panel .mem-actions{display:flex;flex-wrap:wrap;align-items:center;justify-content:flex-end;gap:6px}',
      '.mem-panel .mem-action{display:inline-flex;align-items:center;min-height:32px;flex:none;padding:0 2px;border:0;background:none;color:var(--dsw-alias-state-business-primary);font:var(--dsw-font-xxxs-strong-11);line-height:1.5;cursor:pointer;white-space:nowrap;transition:color 150ms ease}',
      '.mem-panel .mem-action:hover{color:var(--dsw-alias-label-primary)}',
      '.mem-panel .mem-action:disabled{opacity:.55;cursor:default}',
      '.mem-panel .mem-btn{display:inline-flex;align-items:center;justify-content:center;min-height:32px;padding:0 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary);font:var(--dsw-font-xxs-12);line-height:1;cursor:pointer;transition:background-color 150ms ease}',
      '.mem-panel .mem-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.mem-panel .mem-btn:disabled{opacity:.55;cursor:default}',
      '.mem-panel .mem-btn-primary{background:var(--dsw-alias-state-business-primary);border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-bg-base)}',
      '.mem-panel .mem-btn-primary:hover{background:var(--dsw-alias-state-business-primary)}',
      '.mem-panel .mem-btn-quiet{border-color:transparent;background:none;padding:0 4px;color:var(--dsw-alias-label-secondary)}',
      '.mem-panel .mem-label{font:var(--dsw-font-xxxs-11);line-height:1.6;color:var(--dsw-alias-label-secondary)}',
      '.mem-panel .mem-meta{font:var(--dsw-font-xxxs-11);line-height:1.6;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}',
      '.mem-panel .mem-warn{color:var(--dsw-alias-state-warn-primary)}',
      '.mem-panel .mem-notice{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:10px;padding:9px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1);font:var(--dsw-font-xxs-12);line-height:1.6;color:var(--dsw-alias-label-secondary)}',
      '.mem-panel .mem-notice.is-stale{color:var(--dsw-alias-state-warn-primary)}',
      '.mem-panel .mem-notice.is-error{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 45%,transparent);color:var(--dsw-alias-state-error-primary)}',
      '.mem-panel .mem-notice.is-empty{justify-content:center;padding:18px 0;border:0;background:none}',
      '.mem-panel .mem-status{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 0;border-top:1px solid var(--dsw-alias-border-l1);font:var(--dsw-font-xxs-12);line-height:1.6;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}',
      '.mem-panel .mem-status.is-error{border-top-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 45%,transparent);color:var(--dsw-alias-state-error-primary)}',
      '.mem-panel .mem-status.is-idle{color:var(--dsw-alias-label-secondary)}',
      '.mem-panel .mem-empty{padding:18px 0;text-align:center;font:var(--dsw-font-xxs-12);line-height:1.6;color:var(--dsw-alias-label-secondary)}',
      '.mem-panel .mem-skeleton{display:flex;flex-direction:column;gap:8px;padding-top:14px;color:var(--dsw-alias-label-secondary)}',
      '.mem-panel .mem-skeleton span{height:10px;border-radius:8px;background:var(--dsw-alias-bg-layer-2)}',
      '.mem-panel .mem-skeleton span:first-child{height:auto;background:none}',
      '.mem-panel .mem-more{display:flex;align-items:center;justify-content:space-between;gap:8px;padding-top:10px}',
      '.mem-panel .mem-action-status{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:10px;padding:9px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1);font:var(--dsw-font-xxs-12);line-height:1.6;color:var(--dsw-alias-label-secondary)}',
      '.mem-panel .mem-action-status.is-error{color:var(--dsw-alias-state-error-primary)}',
      '.mem-panel .mem-kpiline{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));margin-top:14px;overflow:hidden;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1)}',
      '.mem-panel .mem-kpi{display:flex;flex-direction:column;gap:3px;padding:10px 10px 12px}',
      '.mem-panel .mem-kpi+.mem-kpi{border-left:1px solid var(--dsw-alias-border-l1)}',
      '.mem-panel .mem-kpi-label{font:var(--dsw-font-xxxs-11);line-height:1.5;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.mem-panel .mem-kpi-line{display:flex;align-items:baseline;gap:3px}',
      '.mem-panel .mem-kpi-value{font-size:26px;font-weight:600;line-height:1;letter-spacing:0;font-variant-numeric:tabular-nums}',
      '.mem-panel .mem-kpi-unit{font:var(--dsw-font-xxxs-11);line-height:1.5;color:var(--dsw-alias-label-secondary)}',
      '.mem-panel .mem-summary{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:1px;margin-top:10px;overflow:hidden;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-border-l1)}',
      '.mem-panel .mem-summary-item{display:flex;flex-direction:column;gap:2px;justify-content:center;min-height:44px;padding:10px 12px;border:0;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);text-align:left}',
      '.mem-panel .mem-summary-value{font:var(--dsw-font-xxs-strong-12);line-height:1.5;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary)}',
      '.mem-panel .mem-summary-value.is-warn{color:var(--dsw-alias-state-warn-primary)}',
      '.mem-panel .mem-summary-value.is-err{color:var(--dsw-alias-state-error-primary)}',
      '.mem-panel .mem-section{margin-top:18px}',
      '.mem-panel .mem-section-head{display:flex;align-items:baseline;justify-content:space-between;gap:8px;padding-bottom:6px;border-bottom:1px solid var(--dsw-alias-border-l1)}',
      '.mem-panel .mem-section-head h2{margin:0;font:var(--dsw-font-xxs-strong-12);line-height:1.5;letter-spacing:0;color:var(--dsw-alias-label-secondary)}',
      '.mem-panel .mem-section-meta{font:var(--dsw-font-xxxs-11);line-height:1.5;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}',
      '.mem-panel .mem-comp{display:flex;flex-direction:column;gap:10px;padding-top:12px}',
      '.mem-panel .mem-bar-track{display:flex;height:8px;overflow:hidden;border-radius:16px;background:var(--dsw-alias-bg-layer-2)}',
      '.mem-panel .mem-bar-fill{display:block;height:100%;background:var(--dsw-alias-state-business-primary)}',
      '.mem-panel .mem-bar-fill+.mem-bar-fill{border-left:1px solid var(--dsw-alias-bg-base)}',
      '.mem-panel .mem-comp-legend{display:flex;flex-direction:column}',
      '.mem-panel .mem-comp-row{display:grid;grid-template-columns:8px minmax(0,1fr) auto 34px;align-items:center;gap:8px;min-height:28px;border-bottom:1px solid var(--dsw-alias-border-l1)}',
      '.mem-panel .mem-comp-row:last-child{border-bottom:0}',
      '.mem-panel .mem-comp-dot{width:8px;height:8px;border-radius:16px;background:var(--dsw-alias-state-business-primary)}',
      '.mem-panel .mem-comp-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:var(--dsw-font-xxs-12);line-height:1.5}',
      '.mem-panel .mem-comp-value{text-align:right;font:var(--dsw-font-xxs-12);line-height:1.5;font-variant-numeric:tabular-nums}',
      '.mem-panel .mem-comp-pct{text-align:right;font:var(--dsw-font-xxxs-11);line-height:1.5;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}',
      '.mem-panel .mem-stamps{display:flex;flex-wrap:wrap;gap:6px;padding-top:10px}',
      '.mem-panel .mem-recent{list-style:none;margin:0;padding:0}',
      '.mem-panel .mem-recent-row{display:flex;align-items:flex-start;gap:8px;padding:10px 0;border-bottom:1px solid var(--dsw-alias-border-l1)}',
      '.mem-panel .mem-recent-row:last-child{border-bottom:0}',
      '.mem-panel .mem-dot{flex:0 0 auto;width:8px;height:8px;margin-top:5px;border-radius:16px;background:var(--dsw-alias-state-business-primary)}',
      '.mem-panel .mem-recent-main{flex:1;overflow:hidden}',
      '.mem-panel .mem-recent-title{display:block;font:var(--dsw-font-xxs-strong-12);line-height:1.6;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.mem-panel .mem-recent-meta{display:block;margin-top:1px;font:var(--dsw-font-xxxs-11);line-height:1.5;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-variant-numeric:tabular-nums}',
      // The persistent search box is shell chrome, not a view: it sits between the
      // masthead and the tab strip so it stays visible on every page, and the
      // shell owns its state (design §3.1). One 40px rounded field, icon at the
      // leading edge, clear button at the trailing edge, submit to enter search.
      // The layout rule is shared with the results view it replaces; only the
      // direct child of the panel gets the shell's own placement, so a view that
      // still renders its own bar is not double-padded while Task 4 catches up.
      '.mem-panel .mem-searchbar{display:flex;align-items:center;gap:8px}',
      '.mem-panel > .mem-searchbar{flex:0 0 auto;padding:0 14px 8px}',
      '.mem-panel .mem-search-field{display:flex;flex:1;align-items:center;gap:8px;height:40px;min-width:0;padding:0 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1)}',
      '.mem-panel .mem-search-field:focus-within{border-color:var(--dsw-alias-state-business-primary)}',
      '.mem-panel .mem-search-icon{display:inline-flex;flex:0 0 auto;align-items:center;justify-content:center;width:16px;height:16px;color:var(--dsw-alias-label-secondary)}',
      '.mem-panel .mem-search-icon svg{width:16px;height:16px}',
      '.mem-panel .mem-search-input{flex:1;height:100%;padding:0;border:0;background:transparent;color:var(--dsw-alias-label-primary);font:var(--dsw-font-xs-regular-13);line-height:1.6}',
      '.mem-panel .mem-search-input::placeholder{color:var(--dsw-alias-label-secondary)}',
      '.mem-panel .mem-search-input::-webkit-search-cancel-button{-webkit-appearance:none;display:none}',
      '.mem-panel .mem-search-clear{display:inline-flex;flex:0 0 auto;align-items:center;justify-content:center;width:24px;height:24px;padding:0;border:0;border-radius:16px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}',
      '.mem-panel .mem-search-clear:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '.mem-panel .mem-search-clear svg{width:13px;height:13px}',
      '.mem-panel .mem-search-submit{display:inline-flex;align-items:center;justify-content:center;height:40px;padding:0 14px;border:1px solid var(--dsw-alias-state-business-primary);border-radius:10px;background:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-bg-base);font:var(--dsw-font-xxs-strong-12);line-height:1;white-space:nowrap;cursor:pointer;transition:background-color 150ms ease,color 150ms ease}',
      '.mem-panel .mem-search-submit:disabled{opacity:.55;cursor:default}',
      '.mem-panel .mem-filter{display:grid;grid-template-columns:auto minmax(0,1fr);align-items:baseline;gap:8px;padding-top:12px}',
      '.mem-panel .mem-filter-label{font:var(--dsw-font-xxxs-strong-11);line-height:1.5;color:var(--dsw-alias-label-secondary)}',
      '.mem-panel .mem-filter-options{display:flex;flex-wrap:wrap;gap:8px}',
      '.mem-panel .mem-filter-option{display:inline-flex;align-items:center;min-height:30px;padding:0 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:16px;background:transparent;color:var(--dsw-alias-label-secondary);font:var(--dsw-font-xxxs-strong-11);line-height:1;white-space:nowrap;cursor:pointer;transition:background-color 150ms ease,color 150ms ease,border-color 150ms ease}',
      '.mem-panel .mem-filter-option:hover{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary)}',
      '.mem-panel .mem-filter-option[aria-pressed="true"]{background:var(--dsw-alias-state-business-primary);border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-bg-base)}',
      '.mem-panel .mem-results{list-style:none;margin:0;padding:0}',
      '.mem-panel .mem-result{display:flex;flex-direction:column;gap:2px;padding:12px 0;border-bottom:1px solid var(--dsw-alias-border-l1)}',
      '.mem-panel .mem-result:last-child{border-bottom:0}',
      '.mem-panel .mem-result-main{overflow:hidden}',
      '.mem-panel .mem-result-head{display:flex;flex-wrap:wrap;align-items:baseline;gap:6px}',
      '.mem-panel .mem-result-title{flex:1;font:var(--dsw-font-xxs-strong-12);line-height:1.6;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.mem-panel .mem-result-path{display:block;margin-top:1px;font:var(--dsw-font-xxxs-11);line-height:1.5;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-variant-numeric:tabular-nums}',
      '.mem-panel .mem-snippet{margin:4px 0 0;font:var(--dsw-font-xxs-12);line-height:1.6;color:var(--dsw-alias-label-secondary);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}',
      '.mem-panel .mem-snippet mark{padding:0 1px;border-radius:2px;background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 22%,transparent);color:inherit}',
      '.mem-panel .mem-chips{display:flex;flex-wrap:wrap;gap:4px;margin-top:4px}',
      '.mem-panel .mem-chip{display:inline-flex;align-items:center;min-height:18px;padding:0 6px;border:1px solid var(--dsw-alias-border-l1);border-radius:16px;background:var(--dsw-alias-bg-layer-1);font:var(--dsw-font-xxxs-11);line-height:1.4;color:var(--dsw-alias-label-secondary);white-space:nowrap;font-variant-numeric:tabular-nums}',
      '.mem-panel .mem-facts{display:grid;grid-template-columns:auto minmax(0,1fr);margin:10px 0 0}',
      '.mem-panel .mem-facts dt{padding:6px 8px 6px 0;border-bottom:1px solid var(--dsw-alias-border-l1);font:var(--dsw-font-xxxs-11);line-height:1.5;color:var(--dsw-alias-label-secondary)}',
      '.mem-panel .mem-facts dd{margin:0;padding:6px 0;border-bottom:1px solid var(--dsw-alias-border-l1);font:var(--dsw-font-xxs-12);line-height:1.5;font-variant-numeric:tabular-nums;word-break:break-word}',
      '.mem-panel .mem-rows{list-style:none;margin:0;padding:0}',
      '.mem-panel .mem-row{display:flex;align-items:baseline;gap:8px;padding:8px 0;border-bottom:1px solid var(--dsw-alias-border-l1);font:var(--dsw-font-xxs-12);line-height:1.6}',
      '.mem-panel .mem-row:last-child{border-bottom:0}',
      '.mem-panel .mem-row-title{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.mem-panel .mem-row-time{flex:0 0 auto;font:var(--dsw-font-xxxs-11);line-height:1.5;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}',
      '.mem-panel .mem-meter{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:6px 8px;padding:10px 0}',
      '.mem-panel .mem-meter-head{font:var(--dsw-font-xxxs-11);line-height:1.5;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}',
      '.mem-panel .mem-meter-track{grid-column:1/-1;display:block;height:6px;overflow:hidden;border-radius:16px;background:var(--dsw-alias-bg-layer-2)}',
      '.mem-panel .mem-meter-fill{display:block;height:100%;border-radius:16px;background:var(--dsw-alias-state-business-primary)}',
      '.mem-panel .mem-meter-fill.is-warn{background:var(--dsw-alias-state-warn-primary)}',
      '.mem-panel .mem-digest{padding-top:2px}',
      '.mem-panel .mem-events{list-style:none;margin:0;padding:0}',
      '.mem-panel .mem-event{display:grid;grid-template-columns:10px minmax(0,1fr);align-items:baseline;gap:8px;padding:6px 0;border-bottom:1px solid var(--dsw-alias-border-l1);font:var(--dsw-font-xxs-12);line-height:1.6}',
      '.mem-panel .mem-event:last-child{border-bottom:0}',
      '.mem-panel .mem-event-dot{width:8px;height:8px;border-radius:16px;background:var(--dsw-alias-state-business-primary)}',
      '.mem-panel .mem-sheet{position:absolute;inset:0;z-index:20;display:flex;align-items:flex-end}',
      '.mem-panel .mem-sheet-scrim{position:absolute;inset:0;background:color-mix(in srgb,var(--dsw-alias-bg-base) 60%,transparent)}',
      '.mem-panel .mem-sheet-panel{position:relative;width:100%;max-height:86%;overflow:auto;padding:18px;background:var(--dsw-alias-bg-overlay);border-top:1px solid var(--dsw-alias-border-l1);border-radius:16px 16px 0 0;box-shadow:var(--dsw-shadow-lv3)}',
      '.mem-panel .mem-sheet-head{display:flex;align-items:baseline;justify-content:space-between;gap:8px;padding-bottom:10px;border-bottom:1px solid var(--dsw-alias-border-l1)}',
      '.mem-panel .mem-sheet-title{margin:0;font:var(--dsw-font-s-strong-14);line-height:1.3;letter-spacing:0}',
      '.mem-panel .mem-sheet-body{padding-top:6px}',
      '.mem-panel .mem-sheet-fact{display:grid;grid-template-columns:auto minmax(0,1fr);gap:10px;padding:7px 0;border-bottom:1px solid var(--dsw-alias-border-l1)}',
      '.mem-panel .mem-fact-value{font-variant-numeric:tabular-nums;word-break:break-word}',
      '.mem-panel .mem-sheet-effects{margin:10px 0 0;padding-left:16px;font:var(--dsw-font-xxs-12);line-height:1.6;color:var(--dsw-alias-label-secondary)}',
      '.mem-panel .mem-sheet-warning{margin:10px 0 0;color:var(--dsw-alias-state-warn-primary)}',
      '.mem-panel .mem-sheet-error{margin:10px 0 0;color:var(--dsw-alias-state-error-primary)}',
      '.mem-panel .mem-sheet-actions{display:flex;align-items:center;justify-content:flex-end;gap:8px;padding-top:16px}',
      '.mem-panel .mem-sheet-confirm{display:inline-flex;align-items:center;justify-content:center;min-height:44px;padding:0 16px;border:1px solid var(--dsw-alias-state-business-primary);border-radius:10px;background:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-bg-base);font:var(--dsw-font-xxs-strong-12);cursor:pointer}',
      '.mem-panel .mem-sheet-confirm:disabled{opacity:.55;cursor:default}',
      '.mem-panel .mem-sheet-cancel{display:inline-flex;align-items:center;justify-content:center;min-height:44px;padding:0 14px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:transparent;color:var(--dsw-alias-label-primary);font:var(--dsw-font-xxs-12);cursor:pointer}',
      '.mem-panel .mem-sheet-cancel:disabled{opacity:.55;cursor:default}',
      '.mem-panel .mem-sr{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}',
      '@container (max-width:359px){.mem-panel .mem-tab-icon{display:none}.mem-panel .mem-kpiline{grid-template-columns:repeat(2,minmax(0,1fr))}.mem-panel .mem-kpi:nth-child(3){border-left:0;border-top:1px solid var(--dsw-alias-border-l1)}.mem-panel .mem-kpi:nth-child(4){border-top:1px solid var(--dsw-alias-border-l1)}}',
    ].join('')
    /* panel-css:end */

    async function post(payload) {
      const response = await fetch('obsidian-mem/graph', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const envelope = await response.json()
      if (!response.ok || envelope.ok !== true)
        throw new Error(envelope.error?.message ?? '图谱暂不可用')
      return envelope.value
    }

    function icon(name) {
      const paths = {
        settings:
          'M9.2 3.4h5.6l.6 2.4 2 1.2 2.4-.6 2.8 4.8-1.8 1.8v2.3l1.8 1.8-2.8 4.8-2.4-.6-2 1.2-.6 2.4H9.2l-.6-2.4-2-1.2-2.4.6-2.8-4.8 1.8-1.8V11l-1.8-1.8 2.8-4.8 2.4.6 2-1.2z',
        wand: 'M15 4l5 5M4 20l16-16-4-4L0 16zM20 15v4M18 17h4M5 2v4M3 4h4',
        reset: 'M3 11a9 9 0 1 1 3 7M3 3v8h8',
        close: 'M6 6l12 12M6 18L18 6',
        search: 'M21 21l-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0',
        down: 'M6 9l6 6 6-6',
        right: 'M9 6l6 6-6 6',
        overview: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z',
        graph: 'M8.6 7.5l6.8 4M8.6 16.5l6.8-4M6 9v6',
        health: 'M3 12h4l2.5-6 4 12 2.5-6H21',
        refresh: 'M21 3v6h-6M21 9a9 9 0 1 0-2.6 8.4',
      }
      return h(
        'svg',
        {
          viewBox: name === 'settings' ? '0 0 24 28' : '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
        },
        h('path', { d: paths[name] }),
        name === 'settings' && h('circle', { cx: 12, cy: 14, r: 3 }),
        name === 'graph' && h('circle', { cx: 6, cy: 6, r: 3 }),
        name === 'graph' && h('circle', { cx: 6, cy: 18, r: 3 }),
        name === 'graph' && h('circle', { cx: 18, cy: 12, r: 3 }),
      )
    }

    function matches(node, query) {
      const branches = query.toLowerCase().split(/\s+OR\s+/i)
      return branches.some((branch) => {
        const terms = branch.match(/\[[^\]]+\]|(?:[^\s"]+|"[^"]*")+/g) ?? []
        return terms.every((term) => {
          const negative = term.startsWith('-')
          term = (negative ? term.slice(1) : term)
            .replace(/^\[|\]$/g, '')
            .replace(/"/g, '')
            .trim()
          const colon = term.indexOf(':')
          const field = colon < 0 ? '' : term.slice(0, colon)
          const value = (colon < 0 ? term : term.slice(colon + 1)).trim()
          const text =
            field === 'type'
              ? node.type
              : field === 'tag'
                ? (node.tags ?? []).join(' ')
                : field === 'path'
                  ? node.path
                  : field === 'file'
                    ? node.path.split('/').pop()
                    : node.title + ' ' + node.path
          const found = String(text).toLowerCase().includes(value)
          return negative ? !found : found
        })
      })
    }

    function GraphCanvas({ graph, display, forces, groups, active, visible, onError }) {
      const ref = React.useRef(null)
      const state = React.useRef({ renderer: null, model: null, forces: null })
      const styling = React.useMemo(() => {
        const degree = new Map()
        for (const edge of graph.edges) {
          degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1)
          degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1)
        }
        const colors = new Map(
          graph.nodes.map((node) => [
            node.id,
            groups.find((group) => group.query.trim() && matches(node, group.query))?.color,
          ]),
        )
        return { degree, colors }
      }, [graph, groups])
      state.current.model = { graph, display, active, ...styling }
      state.current.forces = {
        centerStrength: forceValue(forces.center),
        repelStrength: forces.repel ** 3,
        linkStrength: forceValue(forces.link),
        linkDistance: forces.distance,
      }
      React.useEffect(() => {
        if (!visible) return undefined
        let cancelled = false
        let renderer
        void import('/obsidian-mem/graph-renderer.js')
          .then(({ createGraphRenderer }) => {
            if (cancelled) return
            renderer = createGraphRenderer(ref.current, onError)
            state.current.renderer = renderer
            renderer.update(state.current.model)
            renderer.setForces(state.current.forces)
          })
          .catch(() => {
            if (!cancelled) onError('图谱渲染暂不可用')
          })
        return () => {
          cancelled = true
          renderer?.destroy()
          state.current.renderer = null
        }
      }, [visible])
      React.useEffect(() => {
        state.current.renderer?.update(state.current.model)
      }, [graph, display, active, styling])
      React.useEffect(() => {
        state.current.renderer?.setForces(state.current.forces)
      }, [forces])
      return h('canvas', { ref, role: 'img', tabIndex: 0, 'aria-label': '可缩放的记忆关系图谱' })
    }

    function GraphView({ sessionId, visible }) {
      const [scope, setScope] = React.useState('all')
      const [graph, setGraph] = React.useState({ nodes: [], edges: [], total: 0 })
      const [error, setError] = React.useState('')
      const [active, setActive] = React.useState([])
      const [open, setOpen] = React.useState(false)
      const [expanded, setExpanded] = React.useState({})
      const [filter, setFilter] = React.useState(FILTER)
      const [groups, setGroups] = React.useState(initialGroups)
      const [display, setDisplay] = React.useState(DISPLAY)
      const [forces, setForces] = React.useState(FORCES)
      const [progression, setProgression] = React.useState(null)
      const cursor = React.useRef(0)
      const [restored, setRestored] = React.useState(false)
      const store = React.useRef(null)
      // The host builds this tab from scratch on every page load, and the route that
      // feeds it is read-only, so the browser's own storage is the only place the
      // panel's controls can be remembered (`lib/graph-settings.js`, served beside
      // this bundle). The dynamic import is what makes the read asynchronous — the
      // first render already has to draw something, and the built-in controls are a
      // graph that works.
      React.useEffect(() => {
        let live = true
        void import('/obsidian-mem/graph-settings.js')
          .then((module) => {
            if (!live) return
            store.current = module.createGraphSettingsStore({
              scope: 'all',
              filter: FILTER,
              groups: initialGroups(),
              display: DISPLAY,
              forces: FORCES,
            })
            const saved = store.current.read()
            setScope(saved.scope)
            setFilter(saved.filter)
            setGroups(saved.groups)
            setDisplay(saved.display)
            setForces(saved.forces)
            setRestored(true)
          })
          .catch(() => setRestored(true))
        return () => {
          live = false
        }
      }, [])
      React.useEffect(() => {
        // Never before the read landed: this render still holds the built-in
        // controls, and saving those would erase what was remembered.
        if (!restored) return
        store.current?.write({ scope, filter, groups, display, forces })
      }, [restored, scope, filter, groups, display, forces])
      React.useEffect(() => {
        if (!visible || !sessionId) return undefined
        let cancelled = false
        let loading = false
        const load = async () => {
          if (loading) return
          loading = true
          try {
            const value = await post({ sessionId, scope, action: 'snapshot' })
            if (!cancelled) {
              setGraph((previous) =>
                JSON.stringify(previous) === JSON.stringify(value) ? previous : value,
              )
              setError('')
            }
          } catch (cause) {
            if (!cancelled) setError(cause.message)
          } finally {
            loading = false
          }
        }
        void load()
        const timer = setInterval(load, 15000)
        return () => {
          cancelled = true
          clearInterval(timer)
        }
      }, [sessionId, scope, visible])
      React.useEffect(() => {
        cursor.current = 0
        setActive([])
      }, [sessionId])
      React.useEffect(() => {
        if (!visible || !sessionId) return undefined
        let cancelled = false
        let polling = false
        const poll = async () => {
          if (polling) return
          polling = true
          try {
            const value = await post({ sessionId, action: 'activity', cursor: cursor.current })
            if (cancelled) return
            cursor.current = value.cursor
            if (value.events.length)
              setActive((previous) =>
                [...previous, ...value.events]
                  .filter((event) => Date.now() - event.at < 3600)
                  .slice(-80),
              )
          } catch {
            /* Temporary activity failure does not invalidate a graph snapshot. */
          } finally {
            polling = false
          }
        }
        void poll()
        const timer = setInterval(poll, 700)
        return () => {
          cancelled = true
          clearInterval(timer)
        }
      }, [sessionId, visible])
      React.useEffect(() => {
        if (progression === null) return undefined
        const timer = setTimeout(
          () => setProgression((value) => (value + 1 >= graph.nodes.length ? null : value + 1)),
          50,
        )
        return () => clearTimeout(timer)
      }, [progression, graph.nodes.length])
      const filtered = React.useMemo(() => {
        let nodes = graph.nodes.filter(
          (node) =>
            matches(node, filter.search) && (!filter.existing || node.type !== 'unresolved'),
        )
        if (progression !== null) nodes = nodes.slice(0, progression)
        let ids = new Set(nodes.map((node) => node.id))
        let edges = graph.edges.filter((edge) => ids.has(edge.source) && ids.has(edge.target))
        if (filter.tags) {
          const tags = new Map()
          for (const node of nodes)
            for (const tag of node.tags ?? []) {
              const id = 'tag:' + tag
              tags.set(id, { id, path: '#' + tag, title: '#' + tag, type: 'tag' })
              edges.push({ source: node.id, target: id })
            }
          nodes = [...nodes, ...tags.values()]
        }
        if (!filter.orphans) {
          ids = new Set(edges.flatMap((edge) => [edge.source, edge.target]))
          nodes = nodes.filter((node) => ids.has(node.id))
        }
        return { nodes, edges }
      }, [graph, filter, progression])
      const button = (name, label, callback, cls) =>
        h(
          'button',
          {
            key: name,
            type: 'button',
            className: 'clickable-icon ' + cls,
            title: label,
            'aria-label': label,
            onClick: callback,
          },
          icon(name),
        )
      const section = (id, label, content) =>
        h(
          'div',
          { key: id, className: 'graph-control-section mod-' + id },
          h(
            'button',
            {
              className: 'tree-item-self',
              type: 'button',
              'aria-expanded': !!expanded[id],
              onClick: () => setExpanded((value) => ({ ...value, [id]: !value[id] })),
            },
            icon(expanded[id] ? 'down' : 'right'),
            h('span', { className: 'graph-control-section-header' }, label),
          ),
          expanded[id] && h('div', { className: 'tree-item-children' }, content),
        )
      const toggle = (label, checked, change, disabled = false) =>
        h(
          'label',
          { key: label, className: 'setting-item mod-toggle' },
          h('span', { className: 'setting-item-name' }, label),
          h(
            'span',
            { className: 'checkbox-container' + (checked ? ' is-enabled' : '') },
            h('input', {
              type: 'checkbox',
              checked,
              disabled,
              'aria-label': label,
              onChange: (event) => change(event.target.checked),
            }),
          ),
        )
      const slider = (label, field, state, change, min, max, step = 'any') =>
        h(
          'label',
          { key: label, className: 'setting-item mod-slider' },
          h('span', { className: 'setting-item-name' }, label),
          h(
            'span',
            { className: 'setting-item-control' },
            h('output', null, step === 1 ? String(state[field]) : state[field].toFixed(2)),
            h('input', {
              type: 'range',
              min,
              max,
              step,
              value: state[field],
              'aria-label': label,
              onChange: (event) =>
                change((previous) => ({ ...previous, [field]: Number(event.target.value) })),
            }),
          ),
        )
      const play = () => setProgression(0)
      const reset = () => {
        setFilter(FILTER)
        setGroups(initialGroups())
        setDisplay(DISPLAY)
        setForces(FORCES)
      }
      return h(
        'div',
        { className: 'memgraph' },
        h('style', null, styles),
        h(GraphCanvas, {
          key: sessionId + ':' + scope,
          graph: filtered,
          display,
          forces,
          groups,
          active,
          visible,
          onError: setError,
        }),
        h(
          'div',
          {
            className: 'graph-controls' + (open ? '' : ' is-close'),
            role: 'region',
            'aria-label': '图谱设置',
          },
          button('close', '关闭', () => setOpen(false), 'graph-controls-button mod-close'),
          button('settings', '打开图谱设置', () => setOpen(true), 'graph-controls-button mod-open'),
          button('wand', '开始播放动画', play, 'graph-controls-button mod-animate'),
          button('reset', '恢复默认设置', reset, 'graph-controls-button mod-reset'),
          section('filter', '筛选', [
            h(
              'div',
              { className: 'setting-item mod-search-setting', key: 'search' },
              h(
                'div',
                { className: 'search-input-container' },
                icon('search'),
                h('input', {
                  type: 'search',
                  placeholder: '搜索文件…',
                  value: filter.search,
                  'aria-label': '搜索文件',
                  onChange: (event) =>
                    setFilter((value) => ({ ...value, search: event.target.value })),
                }),
              ),
            ),
            toggle('标签', filter.tags, (tags) => setFilter((value) => ({ ...value, tags }))),
            toggle('附件', false, () => {}, true),
            toggle('仅显示已创建的笔记', filter.existing, (existing) =>
              setFilter((value) => ({ ...value, existing })),
            ),
            toggle('孤立文件', filter.orphans, (orphans) =>
              setFilter((value) => ({ ...value, orphans })),
            ),
            h(
              'label',
              { className: 'setting-item', key: 'scope' },
              h('span', { className: 'setting-item-name' }, '范围'),
              h(
                'select',
                {
                  value: scope,
                  style: { width: 108 },
                  'aria-label': '图谱范围',
                  onChange: (event) => setScope(event.target.value),
                },
                h('option', { value: 'all' }, '全部记忆'),
                h('option', { value: 'project' }, '当前项目'),
              ),
            ),
          ]),
          section('color-groups', '颜色组', [
            ...groups.map((group, index) =>
              h(
                'div',
                {
                  key: index,
                  className: 'graph-color-group',
                  draggable: true,
                  onDragStart: (event) => event.dataTransfer.setData('text/plain', String(index)),
                  onDragOver: (event) => event.preventDefault(),
                  onDrop: (event) => {
                    event.preventDefault()
                    const from = Number(event.dataTransfer.getData('text/plain'))
                    if (!Number.isInteger(from) || from < 0 || from >= groups.length) return
                    setGroups((value) => {
                      const next = [...value]
                      next.splice(index, 0, ...next.splice(from, 1))
                      return next
                    })
                  },
                },
                h('input', {
                  type: 'text',
                  value: group.query,
                  placeholder: '输入查询…',
                  'aria-label': '颜色组查询 ' + (index + 1),
                  onChange: (event) =>
                    setGroups((value) =>
                      value.map((item, i) =>
                        i === index ? { ...item, query: event.target.value } : item,
                      ),
                    ),
                }),
                h('input', {
                  type: 'color',
                  value: group.color,
                  title: '点击更换颜色，拖动调整顺序',
                  'aria-label': '颜色组颜色 ' + (index + 1),
                  onChange: (event) =>
                    setGroups((value) =>
                      value.map((item, i) =>
                        i === index ? { ...item, color: event.target.value } : item,
                      ),
                    ),
                }),
                button(
                  'close',
                  '删除颜色组 ' + (index + 1),
                  () => setGroups((value) => value.filter((_, i) => i !== index)),
                  '',
                ),
              ),
            ),
            h(
              'div',
              { key: 'new', className: 'graph-color-button-container' },
              h(
                'button',
                {
                  type: 'button',
                  className: 'mod-cta',
                  onClick: () => setGroups((value) => [...value, { query: '', color: '#8a5cf5' }]),
                },
                '新建颜色组',
              ),
            ),
          ]),
          section('display', '外观', [
            toggle('箭头', display.arrows, (arrows) =>
              setDisplay((value) => ({ ...value, arrows })),
            ),
            slider('文本透明度', 'text', display, setDisplay, -3, 3, 0.1),
            slider('标题文字大小', 'label', display, setDisplay, 0.4, 1.6, 0.05),
            slider('节点大小', 'size', display, setDisplay, 0.1, 5),
            slider('连线粗细', 'width', display, setDisplay, 0.1, 5),
            h(
              'div',
              { className: 'setting-item mod-playback', key: 'play' },
              h('button', { type: 'button', className: 'mod-cta', onClick: play }, '播放动画'),
            ),
          ]),
          section('forces', '力度', [
            slider('图谱向心力', 'center', forces, setForces, 0, 1),
            slider('节点间的排斥力', 'repel', forces, setForces, 0, 20),
            slider('相连节点间的吸引力', 'link', forces, setForces, 0, 1),
            slider('连线长度', 'distance', forces, setForces, 30, 500, 1),
          ]),
        ),
        error && h('div', { className: 'graph-message error', role: 'status' }, error),
        !error &&
          graph.truncated === true &&
          graph.total > graph.nodes.length &&
          h(
            'div',
            { className: 'graph-truncated', role: 'status' },
            '仅显示前 ' +
              graph.nodes.length +
              ' 个节点；共有 ' +
              graph.total +
              ' 个，按连接数优先。',
          ),
        !error &&
          graph.nodes.length === 0 &&
          h(
            'div',
            { className: 'graph-message', role: 'status' },
            !sessionId
              ? '打开一个会话以查看记忆图谱'
              : graph.unbound
                ? '当前项目尚未绑定记忆'
                : '暂无记忆',
          ),
      )
    }

    // The 记忆 panel shell: a compact masthead, a persistent search box, a
    // folder-form tab strip, then the one mounted view body. The strip lives
    // here so the tab stays usable while the served module loads; the masthead
    // lives here because the project identity and the freshness clock are the
    // same on every view; the search box lives here because 检索 is no longer a
    // tab — it is one shell-level field whose submit swaps the body for the
    // results page and whose Esc/clear returns to the last tab (design §3.1).
    // Views report their read state through onMeta, and the shell's refresh
    // bumps a key the polling views watch — one refresh action, no second poll.
    const MEMORY_VIEWS = [
      { id: 'overview', label: '概览', icon: 'overview' },
      { id: 'graph', label: '图谱', icon: 'graph' },
      { id: 'health', label: '健康', icon: 'health' },
    ]

    // The search state the shell owns: one object, or null when the body is a
    // tab. `limit` starts at the view's first-page size; the results page raises
    // it itself through `更多`.
    const SEARCH_DEFAULTS = { query: '', scope: 'project', type: null, status: null, limit: 25 }

    function injectPanelCss() {
      // One <head> sheet per page, deduped by selector: the host remounts this
      // tab on every load, and re-parsing the sheet each remount is the cost the
      // graph styles already pay.
      if (typeof document === 'undefined') return
      if (document.querySelector('style[data-plugin-css="dsh-obsidian-mem/panel"]') !== null) return
      const style = document.createElement('style')
      style.setAttribute('data-plugin-css', 'dsh-obsidian-mem/panel')
      style.textContent = PANEL_CSS
      document.head.appendChild(style)
    }

    function PanelNotice({ kind, children, retry }) {
      return h(
        'div',
        {
          className: 'mem-notice' + (kind === 'loading' ? '' : ' is-' + kind),
          role: kind === 'error' ? 'alert' : 'status',
          'aria-live': kind === 'error' ? undefined : 'polite',
        },
        h('span', null, children),
        retry
          ? h('button', { type: 'button', className: 'mem-btn', onClick: retry }, '重试')
          : null,
      )
    }

    const mastheadClock = (value) => {
      const stamp = Number(value)
      if (!Number.isFinite(stamp) || stamp <= 0) return '数据截至 —'
      const date = new Date(stamp)
      return (
        '数据截至 ' +
        String(date.getHours()).padStart(2, '0') +
        ':' +
        String(date.getMinutes()).padStart(2, '0')
      )
    }

    // The masthead is the project's identity and the panel's one freshness
    // readout: a compact three-row header — name + binding stamp, vault line,
    // clock + icon refresh. The clock is withheld when no view has reported and
    // the current tab has no poll, so 图谱/检索 cannot show a permanent reading
    // state that will never resolve.
    function Masthead({ meta, onRefresh }) {
      const project = meta?.project ?? null
      const bound = project === null ? null : project.state === 'bound'
      const name = project?.name ? String(project.name) : '项目记忆'
      const detail = [
        project?.vault?.basename ? 'vault ' + project.vault.basename : null,
        project?.projectId ? 'projectId ' + String(project.projectId).slice(0, 8) : null,
      ]
        .filter(Boolean)
        .join(' · ')
      const hasClock = meta !== null || onRefresh !== null
      let clock = '正在读取…'
      if (meta !== null) {
        if (meta.error) clock = '读取失败'
        else if (meta.updatedAt > 0) clock = mastheadClock(meta.updatedAt)
        else if (!meta.loading) clock = '数据截至 —'
      }
      return h(
        'header',
        { className: 'mem-masthead' },
        h(
          'div',
          { className: 'mem-masthead-top' },
          h('h2', { className: 'mem-masthead-name mem-display' }, name),
          bound === null
            ? null
            : h(
                'span',
                { className: 'mem-stamp' + (bound ? ' is-ok' : ' is-warn') },
                bound ? '已绑定' : '未绑定',
              ),
        ),
        detail ? h('span', { className: 'mem-masthead-sub' }, detail) : null,
        h(
          'div',
          { className: 'mem-masthead-meta' },
          hasClock ? h('span', { className: 'mem-clock' }, clock) : null,
          onRefresh
            ? h(
                'button',
                {
                  type: 'button',
                  className: 'mem-refresh',
                  onClick: onRefresh,
                  title: '刷新记忆数据',
                  'aria-label': '刷新记忆数据',
                },
                icon('refresh'),
              )
            : null,
        ),
      )
    }

    function MemoryTabs({ value, change }) {
      const refs = React.useRef([])
      const press = (event, index) => {
        const last = MEMORY_VIEWS.length - 1
        let next = null
        if (event.key === 'ArrowRight') next = index === last ? 0 : index + 1
        else if (event.key === 'ArrowLeft') next = index === 0 ? last : index - 1
        else if (event.key === 'Home') next = 0
        else if (event.key === 'End') next = last
        if (next === null) return
        event.preventDefault()
        change(MEMORY_VIEWS[next].id)
        refs.current[next]?.focus()
      }
      return h(
        'div',
        { className: 'mem-tabs', role: 'tablist', 'aria-label': '记忆视图' },
        MEMORY_VIEWS.map((view, index) =>
          h(
            'button',
            {
              key: view.id,
              ref: (node) => {
                refs.current[index] = node
              },
              type: 'button',
              role: 'tab',
              id: 'obsidian-mem-tab-' + view.id,
              'aria-selected': value === view.id,
              'aria-controls': 'obsidian-mem-panel',
              tabIndex: value === view.id ? 0 : -1,
              className: 'mem-tab',
              onClick: () => change(view.id),
              onKeyDown: (event) => press(event, index),
            },
            h('span', { className: 'mem-tab-icon', 'aria-hidden': true }, icon(view.icon)),
            h('span', { className: 'mem-tab-label' }, view.label),
          ),
        ),
      )
    }

    function MemoryPanel({ sessionId, visible }) {
      const [view, setView] = React.useState('overview')
      // `search` is null while the body is a tab; an object means the body is the
      // results page. The box keeps its text in `draft`, which survives entering
      // search mode — the field is never cleared just because a run started.
      const [search, setSearch] = React.useState(null)
      const [draft, setDraft] = React.useState('')
      const [views, setViews] = React.useState(null)
      const [failure, setFailure] = React.useState('')
      const [attempt, setAttempt] = React.useState(0)
      const [meta, setMeta] = React.useState(null)
      const [refreshKey, setRefreshKey] = React.useState(0)
      // The caret target for a view's jump: the field lives in SearchBox, but its
      // node ref is owned here so "去检索" can focus it without a second input.
      const searchField = React.useRef(null)
      const report = React.useRef(null)
      if (report.current === null) report.current = (next) => setMeta(next)
      React.useEffect(() => injectPanelCss(), [])
      React.useEffect(() => {
        if (!visible) return undefined
        let live = true
        void import('/obsidian-mem/memory-panel.js')
          .then((module) => {
            if (live) setViews(module.createMemoryViews({ React }))
          })
          .catch(() => {
            if (live) setFailure('记忆面板模块无法加载；刷新页面后重试')
          })
        return () => {
          live = false
        }
      }, [visible, attempt])
      const retry = () => {
        setFailure('')
        setAttempt((count) => count + 1)
      }
      // The search field is a shell control with three exits: Esc, the clear
      // button, or any tab. Leaving search mode is one operation here, so there is
      // exactly one place that can drop back to a tab; the clear button (and Esc,
      // matching a native search input) also empties the field, while a tab click
      // keeps the typed text so pressing Enter again repeats the search.
      const leaveSearch = () => setSearch(null)
      const clearSearch = () => {
        setSearch(null)
        setDraft('')
      }
      const submitSearch = (text) => {
        const query = String(text ?? '').trim()
        // An empty query is not a search: no request, no mode change (design §6.3).
        if (query === '') return
        setSearch({ ...SEARCH_DEFAULTS, query })
      }
      const chooseView = (next) => {
        leaveSearch()
        setView(next)
      }
      // A view's jump keeps its meaning without the retired 检索 tab: 概览's
      // "去检索" targets the new search box, so it puts the caret there rather than
      // opening a second input (design §3.4 keeps the jump semantics).
      const jump = (target) => {
        if (target === 'search') {
          searchField.current?.focus?.()
          return
        }
        leaveSearch()
        setView(target)
      }
      // The 检索 page owns its submit action and the graph polls itself, so
      // the masthead refresh belongs to the two polling reads only.
      const polling = view === 'overview' || view === 'health'
      let content
      if (!sessionId) content = h(PanelNotice, { kind: 'empty' }, '打开一个会话以查看记忆')
      else if (search !== null)
        content =
          views === null
            ? failure
              ? h(PanelNotice, { kind: 'error', retry }, failure)
              : h(PanelNotice, { kind: 'loading' }, '正在读取记忆…')
            : h(views.SearchView, {
                sessionId,
                query: search.query,
                scope: search.scope,
                type: search.type,
                status: search.status,
                limit: search.limit,
                visible,
                onClose: leaveSearch,
              })
      else if (view === 'graph') content = h(GraphView, { sessionId, visible })
      else if (views === null)
        content = failure
          ? h(PanelNotice, { kind: 'error', retry }, failure)
          : h(PanelNotice, { kind: 'loading' }, '正在读取记忆…')
      else if (view === 'overview')
        content = h(views.OverviewView, {
          sessionId,
          visible,
          onJump: jump,
          onMeta: report.current,
          refreshKey,
        })
      else
        content = h(views.HealthView, {
          sessionId,
          visible,
          onJump: jump,
          onMeta: report.current,
          refreshKey,
        })
      return h(
        'div',
        { className: 'mem-panel' },
        h(Masthead, {
          meta,
          onRefresh: polling ? () => setRefreshKey((count) => count + 1) : null,
        }),
        h(SearchBox, {
          fieldRef: searchField,
          value: draft,
          onDraft: setDraft,
          onSubmit: submitSearch,
          onClear: clearSearch,
        }),
        h(MemoryTabs, { value: view, change: chooseView }),
        h(
          'div',
          {
            className: 'mem-view',
            role: 'tabpanel',
            id: 'obsidian-mem-panel',
            'aria-labelledby': 'obsidian-mem-tab-' + view,
            tabIndex: 0,
          },
          content,
        ),
      )
    }

    // The shell's one search field. It is deliberately dumb: the draft text and the
    // search state belong to MemoryPanel, so leaving search mode is a single shell
    // decision and the box can never grow a second state of its own. The input's
    // ref is passed in (`fieldRef`) so the shell's own tab jumps can put the caret
    // here without owning a second field.
    function SearchBox({ fieldRef, value, onDraft, onSubmit, onClear }) {
      const clear = () => {
        onClear()
        fieldRef.current?.focus?.()
      }
      return h(
        'form',
        {
          className: 'mem-searchbar',
          role: 'search',
          onSubmit: (event) => {
            event.preventDefault()
            onSubmit(value)
          },
        },
        h(
          'div',
          { className: 'mem-search-field' },
          h('span', { className: 'mem-search-icon', 'aria-hidden': true }, icon('search')),
          h('input', {
            type: 'search',
            className: 'mem-search-input',
            ref: fieldRef,
            value,
            placeholder: '搜索记忆…',
            'aria-label': '搜索记忆',
            onChange: (event) => onDraft(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Escape') {
                event.preventDefault()
                onClear()
              }
            },
          }),
          value.trim() === ''
            ? null
            : h(
                'button',
                {
                  type: 'button',
                  className: 'mem-search-clear',
                  title: '清空搜索',
                  'aria-label': '清空搜索',
                  onClick: clear,
                },
                icon('close'),
              ),
        ),
        h(
          'button',
          { type: 'submit', className: 'mem-search-submit', 'aria-label': '检索' },
          '检索',
        ),
      )
    }

    return {
      inject: ['betterSidebar'],
      apply(ctx) {
        ctx.effect(() =>
          ctx.betterSidebar.registerTab({
            id: 'obsidian-mem:graph',
            title: '记忆',
            description: '项目的记忆：概览、图谱、检索与健康',
            icon: (size) =>
              h(
                'svg',
                {
                  width: size,
                  height: size,
                  viewBox: '0 0 24 24',
                  fill: 'none',
                  stroke: 'currentColor',
                  strokeWidth: 1.7,
                },
                h('path', { d: 'M6 9v6M8.6 7.5l6.8 4M8.6 16.5l6.8-4' }),
                ...[
                  [6, 6],
                  [6, 18],
                  [18, 12],
                ].map(([cx, cy]) => h('circle', { key: cx + ':' + cy, cx, cy, r: 3 })),
              ),
            order: 35,
            single: true,
            component: (props) =>
              h(MemoryPanel, { sessionId: props.scope?.sessionId, visible: props.visible }),
          }),
        )
      },
    }
  },
})
