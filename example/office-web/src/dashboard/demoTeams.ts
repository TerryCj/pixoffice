import type { OfficeDataSource } from '@pixoffice/protocol/dashboard'
import type { OfficeChatSource } from '@pixoffice/protocol/chat'
import type { OfficeTeamDefinition } from './officeDirectory.ts'

export type DemoOfficeTeam = OfficeTeamDefinition
export interface DemoOfficeScenario {
  createSource(): OfficeDataSource
  createChatSource(): OfficeChatSource
  createTeams(source: OfficeDataSource): DemoOfficeTeam[]
  createOffice(office: { id: string; name: string }): DemoOfficeTeam
}

export function createDemoOfficeTeams(source: OfficeDataSource): DemoOfficeTeam[] {
  return [
    { id: 'office-1', name: 'AI 团队办公室', description: 'Muse 总管与五位 AI 成员的日常工作。', sceneLabel: '办公室', source },
  ]
}
