// 聊天 webview 构建：esbuild 打包 chat.ts → dist/chat/chat.js，并拷贝 index.html
import { build } from 'esbuild'
import { cpSync, mkdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const chatDir = path.join(root, 'webview', 'chat')
const outDir = path.join(root, 'dist', 'chat')

const production = process.argv.includes('--production')

// 清空旧产物（避免残留 TinyRobot 的旧 bundle）
rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })

await build({
  entryPoints: [path.join(chatDir, 'chat.ts')],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['es2022'],
  outfile: path.join(outDir, 'chat.js'),
  minify: production,
  logLevel: 'silent',
})

cpSync(path.join(chatDir, 'index.html'), path.join(outDir, 'index.html'))
cpSync(path.join(chatDir, 'codicon.css'), path.join(outDir, 'codicon.css'))
console.log('[chat] built → dist/chat')
