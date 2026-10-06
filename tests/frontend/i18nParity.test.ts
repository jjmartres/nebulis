import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Hard-fail parity check between the English source of truth and every other
 * locale. `i18nKeys.test.ts` only proves that each key the code uses exists in
 * `en`; nothing else stopped a locale from silently falling behind, which is
 * how whole groups of keys (the Library filter bar, the framing dialog, the
 * "find device" scan) shipped English-only in de/es/fr.
 *
 * For every namespace and every non-English locale this fails when:
 *   1. the locale file is missing,
 *   2. an English key is missing from the locale,
 *   3. the locale has a key English does not (a stale or mis-nested key),
 *   4. the `{{placeholders}}` of a string differ from English (a translated
 *      variable name renders as literal braces at runtime),
 *   5. a sentence is still identical to English (an untranslated placeholder).
 *      Genuinely language-neutral text goes in `tests/frontend/i18nSameAsEnglish.json`
 *      with a reason; never copy English into a locale to make a key "exist".
 *
 * Plural keys: English `x_one`/`x_other` only requires the locale to have
 * `x_other` (CLDR gives es/fr an extra `_many`, which is allowed).
 */

const LOCALES_ROOT = path.join(__dirname, '..', '..', 'src', 'locales');
const SOURCE = 'en';
const PLURALS = ['_zero', '_one', '_two', '_few', '_many', '_other'];

const allowFile = path.join(__dirname, 'i18nSameAsEnglish.json');
const SAME_ALLOWED: Record<string, string> = fs.existsSync(allowFile)
  ? JSON.parse(fs.readFileSync(allowFile, 'utf-8'))
  : {};

type Flat = Record<string, string>;

function flatten(node: unknown, prefix = '', out: Flat = {}): Flat {
  if (node && typeof node === 'object' && !Array.isArray(node)) {
    for (const [k, v] of Object.entries(node)) flatten(v, prefix ? `${prefix}.${k}` : k, out);
  } else if (typeof node === 'string') {
    out[prefix] = node;
  } else if (Array.isArray(node)) {
    node.forEach((v, i) => flatten(v, `${prefix}.${i}`, out));
  }
  return out;
}

function load(locale: string, ns: string): Flat | null {
  const file = path.join(LOCALES_ROOT, locale, `${ns}.json`);
  return fs.existsSync(file) ? flatten(JSON.parse(fs.readFileSync(file, 'utf-8'))) : null;
}

const pluralBase = (key: string) => {
  const s = PLURALS.find((p) => key.endsWith(p));
  return s ? { base: key.slice(0, -s.length), suffix: s } : { base: key, suffix: '' };
};

/** Keys a locale must define: every English key, except that the plural
 *  forms English has and the locale may not need collapse to `_other`. */
function requiredKeys(en: Flat): string[] {
  const out = new Set<string>();
  for (const key of Object.keys(en)) {
    const { base, suffix } = pluralBase(key);
    out.add(suffix ? `${base}_other` : key);
  }
  return [...out];
}

/** Placeholder names in a string. A singular plural form ("One file") may
 *  spell the number out instead of using `{{count}}`, so `count` is ignored
 *  for `_zero`/`_one`/`_two` keys on both sides. */
const placeholders = (s: string, key: string) => {
  const singular = ['_zero', '_one', '_two'].some((p) => key.endsWith(p));
  return [...s.matchAll(/\{\{\s*([^}\s,]+)[^}]*\}\}/g)]
    .map((m) => m[1])
    .filter((n) => !(singular && n === 'count'))
    .sort()
    .join('|');
};

/** True for a string with real wording: two or more letters-only words once
 *  placeholders, digits and symbols are removed. "{{a}} · {{b}}" and "1:1" are not. */
function hasWords(s: string): boolean {
  const words = s.replace(/\{\{[^}]*\}\}/g, ' ').match(/\p{L}{2,}/gu) ?? [];
  return words.length >= 2;
}

const namespaces = fs.readdirSync(path.join(LOCALES_ROOT, SOURCE)).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, ''));
const locales = fs.readdirSync(LOCALES_ROOT).filter((d) => d !== SOURCE && fs.statSync(path.join(LOCALES_ROOT, d)).isDirectory());

describe('locale parity with English', () => {
  it('finds the locales and namespaces it is meant to check', () => {
    expect(namespaces.length).toBeGreaterThanOrEqual(10);
    expect(locales.sort()).toEqual(expect.arrayContaining(['de', 'es', 'fr']));
  });

  for (const locale of locales) {
    for (const ns of namespaces) {
      it(`${locale}/${ns}.json matches en`, () => {
        const en = load(SOURCE, ns)!;
        const loc = load(locale, ns);
        expect(loc, `src/locales/${locale}/${ns}.json is missing`).not.toBeNull();
        const l = loc!;

        const missing = requiredKeys(en).filter((k) => !(k in l));
        expect(missing, `keys in en/${ns}.json missing from ${locale}`).toEqual([]);

        const enBases = new Set(Object.keys(en).map((k) => pluralBase(k).base));
        const extra = Object.keys(l).filter((k) => !(k in en) && !enBases.has(pluralBase(k).base));
        expect(extra, `keys in ${locale}/${ns}.json that en does not have`).toEqual([]);

        const badVars = Object.keys(en)
          .filter((k) => k in l && placeholders(en[k], k) !== placeholders(l[k], k))
          .map((k) => `${k}: en {{${placeholders(en[k], k)}}} vs ${locale} {{${placeholders(l[k], k)}}}`);
        expect(badVars, `placeholder mismatch in ${locale}/${ns}.json`).toEqual([]);

        const untranslated = Object.keys(en).filter(
          (k) => k in l && l[k] === en[k] && hasWords(en[k]) && !SAME_ALLOWED[`${ns}:${k}`],
        );
        expect(
          untranslated,
          `${locale}/${ns}.json still has English text. Translate it, or if it is language-neutral add "${ns}:<key>" to tests/frontend/i18nSameAsEnglish.json with a reason`,
        ).toEqual([]);
      });
    }
  }
});
