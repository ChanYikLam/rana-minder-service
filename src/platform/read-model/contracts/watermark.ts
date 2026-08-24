import type { ProjectionFormatVersion, ProjectionType } from './projection-type';
import type { ProjectionScope } from './scope';

/**
 * 派生水位（IFC-TX-008；DATA-DER-001"派生版本或水位"）。
 *
 * 水位用于识别新旧：sourceVersion（已消费的权威源版本）+ derivedVersion
 * （派生版本，单调递增）共同判定。旧水位/迟到任务不得覆盖较新的结果。
 * 水位按（投影类型 + 作用域 + 格式版本）隔离。
 */
export interface Watermark {
  /** 投影类型 */
  readonly projectionType: ProjectionType;
  /** 投影作用域（水位按作用域隔离） */
  readonly scope: ProjectionScope;
  /** 投影格式版本 */
  readonly formatVersion: ProjectionFormatVersion;
  /** 已消费的权威源版本（源水位） */
  readonly sourceVersion: number;
  /** 派生版本（重建次数，单调递增；同源版本下的重建排序） */
  readonly derivedVersion: number;
  /** 生成任务引用（job 持久任务标识，DATA-DER-001"生成任务"） */
  readonly generationTaskId?: string;
  /** 生成时间（服务端可信时钟，ISO 8601） */
  readonly generatedAt: string;
}

/** 水位比较结果：新 / 相同 / 旧（用于"旧水位不覆盖新结果"判定） */
export type WatermarkComparison = 'NEWER' | 'EQUAL' | 'OLDER';
