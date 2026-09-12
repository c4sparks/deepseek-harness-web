// 诊断用追踪（**临时**）：DSH_RAWLOG 打开时，把关键活动追加到系统临时目录的文件。
//
// 为什么落文件而不只打控制台：full 模式下控制台一次刷几十 KB（每个原始帧最长 200k），
// 人工复制必然截断 —— 而「工具行有、展开却空」这类问题恰恰要看**完整的活动序列**
// （宿主发了什么、webview 把哪条活动落到了哪一行）。
//
// 只在 DSH_RAWLOG 设置时生效；未设置时是纯空操作，不改变任何功能行为。
// 文件位置：<系统临时目录>/dsh-plugin-trace.log
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

let file: string | undefined;

/**
 * 追加一行诊断。永不抛出（诊断失败不能影响功能）。
 * @param line - 单行内容（调用方自带类别前缀，如 `host toolDone …` / `webview …`）。
 */
export function traceTool(line: string): void {
    if (!process.env['DSH_RAWLOG']) {
        return;
    }
    try {
        file ??= path.join(os.tmpdir(), 'dsh-plugin-trace.log');
        fs.appendFileSync(file, `${new Date().toISOString()} ${line}\n`);
    } catch {
        /* 诊断失败不影响功能 */
    }
}

/**
 * 日志用的安全序列化：**永不抛出**。
 *
 * 必须走这里的原因：`JSON.stringify(undefined)` 返回的不是字符串而是 `undefined`，
 * 再 `.slice()` 就抛 TypeError；日志一旦抛出就会打断它所在的数据分支。
 *
 * @param value - 任意值（`undefined` 按 `null` 处理）。
 * @param max - 截断长度。
 * @returns 预览字符串；无法序列化时给占位文案。
 */
export function jsonPreview(value: unknown, max: number): string {
    try {
        const text = JSON.stringify(value ?? null);
        return text === undefined ? String(value) : text.slice(0, max);
    } catch {
        return '(无法序列化)';
    }
}
