/**
 * 配置版本线单元测试（CFG-005，5.5.5；SRS-FAIL-013）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { ConfigRoot } from './config-version';

const NOW = new Date('2026-01-01T00:00:00Z');
const LATER = new Date('2026-01-02T00:00:00Z');
const BY = 'sa-1';

function newRoot(kind: Parameters<typeof ConfigRoot.create>[0]['kind'] = 'FORM_TEMPLATE') {
  return ConfigRoot.create({ rootId: `root-${kind}`, kind, now: NOW, by: BY });
}

/** 主链路推进到 READY_TO_PUBLISH */
function toReady(
  root: ReturnType<typeof newRoot>,
  versionNumber: number,
  payload: Record<string, unknown>,
) {
  root.editDraft(versionNumber, payload, { by: BY, now: NOW });
  root.startTesting(versionNumber, { by: BY, now: NOW });
  root.markTestPassed(versionNumber, 'test-ref-1', { by: BY, now: NOW });
}

describe('ConfigRoot 初始态（CFG-005）', () => {
  it('create 后 v1 为 DRAFT、当前发布指针为 null', () => {
    const root = newRoot();
    const snap = root.toSnapshot();
    assert.equal(snap.versions.length, 1);
    assert.equal(snap.versions[0].versionNumber, 1);
    assert.equal(snap.versions[0].state, 'DRAFT');
    assert.equal(snap.currentPublishedVersionNumber, null);
    assert.equal(root.getCurrentPublished(), null);
  });
});

describe('草稿—测试—发布主链路（CFG-005）', () => {
  it('完整链路：editDraft→startTesting→markTestPassed→publish → PUBLISHED+指针切换+payload 冻结', () => {
    const root = newRoot();
    toReady(root, 1, { template: 'v1-content' });
    root.publish(1, {}, { by: BY, now: LATER });

    const published = root.getCurrentPublished();
    assert.ok(published);
    assert.equal(published.state, 'PUBLISHED');
    assert.equal(published.publishedBy, BY);
    assert.deepEqual(published.publishedAt, LATER);
    assert.equal(published.payload.template, 'v1-content');

    // payload 冻结：修改被拒绝（严格模式抛 TypeError），值保持不变
    assert.throws(() => {
      (published.payload as Record<string, unknown>).template = 'hacked';
    }, TypeError);
    const after = root.getCurrentPublished() as unknown as { payload: { template: string } };
    assert.equal(after.payload.template, 'v1-content');
  });

  it('状态守卫：editDraft 仅 DRAFT 可用，TESTING/READY_TO_PUBLISH/PUBLISHED 均 CFG_CONFLICT', () => {
    const root = newRoot();
    root.editDraft(1, { a: 1 }, { by: BY, now: NOW });
    root.startTesting(1, { by: BY, now: NOW });
    assert.throws(() => root.editDraft(1, { a: 2 }, { by: BY, now: NOW }), {
      code: 'CFG_CONFLICT',
    });

    root.markTestPassed(1, 'ref', { by: BY, now: NOW });
    assert.throws(() => root.editDraft(1, { a: 3 }, { by: BY, now: NOW }), {
      code: 'CFG_CONFLICT',
    });

    root.publish(1, {}, { by: BY, now: LATER });
    assert.throws(() => root.editDraft(1, { a: 4 }, { by: BY, now: LATER }), {
      code: 'CFG_CONFLICT',
    });
  });

  it('startTesting/markTestPassed/publish 的前置状态不符均 CFG_CONFLICT；markTestPassed 空凭证拒绝', () => {
    const root = newRoot();
    root.editDraft(1, {}, { by: BY, now: NOW });
    assert.throws(() => root.publish(1, {}, { by: BY, now: NOW }), { code: 'CFG_CONFLICT' });
    root.startTesting(1, { by: BY, now: NOW });
    assert.throws(() => root.markTestPassed(1, '', { by: BY, now: NOW }), {
      code: 'CFG_VALIDATION',
    });
    assert.throws(() => root.publish(1, {}, { by: BY, now: NOW }), { code: 'CFG_CONFLICT' });
    root.markTestPassed(1, 'ref', { by: BY, now: NOW });
    root.publish(1, {}, { by: BY, now: NOW });
    assert.throws(() => root.markTestPassed(1, 'ref2', { by: BY, now: NOW }), {
      code: 'CFG_CONFLICT',
    });
  });

  it('editDraft 拒绝非对象 payload（数组/标量/null）', () => {
    const root = newRoot();
    assert.throws(() => root.editDraft(1, [1, 2] as never, { by: BY, now: NOW }), {
      code: 'CFG_VALIDATION',
    });
    assert.throws(() => root.editDraft(1, null as never, { by: BY, now: NOW }), {
      code: 'CFG_VALIDATION',
    });
    assert.throws(() => root.editDraft(1, 'x' as never, { by: BY, now: NOW }), {
      code: 'CFG_VALIDATION',
    });
  });
});

describe('高风险配置二次确认（CFG-005）', () => {
  it('PERMISSION_TEMPLATE/FIELD_MAPPING 缺 impactSummary 或 confirmation → CFG_PRECONDITION', () => {
    for (const kind of ['PERMISSION_TEMPLATE', 'FIELD_MAPPING'] as const) {
      const root = newRoot(kind);
      toReady(root, 1, {});
      assert.throws(() => root.publish(1, {}, { by: BY, now: NOW }), { code: 'CFG_PRECONDITION' });
      assert.throws(
        () =>
          root.publish(1, { impactSummary: '影响 3 个职位 Group 20 名成员' }, { by: BY, now: NOW }),
        { code: 'CFG_PRECONDITION' },
      );
      assert.throws(
        () =>
          root.publish(
            1,
            { impactSummary: '影响 3 个职位 Group 20 名成员', confirmation: 'OK' },
            { by: BY, now: NOW },
          ),
        { code: 'CFG_PRECONDITION' },
      );
    }
  });

  it('高风险齐备确认后成功；FORM_TEMPLATE 无需确认即可发布', () => {
    const risky = newRoot('PERMISSION_TEMPLATE');
    toReady(risky, 1, {});
    risky.publish(
      1,
      { impactSummary: '影响 3 个职位 Group 20 名成员', confirmation: 'CONFIRMED' },
      { by: BY, now: NOW },
    );
    assert.equal(risky.getCurrentPublished()?.state, 'PUBLISHED');

    const plain = newRoot('FORM_TEMPLATE');
    toReady(plain, 1, {});
    plain.publish(1, {}, { by: BY, now: NOW });
    assert.equal(plain.getCurrentPublished()?.state, 'PUBLISHED');
  });
});

describe('修改=新版本；回滚=基于旧版本的新发布（CFG-005 核心语义）', () => {
  function twoVersions(): { root: ReturnType<typeof newRoot> } {
    const root = newRoot();
    toReady(root, 1, { content: 'v1' });
    root.publish(1, {}, { by: BY, now: NOW });

    root.createDraft({ by: BY, now: LATER });
    toReady(root, 2, { content: 'v2' });
    root.publish(2, {}, { by: BY, now: LATER });
    return { root };
  }

  it('createDraft 得新号且旧记录逐字段不变', () => {
    const root = newRoot();
    toReady(root, 1, { content: 'v1' });
    root.publish(1, {}, { by: BY, now: NOW });
    const v1Before = JSON.stringify(root.toSnapshot().versions[0]);

    const draft = root.createDraft({ by: BY, now: LATER });
    assert.equal(draft.versionNumber, 2);
    assert.equal(JSON.stringify(root.toSnapshot().versions[0]), v1Before);
  });

  it('回滚链：rollbackTo(v1) 得 v3 草稿（payload=v1、source=1）；发布后 current=3 且历史完整', () => {
    const { root } = twoVersions();
    const rolled = root.rollbackTo(1, { by: BY, now: LATER });
    assert.equal(rolled.versionNumber, 3);
    assert.equal(rolled.state, 'DRAFT');
    assert.equal(rolled.sourceVersionNumber, 1);
    assert.equal(rolled.payload.content, 'v1');

    toReady(root, 3, { content: 'v1' });
    root.publish(3, {}, { by: BY, now: LATER });

    const snap = root.toSnapshot();
    assert.equal(snap.currentPublishedVersionNumber, 3);
    assert.equal(snap.versions.length, 3);
    assert.equal(snap.versions[0].payload.content, 'v1');
    assert.equal(snap.versions[1].payload.content, 'v2');
  });

  it('rollbackTo 非 PUBLISHED 来源或不存在版本 → CFG_VALIDATION', () => {
    const { root } = twoVersions();
    const draft = root.createDraft({ by: BY, now: LATER });
    assert.throws(() => root.rollbackTo(draft.versionNumber, { by: BY, now: LATER }), {
      code: 'CFG_VALIDATION',
    });
    assert.throws(() => root.rollbackTo(99, { by: BY, now: LATER }), { code: 'CFG_VALIDATION' });
  });

  it('deleteVersion 恒 CFG_CONFLICT（DRAFT 与 PUBLISHED 都不可删）', () => {
    const { root } = twoVersions();
    const draft = root.createDraft({ by: BY, now: LATER });
    assert.throws(() => root.deleteVersion(draft.versionNumber), { code: 'CFG_CONFLICT' });
    assert.throws(() => root.deleteVersion(1), { code: 'CFG_CONFLICT' });
  });

  it('MAIL_CREDENTIAL 标记随回滚保留（回滚不恢复旧明文，只能重填/轮换）', () => {
    const root = ConfigRoot.create({
      rootId: 'root-mail',
      kind: 'NOTIFY_TEMPLATE',
      now: NOW,
      by: BY,
    });
    root.toSnapshot(); // no-op sanity
    // 直接以 MAIL_CREDENTIAL 种子建根后走链路
    root.createDraft({ by: BY, now: NOW }, { secretKind: 'MAIL_CREDENTIAL', payload: {} });
    toReady(root, 2, {});
    root.publish(2, {}, { by: BY, now: NOW });

    const rolled = root.rollbackTo(2, { by: BY, now: LATER });
    assert.equal(rolled.secretKind, 'MAIL_CREDENTIAL');
    // payload 不含任何密钥明文字段
    assert.ok(!Object.keys(rolled.payload).some((k) => k.toLowerCase().includes('secret')));
  });
});

describe('快照往返与版本续接（CFG-005）', () => {
  it('往返一致且 fromSnapshot 后继续 createDraft 版本号正确续接', () => {
    const root = newRoot();
    toReady(root, 1, { c: 1 });
    root.publish(1, {}, { by: BY, now: NOW });

    const restored = ConfigRoot.fromSnapshot(root.toSnapshot());
    assert.deepEqual(restored.toSnapshot(), root.toSnapshot());

    const next = restored.createDraft({ by: BY, now: LATER });
    assert.equal(next.versionNumber, 2);
  });

  it('fromSnapshot 拒绝版本号重复的损坏快照', () => {
    const snap = newRoot().toSnapshot();
    const corrupted = { ...snap, versions: [snap.versions[0], snap.versions[0]] };
    assert.throws(() => ConfigRoot.fromSnapshot(corrupted), { code: 'CFG_VALIDATION' });
  });
});
