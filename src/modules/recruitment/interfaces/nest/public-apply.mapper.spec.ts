/**
 * 申请人响应映射测试（C5：preferences 补全 departmentName）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { toRecApplication } from './public-apply.nest.controller';

const ROW = {
  id: 'app-1',
  activityId: 'act-1',
  channelId: 'ch-1',
  status: 'SUBMITTED',
  departmentChoices: [
    { departmentId: 'dept-dev', order: 1 },
    { departmentId: 'dept-design', order: 2 },
  ],
  formRef: null,
  qualifySnapshot: { allowAdjustment: true, answers: { intro: 'hi' } },
  revisionNumber: 2,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-02T00:00:00Z',
} as unknown as Parameters<typeof toRecApplication>[0];

describe('toRecApplication（C5：departmentName 映射）', () => {
  it('传入活动部门目录 → preferences 携带 departmentName（按 departmentId 匹配）', () => {
    const view = toRecApplication(ROW, [
      { id: 'dept-dev', name: '研发部' },
      { id: 'dept-design', name: '设计部' },
    ]);
    const preferences = view.preferences as Array<{
      order: number | null;
      departmentId: string;
      departmentName: string | null;
    }>;
    assert.deepEqual(preferences, [
      { order: 1, departmentId: 'dept-dev', departmentName: '研发部' },
      { order: 2, departmentId: 'dept-design', departmentName: '设计部' },
    ]);
  });

  it('未传目录 → departmentName 为 null（不误造名称）', () => {
    const view = toRecApplication(ROW);
    const preferences = view.preferences as Array<{ departmentName: string | null }>;
    assert.equal(preferences[0]!.departmentName, null);
    assert.equal(preferences[1]!.departmentName, null);
  });

  it('未知 departmentId → departmentName 为 null', () => {
    const view = toRecApplication(ROW, [{ id: 'dept-other', name: '其他部' }]);
    const preferences = view.preferences as Array<{ departmentName: string | null }>;
    assert.equal(preferences[0]!.departmentName, null);
  });
});
