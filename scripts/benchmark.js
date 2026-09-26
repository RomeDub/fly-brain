import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';

const url = process.env.BENCH_URL || 'http://127.0.0.1:4173/fly-brain/?flies=1';
const runs = Number(process.env.BENCH_RUNS || 10);
const warmupMs = 8000;
const sampleMs = 12000;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const totals = new Map();
const samples = [];

function add(map, key, value) {
  const v = map.get(key) || { samples: 0, total: 0 };
  v.samples += 1;
  v.total += value;
  map.set(key, v);
}

const browser = await chromium.launch({ headless: true, args: ['--use-gl=swiftshader', '--disable-gpu-sandbox'] });
try {
  for (let run = 1; run <= runs; run++) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
    const client = await page.context().newCDPSession(page);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.waitForFunction(() => window.__arena?.renderer && window.__arena?.flies?.some(f => f.ready), null, { timeout: 120000 });
    await page.locator('#play').click();
    await sleep(warmupMs);

    await page.evaluate(() => {
      window.__bench = { frames: 0, renderMs: 0, shadowUpdates: 0, brainUploads: 0, brainDraws: 0 };
      const tick = () => {
        const a = window.__arena;
        if (a?.metrics) {
          window.__bench.renderMs += Number(a.metrics.renderMs) || 0;
          window.__bench.shadowUpdates = Number(a.metrics.shadowUpdates) || 0;
          window.__bench.brainUploads = Number(a.metrics.brainUploads) || 0;
          window.__bench.brainDraws = Number(a.metrics.brainDraws) || 0;
        }
        window.__bench.frames++;
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });

    await client.send('Profiler.enable');
    await client.send('Profiler.start', { samplingInterval: 1000 });
    const start = Date.now();
    const before = await page.evaluate(() => ({ simTime: window.__arena.flies[0]?.last?.t || 0 }));
    await sleep(sampleMs);
    const profile = await client.send('Profiler.stop');
    const elapsed = Date.now() - start;
    const after = await page.evaluate(() => ({
      simTime: window.__arena.flies[0]?.last?.t || 0,
      bench: { ...window.__bench },
    }));

    const profileSamples = profile.profile?.samples || [];
    const nodes = new Map((profile.profile?.nodes || []).map(n => [n.id, n]));
    for (const id of profileSamples) {
      const node = nodes.get(id);
      if (!node) continue;
      const key = `${node.callFrame.url || '<native>'} :: ${node.callFrame.functionName || '<anonymous>'}`;
      add(totals, key, 1);
    }

    const frameCount = after.bench.frames;
    const row = {
      run,
      elapsedMs: elapsed,
      frames: frameCount,
      fps: frameCount / (elapsed / 1000),
      simMsPerWallMs: (after.simTime - before.simTime) / elapsed,
      renderMsPerFrame: after.bench.renderMs / Math.max(1, frameCount),
      shadowUpdatesPerSec: after.bench.shadowUpdates / (elapsed / 1000),
      brainUploadsPerSec: after.bench.brainUploads / (elapsed / 1000),
      brainDrawsPerSec: after.bench.brainDraws / (elapsed / 1000),
    };
    samples.push(row);
    await page.close();
    console.log(`run ${run}/${runs}: ${JSON.stringify(row)}`);
  }
} finally {
  await browser.close();
}

const mean = key => samples.reduce((s, r) => s + r[key], 0) / samples.length;
const result = {
  url,
  runs,
  warmupMs,
  sampleMs,
  averages: Object.fromEntries(['fps', 'simMsPerWallMs', 'renderMsPerFrame', 'shadowUpdatesPerSec', 'brainUploadsPerSec', 'brainDrawsPerSec'].map(k => [k, mean(k)])),
  runs: samples,
  hottestFunctions: [...totals.entries()].sort((a, b) => b[1].total - a[1].total).slice(0, 30).map(([fn, v]) => ({ function: fn, samples: v.total })),
};
writeFileSync('benchmark-results.json', JSON.stringify(result, null, 2));
console.log('BENCHMARK_RESULT=' + JSON.stringify(result));
