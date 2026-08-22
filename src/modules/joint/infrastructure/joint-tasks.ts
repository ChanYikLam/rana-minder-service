/**
 * 联合定时任务处理（infrastructure；5.1 JNT 扫描类任务）。
 *
 * 直接经仓储 + 领域模型执行扫描，不引入应用层用例。每个 handler 接收
 * { activityId } 载荷；调度侧以真实 TaskProcessorRegistry.register 注册。
 */

import type { JointRepository } from '../application/ports/joint-repository.port';
import type { JointConfigPort } from '../application/ports/joint-data-access.port';

import { JointActivity } from '../domain/models/joint-activity';
import { JointParticipant } from '../domain/models/joint-participant';
import { JointApplication } from '../domain/models/joint-application';
import { JointConclusion } from '../domain/models/joint-conclusion';
import { JointChannel } from '../domain/models/joint-channel';

import { JointActivityStatus } from '../domain/state-machines/joint-activity.state-machine';
import {
  JointParticipantStatus,
  JointParticipantStateMachine,
} from '../domain/state-machines/joint-participant.state-machine';
import {
  JointApplicationStatus,
  JointApplicationStateMachine,
} from '../domain/state-machines/joint-application.state-machine';
import {
  JointConclusionStatus,
  JointConclusionStateMachine,
} from '../domain/state-machines/joint-conclusion.state-machine';
import {
  JointChannelStatus,
  JointChannelStateMachine,
} from '../domain/state-machines/joint-channel.state-machine';

import type { TaskProcessorRegistry } from '../../../platform/tasks/contracts/task-ports';
import type { TaskRecord } from '../../../platform/tasks/contracts/task-record';
import { TaskType } from '../../../platform/tasks/contracts/task-type';

export const JOINT_TASK_TYPES = [
  TaskType.JOINT_CONFIRM_DEADLINE_SCAN,
  TaskType.JOINT_INVITATION_TIMEOUT,
  TaskType.JOINT_CHANNEL_AUTO_CLOSE,
  TaskType.JOINT_FORCE_END_CLEANUP,
  TaskType.JOINT_ARCHIVE_TERMINAL,
] as const;

export type JointTaskType = (typeof JOINT_TASK_TYPES)[number];

export type JointTaskHandler = (payload: { activityId: string }) => Promise<void>;

export interface JointTaskDeps {
  readonly repository: JointRepository;
  readonly config: JointConfigPort;
}

/** 终态/强制结束后的统一归档逻辑 */
async function archiveJointActivity(
  repository: JointRepository,
  activityId: string,
  now: Date,
): Promise<void> {
  const appMachine = new JointApplicationStateMachine();
  const conMachine = new JointConclusionStateMachine();

  const applications = await repository.loadApplicationsByActivity(activityId);
  for (const s of applications) {
    if (s.status !== JointApplicationStatus.SUBMITTED) {
      continue;
    }
    const app = JointApplication.fromSnapshot(s);
    const ok = app.archive(appMachine, now);
    if (ok) {
      await repository.saveApplication(app.toSnapshot(), s.revisionNumber);
    }
  }

  const conclusions = await repository.loadConclusionsByActivity(activityId);
  for (const s of conclusions) {
    if (s.status === JointConclusionStatus.ARCHIVED_LOCKED) {
      continue;
    }
    const conclusion = JointConclusion.fromSnapshot(s);
    const ok = conclusion.archive(conMachine, now);
    if (ok) {
      await repository.saveConclusion(conclusion.toSnapshot(), s.revisionNumber);
    }
  }
}

export function createJointTaskHandlers(deps: JointTaskDeps): Record<string, JointTaskHandler> {
  const { repository } = deps;

  return {
    'joint-confirm-deadline-scan': async ({ activityId }) => {
      const now = new Date();
      const activity = await repository.loadActivity(activityId);
      if (!activity) {
        return;
      }
      const participants = await repository.loadParticipantsByActivity(activityId);
      const machine = new JointParticipantStateMachine();
      for (const snap of participants) {
        if (snap.status !== JointParticipantStatus.CONFIRMED) {
          continue;
        }
        const deadlineExceeded =
          activity.confirmDeadline !== null && now.getTime() > activity.confirmDeadline.getTime();
        if (snap.roundId !== activity.confirmRound || deadlineExceeded) {
          const participant = JointParticipant.fromSnapshot(snap);
          const ok = participant.markStale(machine, now);
          if (ok) {
            await repository.saveParticipant(participant.toSnapshot(), snap.revisionNumber);
          }
        }
      }
    },

    'joint-channel-auto-close': async ({ activityId }) => {
      const now = new Date();
      const channelId = JointChannel.channelId(activityId);
      const snap = await repository.loadChannel(channelId);
      if (!snap || snap.status !== JointChannelStatus.OPEN || !snap.currentWindow) {
        return;
      }
      if (snap.currentWindow.deadline.getTime() <= now.getTime()) {
        const channel = JointChannel.fromSnapshot(snap);
        const ok = channel.close(new JointChannelStateMachine(), now);
        if (ok) {
          await repository.saveChannel(channel.toSnapshot(), snap.revisionNumber);
        }
      }
    },

    'joint-archive-terminal': async ({ activityId }) => {
      const now = new Date();
      const activity = await repository.loadActivity(activityId);
      if (!activity || !JointActivity.fromSnapshot(activity).isTerminal()) {
        return;
      }
      await archiveJointActivity(repository, activityId, now);
    },

    'joint-invitation-timeout': async ({ activityId }) => {
      const now = new Date();
      const conclusions = await repository.loadConclusionsByActivity(activityId);
      const machine = new JointConclusionStateMachine();
      for (const snap of conclusions) {
        if (snap.status !== JointConclusionStatus.INVITE_PENDING) {
          continue;
        }
        const conclusion = JointConclusion.fromSnapshot(snap);
        if (conclusion.timeoutInvite(machine, now)) {
          await repository.saveConclusion(conclusion.toSnapshot(), snap.revisionNumber);
        }
      }
    },

    'joint-force-end-cleanup': async ({ activityId }) => {
      const now = new Date();
      const activity = await repository.loadActivity(activityId);
      if (!activity || activity.status !== JointActivityStatus.FORCE_ENDED) {
        return;
      }
      await archiveJointActivity(repository, activityId, now);
    },
  };
}

export function registerJointTasks(
  registry: TaskProcessorRegistry,
  handlers: Record<string, JointTaskHandler>,
): void {
  for (const taskType of JOINT_TASK_TYPES) {
    const handler = handlers[taskType];
    if (!handler) {
      continue;
    }
    registry.register({
      taskType,
      handle: async (task: TaskRecord): Promise<void> => {
        const payload = task.payload as { activityId: string };
        await handler(payload);
      },
    });
  }
}
