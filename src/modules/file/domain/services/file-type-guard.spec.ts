import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FileTypeGuard } from './file-type-guard';
import { FileCheckOutcome } from '../state-machines/file-state-machine';

const hex = (s: string): Uint8Array => {
  const bytes = new Uint8Array(s.length / 2);
  for (let i = 0; i < s.length; i += 2) {
    bytes[i / 2] = parseInt(s.slice(i, i + 2), 16);
  }
  return bytes;
};

describe('FileTypeGuard（GOV-008 真实类型校验，不信任扩展名）', () => {
  const guard = new FileTypeGuard();

  it('PNG magic bytes 检测为 image/png 且与声明一致 → PASSED', () => {
    const png = hex('89504e470d0a1a0a0000000d49484452');
    const r = guard.check(png, 'image/png');
    assert.equal(r.detectedType, 'image/png');
    assert.equal(r.outcome, FileCheckOutcome.PASSED);
  });

  it('伪造扩展名：声明 png 实为可执行（MZ）→ 检测为 exe，默认禁止 → QUARANTINED', () => {
    const exe = hex('4d5a90000300000004000000ffff0000');
    const r = guard.check(exe, 'image/png');
    assert.equal(r.detectedType, 'application/x-msdownload');
    assert.equal(r.outcome, FileCheckOutcome.QUARANTINED);
    assert.equal(r.matchesDeclaration, false);
  });

  it('脚本 shebang → 默认禁止（QUARANTINED）', () => {
    const script = new TextEncoder().encode('#!/bin/sh\nrm -rf /');
    const r = guard.check(script, 'text/plain');
    assert.equal(r.detectedType, 'text/x-script');
    assert.equal(r.outcome, FileCheckOutcome.QUARANTINED);
  });

  it('高风险压缩（ZIP）→ 默认禁止（QUARANTINED）', () => {
    const zip = hex('504b03041400000008000000002100');
    const r = guard.check(zip, 'application/zip');
    assert.equal(r.detectedType, 'application/zip');
    assert.equal(r.outcome, FileCheckOutcome.QUARANTINED);
  });

  it('声明与检测不一致（声明 png 实际 pdf）→ FAILED（不信任扩展名）', () => {
    const pdf = hex('255044462d312e340a25e2e3cfd30a');
    const r = guard.check(pdf, 'image/png');
    assert.equal(r.outcome, FileCheckOutcome.FAILED);
  });

  it('未知类型（octet-stream）→ FAILED（不可信）', () => {
    const unknown = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const r = guard.check(unknown, 'application/octet-stream');
    assert.equal(r.outcome, FileCheckOutcome.FAILED);
  });

  it('JPEG/PDF/MP4 合法类型 → PASSED', () => {
    assert.equal(guard.check(hex('ffd8ffe000104a4649460001'), 'image/jpeg').outcome, FileCheckOutcome.PASSED);
    assert.equal(guard.check(hex('255044462d312e34'), 'application/pdf').outcome, FileCheckOutcome.PASSED);
    assert.equal(guard.check(hex('00000018667479706d703432'), 'video/mp4').outcome, FileCheckOutcome.PASSED);
  });
});
