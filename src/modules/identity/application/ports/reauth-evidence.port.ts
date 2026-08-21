/**
 * 最近重新认证证据端口（CAS-REC-003 依赖边界）。
 *
 * 高风险命令要求最近 10 分钟重新认证；证据由认证链路（3.3 Casdoor 登录/
 * 增强认证）登记。缺失或过期一律按未认证处理（失败关闭，IFC-ERR-002）。
 * 证据只存时间戳与服务端会话引用，不存令牌/口令（CAS-SEC-001~004）。
 */

export interface ReauthEvidencePort {
  /** 最近一次成功重新认证时间（无证据返回 null） */
  latestReauthAt(subjectId: string): Promise<Date | null>;
  /** 登记一次成功重新认证（认证链路调用） */
  record(subjectId: string, at: Date): Promise<void>;
}
