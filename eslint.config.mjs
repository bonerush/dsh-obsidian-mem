// ESLint flat config.
//
// Task 2 of the engineering-harness plan replaces this file with the rule set;
// it exists here so that the formatter's explicit globs have a real file to
// cover, and so the ignore list has one home that the formatter also reads.
export default [
  {
    ignores: [
      'node_modules/**',
      '.codegraph/**',
      'test/fixtures/**',
      'test/smoke/records/**',
      'research/**',
      'scratch/**',
    ],
  },
]
