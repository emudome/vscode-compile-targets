import * as vscode from 'vscode';
import * as path from 'path';
import { CompileTargetsProvider } from './compileTargetsProvider';

export function activate(context: vscode.ExtensionContext): void {
    const provider = new CompileTargetsProvider();

    const treeView = vscode.window.createTreeView('cmakeCompileExplorer', {
        treeDataProvider: provider,
        showCollapseAll: true,
    });
    context.subscriptions.push(treeView);

    context.subscriptions.push(
        vscode.commands.registerCommand('cmakeCompileExplorer.refresh', () => {
            void provider.refresh();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('cmakeCompileExplorer.openFile', (uri: vscode.Uri) => {
            vscode.window.showTextDocument(uri, { preview: true });
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('cmakeCompileExplorer.searchInTargets', async () => {
            const files = provider.getAllFilePaths();
            if (files.length === 0) {
                vscode.window.showWarningMessage('コンパイル対象ファイルがありません');
                return;
            }
            const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            if (!workspaceRoot) { return; }

            const filesToInclude = buildCompactGlob(files, workspaceRoot);

            await vscode.commands.executeCommand('workbench.action.findInFiles', {
                filesToInclude,
                triggerSearch: false,
            });
        })
    );

    // 設定変更時に自動リフレッシュ
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration('cmakeCompileExplorer')) {
                void provider.refresh();
            }
        })
    );

    // compile_commands.json が変更されたら自動リフレッシュ
    const watcher = vscode.workspace.createFileSystemWatcher('**/compile_commands.json');
    watcher.onDidChange(() => void provider.refresh());
    watcher.onDidCreate(() => void provider.refresh());
    watcher.onDidDelete(() => void provider.refresh());
    context.subscriptions.push(watcher);
}

export function deactivate(): void { }

/**
 * ファイルパス一覧からコンパクトな glob パターン文字列を生成する。
 *
 * 1. ディレクトリごとにファイル名をグループ化し、ブレース展開で圧縮
 *    例: src/lib/{a.cpp,b.cpp}
 * 2. それでも長すぎる場合はディレクトリ単位のワイルドカード（dir/**）に切り替え
 * 3. さらに長い場合はトップレベルディレクトリに集約
 */
function buildCompactGlob(files: string[], workspaceRoot: string): string {
    const MAX_LENGTH = 15000;

    // ディレクトリ → ファイル名[] にグループ化
    const dirFiles = new Map<string, string[]>();
    for (const f of files) {
        const rel = path.relative(workspaceRoot, f).replace(/\\/g, '/');
        const dir = path.posix.dirname(rel);
        const base = path.posix.basename(rel);
        let list = dirFiles.get(dir);
        if (!list) {
            list = [];
            dirFiles.set(dir, list);
        }
        list.push(base);
    }

    // 戦略1: ブレース展開でグループ化 — dir/{a.cpp,b.cpp}
    const patterns: string[] = [];
    for (const [dir, bases] of dirFiles) {
        if (bases.length === 1) {
            patterns.push(dir === '.' ? bases[0] : `${dir}/${bases[0]}`);
        } else {
            const braced = `{${bases.join(',')}}`;
            patterns.push(dir === '.' ? braced : `${dir}/${braced}`);
        }
    }
    let result = patterns.join(', ');
    if (result.length <= MAX_LENGTH) {
        return result;
    }

    // 戦略2: ディレクトリ単位の ** パターン
    const dirPatterns = [...dirFiles.keys()].map(d => d === '.' ? '**' : `${d}/**`);
    result = dirPatterns.join(', ');
    if (result.length <= MAX_LENGTH) {
        return result;
    }

    // 戦略3: トップレベルディレクトリに集約
    const topDirs = new Set<string>();
    for (const dir of dirFiles.keys()) {
        const first = dir.split('/')[0];
        topDirs.add(first === '.' ? '**' : `${first}/**`);
    }
    return [...topDirs].join(', ');
}
