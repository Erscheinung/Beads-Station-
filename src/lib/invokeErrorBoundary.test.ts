import { describe, it, expect, beforeEach } from 'vitest';
import { pushInvokeToast, peekToasts, clearToasts, dismissToast } from './invokeErrorBoundary';

// RV3.1 — the toast store must survive a bd fork-exhaustion storm: identical
// messages coalesce (count++) and the total is hard-capped, so hundreds of
// "invoke bd_list failed" failures can never bury the UI / lock out Esc+i.

describe('invoke toast store — storm resilience', () => {
  beforeEach(() => clearToasts());

  it('coalesces identical messages into one toast with a count', () => {
    for (let i = 0; i < 50; i++) {
      pushInvokeToast('invoke bd_list failed: fork: Resource temporarily unavailable', 'detail');
    }
    const live = peekToasts();
    expect(live).toHaveLength(1);
    expect(live[0].count).toBe(50);
  });

  it('keeps distinct messages separate', () => {
    pushInvokeToast('invoke bd_list failed', 'd');
    pushInvokeToast('invoke bd_ready failed', 'd');
    pushInvokeToast('invoke bd_counts failed', 'd');
    expect(peekToasts()).toHaveLength(3);
  });

  it('hard-caps distinct toasts at MAX_TOASTS (6), dropping oldest', () => {
    for (let i = 0; i < 20; i++) {
      pushInvokeToast(`distinct error #${i}`, 'd');
    }
    const live = peekToasts();
    expect(live.length).toBe(6);
    // Oldest dropped — the last-6 distinct survive.
    expect(live[0].message).toBe('distinct error #14');
    expect(live[5].message).toBe('distinct error #19');
  });

  it('a mixed storm (few distinct, many repeats) never exceeds the cap', () => {
    for (let i = 0; i < 500; i++) {
      // 4 distinct messages, hammered.
      pushInvokeToast(`invoke bd_${['list', 'ready', 'counts', 'show'][i % 4]} failed`, 'd');
    }
    const live = peekToasts();
    expect(live.length).toBe(4);
    // Each got ~125 coalesced hits.
    expect(live.reduce((s, t) => s + t.count, 0)).toBe(500);
  });

  it('dismiss removes a single coalesced toast', () => {
    pushInvokeToast('boom', 'd');
    pushInvokeToast('boom', 'd');
    const id = peekToasts()[0].id;
    dismissToast(id);
    expect(peekToasts()).toHaveLength(0);
  });
});
