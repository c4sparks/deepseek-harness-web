// dsh 会话日志导出（ZIP）传输。适配 dsh v0.1.2-alpha（web 端 `/export` 的下载路由）：
// 官方浏览器插件在 `/export` 命令成功后去拉 GET `/api/session.export?sessionId=…&includeDescendants=true`，
// host 以流式 ZIP 返回（fflate，application/zip + content-disposition）。命令本体只返回
// `Session log download requested.`，真正的导出内容只能经该 GET 路由拿 —— 本函数即该路由的宿主侧取回。
// 运行中的 dsh 若不支持该路由（HTTP 404/405）→ 抛 ExportUnsupportedError，由上层回退为仅回显命令文本。
import * as http from 'http';
import { getEndpoint, authCookieForPort } from './auth';

/** 运行中的 dsh 没有 /api/session.export 下载路由（版本未带或未启用）。上层据此回退。 */
export class ExportUnsupportedError extends Error {
    constructor() {
        super('当前 DSH 服务未提供会话日志下载路由（/api/session.export）');
        this.name = 'ExportUnsupportedError';
    }
}

export interface SessionLogZip {
    /** 优先取 content-disposition 的文件名，缺省 `dsh-session-<id>.zip`。 */
    filename: string;
    data: Uint8Array;
}

const RPC_TIMEOUT_MS = 30000;

function parseContentDispositionFilename(raw: string | string[] | undefined, fallback: string): string {
    const header = (Array.isArray(raw) ? raw[0] : raw) ?? '';
    const m = /filename\*=UTF-8''([^;]+)/i.exec(header) || /filename="?([^";]+)"?/i.exec(header);
    if (!m) {
        return fallback;
    }
    try {
        return decodeURIComponent(m[1].trim());
    } catch {
        return m[1].trim();
    }
}

/** 取回当前会话日志 ZIP（原样二进制）。服务不支持该路由 → 抛 ExportUnsupportedError。 */
export async function fetchSessionLogZip(sessionId: string): Promise<SessionLogZip> {
    const ep = getEndpoint();
    const fallback = `dsh-session-${sessionId.slice(0, 8)}.zip`;
    const query = `sessionId=${encodeURIComponent(sessionId)}&includeDescendants=true`;
    const pathname = `/api/session.export?${query}`;

    return new Promise<SessionLogZip>((resolve, reject) => {
        const req = http.request(
            {
                host: '127.0.0.1',
                port: ep.port,
                path: pathname,
                method: 'GET',
                headers: Object.assign(
                    { accept: 'application/zip', host: `127.0.0.1:${ep.port}` },
                    authCookieForPort(ep.port) ? { cookie: authCookieForPort(ep.port) as string } : {}
                ),
                timeout: RPC_TIMEOUT_MS,
            },
            (res) => {
                if (res.statusCode === 404 || res.statusCode === 405 || res.statusCode === 501) {
                    res.resume();
                    reject(new ExportUnsupportedError());
                    return;
                }
                if (res.statusCode !== 200) {
                    res.resume();
                    reject(new Error(`会话日志导出失败：HTTP ${res.statusCode}`));
                    return;
                }
                const chunks: Buffer[] = [];
                res.on('data', (chunk: Buffer) => chunks.push(chunk));
                res.on('end', () => {
                    resolve({
                        filename: parseContentDispositionFilename(res.headers['content-disposition'], fallback),
                        data: Buffer.concat(chunks),
                    });
                });
                res.on('error', (err) => reject(new Error(`会话日志导出连接中断：${err.message}`)));
            }
        );
        req.on('error', (err) => reject(new Error(`无法连接 DSH 服务（127.0.0.1:${ep.port}）：${err.message}`)));
        req.on('timeout', () => {
            req.destroy();
            reject(new Error('会话日志导出请求超时'));
        });
        req.end();
    });
}
