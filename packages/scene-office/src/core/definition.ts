import type { Actor, World } from '@pixoffice/runtime/model'
import { OFFICE_ROSTER } from './roster.ts'
import { OFFICE_WALKABLE_AREA } from './officeFloor.ts'

const people = OFFICE_ROSTER.map(({ id, name, color, room }) => [id, name, color, room] as const)

// 前 6 张桌子沿用两列布局；第 7 张起放右侧空列（白板在 (4,7)，右侧 x=14 列空闲）。
// 4 列布局会把原有桌子移位，故新增成员走溢出位，不动已有位置。
const OVERFLOW_DESKS = [{ x: 14, y: 4 }, { x: 14, y: 7 }, { x: 14, y: 10 }]
const deskPosition = (i: number) => i < 6
  ? { x: 6 + i % 2 * 5, y: 4 + Math.floor(i / 2) * 3 }
  : OVERFLOW_DESKS[Math.min(i - 6, OVERFLOW_DESKS.length - 1)]

// 座位映射：第 i 位成员坐第 SEAT_FOR[i] 张桌子。Claude（序号 1）与 Gemini（序号 3）对调，用户 2026-11-12 定。
export const SEAT_FOR = [0, 3, 2, 1, 4, 5, 6]

export function createOfficeWorld(sceneId = 'office-1'): World {
  const props = people.map((_, i) => ({ id: `desk-${i}`, name: people[i][3], templateId: 'office.workstation', position: deskPosition(i), state: {}, stateRevision: 0 }))
  const actors: Actor[] = people.map(([id, name, color], i) => { const desk = props[SEAT_FOR[i]]; return ({ id, name, templateId: id, color, homeId: desk.id,
    position: { x: desk.position.x, y: desk.position.y + 1 }, facing: 'back', posture: 'seated', using: { propId: desk.id, interactionId: 'seat' },
    presentation: { status: 'idle', title: '等待指令', sourceRevision: 0 } }) })
  return { sceneId, unit: 'cell', width: 20, height: 13, gridSize: 1, layoutRevision: 0,
    bounds: { left: 4, top: 4, right: 16, bottom: 12 }, walkableArea: OFFICE_WALKABLE_AREA.map(point => ({ ...point })), actors,
    props: [...props, { id: 'whiteboard-1', name: '协作白板', templateId: 'office.whiteboard', position: { x: 4, y: 7 }, state: { title: '团队协作', text: '等待议题' }, stateRevision: 0 }] }
}
