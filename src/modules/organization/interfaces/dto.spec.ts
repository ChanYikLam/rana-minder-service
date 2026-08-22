import 'reflect-metadata';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';

import { WizardCreateDto, WizardCompleteDto, TemplatePublishDto } from './dto';

describe('Organization DTO validation', () => {
  it('WizardCreateDto：reauthProof 为空串时被拒绝（IFC-ERR-002）', async () => {
    const dto = plainToInstance(WizardCreateDto, {
      groupId: 'g-1',
      name: 'ACM',
      leaderGroupId: 'lg-1',
      reauthProof: '',
    });
    const errors = await validate(dto);
    assert.ok(errors.some((e) => e.property === 'reauthProof'));
  });

  it('WizardCreateDto：reauthProof 缺失时通过（可选字段）', async () => {
    const dto = plainToInstance(WizardCreateDto, {
      groupId: 'g-1',
      name: 'ACM',
      leaderGroupId: 'lg-1',
    });
    const errors = await validate(dto);
    assert.ok(!errors.some((e) => e.property === 'reauthProof'));
  });

  it('WizardCompleteDto：reauthProof 为空串时被拒绝（IFC-ERR-002）', async () => {
    const dto = plainToInstance(WizardCompleteDto, {
      clubId: 'c-1',
      confirmed: true,
      reauthProof: '',
    });
    const errors = await validate(dto);
    assert.ok(errors.some((e) => e.property === 'reauthProof'));
  });

  it('TemplatePublishDto：reauthProof 为空串时被拒绝（IFC-ERR-002）', async () => {
    const dto = plainToInstance(TemplatePublishDto, {
      reauthProof: '',
      previewVersion: 1,
      reason: '发布',
    });
    const errors = await validate(dto);
    assert.ok(errors.some((e) => e.property === 'reauthProof'));
  });
});
