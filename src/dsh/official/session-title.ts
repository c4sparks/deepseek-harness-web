// ⚠️ CORE-COUPLED（核心耦合；目录名 official，本仓库注释里称“核心”）——只映射 dsh 核心 rc1 规则，勿混入插件自有逻辑；核心变化只改本目录。
// 会话/工作区显示名 —— 核心三层 fallback。
// 核心三层 fallback：displayTitle = title → cwd basename → sessionId；blank 会话由 UI 显示“新会话”。
// 出处：核心 rc1 service.ts:146-153 (displayTitleOf)。

import * as path from 'node:path';

function baseName(p: string): string {
    const n = path.basename(p).replace(/[\\/]+$/, '');
    return n.length > 0 ? n : p;
}

export interface SessionTitleInput {
    title?: string | null;
    cwd?: string | null;
    sessionId: string;
    /** 空白(未开始)会话：返回空串，由 UI 决定是否显示“新会话” */
    blank?: boolean;
}

/** 会话显示名（核心语义）：blank→''；title→cwd basename→sessionId */
export function sessionDisplayTitle(input: SessionTitleInput): string {
    if (input.blank) {
        return '';
    }
    if (input.title && input.title.trim().length > 0) {
        return input.title.trim();
    }
    if (input.cwd && input.cwd.trim().length > 0) {
        return baseName(input.cwd);
    }
    return input.sessionId;
}

/** 工作区显示名（核心用实体 title，缺省 basename(path)） */
export function workspaceDisplayTitle(title: string | null | undefined, pathText: string | null | undefined): string {
    if (title && title.trim().length > 0) {
        return title.trim();
    }
    if (pathText && pathText.trim().length > 0) {
        return baseName(pathText);
    }
    return '';
}
