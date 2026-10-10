import assert from 'node:assert/strict';
import { test } from 'node:test';

import { escapeMd, formatDuration, formatTime, link, parseRange, parseTimeInput, progressBar, truncate } from '../src/ui/format.js';

test('formatTime', () => {
  assert.equal(formatTime(0), '0:00');
  assert.equal(formatTime(83), '1:23');
  assert.equal(formatTime(3725), '1:02:05');
  assert.equal(formatTime(NaN), '0:00');
  assert.equal(formatTime(-5), '0:00');
});

test('formatDuration', () => {
  assert.equal(formatDuration(59), '1m');
  assert.equal(formatDuration(3720), '1h 2m');
  assert.equal(formatDuration(90000), '1d 1h');
});

test('progressBar fills proportionally', () => {
  assert.equal(progressBar(0, 100, 10), '▱▱▱▱▱▱▱▱▱▱');
  assert.equal(progressBar(50, 100, 10), '▰▰▰▰▰▱▱▱▱▱');
  assert.equal(progressBar(150, 100, 10), '▰▰▰▰▰▰▰▰▰▰');
  assert.equal(progressBar(10, 0), '');
});

test('parseTimeInput handles absolute, relative and unit formats', () => {
  assert.deepEqual(parseTimeInput('1:23'), { seconds: 83, relative: false });
  assert.deepEqual(parseTimeInput('83'), { seconds: 83, relative: false });
  assert.deepEqual(parseTimeInput('1:02:03'), { seconds: 3723, relative: false });
  assert.deepEqual(parseTimeInput('+30'), { seconds: 30, relative: true });
  assert.deepEqual(parseTimeInput('-15'), { seconds: -15, relative: true });
  assert.deepEqual(parseTimeInput('1m30s'), { seconds: 90, relative: false });
  assert.equal(parseTimeInput('abc'), null);
  assert.equal(parseTimeInput(''), null);
});

test('parseRange', () => {
  assert.deepEqual(parseRange('3'), [2, 2]);
  assert.deepEqual(parseRange('3-7'), [2, 6]);
  assert.deepEqual(parseRange('3 – 7'), [2, 6]);
  assert.equal(parseRange('7-3'), null);
  assert.equal(parseRange('0'), null);
  assert.equal(parseRange('song'), null);
});

test('escapeMd neutralises markdown in titles', () => {
  assert.equal(escapeMd('*NSYNC [Live]'), '\\*NSYNC \\[Live\\]');
  assert.equal(escapeMd('# Not a header'), '\\# Not a header');
  assert.ok(!escapeMd('see https://x.y').includes('https://'));
});

test('link escapes the title and protects the URL', () => {
  assert.equal(link('a]b', 'https://x.com/a)b'), '[a\\]b](https://x.com/a%29b)');
  assert.equal(link('plain', null), 'plain');
});

test('truncate', () => {
  assert.equal(truncate('hello world', 6), 'hello…');
  assert.equal(truncate('hi', 6), 'hi');
});
