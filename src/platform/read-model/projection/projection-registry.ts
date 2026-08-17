import { Injectable } from '@nestjs/common';
import type { ProjectionType } from '../contracts';
import type { ProjectionBuilder } from './projection-builder';

/**
 * 投影注册表：投影类型 → 构建器映射。
 *
 * query/refresh/invalidation 经它定位投影构建器与权威源端口；
 * 三个具体投影（子任务6）在 ReadModelModule 装配时注册。
 */
@Injectable()
export class ProjectionRegistry {
  private readonly builders = new Map<ProjectionType, ProjectionBuilder>();

  register(builder: ProjectionBuilder): void {
    this.builders.set(builder.projectionType, builder);
  }

  has(projectionType: ProjectionType): boolean {
    return this.builders.has(projectionType);
  }

  get(projectionType: ProjectionType): ProjectionBuilder {
    const builder = this.builders.get(projectionType);
    if (builder === undefined) {
      throw new Error(`未注册的投影类型: ${projectionType}`);
    }
    return builder;
  }

  list(): readonly ProjectionBuilder[] {
    return [...this.builders.values()];
  }
}
