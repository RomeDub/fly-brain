import { chromium } from 'playwright';

const url = process.env.BENCH_URL || 'http://127.0.0.1:4173/fly-brain/?flies=1';
const runs = Number(process.env.BENCH_RUNS || 10);
const warmupMs = 8000;
const sampleMs = 12000;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const totals = new Map();
const frameSamples = [];

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

    await client.send('Profiler.enable');
    await client.send('Profiler.start', { samplingInterval: 1000 });
    const start = Date.now();
    const before = await page.evaluate(() => ({
      calls: window.__arena.renderer.info.render.calls,
      triangles: window.__arena.renderer.info.render.triangles,
      simTime: window.__arena.flies[0]?.last?.t || 0,
    }));
    await sleep(sampleMs);
    const profile = await client.send('Profiler.stop');
    const elapsed = Date.now() - start;
    const after = await page.evaluate(() => ({
      calls: window.__arena.renderer.info.render.calls,
      triangles: window.__arena.renderer.info.render.triangles,
      simTime: window.__arena.flies[0]?.last?.t || 0,
      metrics: { ...window.__arena.metrics },
    }));

    const samples = profile.profile?.samples || [];
    const nodes = new Map((profile.profile?.nodes || []).map(n => [n.id, n]));
    for (const id of samples) {
      const node = nodes.get(id);
      if (!node) continue;
      const key = `${node.callFrame.url || '<native>'} :: ${node.callFrame.functionName || '<anonymous>'}`;
      add(totals, key, 1);
    }

    frameSamples.push({
      run,
      elapsedMs: elapsed,
      renderCalls: after.calls - before.calls,
      renderCallsPerSec: (after.calls - before.calls) / (elapsed / 1000),
      trianglesPerFrame: (after.triangles - before.triangles) / Math.max(1, after.calls - before.calls),
      simMsPerWallMs: (after.simTime - before.simTime) / elapsed,
      renderMs: after.metrics.renderMs,
      shadowUpdates: after.metrics.shadowUpdates,
      brainUploads: after.metrics.brainUploads,
      brainDraws: after.metrics.brainDraws,
    });
    await page.close();
    console.log(`run ${run}/${runs}: ${JSON.stringify(frameSamples.at(-1))}`);
  }
} finally {
  await browser.close();
}

const top = [...totals.entries()]
  .sort((a, b) => b[1].total - a[1].total)
  .slice(0, 20)
  .map(([key, v]) => ({ function: key, samples: v.total }));

const mean = key => frameSamples.reduce((s, r) => s + r[key], 0) / frameSamples.length;
const result = {
  url,
  runs,
  warmupMs,
  sampleMs,
  averages: Object.fromEntries(['renderCallsPerSec', 'trianglesPerFrame', 'simMsPerWallMs', 'renderMs', 'shadowUpdates', 'brainUploads', 'brainDraws'].map(k => [k, mean(k)])),
  runs: frameSamples,
  hottestFunctions: top,
};
console.log('BENCHMARK_RESULT=' + JSON.stringify(result));
