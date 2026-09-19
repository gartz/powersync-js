import { LogLevels, WatchCompatibleQuery, createConsoleLogger } from '@powersync/common';
import { describe, expect, it, vi } from 'vitest';
import { DifferentialQueryProcessor } from '../../../src/client/watched/DifferentialQueryProcessor.js';
import { OnChangeQueryProcessor } from '../../../src/client/watched/OnChangeQueryProcessor.js';

interface Row {
  id: string;
  name: string;
}

/**
 * The minimal database surface the processors touch. `waitForReady` is deliberately
 * controllable: the whole point of `initialData` is that it is presented without
 * waiting for the database, so the tests hold the database unready and assert that
 * rows are on screen anyway.
 */
function createHost() {
  const listeners = new Set<any>();
  let onChange: (() => Promise<void>) | undefined;
  let releaseReady: () => void = () => {};
  const ready = new Promise<void>((resolve) => (releaseReady = resolve));

  const db = {
    logger: createConsoleLogger({ minLevel: LogLevels.error }),
    currentStatus: { hasSynced: true },
    waitForReady: vi.fn(() => ready),
    resolveTables: vi.fn(async () => ['items']),
    registerListener: (listener: any) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onChangeWithCallback: (handler: { onChange: () => Promise<void> }, opts: any) => {
      onChange = handler.onChange;
      if (opts?.triggerImmediate) {
        void handler.onChange();
      }
      return () => {};
    }
  };

  return {
    db,
    releaseReady,
    async emit() {
      await onChange?.();
    }
  };
}

function query(rows: () => Row[]): WatchCompatibleQuery<Row[]> {
  return {
    compile: () => ({ sql: 'SELECT * FROM items', parameters: [] }),
    execute: async () => rows()
  };
}

describe('initialData', () => {
  it('is presented before the database is ready, and is not reported as loading', async () => {
    const { db } = createHost();

    const processor = new DifferentialQueryProcessor<Row>({
      db: db as any,
      placeholderData: [],
      initialData: [{ id: 'a', name: 'from cache' }],
      watchOptions: { query: query(() => []) }
    });

    // The database is still held unready; these rows are on screen regardless.
    expect(processor.state.data).toEqual([{ id: 'a', name: 'from cache' }]);
    expect(processor.state.isLoading).toBe(false);
    expect(processor.state.lastUpdated).toBeInstanceOf(Date);

    await processor.close();
  });

  it('becomes the diff baseline, so unchanged rows are not reported as inserts', async () => {
    const { db, releaseReady, emit } = createHost();

    const seeded: Row[] = [
      { id: 'a', name: 'alpha' },
      { id: 'b', name: 'beta' }
    ];
    // The live query returns the same 'a', a changed 'b', and a new 'c'.
    const live: Row[] = [
      { id: 'a', name: 'alpha' },
      { id: 'b', name: 'beta changed' },
      { id: 'c', name: 'gamma' }
    ];

    const processor = new DifferentialQueryProcessor<Row>({
      db: db as any,
      placeholderData: [],
      initialData: seeded,
      watchOptions: { query: query(() => live) }
    });

    const diffs: any[] = [];
    processor.registerListener({ onDiff: (diff) => void diffs.push(diff) });

    releaseReady();
    await emit();
    await vi.waitFor(() => expect(diffs.length).toBeGreaterThan(0));

    const diff = diffs[diffs.length - 1];
    // Without the seeded baseline every row here would land in `added`.
    expect(diff.added.map((r: Row) => r.id)).toEqual(['c']);
    expect(diff.updated.map((u: any) => u.current.id)).toEqual(['b']);
    expect(diff.unchanged.map((r: Row) => r.id)).toEqual(['a']);
    expect(diff.removed).toEqual([]);

    await processor.close();
  });

  it('is replaced by the live result', async () => {
    const { db, releaseReady, emit } = createHost();

    const processor = new OnChangeQueryProcessor<Row[]>({
      db: db as any,
      comparator: undefined as any,
      placeholderData: [],
      initialData: [{ id: 'a', name: 'from cache' }],
      watchOptions: { query: query(() => [{ id: 'z', name: 'from database' }]) }
    });

    expect(processor.state.data).toEqual([{ id: 'a', name: 'from cache' }]);

    releaseReady();
    await emit();
    await vi.waitFor(() => expect(processor.state.data).toEqual([{ id: 'z', name: 'from database' }]));

    await processor.close();
  });

  it('leaves the placeholder path untouched when absent', async () => {
    const { db } = createHost();

    const processor = new DifferentialQueryProcessor<Row>({
      db: db as any,
      placeholderData: [{ id: 'p', name: 'placeholder' }],
      watchOptions: { query: query(() => []) }
    });

    // A placeholder is not a result: still loading, never updated.
    expect(processor.state.data).toEqual([{ id: 'p', name: 'placeholder' }]);
    expect(processor.state.isLoading).toBe(true);
    expect(processor.state.lastUpdated).toBeNull();

    await processor.close();
  });
});
