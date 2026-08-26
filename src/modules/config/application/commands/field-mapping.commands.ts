/**
 * Casdoor 字段映射命令/查询（CFG-004，5.5.4）。
 *
 * 仅平台超管可配置（ORG-029）。编辑态草稿独立持久化（FieldMappingDraft 聚合）；
 * 发布走 CFG-005 不可变版本线（ConfigRoot kind='FIELD_MAPPING'）：发布前校验
 * 实际接口测试凭证与影响预览，高风险二次确认由版本线聚合强制；发布后必须执行
 * 一次受控对账（返回 reconciliationRequired=true，对账编排随 job 切片接入）。
 */

import { FieldMappingDraft } from '../../domain/models/field-mapping';
import type { FieldMappingEntry, MappingImpactPreview } from '../../domain/models/field-mapping';
import { ConfigRoot } from '../../domain/models/config-version';
import type {
  ConfigRootRepositoryPort,
  FieldMappingStateRepositoryPort,
  PolicyAuthorizationPort,
} from '../ports';
import type { ConfigNotificationPort } from '../../infrastructure/not-wired.config-ports';
import type { CommandTransactionPort } from '../ports';
import { cfgErrors } from '../errors';

/** 字段映射版本线固定 rootId（平台级单例） */
export const FIELD_MAPPING_ROOT_ID = 'field_mapping';

export class SaveFieldMappingDraftCommand {
  constructor(
    private readonly stateRepository: FieldMappingStateRepositoryPort,
    private readonly authorization: PolicyAuthorizationPort,
  ) {}

  async execute(input: { subjectId: string; now: Date; entries: readonly FieldMappingEntry[] }) {
    if (!(await this.authorization.canManagePlatform(input.subjectId))) {
      throw cfgErrors.forbidden('仅平台超管可配置 Casdoor 字段映射');
    }
    const existing = await this.stateRepository.load();
    // 首建：以完整条目创建（create 内部走全量校验）；已有：整体替换（setEntries 走同套校验）
    const draft =
      existing !== null
        ? FieldMappingDraft.fromSnapshot(existing)
        : FieldMappingDraft.create(input.entries, { by: input.subjectId, now: input.now });
    if (existing !== null) {
      draft.setEntries(input.entries, { by: input.subjectId, now: input.now });
    }
    const snapshot = draft.toSnapshot();
    await this.stateRepository.save(snapshot);
    return { state: snapshot };
  }
}

export class ActivateFieldMappingRealDataCommand {
  constructor(
    private readonly stateRepository: FieldMappingStateRepositoryPort,
    private readonly authorization: PolicyAuthorizationPort,
  ) {}

  async execute(input: { subjectId: string; now: Date }) {
    if (!(await this.authorization.canManagePlatform(input.subjectId))) {
      throw cfgErrors.forbidden('仅平台超管可启用真实数据处理');
    }
    const existing = await this.stateRepository.load();
    if (existing === null) {
      throw cfgErrors.preconditionFailed('字段映射草稿尚不存在');
    }
    const draft = FieldMappingDraft.fromSnapshot(existing);
    draft.activateRealData({ by: input.subjectId, now: input.now });
    const snapshot = draft.toSnapshot();
    await this.stateRepository.save(snapshot);
    return { state: snapshot };
  }
}

export interface PublishFieldMappingInput {
  readonly subjectId: string;
  readonly now: Date;
  /** 实际 Casdoor 接口测试凭证（发布前须测试真实接口） */
  readonly testResultRef: string;
  readonly impactPreview: MappingImpactPreview;
  /** 影响对象摘要+二次确认声明（版本线聚合对 FIELD_MAPPING 强制） */
  readonly impactSummary: string;
  readonly confirmation: string;
}

/**
 * 发布字段映射：草稿门禁（validateForPublish）→ 写入版本线新草稿 → 测试通过 →
 * 发布（CFG-005 高风险确认）→ 返回受控对账标记。任一步失败抛错且版本线保持
 * 旧版本完整生效（SRS-FAIL-013：不部分生效）。
 */
export class PublishFieldMappingCommand {
  constructor(
    private readonly stateRepository: FieldMappingStateRepositoryPort,
    private readonly rootRepository: ConfigRootRepositoryPort,
    private readonly authorization: PolicyAuthorizationPort,
    private readonly notification: ConfigNotificationPort,
    private readonly uow: CommandTransactionPort,
  ) {}

  async execute(input: PublishFieldMappingInput) {
    if (!(await this.authorization.canManagePlatform(input.subjectId))) {
      throw cfgErrors.forbidden('仅平台超管可发布 Casdoor 字段映射');
    }
    // 单事务窗口：加锁读版本线 → 修改 → save（CFG-005 并发保护；findForUpdate 行锁
    // 在命令读-改-写期间持续持有，锁不随 find 的独立事务释放）。
    // 事务内状态经返回值解构（不闭包外泄，降低耦合）
    const { publishedVersionNumber } = await this.uow.runShared(
      { kind: 'unprotected' },
      async () => {
        // 先取版本线根行锁（findForUpdate），再读草稿（评审 warning）：并发发布时
        // 第二个发布者在根锁上阻塞，锁到手后读到的是前序发布提交后的最新草稿——
        // 「串行化并发发布」语义覆盖草稿读取，无旧快照缝隙
        const rootSnapshot = await this.rootRepository.findForUpdate(FIELD_MAPPING_ROOT_ID);
        const existing = await this.stateRepository.load();
        if (existing === null) {
          throw cfgErrors.preconditionFailed('字段映射草稿尚不存在');
        }
        const draft = FieldMappingDraft.fromSnapshot(existing);
        // 发布前门禁：测试凭证+影响预览+条目兜底校验（CFG-004）
        draft.validateForPublish({
          testResultRef: input.testResultRef,
          impactPreview: input.impactPreview,
        });

        // 写入版本线：基于当前发布版本创建新草稿（回滚语义），走完整测试→发布流程
        let root: ConfigRoot;
        let draftRecord: { versionNumber: number };
        if (rootSnapshot === null) {
          // 首发版本线：ConfigRoot.create 内建 v1 DRAFT，直接作为本次发布载体
          root = ConfigRoot.create({
            rootId: FIELD_MAPPING_ROOT_ID,
            kind: 'FIELD_MAPPING',
            now: input.now,
            by: input.subjectId,
          });
          draftRecord = root.toSnapshot().versions[0];
        } else {
          root = ConfigRoot.fromSnapshot(rootSnapshot);
          const currentPublished = root.getCurrentPublished();
          // 有已发布版本→基于它建新草稿（回滚语义）；否则全新草稿。两路都产出全新 DRAFT。
          draftRecord =
            currentPublished !== null
              ? root.rollbackTo(currentPublished.versionNumber, {
                  by: input.subjectId,
                  now: input.now,
                })
              : root.createDraft({ by: input.subjectId, now: input.now });
        }

        root.editDraft(
          draftRecord.versionNumber,
          { entries: [...existing.entries] } as Record<string, unknown>,
          {
            by: input.subjectId,
            now: input.now,
          },
        );
        // 完整测试→发布编排：DRAFT → TESTING →（真实接口凭证）READY_TO_PUBLISH → 高风险确认发布
        root.startTesting(draftRecord.versionNumber, { by: input.subjectId, now: input.now });
        root.markTestPassed(draftRecord.versionNumber, input.testResultRef, {
          by: input.subjectId,
          now: input.now,
        });
        root.publish(
          draftRecord.versionNumber,
          { impactSummary: input.impactSummary, confirmation: input.confirmation },
          { by: input.subjectId, now: input.now },
        );
        await this.rootRepository.save(root.toSnapshot());
        return { publishedVersionNumber: draftRecord.versionNumber };
      },
    );
    // 通知置于事务提交之后（评审 1）：外部通知失败不回滚已提交的发布；
    // 外部调用期间不持续持有 DB 行锁
    // 失败补偿策略（评审 info）：通知抛错时调用方看到失败但发布已落库——重试会触发
    // 「已发布不可重复发布」校验；3.x 接线须提供幂等补偿（通知侧按 rootId+版本号去重，
    // 失败仅记录待补偿队列，不重放发布流程）
    await this.notification.notifyConfigPublished({
      rootId: FIELD_MAPPING_ROOT_ID,
      kind: 'FIELD_MAPPING',
      versionNumber: publishedVersionNumber,
      publishedBy: input.subjectId,
      highRisk: true,
    });
    return {
      publishedVersionNumber,
      reconciliationRequired: true as const,
    };
  }
}

export class GetFieldMappingQuery {
  constructor(
    private readonly stateRepository: FieldMappingStateRepositoryPort,
    private readonly authorization: PolicyAuthorizationPort,
  ) {}

  async execute(input: { subjectId: string }) {
    if (!(await this.authorization.canManagePlatform(input.subjectId))) {
      throw cfgErrors.forbidden('仅平台超管可查看 Casdoor 字段映射');
    }
    return this.stateRepository.load();
  }
}
