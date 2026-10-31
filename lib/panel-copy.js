// The words the panel's three confirmation sheets show, in the two locales this
// build speaks.
//
// This module is import-free on purpose. The panel's dialog copy is a vocabulary
// leaf — like lib/hot-text.js and lib/locale.js — so the layer table can keep it
// at the bottom, and a translator can read every sentence without following a
// service or a clock. lib/panel-actions.js owns the facts and the state machine;
// this module owns the words around those facts.
//
// The zh catalog is the copy that shipped before this file existed, byte for
// byte: zh is the default locale, and the existing tests in
// test/panel-actions.test.js and test/panel-route.test.js already assert it. The
// en catalog follows the glossary in scratch/i18n-spec.md §4; the judgement calls
// beyond that glossary are noted inline.

/** Spell a count with the singular or plural English noun. */
function quantity(n, one, many) {
  return n + ' ' + (n === 1 ? one : many)
}

/** The Chinese (source) catalog: today's strings, unchanged. */
const ZH = {
  retry: {
    title: '重新排队失败任务',
    confirmLabel: '重新排队',
    labels: {
      job: '任务',
      project: '项目',
      state: '状态',
      attempts: '尝试',
      failedAt: '失败于',
      error: '错误',
    },
    unknown: '—',
    effects: ['该任务重新进入队列', '尝试次数清零', '是否立刻运行取决于宿主'],
    // The adapter difference lives in the confirmation copy: DSH can wake its
    // queue worker, Codex has no worker and only requeues until the next start.
    warning:
      'DSH 会尝试立即唤醒队列 worker 执行该任务；Codex 只重新排队，需要等下一次启动才能运行。',
  },
  hot: {
    title: '整理热层',
    confirmLabel: '整理热层',
    labels: {
      used: '使用',
      trigger: '触发线',
      movable: '可搬出',
      archivable: '可归档',
    },
    // Section names are the hot-file protocol's zone names (HOT_SECTIONS in
    // lib/hot-text.js); Chinese shows each zone exactly as the file spells it.
    sectionLabel: (name) => name,
    usedValue: (used, capacity) => used + ' / ' + capacity + ' 码点',
    triggerValue: (trigger) => trigger + ' 码点',
    sectionValue: (entries, pointers, movable) =>
      entries + ' 完整条目，' + pointers + ' 指针，可搬出 ' + movable,
    effectsBelow: ['只折叠 已完成 的旧式逐条指针行', '不会搬出条目，归档与各分区保持不变'],
    effectsAbove: (movable) => [
      '把已终止的 已完成/进行中 条目移入归档',
      '折叠 已完成 的指针行',
      '本次最多搬出 ' + movable + ' 条',
    ],
    warningBelow: (used, trigger) =>
      '热层暂未超过触发线（' + used + ' / ' + trigger + ' 码点）：本次整理不会搬出任何条目。',
  },
  digest: {
    title: '发布项目摘要',
    confirmLabel: '写入摘要',
    labels: {
      target: '目标',
      project: '项目',
      window: '窗口',
      created: '新建',
      updated: '更新',
      checked: '检查来源',
    },
    windowValue: (days) => '最近 ' + days + ' 天',
    effects: (relativeDir) => [
      '按窗口重新采集来源并渲染摘要',
      '写入 ' + relativeDir + '_meta/digest.md',
      '内容不变时不写文件',
    ],
    warning: (reasons) =>
      '采集不完整：' +
      (reasons.length === 0 ? '部分来源未读取' : reasons.join('、')) +
      '；摘要只覆盖已检查的来源。',
  },
}

// The three zone names are the hot-file protocol's own (lib/hot-text.js's
// HOT_SECTIONS); an unknown name — a future zone, or a hand-edited file — passes
// through untranslated rather than being dropped, so the row still names what the
// service reported.
const EN_SECTION_LABELS = {
  强约束: 'Strong constraints',
  进行中: 'In progress',
  已完成: 'Completed',
}

/** The English catalog. */
const EN = {
  retry: {
    title: 'Retry failed job',
    confirmLabel: 'Retry',
    labels: {
      job: 'Job',
      project: 'Project',
      state: 'Status',
      attempts: 'Attempts',
      failedAt: 'Failed at',
      error: 'Error',
    },
    unknown: '—',
    effects: [
      'The job re-enters the queue',
      'Attempts reset to zero',
      'Whether it runs immediately depends on the host',
    ],
    warning:
      'DSH tries to wake its queue worker immediately; Codex only requeues the job, so it runs at the next start.',
  },
  hot: {
    title: 'Compact hot zone',
    // The button names the verb; the title already carries the noun phrase.
    confirmLabel: 'Compact',
    labels: {
      used: 'Used',
      trigger: 'Trigger',
      movable: 'Movable',
      archivable: 'Archivable',
    },
    sectionLabel: (name) => EN_SECTION_LABELS[name] ?? name,
    usedValue: (used, capacity) => used + ' / ' + capacity + ' code points',
    triggerValue: (trigger) => trigger + ' code points',
    sectionValue: (entries, pointers, movable) =>
      quantity(entries, 'complete entry', 'complete entries') +
      ', ' +
      quantity(pointers, 'pointer', 'pointers') +
      ', ' +
      movable +
      ' movable',
    effectsBelow: [
      'Only folds legacy per-entry pointer lines in Completed',
      'No entries are archived; the archive and sections stay as they are',
    ],
    effectsAbove: (movable) => [
      'Moves terminated Completed/In progress entries into the archive',
      'Folds pointer lines in Completed',
      'Moves at most ' + quantity(movable, 'entry', 'entries') + ' this time',
    ],
    warningBelow: (used, trigger) =>
      'The hot zone is below its trigger (' +
      used +
      ' / ' +
      trigger +
      ' code points): this compact moves no entries.',
  },
  digest: {
    title: 'Publish project digest',
    confirmLabel: 'Write digest',
    labels: {
      target: 'Target',
      project: 'Project',
      window: 'Window',
      created: 'Created',
      updated: 'Updated',
      checked: 'Sources checked',
    },
    // "Last 1 day" is grammatical but stiff; the one-day window reads best as a
    // definite phrase, like the Chinese 最近 1 天.
    windowValue: (days) => (days === 1 ? 'Last day' : 'Last ' + days + ' days'),
    effects: (relativeDir) => [
      'Re-collect and render the digest for the window',
      'Writes ' + relativeDir + '_meta/digest.md',
      'No file is written when the content is unchanged',
    ],
    warning: (reasons) =>
      'Collection was incomplete: ' +
      (reasons.length === 0 ? 'some sources could not be read' : reasons.join(', ')) +
      '; the digest covers only the sources that were checked.',
  },
}

/** The dialog catalog for every locale this build speaks, keyed like lib/locale.js. */
export const PANEL_DIALOG_COPY = { zh: ZH, en: EN }

/**
 * The catalog for one resolved locale.
 *
 * English is the only translation this build carries, so every other locale —
 * including a missing or malformed one — gets the Chinese source copy. That is
 * also the behaviour the default path had before localization existed.
 *
 * @param {string} [locale] - `zh` or `en`.
 * @returns {object} that locale's dialog catalog.
 */
export function dialogCopy(locale) {
  return locale === 'en' ? EN : ZH
}
