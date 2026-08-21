import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { isGroupRefUniqueAcrossMappings, isSubjectMappingBindable } from './mapping-rules';

describe('Casdoor 稳定映射规则', () => {
  it('不能仅凭姓名或邮箱合并主体', () => {
    assert.deepEqual(isSubjectMappingBindable({ localSubjectId: 'u1', externalSubjectId: '' }), {
      ok: false,
      reason: '本地主体与外部稳定主体均不能为空',
    });
  });

  it('不允许同名不同 owner 的 Group 被当作全局唯一', () => {
    const result = isGroupRefUniqueAcrossMappings({ owner: 'o2', name: '同社团' }, [
      { externalRef: { owner: 'o1', name: '同社团' }, name: 'x' } as never,
    ]);
    assert.equal(result.ok, false);
  });

  it('有可验证外部身份证据时允许绑定', () => {
    assert.deepEqual(
      isSubjectMappingBindable({
        localSubjectId: 'u1',
        externalSubjectId: 'cas-u1',
        displayName: '张三',
      }),
      { ok: true },
    );
  });
});
