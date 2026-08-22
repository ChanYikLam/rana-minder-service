/**
 * 列出社团结论用例（JNT-005）。
 */

import type { JointConclusionSnapshot } from '../../domain/models/joint-conclusion';
import type { JointRepository } from '../ports/joint-repository.port';

export interface ListClubConclusionsInput {
  readonly jointApplicationId: string;
}

export interface ListClubConclusionsUseCase {
  execute(input: ListClubConclusionsInput): Promise<JointConclusionSnapshot[]>;
}

export class DefaultListClubConclusionsUseCase implements ListClubConclusionsUseCase {
  constructor(private readonly repository: JointRepository) {}

  async execute(input: ListClubConclusionsInput): Promise<JointConclusionSnapshot[]> {
    return this.repository.loadConclusionsByApplication(input.jointApplicationId);
  }
}
