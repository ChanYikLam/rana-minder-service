import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { WatermarkPolicy } from './watermark-policy';

describe('WatermarkPolicy（GOV-008/AUD-004：敏感附件默认加查看者与时间水印）', () => {
  const policy = new WatermarkPolicy();

  it('敏感标记 → 必须加水印，内容含查看者（脱敏）与时间', () => {
    const d = policy.decide('GENERIC', 'resume', true, 'u1', '2026-08-21T06:00:00.000Z');
    assert.equal(d.required, true);
    assert.ok(d.content.includes('u1')); // 脱敏后仍含前缀，便于追溯
    assert.ok(d.content.includes('2026-08-21T06:00:00.000Z'));
  });

  it('水印对查看者标识脱敏：不泄露完整 principalId', () => {
    const longId = 'internal-user-42-abcdef';
    const d = policy.decide('PHOTO', 'other', false, longId, 'x');
    assert.equal(d.required, true);
    assert.ok(d.content.includes(longId.slice(0, 4)));
    assert.ok(!d.content.includes(longId)); // 完整标识不得出现在水印中
    assert.ok(d.content.includes('****'));
  });

  it('招新报名/面试材料字段键 → 即使未标记也触发水印', () => {
    assert.equal(policy.decide('GENERIC', 'interviewMaterial', false, 'u1', 'x').required, true);
    assert.equal(policy.decide('GENERIC', 'idPhoto', false, 'u1', 'x').required, true);
  });

  it('普通文件（非敏感类别/字段/标记）→ 不加水印', () => {
    assert.equal(policy.decide('VIDEO', 'activityVideo', false, 'u1', 'x').required, false);
  });

  it('字段键等值匹配：前缀相似的普通字段键（如 photocopier）不误触发水印', () => {
    // 此前用 startsWith 前缀匹配，photo 会误匹配 photocopier；改为等值匹配后不再误伤
    assert.equal(policy.decide('GENERIC', 'photocopier', false, 'u1', 'x').required, false);
  });

  it('照片类别默认敏感（水印）', () => {
    assert.equal(policy.decide('PHOTO', 'other', false, 'u1', 'x').required, true);
  });
});
