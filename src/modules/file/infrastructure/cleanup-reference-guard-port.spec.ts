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
  it('占位实现默认无活动引用（开发期放行物理删除）', async () => {
    const guard = new LogOnlyCleanupReferenceGuard();
    assert.equal(await guard.hasActiveReference(loc), false);
  });
});
