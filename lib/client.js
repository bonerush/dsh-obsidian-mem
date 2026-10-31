/* global window, document */
// Source contracts and measured theme values: docs/obsidian-graph-source.md.
window.__ModuleLoader__.load({
  id: 'dsh-obsidian-mem',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    // This asset is served on its own, so the zh/en rule lives inline instead of
    // importing lib/locale.js. It mirrors that module: the first zh/en tag in the
    // browser's preference wins; outside a browser the source locale stays zh, so
    // every default render is byte-identical to the Chinese one.
    function detectLocale() {
      // Node ships a global navigator since v21 (language "en-US"), but the
      // DOM-less test harness is not a browser: no window means the source
      // locale, so every existing Chinese test assertion keeps its language.
      if (typeof window === 'undefined') return 'zh'
      const tags =
        typeof navigator === 'undefined'
          ? []
          : Array.isArray(navigator.languages) && navigator.languages.length > 0
            ? navigator.languages
            : typeof navigator.language === 'string'
              ? [navigator.language]
              : []
      for (const tag of tags) {
        const base = String(tag).trim().toLowerCase().split(/[-_]/u)[0]
        if (base === 'zh') return 'zh'
        if (base === 'en') return 'en'
      }
      return tags.length > 0 ? 'en' : 'zh'
    }
    const locale = detectLocale()
    // One-off copy: the shell has no keyed catalog, so each string is paired here
    // at its use. The Chinese literal stays visible for the source-shape tests.
    const t = (zh, en) => (locale === 'en' ? en : zh)
    const quantity = (count, one, many) => count + ' ' + (count === 1 ? one : many)
    // The renderer writes the canvas aria-label after load; this is the fallback
    // before it does, kept as one binding so the element stays a single line.
    const CANVAS_ARIA = t('可缩放的记忆关系图谱', 'Zoomable memory graph')
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
      '.memgraph .graph-count{position:absolute;left:12px;right:12px;bottom:10px;text-align:center;color:var(--label-tertiary);font-size:12px;pointer-events:none;font-variant-numeric:tabular-nums}',
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
      // The top bar is the tab strip. `mem-tabbar` is the row, `mem-tabs` the
      // tablist inside it; the meta (freshness + refresh) sits at the tail so the
      // panel opens on its tabs instead of on a repeated project header.
      '.mem-panel .mem-tabbar{display:flex;flex:0 0 auto;align-items:flex-end;justify-content:space-between;gap:8px;min-width:0;padding:8px 14px 0;background:var(--dsw-alias-bg-layer-1);border-bottom:1px solid var(--dsw-alias-border-l1)}',
      '.mem-panel .mem-tabbar-meta{display:flex;flex:none;align-items:center;gap:2px;padding-bottom:1px;min-height:28px}',
      '.mem-panel .mem-clock{font:var(--dsw-font-xxxs-11);line-height:1.6;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.mem-panel .mem-refresh{display:inline-flex;flex:0 0 auto;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;transition:background-color 150ms ease,color 150ms ease}',
      '.mem-panel .mem-refresh:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '.mem-panel .mem-refresh svg{width:15px;height:15px}',
      '.mem-panel .mem-stamp{display:inline-flex;flex:none;align-items:center;gap:4px;min-height:19px;padding:0 7px;border:1px solid var(--dsw-alias-border-l1);border-radius:16px;font:var(--dsw-font-xxxs-strong-11);line-height:1;color:var(--dsw-alias-label-secondary);white-space:nowrap;font-variant-numeric:tabular-nums}',
      '.mem-panel .mem-stamp.is-ok{color:var(--dsw-alias-state-success-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 45%,transparent)}',
      '.mem-panel .mem-stamp.is-warn{color:var(--dsw-alias-state-warn-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 45%,transparent)}',
      '.mem-panel .mem-stamp.is-err{color:var(--dsw-alias-state-error-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 45%,transparent)}',
      // The tab strip is the Chrome form, sized up for this panel: separate leaves
      // with a 2px gap (the old folded-folder -8px overlap read cramped at every
      // width), 36px tall, 14px side padding and a 16px glyph. The 44px click target
      // is the leaf plus the strip's 8px top padding (`.mem-tab::after`, 8px above the
      // leaf). The active leaf keeps its bottom border erased and a -1px overhang so
      // it merges with the content surface below; the icon collapses under the 360px
      // container query instead of letting the leaves overflow.
      '.mem-panel .mem-tabs{display:flex;flex-wrap:nowrap;flex:0 1 auto;align-items:flex-end;gap:2px;min-width:0}',
      '.mem-panel .mem-tab{position:relative;display:flex;flex:0 1 auto;align-items:center;justify-content:center;gap:6px;height:36px;min-width:0;max-width:180px;margin-bottom:-1px;padding:0 14px;border:1px solid var(--dsw-alias-border-l1);border-bottom-color:transparent;border-radius:10px 10px 0 0;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font:var(--dsw-font-xxs-strong-12);line-height:1;white-space:nowrap;cursor:pointer;z-index:0;transition:background-color 150ms ease,color 150ms ease}',
      '.mem-panel .mem-tab::after{content:"";position:absolute;left:0;right:0;top:-8px;bottom:0}',
      '.mem-panel .mem-tab:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '.mem-panel .mem-tab[aria-selected="true"]{z-index:2;background:var(--dsw-alias-bg-base);border-color:var(--dsw-alias-border-l1);border-bottom-color:var(--dsw-alias-bg-base);box-shadow:var(--dsw-shadow-lv1);color:var(--dsw-alias-label-primary)}',
      '.mem-panel .mem-tab-icon{display:inline-flex;flex:0 0 auto;align-items:center;justify-content:center;width:16px;height:16px}',
      '.mem-panel .mem-tab-icon svg{width:16px;height:16px}',
      '.mem-panel .mem-tab-label{overflow:hidden;text-overflow:ellipsis}',
      // The body's top inset is 8px, not the 18px the first round shipped: with the
      // search row's 10px bottom padding that is the 18px the shell spends between the
      // search field and the first content (users asked for 16-20px). The horizontal
      // 14px is load-bearing — the 320px floor's content box (292px) and the heat-map
      // cell arithmetic are measured from it — and the 32px bottom keeps the last chart
      // clear of the scroll edge.
      '.mem-panel .mem-view{flex:1;overflow:auto;padding:8px 14px 32px;scrollbar-width:thin;scrollbar-color:color-mix(in srgb,var(--dsw-alias-label-secondary) 35%,transparent) transparent}',
      '.mem-panel .mem-view::-webkit-scrollbar{width:8px;height:8px}',
      '.mem-panel .mem-view::-webkit-scrollbar-thumb{background:color-mix(in srgb,var(--dsw-alias-label-secondary) 35%,transparent);border-radius:16px}',
      '.mem-panel .mem-view::-webkit-scrollbar-track{background:transparent}',
      '.mem-panel .mem-ledger{display:flex;flex-direction:column}',
      '.mem-panel .mem-ledger>*{animation:mem-enter 160ms cubic-bezier(.2,.7,.3,1) both}',
      '.mem-panel .mem-ledger>:nth-child(2){animation-delay:20ms}.mem-panel .mem-ledger>:nth-child(3){animation-delay:40ms}.mem-panel .mem-ledger>:nth-child(4){animation-delay:60ms}.mem-panel .mem-ledger>:nth-child(5){animation-delay:80ms}',
      '@keyframes mem-enter{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:translateY(0)}}',
      '@media (prefers-reduced-motion:reduce){.mem-panel .mem-ledger>*{animation:none}.mem-panel .mem-tab,.mem-panel .mem-refresh,.mem-panel .mem-btn,.mem-panel .mem-action,.mem-panel .mem-search-submit,.mem-panel .mem-filter-option{transition:none}}',
      '.mem-panel .mem-viewhead{display:flex;flex-wrap:wrap;align-items:baseline;justify-content:space-between;gap:2px 8px;padding:2px 0 10px;border-bottom:1px solid var(--dsw-alias-border-l1)}',
      '.mem-panel .mem-viewhead-title{margin:0;font:var(--dsw-font-s-strong-14);line-height:1.3;letter-spacing:0;white-space:nowrap}',
      '.mem-panel .mem-viewhead-meta{margin-left:auto;font:var(--dsw-font-xxxs-11);line-height:1.6;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;text-align:right}',
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
      // The per-mutation outcome line: a success is drawn in the section that owns the
      // action (hot/digest/queue), not only in the page-top notice — the top of a long
      // 健康 page is off-screen while the reader stands at the card (the reported
      // "看不到痕迹"). Errors may still use the top notice; this line can carry either.
      '.mem-panel .mem-action-result{margin:0;padding-top:8px;font:var(--dsw-font-xxs-12);line-height:1.6;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}',
      '.mem-panel .mem-action-result.is-error{color:var(--dsw-alias-state-error-primary)}',
      // Whether the hot file has crossed its trigger line: compact is a deliberate no-op
      // below it, so the reader is told before clicking, in the action's own row.
      '.mem-panel .mem-hot-state{font:var(--dsw-font-xxxs-11);line-height:1.6;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary)}',
      '.mem-panel .mem-hot-state.is-ok{color:var(--dsw-alias-state-success-primary)}',
      '.mem-panel .mem-hot-state.is-warn{color:var(--dsw-alias-state-warn-primary)}',
      '.mem-panel .mem-kpiline{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));margin-top:14px;overflow:hidden;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1)}',
      // The KPI band's 14px top margin is the STANDALONE separation from a view head
      // or project card. The shell mounts 概览 with `onMeta`, which suppresses both
      // (the tab already names the page), so the band is the first thing the body
      // paints — and the 14px then doubles the body inset. One owner for that inset is
      // enough: the search row's 10px plus the body's 8px is the 18px every view spends
      // between the search field and its first content. Zero the margin only for a
      // ledger's first block; standalone keeps 14px because its view head precedes the
      // blocks, so the first `.mem-block` is not a `:first-child`.
      '.mem-panel .mem-view>.mem-ledger>.mem-block:first-child>.mem-kpiline{margin-top:0}',
      // The four cells are equal quarters of the band, so each cell's rows are centred
      // on its own centre line instead of hugging the left edge: at 659px the left-aligned
      // 记忆条目 reading used 70px of its 137px content box and the quarter read as an
      // empty column with a number in its corner. The quarter dividers still do the
      // grouping; centring only moves the reading.
      '.mem-panel .mem-kpi{display:flex;flex-direction:column;align-items:center;gap:3px;padding:10px 10px 12px}',
      '.mem-panel .mem-kpi+.mem-kpi{border-left:1px solid var(--dsw-alias-border-l1)}',
      '.mem-panel .mem-kpi-label{font:var(--dsw-font-xxxs-11);line-height:1.5;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.mem-panel .mem-kpi-line{display:flex;align-items:baseline;gap:3px;min-width:0}',
      // The sparkline is its own row under the value: inline in the value's line it
      // either overlapped the digits or was squeezed to a hairline, because that line
      // already holds a 26px number plus its unit. It may use the cell up to 120px and
      // stops there — a 14px-tall shape stretched across a 137px quarter reads as a
      // rule, and the cell's centre line (align-items:center above) centres it.
      '.mem-panel .mem-kpi-spark{display:block;width:100%;max-width:120px;height:14px;margin-top:5px;color:var(--dsw-alias-state-business-primary);opacity:.9}',
      '.mem-panel .mem-kpi-value{font-size:26px;font-weight:600;line-height:1;letter-spacing:0;font-variant-numeric:tabular-nums}',
      '.mem-panel .mem-kpi-unit{font:var(--dsw-font-xxxs-11);line-height:1.5;color:var(--dsw-alias-label-secondary)}',
      '.mem-panel .mem-summary{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:1px;margin-top:10px;overflow:hidden;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-border-l1)}',
      '.mem-panel .mem-summary-item{display:flex;flex-direction:column;gap:2px;justify-content:center;min-height:44px;padding:10px 12px;border:0;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);text-align:left}',
      '.mem-panel .mem-summary-value{font:var(--dsw-font-xxs-strong-12);line-height:1.5;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary)}',
      '.mem-panel .mem-summary-value.is-warn{color:var(--dsw-alias-state-warn-primary)}',
      '.mem-panel .mem-summary-value.is-err{color:var(--dsw-alias-state-error-primary)}',
      '.mem-panel .mem-section{margin-top:0}',
      // The view body stacks one block per chart, and `mem-block` is that stacking
      // slot. The rhythm lives on the slot, not on the section: an earlier version put
      // `margin-top` on the section and then zeroed it for the first child of every
      // block, which — since each block holds exactly one section — removed the gap
      // between every pair of blocks and left the charts sitting on each other's
      // shoulders. A flex column with a gap cannot collapse its margins at all, so
      // the spacing is one number here instead of a margin that may or may not apply.
      '.mem-panel .mem-block{display:block;margin-top:24px}',
      '.mem-panel .mem-block:first-child{margin-top:0}',
      // A section head is a title and a reading on one line, and at 320px they cannot
      // both have it: the flex row kept both children at `flex-shrink:1` with
      // `white-space:normal`, so "活动热度" wrapped to "活动热/度" and the meta wrapped
      // too (measured with the Range API at 280/300/320 — two line boxes each, one
      // from 340 up). The fix is to let the ROW wrap instead of the words: the title
      // never breaks inside itself, and when both do not fit the reading drops to its
      // own line, right-aligned so it still reads as the head's tail. The view head
      // is the same shape and gets the same rule (健康's viewhead carries a long meta).
      '.mem-panel .mem-section-head{display:flex;flex-wrap:wrap;align-items:baseline;justify-content:space-between;gap:2px 8px;padding-bottom:8px;border-bottom:1px solid var(--dsw-alias-border-l1)}',
      '.mem-panel .mem-section-head h2{margin:0;font:var(--dsw-font-xxs-strong-12);line-height:1.5;letter-spacing:0;color:var(--dsw-alias-label-secondary);white-space:nowrap}',
      '.mem-panel .mem-section-meta{margin-left:auto;font:var(--dsw-font-xxxs-11);line-height:1.5;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}',
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
      // 最近变化 is GitHub's contribution-activity rail: one continuous hairline through
      // a 12px node column, filled accent nodes ringed in the page background, and each
      // day's items as 6px dots under its date. The rail is one pseudo-element per group
      // spanning top:0..bottom:0, so consecutive groups join without a seam; the first
      // group starts it at its node instead of above it.
      '.mem-panel .mem-timeline{list-style:none;margin:0;padding:0}',
      '.mem-panel .mem-timeline-group{position:relative;display:grid;grid-template-columns:12px minmax(0,1fr);gap:10px;padding-top:10px}',
      '.mem-panel .mem-timeline-group:first-child{padding-top:14px}',
      // The border-l1 token resolves to only ~4% alpha on the host's light theme and
      // measured nearly invisible in the round-4 capture. A 22% label-secondary mix is
      // still token-only and reads as one continuous hairline on both themes, which is
      // what GitHub's rail looks like.
      '.mem-panel .mem-timeline-group::before{content:"";position:absolute;left:5px;top:0;bottom:0;width:1px;background:color-mix(in srgb,var(--dsw-alias-label-secondary) 22%,transparent)}',
      '.mem-panel .mem-timeline-group:first-child::before{top:6px}',
      '.mem-panel .mem-timeline-node{position:relative;z-index:1;display:flex;align-items:center;justify-content:center;width:12px;height:12px;margin-top:2px;border:2px solid var(--dsw-alias-bg-base);border-radius:16px;background:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-bg-base)}',
      '.mem-panel .mem-timeline-node svg{width:8px;height:8px}',
      '.mem-panel .mem-timeline-body{min-width:0;padding-bottom:10px}',
      '.mem-panel .mem-timeline-head{display:flex;align-items:baseline;justify-content:space-between;gap:8px}',
      '.mem-panel .mem-timeline-date{font:var(--dsw-font-xxs-strong-12);line-height:1.5;color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums}',
      '.mem-panel .mem-timeline-count{font:var(--dsw-font-xxxs-11);line-height:1.5;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}',
      '.mem-panel .mem-timeline-items{list-style:none;margin:2px 0 0;padding:0}',
      '.mem-panel .mem-timeline-item{display:grid;grid-template-columns:6px minmax(0,1fr);align-items:start;gap:8px;padding:4px 0}',
      '.mem-panel .mem-timeline-dot{width:6px;height:6px;margin-top:6px;border-radius:16px;background:var(--dsw-alias-state-business-primary)}',
      '.mem-panel .mem-timeline-main{min-width:0}',
      '.mem-panel .mem-timeline-title{display:block;font:var(--dsw-font-xxs-12);line-height:1.6;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.mem-panel .mem-timeline-meta{display:block;margin-top:1px;font:var(--dsw-font-xxxs-11);line-height:1.5;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-variant-numeric:tabular-nums}',
      // The sample hint under a busy day's count: quiet by design (the count is the
      // reading), token-only, and one line so it never competes with the items.
      '.mem-panel .mem-timeline-more{display:block;margin-top:1px;font:var(--dsw-font-xxxs-11);line-height:1.5;color:var(--dsw-alias-label-secondary)}',
      // The persistent search box is shell chrome, not a view: it sits between the
      // masthead and the tab strip so it stays visible on every page, and the
      // shell owns its state (design §3.1). One 40px rounded field, icon at the
      // leading edge, clear button at the trailing edge, submit to enter search.
      // The layout rule is shared with the results view it replaces; only the
      // direct child of the panel gets the shell's own placement, so a view that
      // still renders its own bar is not double-padded while Task 4 catches up.
      // Focus is ONE indicator on the rounded field. The input must paint none:
      // the panel-wide :focus-visible rule used to ring the square input at 2px
      // offset inside the pill, which is the measured double-ring defect.
      '.mem-panel .mem-searchbar{display:flex;align-items:center;gap:8px}',
      '.mem-panel > .mem-searchbar{flex:0 0 auto;padding:14px 14px 10px}',
      '.mem-panel .mem-search-field{display:flex;flex:1;align-items:center;gap:8px;height:40px;min-width:0;padding:0 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);cursor:text}',
      '.mem-panel .mem-search-field:focus-within{border-color:var(--dsw-alias-state-business-primary);outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:0}',
      '.mem-panel .mem-search-icon{display:inline-flex;flex:0 0 auto;align-items:center;justify-content:center;width:16px;height:16px;color:var(--dsw-alias-label-secondary)}',
      '.mem-panel .mem-search-icon svg{width:16px;height:16px}',
      '.mem-panel .mem-search-input{flex:1;height:100%;padding:0;border:0;background:transparent;color:var(--dsw-alias-label-primary);font:var(--dsw-font-xs-13);line-height:1.6}',
      '.mem-panel .mem-search-input:focus-visible{outline:none}',
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
      // The five 概览 charts. Everything is token colour and `color-mix`: a chart
      // tint is a percentage of a host token, never a hex literal, so the panel
      // follows the user's theme instead of carrying its own palette.
      // The heat map is GitHub's contribution graph in this panel's blue ramp: a FIXED
      // 10px-cell calendar on a 2px gap. Cells no longer scale with the panel — that was
      // the round-3 defect, where a narrow panel shrank them into stripes — so a panel
      // narrower than the calendar scrolls it inside .mem-heat-scroll and the page body
      // never gains a horizontal scrollbar. The view asks the route for 371 days once
      // and never refetches on resize; the canvas width is computed inline from that.
      '.mem-panel .mem-heat{position:relative;display:flex;flex-direction:column;gap:8px;padding-top:14px}',
      '.mem-panel .mem-heat-scroll{overflow-x:auto;overflow-y:hidden;scrollbar-width:thin;scrollbar-color:color-mix(in srgb,var(--dsw-alias-label-secondary) 35%,transparent) transparent}',
      '.mem-panel .mem-heat-scroll::-webkit-scrollbar{height:8px}',
      '.mem-panel .mem-heat-scroll::-webkit-scrollbar-thumb{background:color-mix(in srgb,var(--dsw-alias-label-secondary) 35%,transparent);border-radius:16px}',
      '.mem-panel .mem-heat-scroll::-webkit-scrollbar-track{background:transparent}',
      // The canvas is as wide as the whole calendar; the computed inline width is the
      // only pixel constant involved. The monts row is inset by the weekday gutter so a
      // label sits over its own column.
      '.mem-panel .mem-heat-canvas{position:relative}',
      '.mem-panel .mem-heat-months{position:relative;height:14px;margin-left:14px;overflow:hidden}',
      // GitHub's spacing rule: the first column's month, then every month change at
      // least three columns after the previous LABEL. The column offset is inline.
      '.mem-panel .mem-heat-month{position:absolute;top:0;font:var(--dsw-font-xxxs-11);line-height:1;color:var(--dsw-alias-label-secondary);white-space:nowrap}',
      '.mem-panel .mem-heat-frame{display:grid;grid-template-columns:14px auto}',
      // The weekday gutter sticks to the left edge while the calendar scrolls: after a
      // scroll to the current week it is the only thing that says which row is which,
      // and it paints the page background so cells slide underneath it.
      '.mem-panel .mem-heat-weekdays{position:sticky;left:0;display:grid;grid-template-rows:repeat(7,10px);gap:2px;padding-right:4px;background:var(--dsw-alias-bg-base);z-index:1}',
      '.mem-panel .mem-heat-weekday{font:var(--dsw-font-xxxs-11);line-height:10px;color:var(--dsw-alias-label-secondary);text-align:right}',
      '.mem-panel .mem-heat-grid{display:grid;grid-template-rows:repeat(7,10px);grid-auto-flow:column;grid-auto-columns:10px;gap:2px}',
      '.mem-panel .mem-heat-cell{display:block;width:10px;height:10px;border-radius:2px;background:color-mix(in srgb,var(--dsw-alias-label-secondary) 16%,transparent)}',
      '.mem-panel .mem-heat-cell.is-void{background:transparent}',
      '.mem-panel .mem-heat-cell.is-l1{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 28%,transparent)}',
      '.mem-panel .mem-heat-cell.is-l2{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 50%,transparent)}',
      '.mem-panel .mem-heat-cell.is-l3{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 72%,transparent)}',
      '.mem-panel .mem-heat-cell.is-l4{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 92%,transparent)}',
      // The hover tooltip is the only tooltip on the calendar (the native title was
      // dropped); the view positions it above the hovered cell, clamped to the box.
      '.mem-panel .mem-heat-tip{position:absolute;z-index:2;transform:translate(-50%,-100%);padding:4px 7px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-bg-overlay);box-shadow:var(--dsw-shadow-lv1);color:var(--dsw-alias-label-primary);font:var(--dsw-font-xxxs-11);line-height:1.5;white-space:nowrap;pointer-events:none;font-variant-numeric:tabular-nums}',
      // Legend row at the bottom: the hint on the left explains the tooltip; the
      // 少..多 ramp stays right-aligned.
      '.mem-panel .mem-heat-legend{display:flex;align-items:center;justify-content:flex-end;gap:4px;color:var(--dsw-alias-label-secondary);font:var(--dsw-font-xxxs-11);line-height:1.6}',
      '.mem-panel .mem-heat-hint{margin-right:auto}',
      '.mem-panel .mem-heat-legend-label{margin:0 2px}',
      '.mem-panel .mem-heat-swatch{display:block;width:10px;height:10px;border-radius:2px;background:color-mix(in srgb,var(--dsw-alias-label-secondary) 16%,transparent)}',
      '.mem-panel .mem-heat-swatch.is-l1{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 28%,transparent)}',
      '.mem-panel .mem-heat-swatch.is-l2{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 50%,transparent)}',
      '.mem-panel .mem-heat-swatch.is-l3{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 72%,transparent)}',
      '.mem-panel .mem-heat-swatch.is-l4{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 92%,transparent)}',
      '.mem-panel .mem-flow{display:flex;flex-direction:column;gap:10px;padding-top:14px}',
      '.mem-panel .mem-flow-svg{display:block;width:100%;height:80px}',
      '.mem-panel .mem-flow-created{fill:color-mix(in srgb,var(--dsw-alias-state-success-primary) 70%,transparent)}',
      '.mem-panel .mem-flow-updated{fill:color-mix(in srgb,var(--dsw-alias-state-business-primary) 70%,transparent)}',
      '.mem-panel .mem-flow-zero{stroke:var(--dsw-alias-border-l2);stroke-width:1;stroke-dasharray:2 2}',
      '.mem-panel .mem-flow-legend{display:flex;align-items:center;gap:5px;color:var(--dsw-alias-label-secondary);font:var(--dsw-font-xxxs-11);line-height:1.6}',
      '.mem-panel .mem-flow-swatch{display:block;width:8px;height:8px;border-radius:2px}',
      '.mem-panel .mem-flow-swatch.is-created{background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 70%,transparent)}',
      '.mem-panel .mem-flow-swatch.is-updated{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 70%,transparent)}',
      '.mem-panel .mem-flow-legend-label{margin-right:8px}',
      '.mem-panel .mem-chart-empty{margin:0;color:var(--dsw-alias-label-secondary);font:var(--dsw-font-xxs-12);line-height:1.6}',
      // 标签频率 is a squarified treemap: area is the occurrence count, so "which tags
      // dominate" is a glance instead of a scroll. The ranked bars this replaces
      // spent eight 22px rows on the same eight tags every render and hid the long
      // tail entirely; 292 x 148 shows 24 tags with their counts, and the smallest
      // tiles keep only the number (their name rides the native title and the
      // mem-sr list). Position/size are percentages set inline by the layout, so the
      // map scales with the panel while one layout unit stays one percent.
      // Colour is rank identity only, never a reading: the count is printed on
      // every tile, which is the rule the other charts follow.
      '.mem-panel .mem-treemap{position:relative;height:148px;min-height:148px;margin-top:12px;overflow:hidden;border-radius:10px;background:var(--dsw-alias-bg-layer-2)}',
      '.mem-panel .mem-treemap-tile{position:absolute;display:flex;flex-direction:column;justify-content:flex-end;gap:1px;padding:4px 5px;overflow:hidden;border:1px solid var(--dsw-alias-bg-base);border-radius:4px;color:var(--dsw-alias-label-primary)}',
      '.mem-panel .mem-treemap-tile.is-minor{justify-content:center;align-items:center;padding:0}',
      '.mem-panel .mem-treemap-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:var(--dsw-font-xxxs-strong-11);line-height:1.35}',
      '.mem-panel .mem-treemap-value{font:var(--dsw-font-xxxs-11);line-height:1.35;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}',
      '.mem-panel .mem-treemap-tile.is-rank0{background:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-bg-base)}',
      '.mem-panel .mem-treemap-tile.is-rank1{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 78%,var(--dsw-alias-bg-base))}',
      '.mem-panel .mem-treemap-tile.is-rank2{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 60%,var(--dsw-alias-bg-base))}',
      '.mem-panel .mem-treemap-tile.is-rank3{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 42%,var(--dsw-alias-bg-base))}',
      '.mem-panel .mem-treemap-tile.is-rank4{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 26%,var(--dsw-alias-bg-base))}',
      '.mem-panel .mem-treemap-tile.is-rank5{background:color-mix(in srgb,var(--dsw-alias-label-secondary) 22%,var(--dsw-alias-bg-layer-2))}',
      '.mem-panel .mem-treemap-tile.is-rank0 .mem-treemap-value{color:var(--dsw-alias-bg-base);opacity:.82}',
      // 健康 is the page where the user asks "is anything wrong?" — so it is gauges and
      // shared bars, not a ledger of `<dl>` rows. Every mark below is a length channel
      // with the number printed beside it; hue never carries a reading on its own.
      //
      // The gauge band is the 概览 KPI band's grammar applied to states: one row of
      // four cells, each a label, a value and a track whose fill repeats the ratio.
      '.mem-panel .mem-gauges{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:1px;margin-top:10px;overflow:hidden;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-border-l1)}',
      '.mem-panel .mem-gauge{display:flex;flex-direction:column;gap:3px;padding:10px 12px;background:var(--dsw-alias-bg-layer-1)}',
      '.mem-panel .mem-gauge-label{font:var(--dsw-font-xxxs-11);line-height:1.5;color:var(--dsw-alias-label-secondary)}',
      '.mem-panel .mem-gauge-value{font:var(--dsw-font-xxs-strong-12);line-height:1.5;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary)}',
      '.mem-panel .mem-gauge-track{display:block;height:4px;overflow:hidden;border-radius:16px;background:var(--dsw-alias-bg-layer-2)}',
      '.mem-panel .mem-gauge-fill{display:block;height:100%;border-radius:16px;background:var(--dsw-alias-state-business-primary)}',
      '.mem-panel .mem-gauge-fill.is-ok{background:var(--dsw-alias-state-success-primary)}',
      '.mem-panel .mem-gauge-fill.is-warn{background:var(--dsw-alias-state-warn-primary)}',
      '.mem-panel .mem-gauge-fill.is-err{background:var(--dsw-alias-state-error-primary)}',
      // The figure grid replaces the six-row definition list the 索引 card printed:
      // one row of cells instead of six text lines, the digit above its key.
      '.mem-panel .mem-figures{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:1px;margin-top:10px;overflow:hidden;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-border-l1)}',
      '.mem-panel .mem-figure{display:flex;flex-direction:column;gap:1px;padding:8px 10px;background:var(--dsw-alias-bg-layer-1)}',
      '.mem-panel .mem-figure-value{font:var(--dsw-font-xxs-strong-12);line-height:1.4;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary)}',
      '.mem-panel .mem-figure-value.is-ok{color:var(--dsw-alias-state-success-primary)}',
      '.mem-panel .mem-figure-value.is-warn{color:var(--dsw-alias-state-warn-primary)}',
      '.mem-panel .mem-figure-value.is-err{color:var(--dsw-alias-state-error-primary)}',
      '.mem-panel .mem-figure-key{font:var(--dsw-font-xxxs-11);line-height:1.4;color:var(--dsw-alias-label-secondary)}',
      // A stack bar says how a handful of counts divide one whole (queue states, hot
      // zones): segments share a single track and the legend prints each count.
      '.mem-panel .mem-stackbar{display:flex;flex-direction:column;gap:8px;margin-top:10px}',
      '.mem-panel .mem-stackbar-track{display:flex;height:8px;overflow:hidden;border-radius:16px;background:var(--dsw-alias-bg-layer-2)}',
      '.mem-panel .mem-stackbar-seg{display:block;height:100%}',
      '.mem-panel .mem-stackbar-seg+.mem-stackbar-seg{border-left:1px solid var(--dsw-alias-bg-base)}',
      '.mem-panel .mem-stackbar-legend{display:flex;flex-direction:column;gap:4px}',
      '.mem-panel .mem-stackbar-row{display:grid;grid-template-columns:minmax(0,1fr) auto auto;align-items:baseline;gap:8px;font:var(--dsw-font-xxxs-11);line-height:1.5;color:var(--dsw-alias-label-secondary)}',
      '.mem-panel .mem-stackbar-seg.is-seg0{background:var(--dsw-alias-state-business-primary)}',
      '.mem-panel .mem-stackbar-seg.is-seg1{background:color-mix(in srgb,var(--dsw-alias-label-secondary) 55%,transparent)}',
      '.mem-panel .mem-stackbar-seg.is-seg2{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 70%,transparent)}',
      '.mem-panel .mem-stackbar-seg.is-seg3{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 70%,transparent)}',
      // Named-count bars: compared against the largest row, not against the total,
      // because these rows are answers to "which one" rather than shares of one.
      '.mem-panel .mem-bars{display:flex;flex-direction:column;gap:6px;margin-top:10px}',
      '.mem-panel .mem-bar-row{display:grid;grid-template-columns:auto minmax(0,1fr) auto;align-items:center;gap:8px}',
      '.mem-panel .mem-bar-name{min-width:44px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:var(--dsw-font-xxxs-11);line-height:1.5;color:var(--dsw-alias-label-secondary)}',
      '.mem-panel .mem-bar-track{display:block;height:4px;overflow:hidden;border-radius:2px;background:color-mix(in srgb,var(--dsw-alias-label-secondary) 12%,transparent)}',
      '.mem-panel .mem-bar-value{min-width:20px;text-align:right;font:var(--dsw-font-xxxs-11);line-height:1.5;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}',
      '.mem-panel .mem-bar-fill.is-seg0{background:var(--dsw-alias-state-business-primary)}',
      '.mem-panel .mem-bar-fill.is-seg1{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 62%,var(--dsw-alias-bg-base))}',
      '.mem-panel .mem-bar-fill.is-seg2{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 38%,var(--dsw-alias-bg-base))}',
      '.mem-panel .mem-bar-fill.is-seg3{background:color-mix(in srgb,var(--dsw-alias-label-secondary) 55%,transparent)}',
      '.mem-panel .mem-bar-fill.is-seg4{background:color-mix(in srgb,var(--dsw-alias-label-secondary) 38%,transparent)}',
      '.mem-panel .mem-bar-fill.is-seg5{background:color-mix(in srgb,var(--dsw-alias-label-secondary) 22%,transparent)}',
      '.mem-panel .mem-comp-dot.is-seg0{background:var(--dsw-alias-state-business-primary)}',
      '.mem-panel .mem-comp-dot.is-seg1{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 62%,var(--dsw-alias-bg-base))}',
      '.mem-panel .mem-comp-dot.is-seg2{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 38%,var(--dsw-alias-bg-base))}',
      '.mem-panel .mem-comp-dot.is-seg3{background:color-mix(in srgb,var(--dsw-alias-label-secondary) 55%,transparent)}',
      '.mem-panel .mem-comp-dot.is-seg4{background:color-mix(in srgb,var(--dsw-alias-label-secondary) 38%,transparent)}',
      '.mem-panel .mem-comp-dot.is-seg5{background:color-mix(in srgb,var(--dsw-alias-label-secondary) 22%,transparent)}',
      '.mem-panel .mem-comp-status{display:flex;align-items:baseline;gap:6px;padding-top:6px;border-top:1px solid var(--dsw-alias-border-l1)}',
      '.mem-panel .mem-comp-status-label{font:var(--dsw-font-xxxs-11);line-height:1.6;color:var(--dsw-alias-label-secondary)}',
      '.mem-panel .mem-comp-status-value{font:var(--dsw-font-xxxs-11);line-height:1.6;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}',
      // 构成: a type->status Sankey. Links are filled closed bands, never strokes, so
      // a band's thickness is its joint count on the same scale as the node heights it
      // connects (numbers = geometry). The 6-tint palette is the chart palette the other
      // 概览 charts already use; flat fills only, and no new host token.
      // The chart's coordinate width is the measured block width (the viewBox is set
      // from it), so it fills a wide panel while its 11px type stays 1:1; the fixed
      // 200px height is the vertical coordinate space, not a cap on the width.
      '.mem-panel .mem-sankey{display:block;width:100%}',
      '.mem-panel .mem-sankey-svg{display:block;width:100%;height:200px}',
      '.mem-panel .mem-sankey-node{fill:var(--dsw-alias-label-dimmed)}',
      // 72%, not 55: the 55% neutral is the type palette's `is-seg3` tint, and a status
      // column that shares a type's fill reads as another type instead of the other end
      // of the flow.
      '.mem-panel .mem-sankey-node.is-status{fill:color-mix(in srgb,var(--dsw-alias-label-secondary) 72%,transparent)}',
      '.mem-panel .mem-sankey-node.is-seg0{fill:var(--dsw-alias-state-business-primary)}',
      '.mem-panel .mem-sankey-node.is-seg1{fill:color-mix(in srgb,var(--dsw-alias-state-business-primary) 62%,var(--dsw-alias-bg-base))}',
      '.mem-panel .mem-sankey-node.is-seg2{fill:color-mix(in srgb,var(--dsw-alias-state-business-primary) 38%,var(--dsw-alias-bg-base))}',
      '.mem-panel .mem-sankey-node.is-seg3{fill:color-mix(in srgb,var(--dsw-alias-label-secondary) 55%,transparent)}',
      '.mem-panel .mem-sankey-node.is-seg4{fill:color-mix(in srgb,var(--dsw-alias-label-secondary) 38%,transparent)}',
      '.mem-panel .mem-sankey-node.is-seg5{fill:color-mix(in srgb,var(--dsw-alias-label-secondary) 22%,transparent)}',
      '.mem-panel .mem-sankey-node.is-seg6{fill:color-mix(in srgb,var(--dsw-alias-label-tertiary) 55%,transparent)}',
      '.mem-panel .mem-sankey-node.is-seg7{fill:color-mix(in srgb,var(--dsw-alias-label-tertiary) 35%,transparent)}',
      '.mem-panel .mem-sankey-link{fill:var(--dsw-alias-label-secondary);fill-opacity:.32}',
      '.mem-panel .mem-sankey-link.is-seg0{fill:var(--dsw-alias-state-business-primary);fill-opacity:.34}',
      '.mem-panel .mem-sankey-link.is-seg1{fill:color-mix(in srgb,var(--dsw-alias-state-business-primary) 62%,var(--dsw-alias-bg-base));fill-opacity:.34}',
      '.mem-panel .mem-sankey-link.is-seg2{fill:color-mix(in srgb,var(--dsw-alias-state-business-primary) 38%,var(--dsw-alias-bg-base));fill-opacity:.34}',
      '.mem-panel .mem-sankey-link.is-seg3{fill:color-mix(in srgb,var(--dsw-alias-label-secondary) 55%,transparent);fill-opacity:.34}',
      '.mem-panel .mem-sankey-link.is-seg4{fill:color-mix(in srgb,var(--dsw-alias-label-secondary) 38%,transparent);fill-opacity:.34}',
      '.mem-panel .mem-sankey-link.is-seg5{fill:color-mix(in srgb,var(--dsw-alias-label-secondary) 22%,transparent);fill-opacity:.34}',
      '.mem-panel .mem-sankey-link.is-seg6{fill:color-mix(in srgb,var(--dsw-alias-label-tertiary) 55%,transparent);fill-opacity:.34}',
      '.mem-panel .mem-sankey-link.is-seg7{fill:color-mix(in srgb,var(--dsw-alias-label-tertiary) 35%,transparent);fill-opacity:.34}',
      '.mem-panel .mem-sankey-leader{stroke:var(--dsw-alias-border-l2);stroke-width:1;fill:none}',
      '.mem-panel .mem-sankey-label{font:var(--dsw-font-xxxs-11);fill:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}',
      '.mem-panel .mem-sankey-value{font:var(--dsw-font-xxxs-strong-11);fill:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums}',
      // Two container steps, because one was measurably wrong.
      //
      // The old single step was `max-width:359px`, and it folded BOTH the glyph and the
      // KPI band at once. Measured: at 359 the glyph is hidden and three 24px labels
      // fit; at 360 the glyph comes back and eats 22px while the leaves gain only 6px,
      // so 360 was WORSE than 359 (labels 19/24 at 360 against 24/24 at 359) — a
      // 40-width band, 281-307px and 360-374px, truncated everywhere.
      //
      // The two properties are now separate steps because they cost different things.
      // Dropping the glyph is cheap and wins 22px, so it starts early (374px) and comes
      // with the leaves' tighter padding and gap: that alone clears truncation through
      // 280-374 (verified pixel by pixel over 280-480). Folding the KPI band into 2x2
      // spends a whole extra row, so it waits for 339px — below the 320px design floor
      // it is the right trade, and at 375 (the common sidebar width) the band stays four
      // across, which is what the screenshot review caught this rule breaking.
      '@container (max-width:374px){.mem-panel .mem-tab-icon{display:none}.mem-panel .mem-tab{padding:0 8px;gap:4px}.mem-panel .mem-tabs{gap:1px}}',
      '@container (max-width:339px){.mem-panel .mem-kpiline{grid-template-columns:repeat(2,minmax(0,1fr))}.mem-panel .mem-kpi:nth-child(3){border-left:0;border-top:1px solid var(--dsw-alias-border-l1)}.mem-panel .mem-kpi:nth-child(4){border-top:1px solid var(--dsw-alias-border-l1)}}',
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
        throw new Error(envelope.error?.message ?? t('图谱暂不可用', 'Graph unavailable'))
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
            renderer = createGraphRenderer(ref.current, onError, { locale })
            state.current.renderer = renderer
            renderer.update(state.current.model)
            renderer.setForces(state.current.forces)
          })
          .catch(() => {
            if (!cancelled) onError(t('图谱渲染暂不可用', 'Graph rendering unavailable'))
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
      return h('canvas', { ref, role: 'img', tabIndex: 0, 'aria-label': CANVAS_ARIA })
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
            'aria-label': t('图谱设置', 'Graph settings'),
          },
          button(
            'close',
            t('关闭', 'Close'),
            () => setOpen(false),
            'graph-controls-button mod-close',
          ),
          button(
            'settings',
            t('打开图谱设置', 'Open graph settings'),
            () => setOpen(true),
            'graph-controls-button mod-open',
          ),
          button(
            'wand',
            t('开始播放动画', 'Start animation'),
            play,
            'graph-controls-button mod-animate',
          ),
          button(
            'reset',
            t('恢复默认设置', 'Reset to defaults'),
            reset,
            'graph-controls-button mod-reset',
          ),
          section('filter', t('筛选', 'Filters'), [
            h(
              'div',
              { className: 'setting-item mod-search-setting', key: 'search' },
              h(
                'div',
                { className: 'search-input-container' },
                icon('search'),
                h('input', {
                  type: 'search',
                  placeholder: t('搜索文件…', 'Search notes…'),
                  value: filter.search,
                  'aria-label': t('搜索文件', 'Search notes'),
                  onChange: (event) =>
                    setFilter((value) => ({ ...value, search: event.target.value })),
                }),
              ),
            ),
            toggle(t('标签', 'Tags'), filter.tags, (tags) =>
              setFilter((value) => ({ ...value, tags })),
            ),
            toggle(t('附件', 'Attachments'), false, () => {}, true),
            toggle(
              t('仅显示已创建的笔记', 'Show created notes only'),
              filter.existing,
              (existing) => setFilter((value) => ({ ...value, existing })),
            ),
            toggle(t('孤立文件', 'Orphans'), filter.orphans, (orphans) =>
              setFilter((value) => ({ ...value, orphans })),
            ),
            h(
              'label',
              { className: 'setting-item', key: 'scope' },
              h('span', { className: 'setting-item-name' }, t('范围', 'Scope')),
              h(
                'select',
                {
                  value: scope,
                  style: { width: 108 },
                  'aria-label': t('图谱范围', 'Graph scope'),
                  onChange: (event) => setScope(event.target.value),
                },
                h('option', { value: 'all' }, t('全部记忆', 'All memories')),
                h('option', { value: 'project' }, t('当前项目', 'Current project')),
              ),
            ),
          ]),
          section('color-groups', t('颜色组', 'Color groups'), [
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
                  placeholder: t('输入查询…', 'Enter a query…'),
                  'aria-label': t('颜色组查询 ', 'Color group query ') + (index + 1),
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
                  title: t('点击更换颜色，拖动调整顺序', 'Click to change color; drag to reorder'),
                  'aria-label': t('颜色组颜色 ', 'Color group color ') + (index + 1),
                  onChange: (event) =>
                    setGroups((value) =>
                      value.map((item, i) =>
                        i === index ? { ...item, color: event.target.value } : item,
                      ),
                    ),
                }),
                button(
                  'close',
                  t('删除颜色组 ', 'Delete color group ') + (index + 1),
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
                t('新建颜色组', 'New color group'),
              ),
            ),
          ]),
          section('display', t('外观', 'Appearance'), [
            toggle(t('箭头', 'Arrows'), display.arrows, (arrows) =>
              setDisplay((value) => ({ ...value, arrows })),
            ),
            slider(t('文本透明度', 'Text opacity'), 'text', display, setDisplay, -3, 3, 0.1),
            slider(t('标题文字大小', 'Label size'), 'label', display, setDisplay, 0.4, 1.6, 0.05),
            slider(t('节点大小', 'Node size'), 'size', display, setDisplay, 0.1, 5),
            slider(t('连线粗细', 'Link thickness'), 'width', display, setDisplay, 0.1, 5),
            h(
              'div',
              { className: 'setting-item mod-playback', key: 'play' },
              h(
                'button',
                { type: 'button', className: 'mod-cta', onClick: play },
                t('播放动画', 'Play animation'),
              ),
            ),
          ]),
          section('forces', t('力度', 'Force'), [
            slider(t('图谱向心力', 'Center force'), 'center', forces, setForces, 0, 1),
            slider(t('节点间的排斥力', 'Repel force'), 'repel', forces, setForces, 0, 20),
            slider(t('相连节点间的吸引力', 'Link force'), 'link', forces, setForces, 0, 1),
            slider(t('连线长度', 'Link distance'), 'distance', forces, setForces, 30, 500, 1),
          ]),
        ),
        error && h('div', { className: 'graph-message error', role: 'status' }, error),
        // The graph draws every node in scope, so there is no truncation to report.
        // What a large graph needs instead is a count: the canvas caption carries it
        // (the renderer writes its own aria-label), and this line names the same fact
        // for a reader who is looking for "how many is all of it".
        !error &&
          graph.nodes.length > 0 &&
          h(
            'div',
            { className: 'graph-count', role: 'status' },
            locale === 'en'
              ? quantity(graph.nodes.length, 'node', 'nodes') +
                  ' · ' +
                  quantity(graph.edges.length, 'link', 'links') +
                  (graph.unbound ? '' : ' · All memories')
              : String(graph.nodes.length) +
                  ' 个节点 · ' +
                  String(graph.edges.length) +
                  ' 条连接' +
                  (graph.unbound ? '' : ' · 全部记忆'),
          ),
        !error &&
          graph.nodes.length === 0 &&
          h(
            'div',
            { className: 'graph-message', role: 'status' },
            !sessionId
              ? t('打开一个会话以查看记忆图谱', 'Open a session to see its memory graph')
              : graph.unbound
                ? t('当前项目尚未绑定记忆', 'This project has no memory bound yet')
                : t('暂无记忆', 'No memories yet'),
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
    // The English tab labels stay beside the list rather than inside it: the list
    // is a source-shape pin in test/panel-client.test.js, so its literals stay put.
    const VIEW_LABELS_EN = { overview: 'Overview', graph: 'Graph', health: 'Health' }
    const viewLabel = (view) => (locale === 'en' ? VIEW_LABELS_EN[view.id] : view.label)

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
          ? h(
              'button',
              { type: 'button', className: 'mem-btn', onClick: retry },
              t('重试', 'Retry'),
            )
          : null,
      )
    }

    const tabbarClock = (value) => {
      const stamp = Number(value)
      if (!Number.isFinite(stamp) || stamp <= 0) return t('数据截至 —', 'Data as of —')
      const date = new Date(stamp)
      return (
        t('数据截至 ', 'Data as of ') +
        String(date.getHours()).padStart(2, '0') +
        ':' +
        String(date.getMinutes()).padStart(2, '0')
      )
    }

    // The top bar is the strip itself: there is no separate header any more. The
    // project name and vault line it used to carry repeated what the host's own
    // sidebar already says, and a panel that is a tab strip over a body should
    // open with its tabs. What survives is the one reading no other surface gives
    // — how fresh the figures are — set small at the strip's tail beside refresh.
    //
    // The clock is still withheld when no view has reported and the current tab
    // has no poll, so 图谱 cannot show a "正在读取…" that will never resolve.
    function TabbarMeta({ meta, onRefresh }) {
      const hasClock = meta !== null || onRefresh !== null
      let clock = '正在读取…'
      if (locale === 'en') clock = 'Loading…'
      if (meta !== null) {
        if (meta.error) clock = t('读取失败', 'Could not read')
        else if (meta.updatedAt > 0) clock = tabbarClock(meta.updatedAt)
        else if (!meta.loading) clock = t('数据截至 —', 'Data as of —')
      }
      return h(
        'div',
        { className: 'mem-tabbar-meta' },
        hasClock ? h('span', { className: 'mem-clock' }, clock) : null,
        onRefresh
          ? h(
              'button',
              {
                type: 'button',
                className: 'mem-refresh',
                onClick: onRefresh,
                title: t('刷新记忆数据', 'Refresh memory data'),
                'aria-label': t('刷新记忆数据', 'Refresh memory data'),
              },
              icon('refresh'),
            )
          : null,
      )
    }

    function MemoryTabs({ value, change, meta, onRefresh }) {
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
        { className: 'mem-tabbar' },
        h(
          'div',
          { className: 'mem-tabs', role: 'tablist', 'aria-label': t('记忆视图', 'Memory view') },
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
              h('span', { className: 'mem-tab-label' }, viewLabel(view)),
            ),
          ),
        ),
        h(TabbarMeta, { meta: meta ?? null, onRefresh: onRefresh ?? null }),
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
            if (live) setViews(module.createMemoryViews({ React, locale }))
          })
          .catch(() => {
            if (live)
              setFailure(
                t(
                  '记忆面板模块无法加载；刷新页面后重试',
                  'Could not load the memory panel module; refresh the page and try again',
                ),
              )
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
      // The results page does not own the query or the filters — the box above it
      // does — so a chip asks the shell for the change, and the shell answers by
      // rewriting the one search object the view reads. That keeps a single owner
      // and makes the chip click one state change plus one read, not two runs.
      const refineSearch = (field, value) => {
        setSearch((current) => {
          if (current === null) return current
          if (field !== 'scope' && field !== 'type' && field !== 'status') return current
          return { ...current, [field]: value, limit: SEARCH_DEFAULTS.limit }
        })
      }
      // "显示更多" is the same single-owner rule as a filter: the page size lives in
      // the one search object, so the view reports the request instead of running
      // with a limit the shell does not know about. Otherwise a retry after an error
      // on a 50-row page would silently drop back to 25.
      const widenSearch = (next) => {
        setSearch((current) => (current === null ? current : { ...current, limit: next }))
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
      if (!sessionId)
        content = h(
          PanelNotice,
          { kind: 'empty' },
          t('打开一个会话以查看记忆', 'Open a session to see its memories'),
        )
      else if (search !== null)
        content =
          views === null
            ? failure
              ? h(PanelNotice, { kind: 'error', retry }, failure)
              : h(PanelNotice, { kind: 'loading' }, t('正在读取记忆…', 'Loading memories…'))
            : h(views.SearchView, {
                sessionId,
                query: search.query,
                scope: search.scope,
                type: search.type,
                status: search.status,
                limit: search.limit,
                visible,
                onFilter: refineSearch,
                onLimit: widenSearch,
                onClose: leaveSearch,
              })
      else if (view === 'graph') content = h(GraphView, { sessionId, visible })
      else if (views === null)
        content = failure
          ? h(PanelNotice, { kind: 'error', retry }, failure)
          : h(PanelNotice, { kind: 'loading' }, t('正在读取记忆…', 'Loading memories…'))
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
        h(MemoryTabs, {
          value: view,
          change: chooseView,
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
          {
            className: 'mem-search-field',
            // The icon and the padding belong to the control: a click anywhere in the
            // field puts the caret in the input. A click that starts on a button (the
            // clear control) is left alone — it owns its own focus handoff.
            onClick: (event) => {
              if (
                typeof event?.target?.closest === 'function' &&
                event.target.closest('button') !== null
              )
                return
              fieldRef.current?.focus?.()
            },
          },
          h('span', { className: 'mem-search-icon', 'aria-hidden': true }, icon('search')),
          h('input', {
            type: 'search',
            className: 'mem-search-input',
            ref: fieldRef,
            value,
            placeholder: t('搜索记忆…', 'Search memories…'),
            'aria-label': t('搜索记忆', 'Search memories'),
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
                  title: t('清空搜索', 'Clear search'),
                  'aria-label': t('清空搜索', 'Clear search'),
                  onClick: (event) => {
                    event?.stopPropagation?.()
                    clear()
                  },
                },
                icon('close'),
              ),
        ),
        h(
          'button',
          {
            type: 'submit',
            className: 'mem-search-submit',
            'aria-label': t('检索', 'Search'),
          },
          t('检索', 'Search'),
        ),
      )
    }

    return {
      inject: ['betterSidebar'],
      apply(ctx) {
        ctx.effect(() =>
          ctx.betterSidebar.registerTab({
            id: 'obsidian-mem:graph',
            title: t('记忆', 'Memory'),
            description: t(
              '项目的记忆：概览、图谱、检索与健康',
              'Project memory: overview, graph, search and health',
            ),
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
