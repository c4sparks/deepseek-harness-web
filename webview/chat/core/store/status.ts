// 会话状态切片：过渡态与宿主投影（统计行 / plan / goal / 系统提示词）。
// 除 applyProjections 外无动作、不需要 host；busy 由归约器直接写 .value。
import { signal } from '@preact/signals'
import { formatStatsLine } from '../format'
import type { ChatStore } from './types'

export interface StatusSlice {
  store: Pick<ChatStore, 'busy' | 'sessionCwd' | 'statsLine' | 'planState' | 'goalState'>
  /** 由投影快照刷新统计行、plan 与 goal 三项（形状兼容见下）。 */
  applyProjections(proj: Record<string, unknown>): void
  reset(): void
}

export function createStatus(): StatusSlice {
  const busy = signal<'loading' | 'switching' | null>(null)
  const sessionCwd = signal('')
  const statsLine = signal({ text: '', title: '' })
  const planState = signal<{ active: boolean; pending: boolean } | null>(null)
  const goalState = signal<{ objective: string; phase: string } | null>(null)

  /** plan 投影：能力未组合则键缺失 → 保持 null。 */
  function derivePlanState(proj: Record<string, unknown>): { active: boolean; pending: boolean } | null {
    const p = proj['plan'] as { active?: boolean; pending?: boolean } | undefined
    return p && typeof p.active === 'boolean' ? { active: p.active, pending: !!p.pending } : null
  }

  /** goal 投影：null=无目标、缺键=能力未组合。形状按官方 GoalProjection{goal:{objective,phase,…}}，
   *  顺带兼容扁平 string/object 的旧/变体。 */
  function deriveGoalState(proj: Record<string, unknown>): { objective: string; phase: string } | null {
    const rawGoal: unknown = proj['goal']
    let goalObj: string | undefined
    let goalPhase = ''
    if (typeof rawGoal === 'string') {
      goalObj = rawGoal || undefined
    } else if (rawGoal && typeof rawGoal === 'object') {
      const rec = rawGoal as Record<string, unknown>
      const nested = rec['goal']
      const src = nested && typeof nested === 'object' ? (nested as Record<string, unknown>) : rec
      const obj = src['objective']
      const ph = src['phase']
      if (typeof obj === 'string' && obj) goalObj = obj
      if (typeof ph === 'string') goalPhase = ph
    }
    return goalObj ? { objective: goalObj, phase: goalPhase } : null
  }

  function applyProjections(proj: Record<string, unknown>): void {
    statsLine.value = formatStatsLine(proj)
    planState.value = derivePlanState(proj)
    goalState.value = deriveGoalState(proj)
  }

  function reset(): void {
    busy.value = null
    statsLine.value = { text: '', title: '' }
    planState.value = null
    goalState.value = null
    // sessionCwd 不随会话清空：它标识的是工作区，换会话后同一工作区仍有效；
    // 工作区切换由宿主推新的 chatInfo 覆盖。
  }

  return { store: { busy, sessionCwd, statsLine, planState, goalState }, applyProjections, reset }
}
