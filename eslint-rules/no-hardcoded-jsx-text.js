/**
 * Bans hardcoded user-visible English (or any language) text in JSX once a
 * file has opted into i18n — flags bare JSXText content and string literals
 * on the four attributes translators actually read (`title`, `placeholder`,
 * `aria-label`, `alt`), including the "looks translated but isn't" case of a
 * template literal that mixes a real word with an interpolated value (e.g.
 * `aria-label={`Import ${name}`}` — this exact pattern was a real miss in
 * ObjectReviewCard.tsx during the i18n migration: it reads like it's dynamic
 * but the word "Import" itself never goes through `t()`).
 *
 * Scoping is per-file, not per-directory: the rule only activates in a file
 * that already imports `useTranslation` or `Trans` from `react-i18next`. A
 * file untouched by the migration (chunks 6-10 as of 2026-09) stays silent
 * under this rule, so it can be wired on repo-wide via eslint.config.js
 * (`files: ['src/**\/*.tsx']`) without waiting for every chunk to land —
 * once a component's owner adds `useTranslation`, this rule immediately
 * holds that same file to the standard, and never regresses afterward.
 *
 * Heuristic for "this string needs translation": contains at least one
 * Unicode lowercase letter. This is deliberately permissive toward
 * ALL-CAPS/no-lowercase strings (object designations like "M31", units like
 * "GB"/"px", acronyms like "FITS"/"UTC") since those are typically invariant
 * across locales, and the cost of a missed acronym is far lower than the
 * noise of flagging every one of them. A real word or sentence in any
 * language always has a lowercase letter, so this does not blind-spot
 * hardcoded German either (catches an accidental copy-paste of the wrong
 * locale's string just as well as English).
 */

const LOWERCASE_LETTER = /\p{Ll}/u;

/** Product name and its wordmark fragments (the logo splits it across two
 *  colored <span>s, e.g. "Neb" + "ulis") plus the marketing domain — these
 *  are proper nouns, never translated, and would otherwise dominate the
 *  findings in every header/footer/about screen. Exact match on the trimmed
 *  text only, so "Nebulis is great" is still flagged normally. */
const BRAND_LITERALS = new Set(['Nebulis', 'Neb', 'ulis', 'Nebu', 'lis', 'nebulis.app']);

/** True if this chunk of literal text is worth flagging: has a real letter
 *  (any script, so a stray hardcoded German string is caught too) and isn't
 *  just a 1-character notation prefix like the "v" in `v{version}`. */
function needsTranslation(raw) {
  const text = raw.trim();
  if (text.length < 2) return false;
  if (BRAND_LITERALS.has(text)) return false;
  return LOWERCASE_LETTER.test(text);
}

const TRACKED_ATTRIBUTES = new Set(['title', 'placeholder', 'aria-label', 'alt']);

/** Recursively checks an expression for a literal string/template chunk that
 *  needs translation, following the two shapes that hide one from the flat
 *  "is this a Literal" check: `cond ? 'Sync all' : 'Syncing…'` (both a JSX
 *  child and an attribute value are commonly built this way) and
 *  `cond && 'text'`. Doesn't chase identifiers/calls — a variable holding a
 *  pre-translated string is exactly the shape correct code should have, so
 *  stopping there is the point, not a limitation. */
function expressionHasBareWords(node) {
  if (!node) return false;
  if (node.type === 'Literal') return typeof node.value === 'string' && needsTranslation(node.value);
  if (node.type === 'TemplateLiteral') return node.quasis.some(q => needsTranslation(q.value.raw));
  if (node.type === 'ConditionalExpression') {
    return expressionHasBareWords(node.consequent) || expressionHasBareWords(node.alternate);
  }
  if (node.type === 'LogicalExpression') {
    return expressionHasBareWords(node.left) || expressionHasBareWords(node.right);
  }
  return false;
}

/** Walks up from a node looking for an enclosing `<Trans>` element — its
 *  children (when used in the literal-children form rather than the
 *  self-closing `i18nKey` form this codebase uses today) are the
 *  translation source itself, not a miss. */
function isInsideTrans(node, sourceCode) {
  for (const ancestor of sourceCode.getAncestors(node)) {
    if (
      ancestor.type === 'JSXElement' &&
      ancestor.openingElement.name.type === 'JSXIdentifier' &&
      ancestor.openingElement.name.name === 'Trans'
    ) {
      return true;
    }
  }
  return false;
}

export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Ban hardcoded user-visible text in JSX (text nodes and title/placeholder/aria-label/alt) once a file uses react-i18next',
    },
    schema: [],
    messages: {
      hardcodedText:
        'Hardcoded text in a file that already uses react-i18next. Wrap it in t(\'...\') (or <Trans> for text with embedded markup/values) and add the key to the matching src/locales/{en,de}/*.json namespace file.',
      hardcodedAttribute:
        'Hardcoded text in the "{{attr}}" attribute of a file that already uses react-i18next. Wrap it in t(\'...\') and add the key to the matching src/locales/{en,de}/*.json namespace file.',
    },
  },
  create(context) {
    const sourceCode = context.sourceCode ?? context.getSourceCode();
    let usesI18n = false;

    return {
      ImportDeclaration(node) {
        if (node.source.value !== 'react-i18next') return;
        for (const spec of node.specifiers) {
          if (
            spec.type === 'ImportSpecifier' &&
            (spec.imported.name === 'useTranslation' || spec.imported.name === 'Trans')
          ) {
            usesI18n = true;
          }
        }
      },
      JSXText(node) {
        if (!usesI18n) return;
        if (!needsTranslation(node.value)) return;
        if (isInsideTrans(node, sourceCode)) return;
        context.report({ node, messageId: 'hardcodedText' });
      },
      JSXExpressionContainer(node) {
        if (!usesI18n) return;
        // Only care about this container as a JSX *child* (visible text), not
        // as a prop value — attributes are handled separately below, and a
        // container used as e.g. a spread or a style object would otherwise
        // false-positive on unrelated string literals inside it.
        if (node.parent.type !== 'JSXElement' && node.parent.type !== 'JSXFragment') return;
        if (expressionHasBareWords(node.expression)) {
          if (isInsideTrans(node, sourceCode)) return;
          context.report({ node, messageId: 'hardcodedText' });
        }
      },
      JSXAttribute(node) {
        if (!usesI18n) return;
        if (node.name.type !== 'JSXIdentifier' || !TRACKED_ATTRIBUTES.has(node.name.name)) return;
        const value = node.value;
        if (!value) return;

        if (value.type === 'Literal' && typeof value.value === 'string') {
          if (needsTranslation(value.value)) {
            context.report({ node, messageId: 'hardcodedAttribute', data: { attr: node.name.name } });
          }
          return;
        }

        if (value.type === 'JSXExpressionContainer' && expressionHasBareWords(value.expression)) {
          context.report({ node, messageId: 'hardcodedAttribute', data: { attr: node.name.name } });
        }
      },
    };
  },
};
