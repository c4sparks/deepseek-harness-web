// dsh 0.1.2-rc.1 agent 模式（preset roster）：远端 agentPresets/list 读取，
// agentPresets/select 仅可在空白会话上切换（已开始会话后端会拒绝）。
import { rpcCall } from './rpc';

/** 一个远端模式行（路径无关，只按 id 寻址）。 */
export interface DshAgentPresetRow {
    id: string;
    trust: 'system' | 'user';
    isDefault: boolean;
    name?: string;
    description?: string;
    broken?: string;
}

/** 当前部署支持的模式列表 + 是否可本地新建。 */
export interface DshAgentPresetRoster {
    presets: DshAgentPresetRow[];
    authorable: boolean;
}

/** 读取 dsh 支持的 agent 模式列表（适配 0.1.2-rc.1；远端无参 list）。 */
export async function listAgentPresets(): Promise<DshAgentPresetRoster> {
    return rpcCall<DshAgentPresetRoster>('agentPresets.list', {});
}

/** 给空白会话切换 agent 模式（适配 0.1.2-rc.1；远端 select(session, agentPreset)）。 */
export async function selectAgentPreset(sessionId: string, agentPreset: string): Promise<string> {
    return rpcCall<string>('agentPresets.select', { agentId: sessionId, agentPreset });
}
