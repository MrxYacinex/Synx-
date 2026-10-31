import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ClockSync, expectedPosition, loopDiff, planCorrection } from '../../app/src/shared/sync';
import { parseReelUrl, isAllowedNavigation, platformForUrl } from '../../app/src/shared/reel';
import { normalizeRoomCode, isValidRoomCode } from '../../app/src/shared/protocol';

test('parseReelUrl understands Instagram, TikTok and YouTube Shorts', () => {
  assert.deepEqual(parseReelUrl('https://www.instagram.com/reel/C9xYz_AbC12/?igsh=abc'), {
    platform: 'instagram',
    id: 'C9xYz_AbC12',
    url: 'https://www.instagram.com/reels/C9xYz_AbC12/',
  });
  assert.equal(parseReelUrl('https://www.instagram.com/reels/DAbcdEf-123/')?.id, 'DAbcdEf-123');
  assert.equal(parseReelUrl('https://instagram.com/someone/reel/DAbcdEf123/')?.id, 'DAbcdEf123');
  assert.equal(parseReelUrl('https://www.instagram.com/reels/'), null);
  assert.equal(parseReelUrl('https://www.instagram.com/'), null);

  const tt = parseReelUrl('https://www.tiktok.com/@cool.user/video/7312345678901234567?lang=en');
  assert.equal(tt?.platform, 'tiktok');
  assert.equal(tt?.id, '7312345678901234567');
  assert.equal(tt?.url, 'https://www.tiktok.com/@cool.user/video/7312345678901234567');

  const yt = parseReelUrl('https://m.youtube.com/shorts/aBcD123_-xY?feature=share');
  assert.deepEqual(yt, { platform: 'youtube', id: 'aBcD123_-xY', url: 'https://m.youtube.com/shorts/aBcD123_-xY' });
  assert.equal(parseReelUrl('/shorts/aBcD123_-xY', 'https://www.youtube.com/')?.id, 'aBcD123_-xY');
  assert.equal(parseReelUrl('https://evil.com/reel/C9xYz_AbC12/'), null);
  assert.equal(parseReelUrl('not a url'), null);
});

test('navigation allow-list keeps users inside the chosen platform', () => {
  assert.equal(isAllowedNavigation('https://www.instagram.com/accounts/login/', 'instagram'), true);
  assert.equal(isAllowedNavigation('https://scontent.cdninstagram.com/x.mp4', 'instagram'), true);
  assert.equal(isAllowedNavigation('instagram://reel/123', 'instagram'), false);
  assert.equal(isAllowedNavigation('intent://foo#Intent;end', 'tiktok'), false);
  assert.equal(isAllowedNavigation('https://example.com', 'youtube'), false);
  assert.equal(isAllowedNavigation('about:blank', 'youtube'), true);
  assert.equal(platformForUrl('https://m.youtube.com/shorts/x'), 'youtube');
});

test('room codes', () => {
  assert.equal(normalizeRoomCode(' ab-cd e '), 'ABCDE');
  assert.equal(isValidRoomCode('ABCDE'), true);
  assert.equal(isValidRoomCode('ABCD0'), false);
  assert.equal(isValidRoomCode('ABCD'), false);
});

test('expectedPosition extrapolates and wraps loops', () => {
  const s = { playing: true, position: 2, refTime: 10_000, rate: 2, duration: 10 };
  assert.equal(expectedPosition(s, 11_000), 4);
  assert.equal(expectedPosition(s, 15_000), 2); // 2 + 10 = 12 -> wraps to 2
  assert.equal(expectedPosition({ ...s, playing: false }, 99_000), 2);
  assert.equal(expectedPosition({ ...s, duration: null }, 15_000), 12);
});

test('loopDiff takes the short way around the loop', () => {
  assert.ok(Math.abs(loopDiff(0.1, 9.9, 10) - 0.2) < 1e-9);
  assert.ok(Math.abs(loopDiff(9.9, 0.1, 10) + 0.2) < 1e-9);
  assert.equal(loopDiff(5, 3, null), 2);
});

test('planCorrection: seek on big drift, nudge on small, nothing when close', () => {
  assert.equal(planCorrection(3, 10, true, 1, false).kind, 'seek');
  const n = planCorrection(0.3, 10, true, 1, false);
  assert.equal(n.kind, 'nudge');
  assert.ok(n.kind === 'nudge' && n.rate > 1 && n.rate <= 1.12 + 1e-9);
  const behind = planCorrection(-0.3, 10, true, 2, false);
  assert.ok(behind.kind === 'nudge' && behind.rate < 2);
  assert.equal(planCorrection(0.05, 10, true, 1, false).kind, 'none');
  assert.equal(planCorrection(0.05, 10, true, 1, true).kind, 'nudge'); // hysteresis
  assert.equal(planCorrection(0.02, 10, true, 1, true).kind, 'none');
  assert.equal(planCorrection(0.5, 10, false, 1, false).kind, 'seek');
});

test('ClockSync prefers low-latency samples', () => {
  const c = new ClockSync();
  c.add(1000, 6050, 1100); // rtt 100, offset 5000
  c.add(2000, 7400, 2800); // rtt 800, offset 5000 -> noisy... make it skewed
  c.add(3000, 8900, 3600); // rtt 600, offset 5600 (asymmetric, bad)
  c.add(4000, 9010, 4020); // rtt 20, offset 5000
  assert.ok(Math.abs(c.offset - 5000) < 250);
  assert.equal(c.rtt, 20);
});
