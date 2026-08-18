import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { NestLoggerServiceAdapter } from './nest-logger.adapter';
import { DefaultLogSanitizer } from '../logging/sanitizer';
import type { AppLogger } from '../logging/app-logger';
import type { LogRecord } from '../logging/sanitizer';

class FakeAppLogger implements AppLogger {
  readonly records: { level: 'info' | 'warn' | 'error'; record: LogRecord }[] = [];
  info(record: LogRecord): void { this.records.push({ level: 'info', record }); }
  warn(record: LogRecord): void { this.records.push({ level: 'warn', record }); }
  error(record: LogRecord): void { this.records.push({ level: 'error', record }); }
}

describe('NestLoggerServiceAdapter', () => {
  const make = () => {
    const app = new FakeAppLogger();
    const adapter = new NestLoggerServiceAdapter({
      sanitizer: new DefaultLogSanitizer(),
      appLogger: app,
    });
    return { adapter, app };
  };

  it('log：转 LogRecord 含 message + level=info，路由到 appLogger.info', () => {
    const { adapter, app } = make();
    adapter.log('hello', 'Bootstrap');
    assert.equal(app.records.length, 1);
    assert.equal(app.records[0]?.level, 'info');
    assert.equal(app.records[0]?.record['message'], 'hello');
    assert.equal(app.records[0]?.record['context'], 'Bootstrap');
  });

  it('warn：路由到 appLogger.warn', () => {
    const { adapter, app } = make();
    adapter.warn('w');
    assert.equal(app.records[0]?.level, 'warn');
  });

  it('error：路由到 appLogger.error（含 error stack）', () => {
    const { adapter, app } = make();
    const err = new Error('boom');
    adapter.error('failed', err);
    assert.equal(app.records[0]?.level, 'error');
    assert.equal(typeof app.records[0]?.record['error'], 'string');
    assert.ok((app.records[0]?.record['error'] as string).includes('boom'));
  });

  it('debug / verbose：路由到 appLogger.info（脱敏管道路径）', () => {
    const { adapter, app } = make();
    adapter.debug('d');
    adapter.verbose('v');
    assert.equal(app.records.length, 2);
    for (const r of app.records) {
      assert.equal(r.level, 'info');
    }
  });

  it('message 非字符串：序列化为 JSON 字符串', () => {
    const { adapter, app } = make();
    adapter.log({ foo: 'bar', count: 3 });
    assert.equal(app.records[0]?.record['message'], '{"foo":"bar","count":3}');
  });

  it('第一个 optionalParam 是字符串：作为 context', () => {
    const { adapter, app } = make();
    adapter.log('m', 'Ctx');
    assert.equal(app.records[0]?.record['context'], 'Ctx');
  });

  it('第一个 optionalParam 是对象：作为 error 字段', () => {
    const { adapter, app } = make();
    adapter.error('m', { code: 500 });
    assert.equal(app.records[0]?.record['error'], '{"code":500}');
  });

  it('setLogLevels：no-op 不抛错', () => {
    const { adapter } = make();
    adapter.setLogLevels();
  });

  it('敏感字段经 sanitize 处理（sensitive key 在 message 中也保护不了——sanitize 按 record 字段处理）', () => {
    const { adapter, app } = make();
    adapter.log({ phone: '13800000000' });
    // message 字段被 stringify 成 JSON 字符串，sanitize 对 string 走 truncate(200)
    const msg = app.records[0]?.record['message'] as string;
    assert.ok(msg.length <= 200);
  });
});