// 历史 /api/respond 兼容（rc.1 的应答走 $events/result，见 events.ts）。
import * as http from "node:http";
import { endpointAuthCookie, getEndpoint } from "./api";
const RPC_TIMEOUT_MS = 15000;
// ---------- 应答残留（历史 /api/respond；rc.1 的应答走 $events/result，见 src/dsh/events.ts） ----------
const pendingApprovalRpc = new Map<string, { rpcId: string; sessionId: string }>();
async function postRespond(
    rpcId: string,
    value: unknown,
    what: string,
    result: { ok: boolean; error?: { code: string; message: string } } = { ok: true }
): Promise<void> {
    const body = {
        type: 'client-response',
        rpcId,
        result: result.ok ? { ok: true, value } : result,
    };
    await new Promise<void>((resolve, reject) => {
        const cookie = endpointAuthCookie();
        const req = http.request(
            {
                host: '127.0.0.1',
                port: getEndpoint().port,
                path: '/api/respond',
                method: 'POST',
                headers: Object.assign(
                    {
                        'content-type': 'application/json',
                        host: `127.0.0.1:${getEndpoint().port}`,
                    },
                    cookie ? { cookie } : {}
                ),
                timeout: RPC_TIMEOUT_MS,
            },
            (res) => {
                let data = '';
                res.on('data', (c) => (data += c));
                res.on('end', () => {
                    try {
                        const parsed = JSON.parse(data) as { accepted?: boolean; reason?: string };
                        if (parsed.accepted) {
                            resolve();
                        } else {
                            reject(
                                new Error(
                                    `DSH 未接受${what}应答${parsed.reason ? `（${parsed.reason}）` : ''}，请在 dsh 网页面板中处理`
                                )
                            );
                        }
                    } catch {
                        resolve(); // 非 JSON 响应按成功处理（旧版服务）
                    }
                });
            }
        );
        req.on('error', (err) => reject(err));
        req.end(JSON.stringify(body));
    });
}
/** 审批应答（仅兼容旧版 dsh 的 /api/respond；dsh v0.1.5-rc.2 无该端点，调用会失败并提示去面板）。 */
export async function respondApproval(
    sessionId: string,
    approvalId: string,
    outcome: 'allowed-once' | 'rejected'
): Promise<void> {
    const entry = pendingApprovalRpc.get(approvalId);
    if (!entry?.rpcId) {
        throw new Error('DSH 未给出该审批的应答标识，无法在本地应答；请到 dsh 网页面板中处理');
    }
    await postRespond(entry.rpcId, { sessionId, approvalId, outcome }, '审批');
}
export async function respondQuestion(
    sessionId: string,
    rpcId: string,
    answers: Array<{ id: string; selected: string[]; custom?: string }>
): Promise<void> {
    await postRespond(rpcId, { sessionId, answer: { answers } }, '提问');
}
export async function cancelQuestion(sessionId: string, rpcId: string): Promise<void> {
    await postRespond(rpcId, { sessionId, answer: { answers: [] } }, '取消提问', {
        ok: false,
        error: { code: 'cancelled', message: 'user cancelled' },
    });
}
