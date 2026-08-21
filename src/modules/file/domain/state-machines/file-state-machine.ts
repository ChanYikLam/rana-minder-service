/**
 * 文件状态机（SRS-SM-FILE-001，11 条转换；IFC-SM-026）。
 *
 * 状态：
 * NEW → TEMPORARY_UPLOAD → CHECKING → AVAILABLE → BOUND_TO_SUBMISSION
 *      → PENDING_CLEANUP → CLEANED；CHECKING → QUARANTINED_FAILED（可重试标志）；
 * AVAILABLE/TEMPORARY_UPLOAD/QUARANTINED_FAILED → PENDING_CLEANUP（失去最后有效引用）；
 * BOUND_TO_SUBMISSION → PENDING_CLEANUP（正式删除执行中）→ FORMALLY_DELETED。
 *
 * 核心不变量（FORM-007、GOV-008）：
 * - 未检查（NEW/TEMPORARY_UPLOAD/CHECKING/QUARANTINED_FAILED）不得预览、下载或正式绑定；
 * - 检查服务不可用保持 CHECKING（可重试），不得超时自动放行；
 * - 隔离/失败不向管理员开放人工标可用，重新上传必须新建文件。
 */
export const FileState = {
  /** 新建（元数据与上传会话建立） */
  NEW: 'NEW',
  /** 临时上传（字节进入隔离区，仍不可访问） */
  TEMPORARY_UPLOAD: 'TEMPORARY_UPLOAD',
  /** 检查中（自动技术安全检查未完成） */
  CHECKING: 'CHECKING',
  /** 可用（检查通过且晋升核验完成，可被绑定） */
  AVAILABLE: 'AVAILABLE',
  /** 已绑定提交（正式提交引用建立） */
  BOUND_TO_SUBMISSION: 'BOUND_TO_SUBMISSION',
  /** 待清理（失去最后有效引用/正式删除接管） */
  PENDING_CLEANUP: 'PENDING_CLEANUP',
  /** 已清理（临时文件终态；不得删除审计） */
  CLEANED: 'CLEANED',
  /** 隔离/失败（危险、不合规或扫描失败；可重试标志） */
  QUARANTINED_FAILED: 'QUARANTINED_FAILED',
  /** 正式删除（终态） */
  FORMALLY_DELETED: 'FORMALLY_DELETED',
} as const;

export type FileState = (typeof FileState)[keyof typeof FileState];

/** 检查收口结果（IFC-FIL-003：真实状态，不伪造） */
export const FileCheckOutcome = {
  PASSED: 'PASSED',
  FAILED: 'FAILED',
  QUARANTINED: 'QUARANTINED',
  /** 服务不可用：保持检查中（可重试），不得放行 */
  UNAVAILABLE: 'UNAVAILABLE',
} as const;

export type FileCheckOutcome = (typeof FileCheckOutcome)[keyof typeof FileCheckOutcome];

/** 转换非法异常（IFC-ERR-006 业务前置条件失败） */
export class IllegalFileTransitionError extends Error {
  constructor(from: FileState, to: FileState) {
    super(`IFC-ERR-006: 非法文件状态转换 ${from} -> ${to}`);
    this.name = 'IllegalFileTransitionError';
  }
}

/** 转换规则：from -> to 集合（SRS-SM-FILE-001 9.3 明细） */
const TRANSITIONS: Readonly<Record<FileState, readonly FileState[]>> = {
  [FileState.NEW]: [FileState.TEMPORARY_UPLOAD, FileState.PENDING_CLEANUP],
  [FileState.TEMPORARY_UPLOAD]: [
    FileState.CHECKING,
    FileState.QUARANTINED_FAILED,
    FileState.PENDING_CLEANUP,
  ],
  [FileState.CHECKING]: [
    FileState.AVAILABLE,
    FileState.QUARANTINED_FAILED,
    FileState.CHECKING, // 服务不可用/重试：保持检查中（状态不变，可重试标志）
    FileState.PENDING_CLEANUP,
  ],
  [FileState.AVAILABLE]: [
    FileState.BOUND_TO_SUBMISSION,
    FileState.PENDING_CLEANUP,
    FileState.QUARANTINED_FAILED, // 后续检查失败（补检）→ 隔离
  ],
  [FileState.BOUND_TO_SUBMISSION]: [FileState.PENDING_CLEANUP],
  [FileState.PENDING_CLEANUP]: [FileState.CLEANED, FileState.FORMALLY_DELETED],
  [FileState.CLEANED]: [],
  [FileState.QUARANTINED_FAILED]: [FileState.PENDING_CLEANUP],
  [FileState.FORMALLY_DELETED]: [],
};

/** 文件状态机（纯规则；SRS-SM-FILE-001） */
export class FileStateMachine {
  canTransition(from: FileState, to: FileState): boolean {
    return TRANSITIONS[from].includes(to);
  }

  /** 执行转换；非法转换抛 IllegalFileTransitionError */
  transition(from: FileState, to: FileState): FileState {
    if (!this.canTransition(from, to)) {
      throw new IllegalFileTransitionError(from, to);
    }
    return to;
  }

  /** 检查未完成或不可信（未检查状态集合；不得绑定/访问，FORM-007） */
  isUnsafe(state: FileState): boolean {
    return state !== FileState.AVAILABLE && state !== FileState.BOUND_TO_SUBMISSION;
  }

  /** 检查服务不可用时保持检查中（可重试标志），不得超时放行（GOV-008/NFR-003） */
  onCheckUnavailable(current: FileState): FileState {
    if (current !== FileState.CHECKING) {
      throw new IllegalFileTransitionError(current, FileState.CHECKING);
    }
    return FileState.CHECKING; // 状态不变；调用方设置 retryable 标志
  }
}
