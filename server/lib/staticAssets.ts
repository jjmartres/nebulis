/**
 * Static-asset request detection and cache policy for the built `dist/`.
 *
 * The SPA fallback serves `index.html` for client-side routes, but it must never
 * answer a request for a missing file with the shell: `index.html` is HTML, so
 * a browser asked to execute it as a module reports the opaque "Importing a
 * module script failed" instead of a plain 404. That is exactly what a tab
 * holding an `index.html` from a build the server has since replaced hits when
 * it lazily loads a route chunk.
 *
 * Both pieces live here rather than inline in `index.ts` so they can be unit
 * tested without booting the server, whose import has real side effects.
 */
import path from 'path';
import type { ServerResponse } from 'http';

/**
 * Extensions the app serves as files. Vite's hashed bundles live under
 * `/assets` and are matched by prefix, so this list covers the images, fonts,
 * and media referenced by name. Keep it in step with what `public/` holds and
 * what Vite emits.
 */
const STATIC_FILE_EXTENSION =
  /\.(?:js|mjs|css|map|json|png|jpe?g|gif|svg|webp|avif|ico|bmp|woff2?|ttf|otf|eot|mp4|webm|mp3|wav|wasm|txt|xml)$/i;

/**
 * True when a request path addresses a file rather than a client-side route.
 * No client route contains a dot, so the extension test cannot swallow one.
 */
export function looksLikeAssetRequest(requestPath: string): boolean {
  return requestPath.startsWith('/assets/') || STATIC_FILE_EXTENSION.test(requestPath);
}

/**
 * `express.static` setHeaders for `dist/`. Content-hashed files under `/assets`
 * can never change under a fixed name, so they are cached immutably.
 * `index.html` names the chunk hashes for its build, so it must revalidate
 * instead of being reused from cache: a stale copy asks for chunks the new
 * build no longer has.
 */
export function setDistCacheHeaders(res: ServerResponse, filePath: string): void {
  if (filePath.includes(`${path.sep}assets${path.sep}`)) {
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    return;
  }
  if (filePath.endsWith('index.html')) {
    // Still cached, just revalidated first (a cheap 304 via express.static's ETag).
    res.setHeader('Cache-Control', 'no-cache');
  }
}

