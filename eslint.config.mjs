// ESLint flat config for the shipped plugin, its probes and its tests.
//
// Two deliberate choices, both because a silently disabled rule is worse than a
// noisy one:
//
//   * `no-undef` is never disabled. It found the real defect fixed in e31fa13 —
//     a re-exported `TransactionError` used in a `catch` without ever being
//     imported — on the first run over this tree.
//   * Intentional findings are disabled *inline, at the site*, with the reason on
//     the same line. A global rule switch would hide the next genuine finding of
//     the same shape, and the reason would live nowhere near the code it excuses.
import js from '@eslint/js'
import globals from 'globals'

export default [
  {
    ignores: [
      'node_modules/**',
      // Local CodeGraph index and other generated tooling state.
      '.codegraph/**',
      // Test *input*: a vault fixture with CJK names, control characters and
      // deliberately malformed frontmatter.
      'test/fixtures/**',
      // Run records, read as evidence and never rewritten.
      'test/smoke/records/**',
      // Investigation output, not code.
      'research/**',
      'scratch/**',
    ],
  },
  js.configs.recommended,
  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      // Rest-sibling omission is *use*, not an unused binding:
      // `({ preassignedId, idempotencyKey, ...rest }) => rest` is how a test strips
      // two fields. Deleting the names to satisfy the rule would change behaviour,
      // so the rule learns the idiom instead.
      'no-unused-vars': ['error', { ignoreRestSiblings: true }],
    },
  },
]
