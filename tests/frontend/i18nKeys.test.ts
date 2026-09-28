import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Regression guard for the i18n migration (issue #6). Parses every source
 * file that calls `useTranslation(...)`, extracts every `t('key...')` and
 * `<Trans i18nKey="key" ns="...">` reference in it, and confirms each one
 * resolves against the real `src/locales/en/<namespace>.json` file —
 * plural-suffix aware (`foo_one`/`foo_other`/... count as `foo` resolving).
 *
 * This exists because a missing or wrongly-nested key fails silently at
 * runtime: react-i18next falls back to rendering the raw key string instead
 * of throwing, so nothing in `tsc -b`, `eslint`, or the component test suite
 * catches it. During this migration a batch of `Edit` calls anchored on
 * non-unique JSON text once nested five new top-level key groups a level too
 * deep — every consuming `t()` call still "worked" (silently returned the
 * key name), and only a manual content diff caught it. This test is exactly
 * the check that would have caught it automatically, every time, in CI.
 */

const SRC_ROOT = path.join(__dirname, '..', '..', 'src');
const LOCALES_DIR = path.join(__dirname, '..', '..', 'src', 'locales', 'en');

const PLURAL_SUFFIXES = ['_one', '_other', '_zero', '_two', '_few', '_many'];

function loadNamespace(ns: string): unknown {
  const file = path.join(LOCALES_DIR, `${ns}.json`);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf-8'));
}

const namespaceCache = new Map<string, unknown>();
function getNamespace(ns: string): unknown {
  if (!namespaceCache.has(ns)) namespaceCache.set(ns, loadNamespace(ns));
  return namespaceCache.get(ns);
}

/** Resolves a dotted key path against a namespace's JSON, treating a final
 *  segment as resolved if `<segment>_one`/`_other`/etc. exists instead (an
 *  i18next plural key group has no bare `<segment>` entry of its own). */
function resolves(ns: string, key: string): boolean {
  const root = getNamespace(ns);
  if (root === null) return false;
  const parts = key.split('.');
  let cur: unknown = root;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (cur !== null && typeof cur === 'object' && part in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[part];
      continue;
    }
    if (i === parts.length - 1 && cur !== null && typeof cur === 'object') {
      const obj = cur as Record<string, unknown>;
      if (PLURAL_SUFFIXES.some(suf => `${part}${suf}` in obj)) return true;
    }
    return false;
  }
  return true;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, out);
    } else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx'))) {
      out.push(full);
    }
  }
  return out;
}

interface Reference {
  file: string;
  ns: string;
  key: string;
}

function extractReferences(file: string, content: string): Reference[] {
  const refs: Reference[] = [];

  // useTranslation('ns') or useTranslation(['ns1', 'ns2']) — first namespace
  // named is the default one t() resolves against absent an { ns } override.
  const nsMatch = content.match(/useTranslation\(\s*\[?\s*['"]([a-zA-Z0-9_]+)['"]/);
  if (!nsMatch) return refs;
  const defaultNs = nsMatch[1];

  // t('key.path' [, { ...opts incl. optional ns: '...' }])
  const tCallRe = /\bt\(\s*['"]([a-zA-Z0-9_.]+)['"]\s*(?:,\s*\{([^}]*)\})?\s*\)/g;
  for (const m of content.matchAll(tCallRe)) {
    const key = m[1];
    const opts = m[2] ?? '';
    const nsOverride = opts.match(/ns:\s*['"]([a-zA-Z0-9_]+)['"]/);
    refs.push({ file, ns: nsOverride ? nsOverride[1] : defaultNs, key });
  }

  // <Trans i18nKey="key.path" ... ns="namespace" ... /> (ns may appear before
  // or after i18nKey, or be absent — absent means the default namespace).
  const transRe = /<Trans\b[^>]*?\/?>/gs;
  for (const tag of content.matchAll(transRe)) {
    const tagText = tag[0];
    const keyMatch = tagText.match(/i18nKey=["']([a-zA-Z0-9_.]+)["']/);
    if (!keyMatch) continue;
    const nsMatchInTag = tagText.match(/\bns=["']([a-zA-Z0-9_]+)["']/);
    refs.push({ file, ns: nsMatchInTag ? nsMatchInTag[1] : defaultNs, key: keyMatch[1] });
  }

  return refs;
}

describe('i18n key resolution', () => {
  const files = walk(SRC_ROOT);
  const allRefs = files.flatMap(file => extractReferences(file, fs.readFileSync(file, 'utf-8')));

  it('found at least one file using useTranslation (sanity check the walk itself works)', () => {
    expect(allRefs.length).toBeGreaterThan(0);
  });

  it('every t()/Trans key referenced in a migrated file resolves in the matching en/*.json namespace', () => {
    const missing = allRefs.filter(ref => !resolves(ref.ns, ref.key));
    const report = missing
      .map(m => `  ${path.relative(SRC_ROOT, m.file)}: [${m.ns}] ${m.key}`)
      .join('\n');
    expect(missing, `Unresolved i18n keys:\n${report}`).toHaveLength(0);
  });
});
