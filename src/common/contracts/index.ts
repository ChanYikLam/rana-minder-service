/**
 * RanaMinder 传输层契约统一出口
 *
 * 这些类型由 docs/specification/接口实现规格-v1.0.md 与
 * docs/specification/接口清单-HTTP端点-v1.0.md 归纳而来，
 * 仅表达“前端已调用 + 后端必须兼容”的传输层形状。
 * 不新增产品行为；与上游冲突时以上游权威文档为准。
 */

export * from './api-envelope';
export * from './api-error';
export * from './pagination';
export * from './api-paths';

export * from './auth.contracts';
export * from './explore.contracts';
export * from './notifications.contracts';
export * from './me.contracts';
export * from './files.contracts';
export * from './org.contracts';
export * from './members.contracts';
export * from './recruitment.contracts';
export * from './joint.contracts';
export * from './forms.contracts';
export * from './config.contracts';
export * from './exports.contracts';
export * from './admin.contracts';
export * from './audit.contracts';
