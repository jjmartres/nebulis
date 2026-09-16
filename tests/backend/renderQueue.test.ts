import { describe, it, expect, vi } from 'vitest';
import { runRender, renderQueueStats } from '../../server/lib/renderQueue';

/** A promise plus its resolver, so a test can hold a render "in flight". */
function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

describe('renderQueue', () => {
  it('caps concurrent renders at the configured limit', async () => {
    const { limit } = renderQueueStats();
    let peak = 0;
    let inFlight = 0;
    const gates = Array.from({ length: limit + 3 }, () => deferred());

    const tasks = gates.map((g, i) =>
      runRender(async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await g.promise;
        inFlight--;
        return i;
      }),
    );

    // Let the queue admit as many as it will.
    await vi.waitFor(() => expect(renderQueueStats().active).toBe(limit));
    expect(renderQueueStats().queued).toBe(3);

    gates.forEach(g => g.resolve());
    const results = await Promise.all(tasks);

    expect(results).toEqual(gates.map((_, i) => i));
    expect(peak).toBe(limit);
    expect(renderQueueStats()).toEqual({ active: 0, queued: 0, limit });
  });

  it('releases the slot when a render throws', async () => {
    const { limit } = renderQueueStats();
    await expect(runRender(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(renderQueueStats()).toEqual({ active: 0, queued: 0, limit });

    // The queue is still usable afterwards.
    await expect(runRender(async () => 'ok')).resolves.toBe('ok');
  });
});
