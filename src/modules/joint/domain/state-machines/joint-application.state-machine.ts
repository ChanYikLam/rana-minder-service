/**
 * 联合申请状态机（JNT-003；SRS-SM-JNT-003）。
 *
 * 草稿 → 提交（硬前提：共享同意快照匹配）→ 活动终态后归档只读。
 * 联合申请是独立强类型对象，不推进普通招新申请或任何社团结论。
 */

export enum JointApplicationStatus {
  DRAFT = 'DRAFT',
  SUBMITTED = 'SUBMITTED',
  ARCHIVED = 'ARCHIVED',
}

export enum JointApplicationEvent {
  SUBMIT = 'SUBMIT',
  ARCHIVE = 'ARCHIVE',
}

export interface JointApplicationTransition {
  readonly allowed: boolean;
  readonly nextState?: JointApplicationStatus;
}

export class JointApplicationStateMachine {
  transition(input: {
    event: JointApplicationEvent;
    currentState: JointApplicationStatus;
  }): JointApplicationTransition {
    const { event, currentState } = input;
    switch (event) {
      case JointApplicationEvent.SUBMIT:
        if (currentState === JointApplicationStatus.DRAFT) {
          return { allowed: true, nextState: JointApplicationStatus.SUBMITTED };
        }
        return { allowed: false };
      case JointApplicationEvent.ARCHIVE:
        if (currentState === JointApplicationStatus.SUBMITTED) {
          return { allowed: true, nextState: JointApplicationStatus.ARCHIVED };
        }
        return { allowed: false };
      default:
        return { allowed: false };
    }
  }
}
