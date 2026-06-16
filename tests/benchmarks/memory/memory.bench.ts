import { test } from '../../../playwright';
import { summarize } from '../utils/stats';
import { writeResults, buildResultEntry, type ResultEntry } from '../utils/results';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

/**
 * Memory benchmark for the QuickJS sandbox (BRU memory regression).
 *
 * Exercises the two leak paths and measures how much *external* memory
 * (WASM linear-memory backing store, which V8 GC cannot reclaim) grows
 * after running N sandbox executions. A leak shows up as external growth
 * that scales with iteration count.
 *
 *   mode=asserts -> sync path  (AssertRuntime -> executeQuickJsVm)
 *   mode=scripts -> async path (ScriptRuntime.runResponseScript -> executeQuickJsVmAsync)
 *
 * Unlike the mounting benchmark this runs entirely in-process and does not
 * need Electron or the web app — it requires the bruno-js runtime directly.
 */

type Mode = 'asserts' | 'scripts';

const MODES: Mode[] = ['asserts', 'scripts'];
const ITERATION_COUNTS = [250, 500, 1000];
const REPS_PER_CASE = 3;

const MB = 1024 * 1024;
const REPO_ROOT = process.cwd();

function snapshotExternalMB(): number {
  return process.memoryUsage().external / MB;
}

function loadRuntimes() {
  const AssertRuntime = require(path.join(REPO_ROOT, 'packages/bruno-js/src/runtime/assert-runtime'));
  const ScriptRuntime = require(path.join(REPO_ROOT, 'packages/bruno-js/src/runtime/script-runtime'));
  const { loader } = require(path.join(REPO_ROOT, 'packages/bruno-js/src/sandbox/quickjs'));
  return { AssertRuntime, ScriptRuntime, loader };
}

async function runAsserts(assertRuntime: any, iterations: number) {
  for (let i = 1; i <= iterations; i++) {
    const status = 200 + (i % 50);
    await assertRuntime.runAssertions(
      [{ name: 'res.status', value: `eq ${status}`, enabled: true }],
      { method: 'GET', url: 'http://localhost/', headers: {} },
      { status, statusText: 'OK', data: { id: i }, headers: {} },
      {},
      {},
      process.env
    );
  }
}

// QuickJS only injects `console` when onConsoleLog is a function (chai uses it internally).
const noopConsoleLog = () => { };

async function runScripts(scriptRuntime: any, iterations: number) {
  for (let i = 1; i <= iterations; i++) {
    await scriptRuntime.runResponseScript(
      `bru.setVar('i', ${i}); test('ok', () => { expect(res.status).to.equal(200); });`,
      { method: 'GET', url: 'http://localhost/', headers: {}, pathname: path.join(os.tmpdir(), 'req.bru') },
      { status: 200, statusText: 'OK', data: { id: i }, headers: {} },
      {}, {}, REPO_ROOT, noopConsoleLog, process.env, {}, null, 'profile'
    );
  }
}

/** Returns external-memory growth (MB) after running `iterations` executions. */
async function measureExternalGrowth(
  mode: Mode,
  iterations: number,
  runtimes: { assertRuntime: any; scriptRuntime: any }
): Promise<number> {
  if (global.gc) global.gc();
  const before = snapshotExternalMB();

  if (mode === 'asserts') {
    await runAsserts(runtimes.assertRuntime, iterations);
  } else {
    await runScripts(runtimes.scriptRuntime, iterations);
  }

  if (global.gc) {
    global.gc();
    global.gc();
  }
  const after = snapshotExternalMB();

  return after - before;
}

function resultKey(mode: Mode, iterations: number): string {
  return `quickjs-${mode}-${iterations}`;
}

test.describe('Benchmark: Runner Memory', () => {
  const results: Record<string, { timings: number[]; mode: Mode; iterations: number }> = {};

  let runtimes: { assertRuntime: any; scriptRuntime: any };

  test.beforeAll(async () => {
    const { AssertRuntime, ScriptRuntime, loader } = loadRuntimes();
    await loader(); // warm up the WASM module once (shared, memoized)
    runtimes = {
      assertRuntime: new AssertRuntime({ runtime: 'quickjs' }),
      scriptRuntime: new ScriptRuntime({ runtime: 'quickjs' })
    };
  });

  for (const mode of MODES) {
    test.describe(`mode: ${mode}`, () => {
      for (const iterations of ITERATION_COUNTS) {
        test(`${mode} memory growth over ${iterations} executions`, async () => {
          test.setTimeout((2 + Math.ceil(iterations / 50)) * 60_000);

          const timings: number[] = [];
          for (let rep = 0; rep < REPS_PER_CASE; rep++) {
            timings.push(await measureExternalGrowth(mode, iterations, runtimes));
          }

          const key = resultKey(mode, iterations);
          results[key] = { timings, mode, iterations };

          const stats = summarize(timings);
          const meanPerReqKb = (stats.mean * 1024) / iterations;
          const r = (v: number) => Number(v.toFixed(3));
          console.log(
            `[BENCHMARK] ${mode} ${iterations} execs — external growth mean: ${r(stats.mean)}MB, `
            + `median: ${r(stats.median)}MB, perReq: ${r(meanPerReqKb)}KB, raw: [${timings.map(r).join(', ')}]`
          );

          test.info().annotations.push({
            type: 'benchmark',
            description: JSON.stringify({ mode, iterations, ...stats, timings })
          });
        });
      }
    });
  }

  test.afterAll(async () => {
    const resultsDir = path.join(REPO_ROOT, 'tests', 'benchmarks', 'results');
    fs.mkdirSync(resultsDir, { recursive: true });
    const outputPath = path.join(resultsDir, 'memory.json');
    const entries: Record<string, ResultEntry> = {};

    for (const [key, { timings, mode, iterations }] of Object.entries(results)) {
      if (timings.length === 0) continue;
      const meanGrowthMB = timings.reduce((a, b) => a + b, 0) / timings.length;
      const externalPerReqKb = Number(((meanGrowthMB * 1024) / iterations).toFixed(2));
      entries[key] = buildResultEntry(timings, { mode, iterations, externalPerReqKb, unit: 'MB' });
    }

    writeResults(outputPath, { name: 'Runner Memory', unit: 'MB', direction: 'smaller' }, entries);
    console.log(`[BENCHMARK] Results written to ${outputPath}`);
  });
});
