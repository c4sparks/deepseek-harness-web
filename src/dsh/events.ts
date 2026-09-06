// dsh 0.1.2-rc.1 的 Remote Event（$events）监听器。
//
// rc.1 移除旧 /api/respond 后，审批与提问改为：
//   - 通过 /api/remote.mux 打开逻辑流 `$events`（payload { args: {} }）；
//   - 服务端下发 ready（clientId）与 waterfall（event/eventId/agentId/request）帧；
//   - 应答方通过 unary `$events/result` 回传 outcome。
// 本模块负责维护一条可重连的 $events 流，并按会话把请求投递给聊天层。
import { openMuxStream, sendRemoteEventResult } from './api';

export interface DshRemoteApprovalRequest {
    readonly clientId: string;
    readonly eventId: string;
    readonly agentId: string;
    /** 上游 request.toolName；缺失时为 undefined，不自行造默认工具名 */
    readonly toolName?: string;
    readonly callId?: string;
    readonly reason?: string;
}

export interface DshRemoteQuestionRequest {
    readonly clientId: string;
    readonly eventId: string;
    readonly agentId: string;
    readonly questions: Array<{
        id: string;
        question: string;
        header?: string;
        detail?: string;
        options?: Array<{ label: string; description?: string }>;
        multiSelect?: boolean;
    }>;
}

/** 某个会话等待期间感兴趣的 $events 回调。 */
export interface DshSessionEventHandlers {
    onApproval?: (request: DshRemoteApprovalRequest) => void;
    onQuestion?: (request: DshRemoteQuestionRequest) => void;
    onCancel?: (eventId: string) => void;
}

interface RemoteInvocation {
    readonly clientId: string;
    readonly eventId: string;
    readonly agentId: string;
    readonly event: string;
}

type WaterfallFrame = {
    type: 'waterfall';
    event: string;
    eventId: string;
    agentId: string;
    request: Record<string, unknown>;
};

const RECONNECT_DELAY_MS = 1500;
const STREAM_TIMEOUT_MS = 10_000;

/**
 * $events 流单例：整条流由本模块持有，外部按 sessionId 订阅感兴趣的事件。
 * 断线后自动重连；重连不会影响仍由官方页面/其它客户端持有的事件。
 */
class RemoteEventHub {
    private started = false;
    private stopping = false;
    private generation = 0;
    private clientId: string | undefined;
    private readonly handlers = new Map<string, Set<DshSessionEventHandlers>>();
    private readonly pending = new Map<string, RemoteInvocation>();

    /** 订阅某个 agent/session 在等待期间的审批/提问事件。 */
    subscribe(sessionId: string, handlers: DshSessionEventHandlers): () => void {
        void this.ensureStarted();
        let set = this.handlers.get(sessionId);
        if (set === undefined) {
            set = new Set();
            this.handlers.set(sessionId, set);
        }
        set.add(handlers);
        return () => {
            const current = this.handlers.get(sessionId);
            if (current === undefined) {
                return;
            }
            current.delete(handlers);
            if (current.size === 0) {
                this.handlers.delete(sessionId);
            }
        };
    }

    /** 应答审批：返回是否命中本地正在等待的 $events 事件。 */
    async approve(eventId: string, outcome: 'allowed-once' | 'rejected'): Promise<boolean> {
        const pending = this.pending.get(eventId);
        if (pending === undefined) {
            return false;
        }
        await sendRemoteEventResult(pending.clientId, eventId, {
            kind: 'result',
            value: outcome,
        });
        this.pending.delete(eventId);
        return true;
    }

    /** 应答提问：value 结构与 AskUserQuestionAnswer 一致。 */
    async answerQuestion(
        eventId: string,
        answers: Array<{ id: string; selected: string[]; custom?: string }>
    ): Promise<boolean> {
        const pending = this.pending.get(eventId);
        if (pending === undefined) {
            return false;
        }
        await sendRemoteEventResult(pending.clientId, eventId, {
            kind: 'result',
            value: { answers },
        });
        this.pending.delete(eventId);
        return true;
    }

    /** 取消提问：与官方页面一致，以 UserQuestionError/ASK_CANCELLED 拒绝该 waterfall。 */
    async cancelQuestion(eventId: string): Promise<boolean> {
        const pending = this.pending.get(eventId);
        if (pending === undefined) {
            return false;
        }
        await sendRemoteEventResult(pending.clientId, eventId, {
            kind: 'rejected',
            error: {
                name: 'UserQuestionError',
                message: 'the user cancelled ask_user_question',
                code: 'ASK_CANCELLED',
            },
        });
        this.pending.delete(eventId);
        return true;
    }

    /** 停用（服务退出/扩展停用）。 */
    stop(): void {
        this.stopping = true;
        this.started = false;
        this.generation += 1;
        this.pending.clear();
        this.handlers.clear();
        this.control?.cancel();
        this.control = undefined;
    }

    private async ensureStarted(): Promise<void> {
        if (this.started || this.stopping) {
            return;
        }
        this.started = true;
        this.stopping = false;
        void this.run();
    }

    private async run(): Promise<void> {
        while (!this.stopping) {
            const generation = ++this.generation;
            try {
                await this.openOnce(generation);
            } catch (e) {
                if (!this.stopping) {
                    console.warn(`[dsh-events] $events 监听失败：${e instanceof Error ? e.message : String(e)}`);
                }
            }
            if (this.stopping) {
                break;
            }
            await new Promise((resolve) => setTimeout(resolve, RECONNECT_DELAY_MS));
        }
    }

    /** 打开一次 $events 流并等到它关闭。 */
    private openOnce(generation: number): Promise<void> {
        return new Promise<void>((resolve) => {
            let settled = false;
            const done = (): void => {
                if (settled) {
                    return;
                }
                settled = true;
                if (this.generation === generation) {
                    this.clientId = undefined;
                    this.pending.clear();
                }
                resolve();
            };
            void openMuxStream(
                '$events',
                { args: {} },
                {
                    onItem: (value) => {
                        if (generation === this.generation && !this.stopping) {
                            this.onFrame(value);
                        }
                    },
                    onError: () => done(),
                    onEnd: () => done(),
                    onClose: () => done(),
                    onFatal: () => done(),
                },
                STREAM_TIMEOUT_MS
            )
                .then((control) => {
                    if (generation !== this.generation || this.stopping) {
                        control.cancel();
                        done();
                        return;
                    }
                    this.control = control;
                })
                .catch(() => done());
        });
    }

    private control: { cancel: () => void } | undefined;

    private onFrame(value: unknown): void {
        // 实验抓帧（$events）：env DSH_RAWLOG=1/full
        const logMode = process.env['DSH_RAWLOG'];
        if (logMode) {
            const f = value as { type?: string; event?: string; eventId?: string; agentId?: string } | undefined;
            if (logMode === 'full') {
                console.log(`[dsh-raw] events ` + JSON.stringify(value).slice(0, 200_000));
            } else {
                console.log(
                    `[dsh-raw] events ${String(f?.type ?? 'frame')}${f?.event ? ' event=' + f.event : ''}${f?.eventId ? ' eventId=' + f.eventId : ''}${f?.agentId ? ' agentId=' + f.agentId : ''}`
                );
            }
        }
        const frame = value as
            | { type?: string; clientId?: string; eventId?: string; event?: string; agentId?: string; request?: Record<string, unknown> }
            | undefined;
        if (!frame || typeof frame !== 'object') {
            return;
        }
        if (frame.type === 'ready' && typeof frame.clientId === 'string') {
            this.clientId = frame.clientId;
            return;
        }
        if (frame.type === 'cancel' && typeof frame.eventId === 'string') {
            this.pending.delete(frame.eventId);
            for (const set of this.handlers.values()) {
                for (const handler of set) {
                    handler.onCancel?.(frame.eventId);
                }
            }
            return;
        }
        if (frame.type !== 'waterfall' || typeof frame.eventId !== 'string' || typeof frame.agentId !== 'string') {
            return;
        }
        const invocation: RemoteInvocation = {
            clientId: this.clientId ?? '',
            eventId: frame.eventId,
            agentId: frame.agentId,
            event: frame.event ?? '',
        };
        const set = this.handlers.get(frame.agentId);
        if (set === undefined || set.size === 0) {
            return;
        }
        this.pending.set(frame.eventId, invocation);
        const request = frame.request ?? {};
        if (frame.event === 'approval/request') {
            const toolName = typeof request['toolName'] === 'string' ? request['toolName'] : undefined;
            const callId = typeof request['callId'] === 'string' ? request['callId'] : undefined;
            const reason = typeof request['reason'] === 'string' ? request['reason'] : undefined;
            for (const handler of set) {
                handler.onApproval?.({
                    clientId: invocation.clientId,
                    eventId: frame.eventId,
                    agentId: frame.agentId,
                    toolName,
                    ...(callId === undefined ? {} : { callId }),
                    ...(reason === undefined ? {} : { reason }),
                });
            }
            return;
        }
        if (frame.event === 'user-questions/request') {
            const rawQuestions = Array.isArray(request['questions']) ? request['questions'] : [];
            for (const handler of set) {
                handler.onQuestion?.({
                    clientId: invocation.clientId,
                    eventId: frame.eventId,
                    agentId: frame.agentId,
                    questions: rawQuestions as DshRemoteQuestionRequest['questions'],
                });
            }
        }
    }
}

/** 全局唯一的 $events 流维护者。 */
export const dshEvents = new RemoteEventHub();
