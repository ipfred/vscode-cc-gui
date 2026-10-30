import { afterEach, describe, expect, it } from 'vitest';
import type { ClaudeMessage } from '../types';
import { addLocalNotice, clearLocalNotices, getLocalNotices, placeLocalNotices } from './localNotices';

const msg = (timestamp?: string): ClaudeMessage => ({ type: 'assistant', content: 'x', timestamp });

afterEach(() => {
  clearLocalNotices();
});

describe('placeLocalNotices', () => {
  it('places each notice after the last message that is not newer than it', () => {
    const messages = [
      msg('2026-01-01T00:00:00.000Z'),
      msg('2026-01-01T00:00:10.000Z'),
      msg(undefined),
      msg('2026-01-01T00:00:30.000Z'),
    ];
    const early = addLocalNotice('early', Date.parse('2026-01-01T00:00:05.000Z'));
    const middle = addLocalNotice('middle', Date.parse('2026-01-01T00:00:20.000Z'));
    const late = addLocalNotice('late', Date.parse('2026-01-01T00:01:00.000Z'));

    const placement = placeLocalNotices(messages, getLocalNotices());
    expect(placement.get(1)).toEqual([early]);
    // The untimestamped message inherits the previous time, so "middle" follows it.
    expect(placement.get(3)).toEqual([middle]);
    expect(placement.get(4)).toEqual([late]);
  });

  it('puts notices at the start of an empty conversation', () => {
    const notice = addLocalNotice('switched');
    expect(placeLocalNotices([], getLocalNotices()).get(0)).toEqual([notice]);
  });

  it('clears notices', () => {
    addLocalNotice('a');
    clearLocalNotices();
    expect(getLocalNotices()).toEqual([]);
  });
});
