/**
 * 表单版本状态机测试（SRS-SM-FORM-001 t2~t8；IFC-SM-024）。
 *
 * 覆盖：版本级转换表、publishable 语义、草稿变更失效、并发发布前置、
 * 停用幂等、来源复用、t8 稳定拒绝（DEPRECATED 直接恢复一律拒绝）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DefaultFormVersionStateMachine,
  FormVersionEvent,
  FormVersionState,
} from './form-version.state-machine';

const machine = new DefaultFormVersionStateMachine();

describe('FormVersionStateMachine（SRS-SM-FORM-001 t2~t8）', () => {
  it('t2 编辑：DRAFT → DRAFT 且可发布标志失效（草稿变更使测试通过标志失效）', () => {
    const result = machine.transition({
      event: FormVersionEvent.UPDATE_DRAFT,
      currentState: FormVersionState.DRAFT,
      publishable: true,
    });
    assert.equal(result.allowed, true);
    assert.equal(result.nextState, FormVersionState.DRAFT);
    assert.equal(result.publishable, false);
  });

  it('t3 预览/测试：DRAFT → PREVIEW_TESTING（存测试快照与结果）', () => {
    const result = machine.transition({
      event: FormVersionEvent.RUN_PREVIEW_TEST,
      currentState: FormVersionState.DRAFT,
      publishable: false,
    });
    assert.equal(result.allowed, true);
    assert.equal(result.nextState, FormVersionState.PREVIEW_TESTING);
  });

  it('t3 结果收口：测试失败回 DRAFT 且不可发布', () => {
    const result = machine.transition({
      event: FormVersionEvent.PREVIEW_TEST_FAILED,
      currentState: FormVersionState.PREVIEW_TESTING,
      publishable: false,
    });
    assert.equal(result.allowed, true);
    assert.equal(result.nextState, FormVersionState.DRAFT);
    assert.equal(result.publishable, false);
  });

  it('t4 测试通过：回 DRAFT 且可发布（不自动发布）', () => {
    const result = machine.transition({
      event: FormVersionEvent.PREVIEW_TEST_PASSED,
      currentState: FormVersionState.PREVIEW_TESTING,
      publishable: false,
    });
    assert.equal(result.allowed, true);
    assert.equal(result.nextState, FormVersionState.DRAFT);
    assert.equal(result.publishable, true);
  });

  it('t5 发布：仅可发布草稿可发布；未通过测试的草稿拒绝', () => {
    const passed = machine.transition({
      event: FormVersionEvent.PUBLISH,
      currentState: FormVersionState.DRAFT,
      publishable: true,
    });
    assert.equal(passed.allowed, true);
    assert.equal(passed.nextState, FormVersionState.PUBLISHED);

    const rejected = machine.transition({
      event: FormVersionEvent.PUBLISH,
      currentState: FormVersionState.DRAFT,
      publishable: false,
    });
    assert.equal(rejected.allowed, false);
    assert.match(rejected.reason ?? '', /不可发布/);
  });

  it('t5 已发布不可变：发布版本不接受任何覆盖/编辑/停用以外事件', () => {
    for (const event of [
      FormVersionEvent.UPDATE_DRAFT,
      FormVersionEvent.PUBLISH,
      FormVersionEvent.RUN_PREVIEW_TEST,
    ]) {
      const result = machine.transition({
        event,
        currentState: FormVersionState.PUBLISHED,
        publishable: false,
      });
      assert.equal(result.allowed, false);
    }
    const deprecate = machine.transition({
      event: FormVersionEvent.DEPRECATE,
      currentState: FormVersionState.PUBLISHED,
      publishable: false,
    });
    assert.equal(deprecate.allowed, true);
  });

  it('t6 停用：PUBLISHED → DEPRECATED（只阻止新提交，历史保留）', () => {
    const result = machine.transition({
      event: FormVersionEvent.DEPRECATE,
      currentState: FormVersionState.PUBLISHED,
      publishable: false,
    });
    assert.equal(result.allowed, true);
    assert.equal(result.nextState, FormVersionState.DEPRECATED);
  });

  it('t6 复用来源：PUBLISHED/DEPRECATED 均为合法来源且原状态不变', () => {
    for (const state of [FormVersionState.PUBLISHED, FormVersionState.DEPRECATED]) {
      const result = machine.transition({
        event: FormVersionEvent.REUSE,
        currentState: state,
        publishable: false,
      });
      assert.equal(result.allowed, true);
      assert.equal(result.nextState, state);
    }
    const draftAsSource = machine.transition({
      event: FormVersionEvent.REUSE,
      currentState: FormVersionState.DRAFT,
      publishable: false,
    });
    assert.equal(draftAsSource.allowed, false);
  });

  it('t8 稳定拒绝：已停用版本直接恢复（RESTORE）一律拒绝并给出原因', () => {
    const result = machine.transition({
      event: FormVersionEvent.RESTORE,
      currentState: FormVersionState.DEPRECATED,
      publishable: false,
    });
    assert.equal(result.allowed, false);
    assert.match(result.reason ?? '', /新草稿/);
  });

  it('停用重复提交幂等语义：停用态不再推进，但复用路径仍可用', () => {
    const again = machine.transition({
      event: FormVersionEvent.DEPRECATE,
      currentState: FormVersionState.DEPRECATED,
      publishable: false,
    });
    assert.equal(again.allowed, false);
    const reuse = machine.transition({
      event: FormVersionEvent.REUSE,
      currentState: FormVersionState.DEPRECATED,
      publishable: false,
    });
    assert.equal(reuse.allowed, true);
  });

  it('PREVIEW_TESTING 中不接受编辑/发布（只能收测试结果）', () => {
    for (const event of [
      FormVersionEvent.UPDATE_DRAFT,
      FormVersionEvent.PUBLISH,
      FormVersionEvent.RUN_PREVIEW_TEST,
    ]) {
      const result = machine.transition({
        event,
        currentState: FormVersionState.PREVIEW_TESTING,
        publishable: false,
      });
      assert.equal(result.allowed, false);
    }
  });
});
