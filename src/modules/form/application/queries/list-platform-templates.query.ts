/**
 * 平台模板列表查询（接口清单 §13：GET /api/org/:clubId/templates）。
 *
 * 只列出平台模板（kind=TEMPLATE，scope=platform）且有已发布版本者；
 * 无发布版本的模板不可复制，不进入列表。读取公开目录，无权限门
 * （模板为平台公开资产）。
 */

import type { FormDefinitionRepository } from '../ports/form-definition-repository.port';
import { PLATFORM_SCOPE } from '../../domain/models/form-scope';

export interface PlatformTemplateItem {
  readonly templateId: string;
  readonly title: string;
  readonly description: string | null;
  readonly businessFamily: string | null;
  readonly publishedVersion: number;
  readonly updatedAt: Date;
}

export interface ListPlatformTemplatesQuery {
  execute(): Promise<{ items: readonly PlatformTemplateItem[] }>;
}

export class DefaultListPlatformTemplatesQuery implements ListPlatformTemplatesQuery {
  constructor(private readonly repository: FormDefinitionRepository) {}

  async execute(): Promise<{ items: readonly PlatformTemplateItem[] }> {
    const roots = await this.repository.listByScope(PLATFORM_SCOPE);
    const items: PlatformTemplateItem[] = [];
    for (const root of roots) {
      if (root.kind !== 'TEMPLATE' || root.currentPublishedVersion === null) {
        continue;
      }
      items.push({
        templateId: root.id,
        title: root.title,
        description: root.description,
        businessFamily: root.businessFamily,
        publishedVersion: root.currentPublishedVersion,
        updatedAt: root.updatedAt,
      });
    }
    items.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
    return { items };
  }
}
