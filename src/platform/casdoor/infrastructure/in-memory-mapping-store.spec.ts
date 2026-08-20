import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { InMemoryMappingStore } from './in-memory-mapping-store';
import type { GroupMapping, SubjectMapping } from '../contracts/types';

const now = '2026-08-20T00:00:00.000Z';

function subjectMapping(localSubjectId: string, externalSubjectId: string): SubjectMapping {
  return {
    localSubjectId,
    externalSubjectId,
    instance: 'https://cas.example',
    status: 'BOUND',
    firstVerifiedAt: now,
    lastVerifiedAt: now,
    history: [],
  };
}

function groupMapping(localObjectRef: string, name: string): GroupMapping {
  return {
    localObjectRef,
    externalRef: { owner: 'o', name },
    purpose: 'SCHOOL',
    status: 'BOUND',
    lastVerifiedAt: now,
    history: [],
  };
}

describe('InMemoryMappingStore', () => {
  it('主体换绑后旧外部 id 的反向映射被清理', async () => {
    const store = new InMemoryMappingStore();
    await store.saveSubjectMapping(subjectMapping('u1', 'cas-a'));
    assert.equal((await store.findSubjectMappingByExternal('cas-a'))?.localSubjectId, 'u1');

    await store.saveSubjectMapping(subjectMapping('u1', 'cas-b'));
    assert.equal(await store.findSubjectMappingByExternal('cas-a'), null);
    assert.equal((await store.findSubjectMappingByExternal('cas-b'))?.localSubjectId, 'u1');
    assert.equal((await store.findSubjectMapping('u1'))?.externalSubjectId, 'cas-b');
  });

  it('主体换绑不影响指向同一外部 id 的其他本地主体', async () => {
    const store = new InMemoryMappingStore();
    await store.saveSubjectMapping(subjectMapping('u1', 'cas-a'));
    await store.saveSubjectMapping(subjectMapping('u2', 'cas-a'));

    await store.saveSubjectMapping(subjectMapping('u1', 'cas-b'));
    assert.equal((await store.findSubjectMappingByExternal('cas-a'))?.localSubjectId, 'u2');
  });

  it('Group 换绑后旧外部 ref 的反向映射被清理', async () => {
    const store = new InMemoryMappingStore();
    await store.saveGroupMapping(groupMapping('L1', 'g1'));
    assert.equal(
      (await store.findGroupMappingByExternal({ owner: 'o', name: 'g1' }))?.localObjectRef,
      'L1',
    );

    await store.saveGroupMapping(groupMapping('L1', 'g2'));
    assert.equal(await store.findGroupMappingByExternal({ owner: 'o', name: 'g1' }), null);
    assert.equal(
      (await store.findGroupMappingByExternal({ owner: 'o', name: 'g2' }))?.localObjectRef,
      'L1',
    );
  });
});
