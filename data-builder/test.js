'use strict';
/* Tests for the precomputed data bundle path.
   Runs app.js's loadDate() in a stubbed DOM + mocked fetch, using the real
   data/2026-10-16.json built by data-builder. Verifies:
   1. Only ~2 fetches happen (data JSON + sims JSON), not ~300.
   2. state.games / state.skaters populate correctly.
   3. Key renderers produce output (slate, board, markets, ice breaker).
   4. Fallback: when data JSON 404s, the live path is attempted. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SITE = path.resolve(__dirname, '..');
const BUNDLE = JSON.parse(fs.readFileSync(path.join(SITE, 'data', '2026-10-16.json'), 'utf8'));

// ---- permissive DOM stub ----
function mkEl(id) {
  const el = {
    id, innerHTML: '', textContent: '', value: '',
    dataset: {}, style: {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    addEventListener() {}, removeEventListener() {},
    querySelectorAll() { return []; },
    querySelector() { return null; },
    appendChild() {}, setAttribute() {}, getAttribute() { return null; },
  };
  return el;
}
const els = {};
function $(id) {
  if (!els[id]) els[id] = mkEl(id);
  return els[id];
}

let fetchCount = 0;
const fetchUrls = [];
async function mockFetch(url, opts) {
  fetchCount++;
  fetchUrls.push(String(url));
  const u = String(url);
  if (u.includes('data/2026-10-16.json')) {
    return { ok: true, json: async () => BUNDLE };
  }
  if (u.includes('sims/2026-10-16.json')) {
    return { ok: false, status: 404, json: async () => ({}) };
  }
  throw new Error('unexpected fetch in bundle mode: ' + u);
}

const sandbox = {
  console,
  setInterval: () => 0, clearInterval: () => {},
  setTimeout: (fn) => 0, clearTimeout: () => {},
  fetch: mockFetch,
  localStorage: {
    _m: {}, getItem(k) { return this._m[k] || null; },
    setItem(k, v) { this._m[k] = String(v); }, removeItem(k) { delete this._m[k]; },
    key(i) { return Object.keys(this._m)[i] || null; },
    get length() { return Object.keys(this._m).length; },
  },
  document: {
    getElementById: (id) => $(id),
    querySelectorAll: () => [],
    querySelector: () => null,
    addEventListener: () => {},
    hidden: false,
  },
  window: {},
  location: { search: '' },
  URLSearchParams: URLSearchParams,
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

// load engine.js then app.js
for (const f of ['engine.js', 'app.js']) {
  const code = fs.readFileSync(path.join(SITE, f), 'utf8');
  vm.runInContext(code, sandbox, { filename: f });
}

let pass = 0, fail = 0;
const t = async (name, fn) => { try { await fn(); pass++; console.log('  ok:', name); } catch (e) { fail++; console.error('  FAIL:', name, '-', e.message); } };

(async () => {
  // explicitly load the test date (auto-boot uses the stubbed picker value)
  fetchCount = 0; fetchUrls.length = 0;
  await vm.runInContext(`loadDate('2026-10-16')`, sandbox);
  await new Promise((r) => setTimeout(r, 200));

  await t('bundle mode: ~2 fetches, not ~300', () => {
    assert.ok(fetchCount <= 5, `expected <=5 fetches, got ${fetchCount}: ${fetchUrls.join(', ')}`);
    assert.ok(fetchUrls.some((u) => u.includes('data/2026-10-16.json')), 'data bundle fetched');
  });

  await t('state.games populated from bundle', () => {
    const games = vm.runInContext('state.games', sandbox);
    assert.strictEqual(games.length, 2, `expected 2 games, got ${games.length}`);
    assert.strictEqual(games[0].away, 'PIT');
    assert.strictEqual(games[0].home, 'COL');
  });

  await t('state.skaters populated with model outputs', () => {
    const skaters = vm.runInContext('state.skaters', sandbox);
    assert.ok(skaters.length > 50, `expected 50+ skaters, got ${skaters.length}`);
    const r = skaters[0];
    assert.ok(r.p > 0 && r.p < 1, 'probability in range');
    assert.ok(r.lam > 0, 'lambda positive');
    assert.ok(r.fair, 'fair odds present');
    assert.ok(r.zone && typeof r.zone.share === 'number', 'zone share present');
    assert.ok(Array.isArray(r.factors) && r.factors.length > 0, 'factors present');
  });

  await t('standings cache populated (no fetch on matchup)', () => {
    const sc = vm.runInContext('state.standingsCache', sandbox);
    assert.ok(sc && sc.key === '2026-10-16', 'standings cached for date');
    assert.ok(sc.map.COL && typeof sc.map.COL.wins === 'number', 'COL standings present');
  });

  await t('player cache pre-populated from bundle', () => {
    const n = vm.runInContext('state.playerCache.size', sandbox);
    assert.ok(n > 50, `expected 50+ cached players, got ${n}`);
  });

  await t('renderers produce output', () => {
    vm.runInContext('renderAll()', sandbox);
    assert.ok($('gamesGrid').innerHTML.length > 100, 'slate rendered');
    assert.ok($('boardBody').innerHTML.length > 100, 'board rendered');
  });

  await t('markets view renders (goal markets)', () => {
    vm.runInContext(`setMarketKind('atg'); setMarketKind('twoplus'); setMarketKind('firstgoal');`, sandbox);
    // no throw = pass
  });

  await t('ice breaker spotlight renders', () => {
    vm.runInContext(`setMarketKind('firstgoal');`, sandbox);
    const html = $('iceSpotWrap').innerHTML;
    assert.ok(html.length > 50, 'ice breaker spotlight rendered');
  });

  await t('matchup card renders with standings', () => {
    const gid = vm.runInContext('state.games[0].id', sandbox);
    vm.runInContext(`openMatchup('${gid}')`, sandbox);
    const html = $('matchupBody').innerHTML;
    assert.ok(html.includes('Tale of the tape'), 'tale of the tape present');
    assert.ok($('matchupModal'), 'modal exists');
  });

  await t('fallback: missing bundle attempts live API', async () => {
    fetchCount = 0; fetchUrls.length = 0;
    const origFetch = sandbox.fetch;
    sandbox.fetch = async (url) => {
      fetchCount++; fetchUrls.push(String(url));
      const u = String(url);
      if (u.includes('data/')) return { ok: false, status: 404, json: async () => ({}) };
      if (u.includes('/schedule/2026-10-16')) return { ok: true, json: async () => BUNDLE.games ? { gameWeek: [{ date: '2026-10-16', games: [] }] } : {} };
      throw new Error('stop-after-schedule:' + u);
    };
    try {
      await vm.runInContext(`loadDate('2026-10-16').catch(() => {})`, sandbox);
    } catch (e) { /* expected: we throw to stop the cascade */ }
    assert.ok(fetchUrls.some((u) => u.includes('/nhl-api/schedule/2026-10-16') || u.includes('/schedule/2026-10-16')),
      'fell back to live schedule fetch: ' + fetchUrls.join(', '));
    sandbox.fetch = origFetch;
  });

  console.log(`\ndone: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
