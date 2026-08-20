import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { CasdoorReadService } from './casdoor-read.service';
import { InMemoryCasdoorStore } from '../infrastructure/in-memory-casdoor-store';
import { InMemoryMappingStore } from '../infrastructure/in-memory-mapping-store';
import { groupRefKey } from '../contracts/types';
import type { ClockPort } from '../contracts/ports';

const fixedNow = new Date('2026-08-20T10:00:00.000Z');
const clock: ClockPort = { now: () => fixedNow };

function makeService() {
  const store = new InMemoryCasdoorStore({
    users: [
      {
        externalId: 'cas-u1',
        name: 'Alice',
        state: 'ACTIVE',
        version: 'v1',
      },
    ],
    groups: [
      {
        ref: { owner: 'o', name: 'g' },
        displayName: 'G',
        parentRef: null,
        memberIds: ['cas-u1'],
        state: 'ACTIVE',
      },
    ],
  });
  const mappings = new InMemoryMappingStore();
  const service = new CasdoorReadService(store, mappings, clock);
  return { store, mappings, service };
}

describe('CasdoorReadService', () => {
  it('解析并绑定当前身份，保存稳定映射', async () => {
    const { mappings, service } = makeService();
    const result = await service.resolveAndBindCurrentIdentity({
      tokenClaims: { sub: 'cas-u1', iss: 'https://cas.example', aud: 'rana' },
      expectedIssuer: 'https://cas.example',
      expectedAudience: 'rana',
      localSubjectId: 'u1',
      trackingId: 'tr-1',
    });
    assert.equal(result.status, 'TRUSTED_CURRENT');
    assert.equal(result.value?.externalSubjectId, 'cas-u1');
    const saved = await mappings.findSubjectMapping('u1');
    assert.equal(saved?.externalSubjectId, 'cas-u1');
  });

  it('读回并登记主体当前 Group 关系', async () => {
    const { mappings, service } = makeService();
    const result = await service.readAndStoreUserGroups({
      localSubjectId: 'u1',
      externalUserId: 'cas-u1',
      trackingId: 'tr-2',
    });
    assert.equal(result.status, 'TRUSTED_CURRENT');
    const relations = await mappings.listRelationsBySubject('u1');
    assert.equal(relations.length, 1);
    assert.equal(relations[0]?.groupRef.name, 'g');
  });

  it('读回后陈旧 Group 关系标记为非当前，不残留为当前关系', async () => {
    const store = new InMemoryCasdoorStore({
      users: [{ externalId: 'cas-u1', name: 'Alice', state: 'ACTIVE' }],
      groups: [
        {
          ref: { owner: 'o', name: 'g1' },
          displayName: 'G1',
          parentRef: null,
          memberIds: ['cas-u1'],
          state: 'ACTIVE',
        },
        {
          ref: { owner: 'o', name: 'g2' },
          displayName: 'G2',
          parentRef: null,
          memberIds: ['cas-u1'],
          state: 'ACTIVE',
        },
      ],
    });
    const mappings = new InMemoryMappingStore();
    const service = new CasdoorReadService(store, mappings, clock);

    await service.readAndStoreUserGroups({
      localSubjectId: 'u1',
      externalUserId: 'cas-u1',
      trackingId: 'tr-6',
    });
    let relations = await mappings.listRelationsBySubject('u1');
    assert.equal(relations.length, 2);
    assert.ok(relations.every((r) => r.current));

    // 外部 g2 关系被移除后再次读回，g2 关系应标记为非当前
    const g2 = store.groups.get(groupRefKey({ owner: 'o', name: 'g2' }));
    store.groups.set(groupRefKey({ owner: 'o', name: 'g2' }), { ...g2!, memberIds: [] });

    await service.readAndStoreUserGroups({
      localSubjectId: 'u1',
      externalUserId: 'cas-u1',
      trackingId: 'tr-7',
    });
    relations = await mappings.listRelationsBySubject('u1');
    assert.equal(relations.length, 2);
    assert.equal(relations.find((r) => r.groupRef.name === 'g1')?.current, true);
    assert.equal(relations.find((r) => r.groupRef.name === 'g2')?.current, false);
  });

  it('重新认证证据过期 → 拒绝', () => {
    const { service } = makeService();
    const result = service.verifyReauthentication({
      authTime: new Date(fixedNow.getTime() - 11 * 60 * 1000).toISOString(),
      requiredFreshnessMs: 10 * 60 * 1000,
      mfaRequired: false,
      mfaVerified: false,
      subjectId: 'u1',
      bindingSubjectId: 'u1',
      trackingId: 'tr-3',
    });
    assert.equal(result.status, 'NOT_FOUND');
    assert.match(result.error?.message ?? '', /过期/);
  });

  it('重新认证证据时间戳来自未来 → 拒绝（CAS-READ-006）', () => {
    const { service } = makeService();
    const result = service.verifyReauthentication({
      // 超过 5 分钟时钟偏移容忍上限，视为伪造/时钟偏移
      authTime: new Date(fixedNow.getTime() + 10 * 60 * 1000).toISOString(),
      requiredFreshnessMs: 10 * 60 * 1000,
      mfaRequired: false,
      mfaVerified: false,
      subjectId: 'u1',
      bindingSubjectId: 'u1',
      trackingId: 'tr-4',
    });
    assert.equal(result.status, 'NOT_FOUND');
    assert.match(result.error?.code ?? '', /REAUTH_FUTURE/);
  });

  it('重新认证证据在容忍窗口内的未来偏移 → 通过', () => {
    const { service } = makeService();
    const result = service.verifyReauthentication({
      authTime: new Date(fixedNow.getTime() + 60 * 1000).toISOString(),
      requiredFreshnessMs: 10 * 60 * 1000,
      mfaRequired: false,
      mfaVerified: false,
      subjectId: 'u1',
      bindingSubjectId: 'u1',
      trackingId: 'tr-5',
    });
    assert.equal(result.status, 'TRUSTED_CURRENT');
  });
});
