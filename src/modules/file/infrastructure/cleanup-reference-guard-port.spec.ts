import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { LogOnlyCleanupReferenceGuard } from './cleanup-reference-guard-port';
import type { ObjectLocation } from '../domain/models/file-model';
import { BucketRole } from '../domain/models/file-model';

const loc: ObjectLocation = {
  bucketRole: BucketRole.OBJECT,
  keyVersion: 'v1',
  randomKey: 'rand-key',
  objectKind: 'OBJECT',
  actualSize: 100,
  sha256: 'sha',
  storageToken: 'tok',
};

describe('LogOnlyCleanupReferenceGuard（FORM-009 引用复核占位）', () => {
  it('占位 fail-closed：未接入真实引用核对前视为仍被引用（拒绝物理删除）', async () => {
    const guard = new LogOnlyCleanupReferenceGuard();
    assert.equal(await guard.hasActiveReference(loc), true, '占位期保守判定为仍被引用');
  });
});
