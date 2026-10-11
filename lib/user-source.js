// @ts-check
// Shared source exclusions for turn capture and memory re-distillation.
/**
 * The deterministic credential patterns the scrub must cover (§10.1).
 *
 * Every pattern is anchored on a real format rather than a heuristic, and every
 * one is stateless (`no /g`), so a shared RegExp object cannot carry
 * `lastIndex` between messages.
 */
const CREDENTIAL_PATTERNS = Object.freeze([
  // AWS access key id.
  /AKIA[0-9A-Z]{16}/,
  // GitHub tokens: classic, OAuth, user, server, refresh.
  /gh[pousr]_[A-Za-z0-9_]{20,}/,
  // A fine-grained GitHub personal access token.
  /github_pat_[A-Za-z0-9_]{20,}/,
  // A PEM private-key block, whatever its algorithm or extra qualifier.
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/,
  // An Authorization header value.
  /\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*/,
])

/** Whether a message body contains a recognisable credential. */
export function containsCredential(text) {
  if (typeof text !== 'string' || text === '') return false
  return CREDENTIAL_PATTERNS.some((pattern) => pattern.test(text))
}

/** Whether text starts with a host-generated or imported instruction block. */
export function looksInjected(text) {
  return /^\s*(#\s*AGENTS\.md instructions|<INSTRUCTIONS>|<environment_context>|<user_instructions>|This session is being continued from a previous conversation)/i.test(
    text,
  )
}
