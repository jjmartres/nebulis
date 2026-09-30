// @vitest-environment jsdom
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import { createElement, Suspense, type ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import i18n from '../../src/i18n';
import { AuthProvider } from '../../src/contexts/AuthContext';
import { NavVisibilityProvider } from '../../src/hooks/useNavVisibility';
import { ThemeProvider } from '../../src/hooks/useTheme';

/**
 * SPA route smoke test.
 *
 * Every route in `src/App.tsx` is code-split through `lazyRoute(() => import(...))`.
 * That indirection is invisible to the compiler: `App.tsx` names the export it
 * expects as a plain string (`m.SettingsPage`), so renaming the export in the
 * page module or breaking one of its imports type-checks cleanly and fails only
 * at runtime, as a blank screen behind the Suspense fallback. Nothing in the
 * suite covered that: `tsc` cannot see through the dynamic import, and the
 * existing frontend tests exercise pure logic plus a handful of components
 * rendered directly, never the route table.
 *
 * This guards three things:
 *   1. The route table itself, snapshotted (a removed route breaks clients,
 *      a same-path swap to a different component is worth a reviewer seeing).
 *   2. That every lazily-imported route module loads and actually exports the
 *      name `App.tsx` asks for. This is the white-screen guard.
 *   3. That each route component renders to markup without throwing, inside
 *      the same provider stack `main.tsx` supplies.
 *
 * `renderToStaticMarkup` runs no effects, so a page's queries stay pending and
 * no network is touched: this measures "does it render at all", not "does it
 * render data". Pages that genuinely cannot render without a live server are
 * listed in RENDER_EXEMPT with the reason, so skipping one is a visible
 * decision rather than a silent gap.
 *
 * Regenerate the snapshot after an intentional route change:
 *   UPDATE_ROUTE_TABLE=1 npx vitest run tests/frontend/routeSmoke.test.tsx
 */

const APP_PATH = path.join(process.cwd(), 'src', 'App.tsx');

interface LazySpec {
  identifier: string;
  modulePath: string;
  /** Named export `App.tsx` destructures, or null for a default export. */
  exportName: string | null;
}

interface RouteSpec {
  routePath: string;
  identifier: string;
  modulePath: string;
  exportName: string | null;
}

/**
 * Pages that cannot be rendered with no server. Each entry needs a reason; an
 * unexplained failure here is the point of the test, so this list should stay
 * as short as it can.
 */
const RENDER_EXEMPT: Record<string, string> = {};

function readAppSource(): string {
  return fs.readFileSync(APP_PATH, 'utf8');
}

function parseLazyComponents(source: string): LazySpec[] {
  const out: LazySpec[] = [];
  // const X = lazyRoute(() => import('...').then(m => ({ default: m.Y })));
  // const X = lazyRoute(() => import('...'));
  const re =
    /const\s+(\w+)\s*=\s*lazyRoute\(\s*\(\)\s*=>\s*import\(\s*['"]([^'"]+)['"]\s*\)\s*(?:\.then\(\s*\w+\s*=>\s*\(\s*\{\s*default:\s*\w+\.(\w+)\s*\}\s*\)\s*\))?\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    out.push({ identifier: m[1], modulePath: m[2], exportName: m[3] ?? null });
  }
  return out;
}

function parseRoutes(source: string): Array<{ routePath: string; identifier: string }> {
  const out: Array<{ routePath: string; identifier: string }> = [];
  const re = /<Route\s+path="([^"]+)"\s+element=\{<(\w+)\s*\/>\}\s*\/>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    out.push({ routePath: m[1], identifier: m[2] });
  }
  return out;
}

const APP_SOURCE = readAppSource();
const LAZY = parseLazyComponents(APP_SOURCE);
const ROUTES: RouteSpec[] = parseRoutes(APP_SOURCE).map(r => {
  const spec = LAZY.find(l => l.identifier === r.identifier);
  if (!spec) {
    throw new Error(
      `Route "${r.routePath}" renders <${r.identifier}/>, which is not defined via lazyRoute() in App.tsx. ` +
        'Update this test (or the route) so the smoke test keeps covering it.',
    );
  }
  return { routePath: r.routePath, identifier: r.identifier, modulePath: spec.modulePath, exportName: spec.exportName };
});

const TABLE_PATH = path.join(process.cwd(), 'tests', 'frontend', 'fixtures', 'routeTable.json');

function serializeTable(): string {
  return `${JSON.stringify(
    ROUTES.map(r => ({ path: r.routePath, module: r.modulePath, export: r.exportName })).sort((a, b) =>
      a.path.localeCompare(b.path),
    ),
    null,
    2,
  )}\n`;
}

function resolveModulePath(modulePath: string): string {
  // App.tsx writes './pages/Gallery'; resolve relative to src/.
  return path.join(process.cwd(), 'src', `${modulePath.replace(/^\.\//, '')}.tsx`);
}

/** The provider stack `main.tsx` + `App` establish around every route. */
function renderRoute(Component: ComponentType): string {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity, refetchOnWindowFocus: false } },
  });

  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(
        MemoryRouter,
        { initialEntries: ['/'] },
        createElement(
          ThemeProvider,
          null,
          createElement(
            NavVisibilityProvider,
            null,
            createElement(AuthProvider, null, createElement(Suspense, { fallback: null }, createElement(Component))),
          ),
        ),
      ),
    ),
  );
}

describe('SPA route smoke', () => {
  beforeAll(async () => {
    await i18n.changeLanguage('en');
  });

  it('parsed a non-trivial route table out of App.tsx', () => {
    // Guards against the regexes silently matching nothing after an App.tsx
    // refactor, which would turn every assertion below into a no-op.
    expect(ROUTES.length).toBeGreaterThanOrEqual(18);
    for (const r of ROUTES) {
      expect(r.modulePath, `route ${r.routePath} has no import path`).toMatch(/^\.\//);
    }
  });

  it('matches the committed route table snapshot', () => {
    const actual = serializeTable();

    if (process.env.UPDATE_ROUTE_TABLE === '1' || !fs.existsSync(TABLE_PATH)) {
      fs.mkdirSync(path.dirname(TABLE_PATH), { recursive: true });
      fs.writeFileSync(TABLE_PATH, actual);
      if (process.env.UPDATE_ROUTE_TABLE !== '1') {
        throw new Error(
          `Route table snapshot was missing and has been written to ${path.relative(process.cwd(), TABLE_PATH)}. ` +
            'Review it and commit it as part of the change.',
        );
      }
      return;
    }

    const expected = fs.readFileSync(TABLE_PATH, 'utf8');
    if (expected === actual) return;

    throw new Error(
      'The SPA route table changed.\n' +
        `Expected:\n${expected}\nActual:\n${actual}\n` +
        'If intentional, regenerate with:\n' +
        '  UPDATE_ROUTE_TABLE=1 npx vitest run tests/frontend/routeSmoke.test.tsx',
    );
  });

  it.each(ROUTES.map(r => [r.routePath, r] as const))(
    'loads and exports the component for %s',
    async (_routePath, route) => {
      const mod = (await import(/* @vite-ignore */ resolveModulePath(route.modulePath))) as Record<string, unknown>;
      expect(Object.keys(mod).length, `${route.modulePath} exported nothing`).toBeGreaterThan(0);

      const exportName = route.exportName ?? 'default';
      const exported = mod[exportName];
      expect(
        exported,
        `${route.modulePath} does not export "${exportName}", but App.tsx imports it as { default: m.${exportName} }. ` +
          'This renders a blank route in production.',
      ).toBeDefined();
      expect(['function', 'object']).toContain(typeof exported);
    },
  );

  it.each(ROUTES.map(r => [r.routePath, r] as const))(
    'renders the component for %s without throwing',
    async (routePath, route) => {
      const mod = (await import(/* @vite-ignore */ resolveModulePath(route.modulePath))) as Record<string, unknown>;
      const Component = mod[route.exportName ?? 'default'] as ComponentType;

      let html: string;
      try {
        html = renderRoute(Component);
      } catch (err) {
        if (routePath in RENDER_EXEMPT) return;
        throw new Error(
          `Route ${routePath} (${route.modulePath}) threw while rendering: ${
            err instanceof Error ? err.message : String(err)
          }\n` +
            'Fix the render path, or add this route to RENDER_EXEMPT with a reason if it genuinely needs a live server.',
        );
      }

      // A component that renders to the empty string is almost always a
      // conditional that bailed out, not a real page.
      expect(typeof html).toBe('string');
    },
  );
});
