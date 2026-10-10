import assert from 'node:assert/strict';
import { test } from 'node:test';

import { atempoChain, buildFilterChain, describeFilters, effectiveSpeed, LOUDNORM, sanitizeFilters, toggleFilter } from '../src/player/filters.js';

test('no filters → empty chain', () => {
  assert.equal(buildFilterChain({}), '');
});

test('normalization adds loudnorm at the end', () => {
  const chain = buildFilterChain({ filters: ['bassboost'], normalize: true });
  assert.ok(chain.startsWith('bass='));
  assert.ok(chain.endsWith(LOUDNORM));
});

test('filters in the same group replace each other', () => {
  let f = toggleFilter([], 'nightcore');
  f = toggleFilter(f, 'bassboost');
  f = toggleFilter(f, 'vaporwave');
  assert.deepEqual(f, ['bassboost', 'vaporwave']);
  assert.deepEqual(toggleFilter(f, 'bassboost'), ['vaporwave']);
  assert.deepEqual(sanitizeFilters(['nightcore', 'vaporwave', 'nope', 'echo']), ['vaporwave', 'echo']);
});

test('nightcore changes the sample rate (speed + pitch together)', () => {
  const chain = buildFilterChain({ filters: ['nightcore'] });
  assert.match(chain, /asetrate=60000/);
  assert.equal(effectiveSpeed({ filters: ['nightcore'] }), 1.25);
});

test('pitch shifts without changing speed', () => {
  const chain = buildFilterChain({ pitch: 2 });
  assert.match(chain, /asetrate=96000/);
  assert.match(chain, /atempo=0.5/);
  assert.equal(effectiveSpeed({ pitch: 2 }), 1);
});

test('speed uses atempo and counts toward effective speed', () => {
  assert.equal(buildFilterChain({ speed: 1.5 }), 'atempo=1.5');
  assert.equal(effectiveSpeed({ filters: ['vaporwave'], speed: 1.5 }), 0.8 * 1.5);
});

test('atempo is chained to stay within 0.5–2.0', () => {
  assert.deepEqual(atempoChain(4), ['atempo=2', 'atempo=2']);
  assert.deepEqual(atempoChain(3), ['atempo=2', 'atempo=1.5']);
  assert.deepEqual(atempoChain(0.25), ['atempo=0.5', 'atempo=0.5']);
  assert.deepEqual(atempoChain(1), []);
});

test('describeFilters is human friendly', () => {
  assert.deepEqual(describeFilters({ filters: ['bassboost'], speed: 1.25 }), ['🔊 Bass Boost', '⏩ 1.25x speed']);
});
