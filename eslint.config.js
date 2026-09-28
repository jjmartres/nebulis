import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'
import noUnguardedTimezone from './eslint-rules/no-unguarded-timezone.js'
import noHardcodedJsxText from './eslint-rules/no-hardcoded-jsx-text.js'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    plugins: {
      local: { rules: { 'no-unguarded-timezone': noUnguardedTimezone, 'no-hardcoded-jsx-text': noHardcodedJsxText } },
    },
    rules: {
      'local/no-unguarded-timezone': 'error',
    },
  },
  {
    // i18n regression guard (issue #6 migration). The rule only activates
    // inside a file that already imports useTranslation/Trans from
    // react-i18next, so it holds already-migrated files (chunks 0-5 so far)
    // to the standard without flagging the still-English chunks 6-10 files —
    // no directory allowlist to maintain as the migration progresses. See
    // eslint-rules/no-hardcoded-jsx-text.js for exactly what it checks.
    files: ['src/**/*.tsx'],
    rules: {
      'local/no-hardcoded-jsx-text': 'error',
    },
  },
  {
    // Off in tests: a test's timezone values typically come from a chain the
    // rule can't trace through a variable binding (e.g.
    // observerTimezoneForCoordinates(...), which is already validated) —
    // real false positives, not render-path code that can crash a user.
    files: ['tests/**/*.{ts,tsx}'],
    rules: {
      'local/no-unguarded-timezone': 'off',
    },
  },
  {
    // Layer boundary: server/lib and server/middleware must never import from
    // server/routes — dependencies flow index.ts → routes → middleware → lib,
    // never back up. Zero violations today; this rule exists to keep it that
    // way, since nothing else currently enforces it.
    files: ['server/lib/**/*.ts', 'server/middleware/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [{
          group: ['**/routes/*'],
          message: 'Upward dependency: server/lib and server/middleware must never import from server/routes.',
        }],
      }],
    },
  },
  {
    // Repository pattern: routes must not talk to SQLite directly — they call
    // a named lib/ function (e.g. resetLibraryData, getObjectInfo) instead of
    // db.prepare/db.exec. Only the default export (the raw Database handle)
    // is restricted, so importing named helpers from lib/db.js is still fine.
    // Keeps queries testable in isolation from Express and means a schema
    // change breaks in one place, not silently at request time.
    files: ['server/routes/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        paths: [{
          name: '../lib/db.js',
          importNames: ['default'],
          message: 'Routes must not access the database directly. Add a function to the owning lib/ module instead.',
        }],
      }],
    },
  },
])
