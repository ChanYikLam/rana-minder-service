/**
 * 社团展示资料聚合（CFG-001，5.5.1）。
 *
 * 接入信息 vs 展示资料：Casdoor Group ID/绑定关系/原始 Group 名称是接入信息
 * （仅超管管理，归组织模块），本聚合只保存展示资料——展示名称/Logo/简介/
 * 联系方式/招新说明/内部说明；展示名称可与 Casdoor Group 名称不同。
 *
 * 不变量（CFG-001）：
 * - 修改立即生效、无需审批，但每次修改追加一条修改历史（旧值/新值/修改人/时间）；
 * - 每个联系方式字段必须选择可见范围（PUBLIC=有效登录学生可见 / MEMBER=本社团成员可见）；
 * - 未登录不可见任何联系方式（由 display-visibility-policy 投影保证）；
 * - 本聚合不含成员名单/部门关系/职位人员等数据，公开展示页结构性排除；
 * - 修改不触碰 Casdoor Group、成员关系或权限（聚合内无此类字段）；
 * - revisionNumber 乐观锁：并发修改以期望版本守卫。
 */

import { ConfigDomainError } from '../errors';

/** 联系方式可见范围：PUBLIC=主动公开（有效登录学生可见）；MEMBER=仅本社团成员可见 */
export type ContactVisibility = 'PUBLIC' | 'MEMBER';

export const CONTACT_VISIBILITIES: readonly ContactVisibility[] = ['PUBLIC', 'MEMBER'];

export interface ContactFieldSnapshot {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly visibility: ContactVisibility;
}

/** 单字段修改留痕（旧值/新值；值统一字符串化以便历史对比） */
export interface ClubProfileFieldChange {
  readonly field: string;
  readonly from: string;
  readonly to: string;
}

/** 修改历史条目：保留修改人、时间与逐字段旧值/新值（CFG-001 修改留痕） */
export interface ClubProfileHistoryEntry {
  readonly at: Date;
  readonly by: string;
  /** true=超管代改；false=负责人/人事本人修改 */
  readonly onBehalf: boolean;
  readonly changes: readonly ClubProfileFieldChange[];
}

export interface ClubProfileSnapshot {
  readonly clubId: string;
  /** 展示名称：可与 Casdoor Group 名称不同；非空且 ≤100 字符 */
  readonly displayName: string;
  /** Logo 文件引用（file 模块文件 ID）；可空 */
  readonly logoFileRef: string | null;
  /** 简介：未登录可见 */
  readonly intro: string | null;
  /** 公开招新说明：未登录可见 */
  readonly recruitmentNote: string | null;
  /** 内部说明：仅本社团成员可见 */
  readonly internalNote: string | null;
  /** 联系方式字段列表；每个字段必须带可见范围 */
  readonly contacts: readonly ContactFieldSnapshot[];
  /** 修改历史：只追加，不删除（CFG-001 保留修改历史和审计） */
  readonly history: readonly ClubProfileHistoryEntry[];
  readonly revisionNumber: number;
  readonly updatedBy: string | null;
  readonly updatedAt: Date;
}

export interface ClubProfileUpdateInput {
  readonly displayName?: string;
  readonly logoFileRef?: string | null;
  readonly intro?: string | null;
  readonly recruitmentNote?: string | null;
  readonly internalNote?: string | null;
  readonly contacts?: readonly ContactFieldSnapshot[];
}

const MAX_DISPLAY_NAME_LENGTH = 100;
const MAX_TEXT_LENGTH = 5000;
const MAX_CONTACT_FIELDS = 20;
const MAX_CONTACT_LABEL_LENGTH = 50;
const MAX_CONTACT_VALUE_LENGTH = 200;

function assertText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string') {
    throw new ConfigDomainError('CFG_VALIDATION', `${field} 必须为字符串`, { field });
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new ConfigDomainError('CFG_VALIDATION', `${field} 不能为空`, { field });
  }
  if (trimmed.length > maxLength) {
    throw new ConfigDomainError('CFG_VALIDATION', `${field} 长度不能超过 ${maxLength}`, { field });
  }
  return trimmed;
}

function normalizeOptionalText(
  value: string | null | undefined,
  field: string,
  maxLength: number,
): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== 'string') {
    throw new ConfigDomainError('CFG_VALIDATION', `${field} 必须为字符串或空`, { field });
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }
  if (trimmed.length > maxLength) {
    throw new ConfigDomainError('CFG_VALIDATION', `${field} 长度不能超过 ${maxLength}`, { field });
  }
  return trimmed;
}

/** 校验并规范化联系方式字段列表；每个字段必须选择可见范围（CFG-001 硬性要求） */
export function normalizeContacts(
  contacts: readonly ContactFieldSnapshot[],
): ContactFieldSnapshot[] {
  if (!Array.isArray(contacts)) {
    throw new ConfigDomainError('CFG_VALIDATION', '联系方式必须为列表', { field: 'contacts' });
  }
  if (contacts.length > MAX_CONTACT_FIELDS) {
    throw new ConfigDomainError('CFG_VALIDATION', `联系方式字段不能超过 ${MAX_CONTACT_FIELDS} 个`, {
      field: 'contacts',
    });
  }
  const seenIds = new Set<string>();
  return contacts.map((contact) => {
    const id = assertText(contact.id, 'contacts.id', 64);
    if (seenIds.has(id)) {
      throw new ConfigDomainError('CFG_VALIDATION', `联系方式标识重复：${id}`, {
        field: 'contacts',
      });
    }
    seenIds.add(id);
    const label = assertText(contact.label, 'contacts.label', MAX_CONTACT_LABEL_LENGTH);
    const value = assertText(contact.value, 'contacts.value', MAX_CONTACT_VALUE_LENGTH);
    if (contact.visibility !== 'PUBLIC' && contact.visibility !== 'MEMBER') {
      // 每个联系方式字段必须选择可见范围
      throw new ConfigDomainError('CFG_VALIDATION', `联系方式「${label}」必须选择可见范围`, {
        field: 'contacts.visibility',
      });
    }
    return { id, label, value, visibility: contact.visibility };
  });
}

export class ClubProfile {
  private constructor(private snapshot: ClubProfileSnapshot) {}

  static fromSnapshot(snapshot: ClubProfileSnapshot): ClubProfile {
    return new ClubProfile(snapshot);
  }

  /** 初始化默认资料：displayName 先取社团名，后续可改（不改变 Casdoor Group 名称） */
  static createDefault(input: { clubId: string; clubName: string; now: Date }): ClubProfile {
    return new ClubProfile({
      clubId: input.clubId,
      displayName: input.clubName,
      logoFileRef: null,
      intro: null,
      recruitmentNote: null,
      internalNote: null,
      contacts: [],
      history: [],
      revisionNumber: 1,
      updatedBy: null,
      updatedAt: input.now,
    });
  }

  get clubId(): string {
    return this.snapshot.clubId;
  }

  get revisionNumber(): number {
    return this.snapshot.revisionNumber;
  }

  toSnapshot(): ClubProfileSnapshot {
    return { ...this.snapshot };
  }

  /**
   * 应用修改：立即生效（无需审批），校验通过后追加修改历史并递增修订号。
   * 仅传入的字段参与变更；未传字段保持原值。返回本次变更条目。
   */
  update(
    input: ClubProfileUpdateInput,
    context: { by: string; onBehalf: boolean; now: Date },
  ): ClubProfileFieldChange[] {
    const current = this.snapshot;
    const changes: ClubProfileFieldChange[] = [];

    let displayName = current.displayName;
    if (input.displayName !== undefined && input.displayName !== current.displayName) {
      displayName = assertText(input.displayName, 'displayName', MAX_DISPLAY_NAME_LENGTH);
      changes.push({ field: 'displayName', from: current.displayName, to: displayName });
    }

    let logoFileRef = current.logoFileRef;
    if (input.logoFileRef !== undefined && input.logoFileRef !== current.logoFileRef) {
      logoFileRef = normalizeOptionalText(input.logoFileRef, 'logoFileRef', 200);
      changes.push({
        field: 'logoFileRef',
        from: current.logoFileRef ?? '',
        to: logoFileRef ?? '',
      });
    }

    let intro = current.intro;
    if (input.intro !== undefined && input.intro !== current.intro) {
      intro = normalizeOptionalText(input.intro, 'intro', MAX_TEXT_LENGTH);
      changes.push({ field: 'intro', from: current.intro ?? '', to: intro ?? '' });
    }

    let recruitmentNote = current.recruitmentNote;
    if (input.recruitmentNote !== undefined && input.recruitmentNote !== current.recruitmentNote) {
      recruitmentNote = normalizeOptionalText(
        input.recruitmentNote,
        'recruitmentNote',
        MAX_TEXT_LENGTH,
      );
      changes.push({
        field: 'recruitmentNote',
        from: current.recruitmentNote ?? '',
        to: recruitmentNote ?? '',
      });
    }

    let internalNote = current.internalNote;
    if (input.internalNote !== undefined && input.internalNote !== current.internalNote) {
      internalNote = normalizeOptionalText(input.internalNote, 'internalNote', MAX_TEXT_LENGTH);
      changes.push({
        field: 'internalNote',
        from: current.internalNote ?? '',
        to: internalNote ?? '',
      });
    }

    let contacts = current.contacts;
    if (input.contacts !== undefined) {
      contacts = normalizeContacts(input.contacts);
      if (JSON.stringify(contacts) !== JSON.stringify(current.contacts)) {
        changes.push({
          field: 'contacts',
          from: JSON.stringify(current.contacts),
          to: JSON.stringify(contacts),
        });
      }
    }

    // 无实际变化时不开新版本、不留痕（避免噪声历史）
    if (changes.length === 0) {
      return [];
    }

    this.snapshot = {
      ...current,
      displayName,
      logoFileRef,
      intro,
      recruitmentNote,
      internalNote,
      contacts,
      history: [
        ...current.history,
        { at: context.now, by: context.by, onBehalf: context.onBehalf, changes },
      ],
      revisionNumber: current.revisionNumber + 1,
      updatedBy: context.by,
      updatedAt: context.now,
    };
    return changes;
  }
}
