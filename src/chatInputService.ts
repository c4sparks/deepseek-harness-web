// 聊天输入框(composer)功能的宿主侧服务。目前承载 "/" 斜杠命令/技能的数据与执行；
// 后续输入类能力(如 "@ " 引用/文件检索、其它输入触发)都加到这里，避免 dshService 继续膨胀。
// 与 DshService 的关系：只复用它的「服务就绪 + 当前会话」能力(结构型依赖，见 ChatInputSession)。
import {
    listCommands as listCommandsRpc,
    listSkills as listSkillsRpc,
    runSessionCommand,
    type DshCommandDescriptor,
    type DshSkillEntry,
} from './dsh';

/** ChatInputService 需要的宿主会话能力(由 DshService 提供)。 */
export interface ChatInputSession {
    ensureRunning(): Promise<boolean>;
    getSession(): Promise<string>;
}

export class ChatInputService {
    constructor(private readonly session: ChatInputSession) {}

    /** 当前会话可用的斜杠命令目录(commands/list)；拉取失败返回空数组。 */
    async listCommands(): Promise<DshCommandDescriptor[]> {
        try {
            if (!(await this.session.ensureRunning())) {
                return [];
            }
            return await listCommandsRpc(await this.session.getSession());
        } catch {
            return [];
        }
    }

    /** 当前会话可用的技能(skill.list)；拉取失败返回空数组。 */
    async listSkills(): Promise<DshSkillEntry[]> {
        try {
            if (!(await this.session.ensureRunning())) {
                return [];
            }
            return await listSkillsRpc(await this.session.getSession());
        } catch {
            return [];
        }
    }

    /** 执行一条任意 dsh 斜杠命令(如 /permission write、/compact)，返回 ok 与结果文本(不抛给 UI)。 */
    async runCommand(line: string): Promise<{ ok: boolean; text?: string }> {
        if (!(await this.session.ensureRunning())) {
            return { ok: false, text: 'DSH 服务不可用，无法执行命令' };
        }
        const sid = await this.session.getSession();
        try {
            const exec = await runSessionCommand(sid, line);
            if (!exec || exec.result?.kind === 'error') {
                return { ok: false, text: exec?.result?.text || '命令执行失败（无返回）' };
            }
            return { ok: true, text: exec.result?.text };
        } catch (e) {
            return { ok: false, text: e instanceof Error ? e.message : String(e) };
        }
    }
}
