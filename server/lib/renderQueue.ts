// Bounds how many expensive image renders (sharp decode/encode, FITS/TIFF
// autostretch) run at once.
//
// Why this exists: opening a calendar month, or scrolling a long observation
// list, makes the client fan out one thumbnail request per session. On a cold
// cache each one runs a sharp pipeline on libuv's threadpool. A monthful of
// those in flight saturates the pool (and the CPU), so the cheap
// `fs.promises.access` guard in the *other*, still-pending thumbnail requests
// can't get a thread inside LIBRARY_IO_TIMEOUT_MS and times out. The route then
// returned that timeout as a 404 and the client drew a permanently-broken
// image. Serialising the renders down to a handful keeps spare threads for the
// fast path (cache hits and the access/stat guards), so a burst queues instead
// of dogpiling.
//
// Cache hits never enter the queue — only the generate-if-missing step does.

const DEFAULT_CONCURRENCY = 4;

function resolveConcurrency(): number {
  const raw = parseInt(process.env.THUMBNAIL_RENDER_CONCURRENCY || '', 10);
  if (Number.isFinite(raw) && raw >= 1 && raw <= 32) return raw;
  return DEFAULT_CONCURRENCY;
}

const limit = resolveConcurrency();
let active = 0;
const waiters: Array<() => void> = [];

function acquire(): Promise<void> {
  if (active < limit) {
    active++;
    return Promise.resolve();
  }
  return new Promise<void>(resolve => {
    waiters.push(() => {
      active++;
      resolve();
    });
  });
}

function release(): void {
  active--;
  const next = waiters.shift();
  if (next) next();
}

/**
 * Run `fn` once a render slot is free. Resolves/rejects with `fn`'s result;
 * the slot is always released, including on throw.
 */
export async function runRender<T>(fn: () => Promise<T>): Promise<T> {
  await acquire();
  try {
    return await fn();
  } finally {
    release();
  }
}

/** Test/introspection helper: current in-flight + queued counts. */
export function renderQueueStats(): { active: number; queued: number; limit: number } {
  return { active, queued: waiters.length, limit };
}
