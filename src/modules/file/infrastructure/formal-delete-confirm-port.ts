import { Injectable, Logger } from '@nestjs/common';

/** 正式删除二次确认核验端口注入令牌（FormalDeleteConfirmPort 为接口，注入须用显式 token） */
export const FORMAL_DELETE_CONFIRM_PORT = Symbol('FORMAL_DELETE_CONFIRM_PORT');

/**
 * 独立二次确认核验端口（AUD-008：超管正式删除需"独立二次确认"）。
 *
 * confirmationCode 由审计/前台二次确认流程签发的一次性确认码或审计令牌，
 * 与删除原因分离存证。命令层不得仅凭"非空/长度"放行——必须经本端口向
 * 签发方核验凭据真实有效，防止任意字符串绕过独立二次确认语义
 * （AUD-007~009 的二次确认/范围/审计纵深防御）。
 *
 * 实现方由审计/二次确认模块接入（占位实现仅脱敏记录，不做放行判定以外的事）。
 */
export interface FormalDeleteConfirmPort {
  /**
   * 核验独立二次确认凭据是否真实有效。
   * @param confirmationCode 待核验的确认码/审计令牌（命令层已 trim）
   * @returns true = 凭据由签发方确认有效；false = 无效/已用/伪造
   */
  verify(confirmationCode: string): Promise<boolean>;
}

/**
 * 占位实现：审计/二次确认签发方接入前的过渡实现。
 *
 * 生产接入前必须替换为真实签发方核验（一次性令牌存证 + 比对 + 作废），
 * 否则二次确认仅停留在"非空/长度"校验层面，无法真正落地 AUD-008。
 */
@Injectable()
export class LogOnlyFormalDeleteConfirm implements FormalDeleteConfirmPort {
  private readonly logger = new Logger(LogOnlyFormalDeleteConfirm.name);

  async verify(confirmationCode: string): Promise<boolean> {
    // 占位：不泄露完整凭据（GOV-008 脱敏口径），仅记录核验事件，
    // 并在占位期要求凭据满足最小强度作为最低防线。
    this.logger.log(`正式删除二次确认核验（占位）：len=${confirmationCode.length}`);
    return confirmationCode.length >= 6;
  }
}
