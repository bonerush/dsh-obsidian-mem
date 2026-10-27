# Memory panel redesign — design addendum

**Status:** approved direction 2026-10-27. Implementation follows the plan.
**Base:** read-only panel at `7295de1`; 375px sidebar; DSH theme tokens.

## Problem

The current panel is a competent generic card stack. It communicates data but
does not feel like the product: a private, long-lived Markdown memory vault. The
sidebar has no masthead, every section has the same weight, and the three views
are visually interchangeable. The user asked for a deliberate UI redesign with
references from the installed DSH plugin ecosystem.

## Direction: vault ledger

One idea: **the sidebar is the index page of a private field notebook.** Not a
dashboard, not a card grid. A narrow editorial ledger with a masthead, ordinal
tabs, hairline rules, large numerals and a single ink accent. It should feel
quiet, exact, and a little archival.

Reference patterns retained from `dsh-context` (KPI band, segmented controls,
paged list), `dshmarket` (dense status rows, empty states) and the existing
graph shell (tablist/keyboard contract). The direction is not copied; only the
information-density and interaction patterns are reused.

## Visual system

- Surface: `--dsw-alias-bg-base` with a very low-contrast vertical rule/grid
  built from `color-mix` and border tokens; no image assets, no hex.
- Type: display `Iowan Old Style, Palatino, Songti SC, serif` for the project
  name and view title; body `var(--dsw-font-xxs-12)`; labels in small caps.
- Numbers: `font-variant-numeric: tabular-nums`; lead KPI 26–30px.
- Accent: business primary as ink; success/warn/error only for state.
- Borders: 1px hairlines; radius 0–4px; no floating card shadows.
- Spacing: 12/16/24 scale; 1px rules separate ledger rows.
- Motion: view entrance opacity + 4px rise, 160ms; stagger children by 20ms;
  reduced motion removes all.

## Information architecture

1. Masthead: project name, binding stamp, "last read" clock, refresh action.
2. Tab index: 01 概览 / 02 图谱 / 03 检索 / 04 健康. Keep the tablist and
   arrow/Home/End behavior.
3. Overview: KPI ledger (notes, links, orphan, pending), composition index,
   recent numbered entries, health strip.
4. Search: a single border-bottom field, underlined filter groups, numbered
   results with type stamp, source and snippet. Empty/idle states stay.
5. Health: index stamp, queue, hot meter, digest column, diagnostics ledger.
6. Confirm sheet: preview facts, explicit "确认执行" and cancel; focus trapped;
   Escape closes; disabled/absent when the API is unavailable.

## Acceptance

- 320/375/768: no horizontal overflow; tab strip remains usable.
- Keyboard: tablist arrows/Home/End; visible focus; confirm sheet focus trap.
- Contrast: text uses existing tokens; no color-only meaning.
- CSS test constraints: no hex/rgb/hsl literals; `prefers-reduced-motion` gate.
- The graph and route contracts are unchanged.
