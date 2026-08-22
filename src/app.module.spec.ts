/**
 * AppModule 注册完整性测试（防回归）：
 *
 * 领域模块必须全部装配进根模块——历史上出现过 RecruitmentModule（4.4 主链路）
 * 实现完成却未注册进 AppModule、运行应用中整条招新链路不可达的缺口。
 * 本测试直接断言 @Module 元数据的 imports 列表，不启动完整应用（避免
 * 调度器定时器等副作用），以最小成本钉死"模块实现完成但忘记装配"这类回归。
 */

import 'reflect-metadata';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { AppModule } from './app.module';
import { OrganizationModule } from './modules/organization/module';
import { IdentityModule } from './modules/identity/identity.module';
import { FormModule } from './modules/form/form.module';
import { FileModule } from './modules/file/module';
import { NotificationModule } from './modules/notification';
import { InvitationModule } from './modules/invitation/module';
import { MembershipModule } from './modules/membership/module';
import { AuditModule } from './modules/audit/module';
import { RecruitmentModule } from './modules/recruitment/recruitment.module';

function appImports(): readonly unknown[] {
  const imports = Reflect.getMetadata('imports', AppModule);
  assert.ok(Array.isArray(imports), 'AppModule @Module 元数据缺少 imports');
  return imports;
}

describe('AppModule 注册完整性（REC 装配回归防护）', () => {
  it('全部领域模块已注册进根模块', () => {
    const imports = appImports();
    const expected = [
      OrganizationModule,
      IdentityModule,
      FormModule,
      FileModule,
      NotificationModule,
      InvitationModule,
      MembershipModule,
      AuditModule,
      RecruitmentModule,
    ] as const;
    for (const mod of expected) {
      assert.ok(
        imports.includes(mod),
        'AppModule imports 缺少领域模块——主链路将在运行应用中不可达',
      );
    }
  });

  it('RecruitmentModule 已注册（4.4 主链路装配，历史缺口回归钉）', () => {
    assert.ok(appImports().includes(RecruitmentModule));
  });
});
