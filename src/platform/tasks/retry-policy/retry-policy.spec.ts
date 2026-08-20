import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  computeExponentialBackoffMs,
  computeLinearBackoffMs,
  canRetry,
  requiresManualIntervention,
  classifyFailure,
} from './retry-policy';

describe('computeExponentialBackoffMs', () => {
  it('attempt 0 -> baseMs', () => {
    assert.equal(computeExponentialBackoffMs(0, 1000, 60000), 1000);
  });
  it('attempt 1 -> 2x baseMs', () => {
    assert.equal(computeExponentialBackoffMs(1, 1000, 60000), 2000);
  });
  it('attempt 3 -> 8x baseMs', () => {
    assert.equal(computeExponentialBackoffMs(3, 1000, 60000), 8000);
  });
  it('attempt 6 -> capped maxMs', () => {
    assert.equal(computeExponentialBackoffMs(6, 1000, 60000), 60000);
  });
  it('negative attempt -> baseMs', () => {
    assert.equal(computeExponentialBackoffMs(-5, 1000, 60000), 1000);
  });
});

describe('computeLinearBackoffMs', () => {
  it('attempt 0 -> 0', () => {
    assert.equal(computeLinearBackoffMs(0, 5000, 60000), 0);
  });
  it('attempt 3 -> 15000', () => {
    assert.equal(computeLinearBackoffMs(3, 5000, 60000), 15000);
  });
  it('capped maxMs', () => {
    assert.equal(computeLinearBackoffMs(20, 5000, 60000), 60000);
  });
});

describe('canRetry', () => {
  it('attempts < maxAttempts', () => {
    assert.equal(canRetry(0, 5), true);
    assert.equal(canRetry(4, 5), true);
  });
  it('attempts >= maxAttempts', () => {
    assert.equal(canRetry(5, 5), false);
  });
});

describe('requiresManualIntervention', () => {
  it('attempts >= maxAttempts', () => {
    assert.equal(requiresManualIntervention(5, 5), true);
  });
  it('attempts < maxAttempts', () => {
    assert.equal(requiresManualIntervention(4, 5), false);
  });
});

describe('classifyFailure', () => {
  it('UNCERTAIN', () => {
    assert.equal(classifyFailure('UNCERTAIN'), 'EXTERNAL_UNCERTAIN');
  });
  it('LEASE', () => {
    assert.equal(classifyFailure('LEASE expired'), 'LEASE_EXPIRED');
  });
  it('PERMISSION', () => {
    assert.equal(classifyFailure('PERMISSION'), 'PERMISSION_DENIED');
  });
  it('VERSION', () => {
    assert.equal(classifyFailure('VERSION'), 'VERSION_STALE');
  });
  it('PRECONDITION', () => {
    assert.equal(classifyFailure('PRECONDITION'), 'PRECONDITION_REJECTED');
  });
  it('RETRY_LIMIT', () => {
    assert.equal(classifyFailure('RETRY_LIMIT'), 'RETRY_LIMIT_EXCEEDED');
  });
  it('unknown', () => {
    assert.equal(classifyFailure('unknown'), 'EXTERNAL_FAILED');
  });
});
