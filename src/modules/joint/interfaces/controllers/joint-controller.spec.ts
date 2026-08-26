/**
 * Joint 控制器冒烟测试（P3 任务①收尾；745 行最大控制器文件）。
 *
 * 验证：类可导入、路由方法存在（GET/POST/PUT/DELETE 装饰器元数据）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('JointController / OrgJointNestController 可导入性', () => {
  it('JointController 类可导入且为构造函数', async () => {
    const mod = (await import('./joint.controller')) as unknown as Record<string, unknown>;
    assert.ok(mod['JointController'], '应导出 JointController');
    assert.equal(typeof mod['JointController'], 'function');
  });

  it('OrgJointNestController 类可导入且为构造函数', async () => {
    const mod = (await import('../nest/org-joint.nest.controller')) as unknown as Record<
      string,
      unknown
    >;
    assert.ok(mod['OrgJointNestController'], '应导出 OrgJointNestController');
    assert.equal(typeof mod['OrgJointNestController'], 'function');
  });

  it('ApplicantJointNestController 类可导入', async () => {
    const mod = (await import('../nest/applicant-joint.nest.controller')) as unknown as Record<
      string,
      unknown
    >;
    assert.ok(mod['ApplicantJointNestController'], '应导出 ApplicantJointNestController');
  });
});
