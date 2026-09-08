// 打包：先由 package.json 的 pnpm vsix 前置执行 pnpm run package，
// 这里直接用 @vscode/vsce 的 pack（跳过 vscode:prepublish，避免 vsce 子进程里 tsc OOM）。
// 产物名带版本号：release/deepseek-harness-web-<version>.vsix（version 取自 package.json）。
import { mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { pack } = require('@vscode/vsce/out/package');

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const version = (pkg && pkg.version) || '0.0.0';
mkdirSync('release', { recursive: true });
try {
    const result = await pack({
        cwd: process.cwd(),
        packagePath: `release/deepseek-harness-web-${version}.vsix`,
        allowMissingRepository: true,
        useYarn: false,
    });
    console.log(`DONE ${result.packagePath}`);
} catch (e) {
    console.error(e);
    process.exitCode = 1;
}
