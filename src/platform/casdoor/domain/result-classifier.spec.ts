import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { classifyMembershipReadback, classifyProfileReadback } from './result-classifier';

describe('Casdoor 写后读回分类', () => {
  it('读回目标集合 → TARGET', () => {
    assert.equal(
      classifyMembershipReadback({
        originalMemberIds: ['a'],
        expectedMemberIds: ['a', 'b'],
        readbackMemberIds: ['a', 'b'],
        readbackStatus: 'TRUSTED_CURRENT',
      }),
      'TARGET',
    );
  });

  it('读回原集合 → ORIGINAL', () => {
    assert.equal(
      classifyMembershipReadback({
        originalMemberIds: ['a'],
        expectedMemberIds: ['a', 'b'],
        readbackMemberIds: ['a'],
        readbackStatus: 'TRUSTED_CURRENT',
      }),
      'ORIGINAL',
    );
  });

  it('读回第三值 → THIRD，不自动覆盖', () => {
    assert.equal(
      classifyMembershipReadback({
        originalMemberIds: ['a'],
        expectedMemberIds: ['a', 'b'],
        readbackMemberIds: ['a', 'x'],
        readbackStatus: 'TRUSTED_CURRENT',
      }),
      'THIRD',
    );
  });

  it('部分命中目标且缺目标成员 → PARTIAL', () => {
    assert.equal(
      classifyMembershipReadback({
        originalMemberIds: ['a'],
        expectedMemberIds: ['a', 'b', 'c'],
        readbackMemberIds: ['a', 'b'],
        readbackStatus: 'TRUSTED_CURRENT',
      }),
      'PARTIAL',
    );
  });

  it('响应不确定 → UNKNOWN', () => {
    assert.equal(
      classifyMembershipReadback({
        originalMemberIds: ['a'],
        expectedMemberIds: ['b'],
        readbackMemberIds: null,
        readbackStatus: 'UNCERTAIN',
      }),
      'UNKNOWN',
    );
  });

  it('资料字段读回目标/原值/第三值', () => {
    const base = {
      originalValue: 'old',
      expectedValue: 'new',
    };
    assert.equal(
      classifyProfileReadback({ ...base, readbackValue: 'new', readbackStatus: 'TRUSTED_CURRENT' }),
      'TARGET',
    );
    assert.equal(
      classifyProfileReadback({ ...base, readbackValue: 'old', readbackStatus: 'TRUSTED_CURRENT' }),
      'ORIGINAL',
    );
    assert.equal(
      classifyProfileReadback({
        ...base,
        readbackValue: 'other',
        readbackStatus: 'TRUSTED_CURRENT',
      }),
      'THIRD',
    );
  });
});
