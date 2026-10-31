import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  DEFAULT_LOCALE,
  SUPPORTED_LOCALES,
  localeFromAcceptLanguage,
  normalizeLocale,
  resolveLocale,
} from '../lib/locale.js'

test('the supported locales are exactly Chinese and English, with Chinese as the source', () => {
  assert.deepEqual([...SUPPORTED_LOCALES], ['zh', 'en'])
  assert.equal(DEFAULT_LOCALE, 'zh')
})

test('a language tag reduces to its primary subtag and an unsupported one is refused', () => {
  assert.equal(normalizeLocale('en'), 'en')
  assert.equal(normalizeLocale('EN'), 'en')
  assert.equal(normalizeLocale(' en '), 'en')
  assert.equal(normalizeLocale('en-US'), 'en')
  assert.equal(normalizeLocale('zh'), 'zh')
  assert.equal(normalizeLocale('zh-Hans-CN'), 'zh')
  assert.equal(normalizeLocale('zh_CN'), 'zh')
  assert.equal(normalizeLocale('fr'), null)
  assert.equal(normalizeLocale('fr-FR'), null)
  assert.equal(normalizeLocale(''), null)
  assert.equal(normalizeLocale('   '), null)
  assert.equal(normalizeLocale(null), null)
  assert.equal(normalizeLocale(42), null)
})

test('Accept-Language picks the highest quality supported locale, ties keeping header order', () => {
  assert.equal(localeFromAcceptLanguage('en-US,en;q=0.9'), 'en')
  assert.equal(localeFromAcceptLanguage('zh-CN,zh;q=0.9,en;q=0.8'), 'zh')
  assert.equal(localeFromAcceptLanguage('fr-FR,fr;q=0.9,en;q=0.8'), 'en')
  assert.equal(localeFromAcceptLanguage('ko;q=0.8,zh;q=0.5'), 'zh')
  assert.equal(localeFromAcceptLanguage('en;q=0.4,zh;q=0.8'), 'zh')
  // A q of zero is a refusal; a malformed q is not a preference.
  assert.equal(localeFromAcceptLanguage('zh;q=0,en;q=0.5'), 'en')
  assert.equal(localeFromAcceptLanguage('zh;q=oops,en;q=0.5'), 'en')
  // No supported locale at all is a null answer, not a default.
  assert.equal(localeFromAcceptLanguage('fr-FR,fr;q=0.9'), null)
  // A wildcard is not a language tag; it is skipped, not mapped to English.
  assert.equal(localeFromAcceptLanguage('*'), null)
  assert.equal(localeFromAcceptLanguage('*, en;q=0.5'), 'en')
  assert.equal(localeFromAcceptLanguage('*, zh;q=0'), null)
  assert.equal(localeFromAcceptLanguage(''), null)
  assert.equal(localeFromAcceptLanguage(';;;'), null)
  assert.equal(localeFromAcceptLanguage(undefined), null)
})

test('an explicit locale wins over the header, and a header over the default', () => {
  assert.equal(resolveLocale({ value: 'en', acceptLanguage: 'zh-CN,zh;q=0.9' }), 'en')
  assert.equal(resolveLocale({ value: 'zh', acceptLanguage: 'en-US,en;q=0.9' }), 'zh')
  // An unsupported explicit value is not a refusal of the header.
  assert.equal(resolveLocale({ value: 'fr', acceptLanguage: 'zh' }), 'zh')
  assert.equal(resolveLocale({ value: '', acceptLanguage: 'en' }), 'en')
  // A supported header is honoured.
  assert.equal(resolveLocale({ acceptLanguage: 'en-US' }), 'en')
  // A header this build cannot answer gets English; no header gets the source.
  assert.equal(resolveLocale({ acceptLanguage: 'fr-FR' }), 'en')
  assert.equal(resolveLocale({}), DEFAULT_LOCALE)
  assert.equal(resolveLocale(), DEFAULT_LOCALE)
  assert.equal(resolveLocale({ acceptLanguage: '   ' }), DEFAULT_LOCALE)
  // A wildcard expresses no preference — Node's fetch sends '*' by default — so
  // it behaves like a missing header instead of flipping the caller to English.
  assert.equal(resolveLocale({ acceptLanguage: '*' }), DEFAULT_LOCALE)
  assert.equal(resolveLocale({ acceptLanguage: '*, *;q=0.8' }), DEFAULT_LOCALE)
  assert.equal(resolveLocale({ acceptLanguage: '*, en;q=0.5' }), 'en')
  // A refused concrete tag is not a preference either.
  assert.equal(resolveLocale({ acceptLanguage: 'fr;q=0, *' }), DEFAULT_LOCALE)
})
