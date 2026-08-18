import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { DefaultSpanLinkFactory } from './span-link';
import { generateTraceId } from '../domain/services/trace-id.generator';

describe('span-link (DefaultSpanLinkFactory)', () => {
  const factory = new DefaultSpanLinkFactory();

  it('linkHttpToCommand：parent=root trace, child=command trace', () => {
    const root = generateTraceId();
    const cmd = generateTraceId();
    const link = factory.linkHttpToCommand(root, cmd);
    assert.equal(link.kind, 'command');
    assert.equal(link.parentTraceId, root);
    assert.equal(link.childTraceId, cmd);
  });

  it('linkCommandToTask：派生为 task', () => {
    const cmd = generateTraceId();
    const task = generateTraceId();
    const link = factory.linkCommandToTask(cmd, task);
    assert.equal(link.kind, 'task');
    assert.equal(link.parentTraceId, cmd);
    assert.equal(link.childTraceId, task);
  });

  it('linkTaskToExternal：派生为 external', () => {
    const task = generateTraceId();
    const ext = generateTraceId();
    const link = factory.linkTaskToExternal(task, ext);
    assert.equal(link.kind, 'external');
    assert.equal(link.parentTraceId, task);
    assert.equal(link.childTraceId, ext);
  });

  it('linkTaskToTask：任务链', () => {
    const a = generateTraceId();
    const b = generateTraceId();
    const link = factory.linkTaskToTask(a, b);
    assert.equal(link.kind, 'task');
    assert.equal(link.parentTraceId, a);
    assert.equal(link.childTraceId, b);
  });

  it('非法 child 抛 TypeError', () => {
    assert.throws(() => factory.linkHttpToCommand(generateTraceId(), 'bad'), TypeError);
  });

  it('非法 parent 抛 TypeError', () => {
    assert.throws(() => factory.linkHttpToCommand('bad', generateTraceId()), TypeError);
  });
});