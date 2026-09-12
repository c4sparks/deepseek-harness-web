// DSH 网页的本地认证代理。
//
// dsh v0.1.5-rc.2 起，网页端登录把 HttpOnly + SameSite=Strict 的 dsh-auth-* cookie
// 写回浏览器；VS Code Webview 的 iframe 处于 vscode-webview:// 跨站上下文，既无法保存
// 该 HttpOnly cookie，也不会在跳回干净 / 时携带它，直接 iframe `/?token=` 必然收到
// “dsh web authentication required”。本模块在扩展宿主内监听 127.0.0.1 随机端口，
// 由扩展进程持有 cookie，并把 iframe 的所有 HTTP / WebSocket 请求转发到真实 dsh 端口：
// iframe 访问的是“同源代理”，不再依赖 Webview 的 cookie 能力。
import * as http from 'node:http';
import type { IncomingHttpHeaders, OutgoingHttpHeaders, ServerResponse } from 'node:http';
import * as net from 'node:net';
import type { Duplex } from 'node:stream';
import type { DshEndpoint } from './api';
import { ensureEndpointAuth, endpointAuthCookie } from './api';

/** 已启动的本地代理句柄。 */
export interface DshWebProxy {
    readonly port: number;
    /** iframe 使用的同源根 URL，例如 http://127.0.0.1:<port>/。 */
    readonly url: string;
    close(): Promise<void>;
}

const HOST = '127.0.0.1';

/** 由 Node 处理、或会向 dsh 泄漏代理同源身份的逐跳/浏览器标记头。 */
const SKIP_REQUEST_HEADERS = new Set([
    'connection',
    'keep-alive',
    'proxy-connection',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade',
    'host',
    'cookie',
    'origin',
    'referer',
    'sec-fetch-site',
    'sec-fetch-mode',
    'sec-fetch-dest',
    'sec-fetch-user',
]);

function headerText(value: string | string[] | undefined): string | undefined {
    if (value === undefined) {
        return undefined;
    }
    return Array.isArray(value) ? value.join(', ') : value;
}

/** 文本类响应体：替换绝对 dsh 源后内容长度不变校验需重写，先缓冲再转发。 */
function isTextualBody(contentType: string | undefined, encoding: string | undefined): boolean {
    if (encoding !== undefined && encoding !== 'identity') {
        return false;
    }
    const base = (contentType ?? '').split(';')[0].trim().toLowerCase();
    if (base === 'text/event-stream') {
        // SSE 是长连接，不能缓冲等待结束；原样转发（正文不会携带 dsh 绝对源）。
        return false;
    }
    return (
        base.startsWith('text/') ||
        base === 'application/javascript' ||
        base === 'application/json' ||
        base.endsWith('+json') ||
        base === 'application/xml' ||
        base.endsWith('+xml') ||
        base === 'image/svg+xml'
    );
}

function makeRewriter(proxyPort: number, backendPort: number): { text(s: string): string; header(v: string): string } {
    const backendOrigin = `http://${HOST}:${backendPort}`;
    const proxyOrigin = `http://${HOST}:${proxyPort}`;
    const backendWs = `ws://${HOST}:${backendPort}`;
    const proxyWs = `ws://${HOST}:${proxyPort}`;
    const backendRelative = `//${HOST}:${backendPort}`;
    const proxyRelative = `//${HOST}:${proxyPort}`;
    const rewrite = (s: string): string =>
        s
            .split(backendWs)
            .join(proxyWs)
            .split(backendOrigin)
            .join(proxyOrigin)
            .split(backendRelative)
            .join(proxyRelative);
    return {
        text: rewrite,
        header: rewrite,
    };
}

function buildRequestHeaders(
    headers: IncomingHttpHeaders,
    backendPort: number,
    cookie: string | undefined
): Record<string, string | string[]> {
    const out: Record<string, string | string[]> = {};
    for (const [name, value] of Object.entries(headers)) {
        const lower = name.toLowerCase();
        if (value === undefined || SKIP_REQUEST_HEADERS.has(lower)) {
            continue;
        }
        out[name] = value;
    }
    out.host = `${HOST}:${backendPort}`;
    out['accept-encoding'] = 'identity';
    if (cookie) {
        out.cookie = cookie;
    }
    return out;
}

/** 请求是否携带需要重放的实体（GET/HEAD 与空请求可在 401 后安全重试）。 */
function hasRequestBody(req: http.IncomingMessage): boolean {
    if (req.method === 'GET' || req.method === 'HEAD') {
        return false;
    }
    if (req.headers['transfer-encoding'] !== undefined) {
        return true;
    }
    const length = Number(req.headers['content-length'] ?? '0');
    return Number.isFinite(length) && length > 0;
}

/** 401 且无法自动恢复时，给网页导航一个可读的本地错误页（不把上游裸 401 铺进面板）。 */
function writeAuthFailure(res: ServerResponse): void {
    if (res.headersSent || res.destroyed) {
        return;
    }
    res.writeHead(502, { 'content-type': 'text/html; charset=utf-8' });
    res.end(
        '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">' +
            '<title>DSH 网页登录失败</title></head>' +
            '<body style="font-family:system-ui;padding:24px;color:var(--vscode-foreground)">' +
            '<h2>无法进入 DSH 官方网页</h2>' +
            '<p>本地认证代理未拿到有效的 dsh 登录会话。请在 dsh 启动终端确认最新 URL，' +
            '然后用标题栏「在浏览器中打开」登录后重试。</p>' +
            '</body></html>'
    );
}

async function proxyHttp(
    req: http.IncomingMessage,
    res: ServerResponse,
    backendPort: number,
    proxyPort: number,
    endpoint: DshEndpoint,
    attempt = 0
): Promise<void> {
    let cookie = endpointAuthCookie(endpoint);
    if (!cookie && endpoint.authUrl) {
        await ensureEndpointAuth(endpoint);
        cookie = endpointAuthCookie(endpoint);
    }
    if (req.destroyed || res.destroyed) {
        return;
    }

    const headers = buildRequestHeaders(req.headers, backendPort, cookie);
    const upstream = http.request(
        {
            host: HOST,
            port: backendPort,
            path: req.url ?? '/',
            method: req.method ?? 'GET',
            headers,
            timeout: 60_000,
        },
        (upRes) => {
            upRes.on('error', () => {
                if (!res.headersSent) {
                    res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
                }
                res.destroy();
            });
            // dsh 会因 cookie 失效/服务重启返回 401：有 authUrl 且请求无实体时，
            // 先重新登录一次，再从代理重发（避免把上游 401 原文显示在面板里）。
            if (upRes.statusCode === 401 && attempt === 0 && endpoint.authUrl && !hasRequestBody(req)) {
                upRes.resume();
                void (async () => {
                    try {
                        await ensureEndpointAuth(endpoint);
                    } catch {
                        // 下面仍会按失败处理
                    }
                    if (res.destroyed || res.headersSent) {
                        return;
                    }
                    await proxyHttp(req, res, backendPort, proxyPort, endpoint, attempt + 1);
                })().catch(() => {
                    writeAuthFailure(res);
                });
                return;
            }
            if (upRes.statusCode === 401 && !res.headersSent) {
                const acceptsHtml = (headerText(req.headers['accept']) ?? '').includes('text/html');
                if (req.method === 'GET' && acceptsHtml) {
                    upRes.resume();
                    writeAuthFailure(res);
                    return;
                }
            }
            const contentType = headerText(upRes.headers['content-type']);
            const encoding = headerText(upRes.headers['content-encoding']);
            const rewriter = makeRewriter(proxyPort, backendPort);
            const shouldRewrite = isTextualBody(contentType, encoding);
            const status = upRes.statusCode ?? 502;

            if (!shouldRewrite) {
                const outHeaders = responseHeaders(upRes.headers, rewriter);
                res.writeHead(status, outHeaders);
                upRes.pipe(res);
                return;
            }

            const chunks: Buffer[] = [];
            upRes.on('data', (chunk: Buffer) => chunks.push(chunk));
            upRes.on('end', () => {
                const raw = Buffer.concat(chunks).toString('utf8');
                const body = Buffer.from(rewriter.text(raw), 'utf8');
                const outHeaders = responseHeaders(upRes.headers, rewriter);
                outHeaders['content-length'] = body.length;
                res.writeHead(status, outHeaders);
                res.end(body);
            });
        }
    );
    req.on('error', () => upstream.destroy());
    res.on('close', () => {
        if (!res.writableEnded) {
            upstream.destroy();
        }
    });
    upstream.on('error', (err) => {
        if (!res.headersSent) {
            res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
            res.end(`无法连接 DSH 本地服务：${err.message}`);
            return;
        }
        res.destroy(err);
    });
    upstream.on('timeout', () => {
        upstream.destroy(new Error('DSH 网页代理请求超时'));
    });
    if (hasRequestBody(req)) {
        req.pipe(upstream);
    } else {
        upstream.end();
    }
}

/** 拷贝上游响应头：跳过逐跳头与 set-cookie，并重写仍含 dsh 绝对源的字段。 */
function responseHeaders(
    headers: IncomingHttpHeaders,
    rewriter: { header(v: string): string }
): OutgoingHttpHeaders {
    const out: OutgoingHttpHeaders = {};
    for (const [name, value] of Object.entries(headers)) {
        const lower = name.toLowerCase();
        if (
            value === undefined ||
            lower === 'connection' ||
            lower === 'keep-alive' ||
            lower === 'transfer-encoding' ||
            lower === 'set-cookie' ||
            lower === 'upgrade' ||
            lower === 'trailer'
        ) {
            continue;
        }
        if (Array.isArray(value)) {
            out[name] = value.map((v) => rewriter.header(v));
        } else {
            out[name] = rewriter.header(value);
        }
    }
    return out;
}

function rejectUpgrade(socket: Duplex, status: number, message: string): void {
    if (socket.destroyed || !socket.writable) {
        socket.destroy();
        return;
    }
    socket.write(`HTTP/1.1 ${status} ${status === 401 ? 'Unauthorized' : status === 403 ? 'Forbidden' : 'Bad Gateway'}\r\ncontent-type: text/plain\r\nconnection: close\r\n\r\n${message}`);
    socket.end();
}

/** 把浏览器发起的 WebSocket Upgrade（/api/remote.mux）桥接到真实 dsh 端口。 */
function proxyWebSocket(
    req: http.IncomingMessage,
    client: Duplex,
    head: Buffer,
    backendPort: number,
    endpoint: DshEndpoint
): void {
    void (async () => {
        let cookie = endpointAuthCookie(endpoint);
        if (!cookie && endpoint.authUrl) {
            await ensureEndpointAuth(endpoint);
            cookie = endpointAuthCookie(endpoint);
        }
        const key = req.headers['sec-websocket-key'];
        if (typeof key !== 'string') {
            rejectUpgrade(client, 400, 'bad websocket request');
            return;
        }
        if (client.destroyed || !client.writable) {
            return;
        }

        const backend = net.connect(backendPort, HOST);
        let buffer = Buffer.alloc(0);
        let bridged = false;
        const destroyBoth = (err?: Error): void => {
            backend.destroy(err);
            if (!client.destroyed) {
                client.destroy(err);
            }
        };
        const onData = (chunk: Buffer): void => {
            buffer = Buffer.concat([buffer, chunk]);
            const headerEnd = buffer.indexOf('\r\n\r\n');
            if (headerEnd === -1) {
                return;
            }
            backend.off('data', onData);
            const headerBytes = buffer.subarray(0, headerEnd + 4);
            const rest = buffer.subarray(headerEnd + 4);
            const statusLine = headerBytes.toString('latin1').split('\r\n', 1)[0] ?? '';
            const status = Number(statusLine.split(' ')[1]);
            if (status !== 101) {
                if (client.writable) {
                    client.write(headerBytes);
                    if (rest.length > 0) {
                        client.write(rest);
                    }
                    client.end();
                }
                backend.destroy();
                return;
            }
            bridged = true;
            if (rest.length > 0) {
                backend.unshift(rest);
            }
            if (client.writable) {
                client.write(headerBytes);
            }
            backend.pipe(client);
            client.pipe(backend);
            client.on('error', () => backend.destroy());
            backend.on('error', () => {
                if (!client.destroyed) {
                    client.destroy();
                }
            });
        };
        backend.on('data', onData);
        backend.on('error', (err) => {
            if (!bridged) {
                rejectUpgrade(client, 502, `无法连接 DSH WebSocket：${err.message}`);
                return;
            }
            destroyBoth(err);
        });
        backend.on('connect', () => {
            const lines = [
                `GET ${req.url ?? '/'} HTTP/1.1`,
                `host: ${HOST}:${backendPort}`,
                'upgrade: websocket',
                'connection: Upgrade',
                `sec-websocket-version: ${req.headers['sec-websocket-version'] ?? '13'}`,
                `sec-websocket-key: ${key}`,
            ];
            const protocol = headerText(req.headers['sec-websocket-protocol']);
            if (protocol) {
                lines.push(`sec-websocket-protocol: ${protocol}`);
            }
            const extensions = headerText(req.headers['sec-websocket-extensions']);
            if (extensions) {
                lines.push(`sec-websocket-extensions: ${extensions}`);
            }
            const userAgent = headerText(req.headers['user-agent']);
            if (userAgent) {
                lines.push(`user-agent: ${userAgent}`);
            }
            if (cookie) {
                lines.push(`cookie: ${cookie}`);
            }
            const payload = Buffer.concat([Buffer.from(`${lines.join('\r\n')}\r\n\r\n`, 'latin1'), head]);
            backend.write(payload);
        });
        client.on('error', () => backend.destroy());
    })().catch((err: unknown) => {
        rejectUpgrade(client, 502, err instanceof Error ? err.message : String(err));
    });
}

/** 启动仅监听本机的 dsh 网页代理；endpoint 需指向当前 dsh 实例（含 authUrl）。 */
export async function startDshWebProxy(endpoint: DshEndpoint): Promise<DshWebProxy> {
    if (!Number.isInteger(endpoint.port) || endpoint.port <= 0) {
        throw new Error('DSH 网页代理需要有效的 dsh 端口');
    }
    let currentPort = 0;
    const server = http.createServer((req, res) => {
        void proxyHttp(req, res, endpoint.port, currentPort, endpoint).catch((err: unknown) => {
            if (!res.headersSent) {
                res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
            }
            res.end(err instanceof Error ? err.message : String(err));
        });
    });
    server.on('upgrade', (req, socket, head) => {
        proxyWebSocket(req, socket, head, endpoint.port, endpoint);
    });
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, HOST, () => {
            server.off('error', reject);
            resolve();
        });
    });
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    if (!port) {
        server.close();
        throw new Error('DSH 网页代理未获得监听端口');
    }
    currentPort = port;
    const url = `http://${HOST}:${port}/`;
    let closed = false;
    const close = (): Promise<void> =>
        new Promise<void>((resolve) => {
            if (closed) {
                resolve();
                return;
            }
            closed = true;
            server.close(() => resolve());
            if ('closeAllConnections' in server) {
                setImmediate(() => server.closeAllConnections());
            }
        });
    return { port, url, close };
}
