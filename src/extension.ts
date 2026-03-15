import * as vscode from 'vscode';
import * as path from 'path';
import { CompileTargetsProvider, CompileTargetItem } from './compileTargetsProvider';

export function activate(context: vscode.ExtensionContext): void {
    void vscode.commands.executeCommand('setContext', 'compileTargetsExplorer.active', true);

    const provider = new CompileTargetsProvider(context);

    const treeView = vscode.window.createTreeView('compileTargetsExplorer', {
        treeDataProvider: provider,
        showCollapseAll: true,
    });
    context.subscriptions.push(treeView);

    function getSelectedItem(item?: CompileTargetItem): CompileTargetItem | undefined {
        return item ?? treeView.selection[0];
    }

    context.subscriptions.push(
        vscode.commands.registerCommand('compileTargetsExplorer.refresh', () => {
            void provider.refresh();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('compileTargetsExplorer.openFile', (item?: CompileTargetItem) => {
            const selected = getSelectedItem(item);
            if (!selected) { return; }
            vscode.window.showTextDocument(vscode.Uri.file(selected.filePath), { preview: true });
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('compileTargetsExplorer.openToSide', (item?: CompileTargetItem) => {
            const selected = getSelectedItem(item);
            if (!selected) { return; }
            vscode.window.showTextDocument(vscode.Uri.file(selected.filePath), { viewColumn: vscode.ViewColumn.Beside, preview: true });
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('compileTargetsExplorer.copyPath', (item?: CompileTargetItem) => {
            const selected = getSelectedItem(item);
            if (!selected) { return; }
            vscode.env.clipboard.writeText(selected.filePath);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('compileTargetsExplorer.copyRelativePath', (item?: CompileTargetItem) => {
            const selected = getSelectedItem(item);
            if (!selected) { return; }
            const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            const relativePath = workspaceRoot ? path.relative(workspaceRoot, selected.filePath) : selected.filePath;
            vscode.env.clipboard.writeText(relativePath);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('compileTargetsExplorer.revealInOS', (item?: CompileTargetItem) => {
            const selected = getSelectedItem(item);
            if (!selected) { return; }
            void vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(selected.filePath));
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('compileTargetsExplorer.openInTerminal', (item?: CompileTargetItem) => {
            const selected = getSelectedItem(item);
            if (!selected) { return; }
            const dir = selected.isFile ? path.dirname(selected.filePath) : selected.filePath;
            const terminal = vscode.window.createTerminal({ cwd: dir });
            terminal.show();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('compileTargetsExplorer.addToFavorites', (item?: CompileTargetItem) => {
            const selected = getSelectedItem(item);
            if (!selected) { return; }
            provider.addFavorite(selected);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('compileTargetsExplorer.removeFromFavorites', (item?: CompileTargetItem) => {
            const selected = getSelectedItem(item);
            if (!selected) { return; }
            provider.removeFavorite(selected.filePath);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('compileTargetsExplorer.openFavoriteFile', (filePath: string) => {
            void vscode.commands.executeCommand('vscode.open', vscode.Uri.file(filePath)).then(() => {
                const item = provider.findItemByPath(filePath);
                if (item) {
                    void treeView.reveal(item, { select: true, focus: false, expand: true });
                }
            });
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('compileTargetsExplorer.revealInTree', (filePath: string) => {
            const item = provider.findItemByPath(filePath);
            if (item) {
                void treeView.reveal(item, { select: true, focus: true, expand: false });
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('compileTargetsExplorer.findInFolder', async (item?: CompileTargetItem) => {
            const selected = getSelectedItem(item);
            if (!selected || selected.isFile) { return; }
            const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            if (!workspaceRoot) { return; }

            const files = collectFiles(selected);
            if (files.length === 0) { return; }

            const filesToInclude = buildCompactGlob(files, workspaceRoot);
            await vscode.commands.executeCommand('workbench.action.findInFiles', {
                filesToInclude,
                triggerSearch: false,
            });
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('compileTargetsExplorer.searchInTargets', async () => {
            const files = provider.getAllFilePaths();
            if (files.length === 0) {
                vscode.window.showWarningMessage(vscode.l10n.t('No compile target files found'));
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
            if (e.affectsConfiguration('compileTargetsExplorer')
                || e.affectsConfiguration('clangd.arguments')
                || e.affectsConfiguration('cmake.buildDirectory')
                || e.affectsConfiguration('cmake.configurePreset')) {
                void provider.refresh();
            }
        })
    );

    // compile_commands.json が変更されたら自動リフレッシュ
    const ccWatcher = vscode.workspace.createFileSystemWatcher('**/compile_commands.json');
    ccWatcher.onDidChange(() => void provider.refresh());
    ccWatcher.onDidCreate(() => void provider.refresh());
    ccWatcher.onDidDelete(() => void provider.refresh());
    context.subscriptions.push(ccWatcher);

    // .clangd, CMakePresets.json, CMakeUserPresets.json の変更も監視
    for (const pattern of ['**/.clangd', '**/CMakePresets.json', '**/CMakeUserPresets.json']) {
        const w = vscode.workspace.createFileSystemWatcher(pattern);
        w.onDidChange(() => void provider.refresh());
        w.onDidCreate(() => void provider.refresh());
        w.onDidDelete(() => void provider.refresh());
        context.subscriptions.push(w);
    }

    // アクティブエディタ変更時にツリーのフォーカスを自動移動
    function revealActiveFile(): void {
        const editor = vscode.window.activeTextEditor;
        if (!editor || !treeView.visible) { return; }
        const filePath = editor.document.uri.fsPath;
        const item = provider.findItemByPath(filePath);
        if (item) {
            void treeView.reveal(item, { select: true, focus: false, expand: true });
        }
    }

    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(() => revealActiveFile())
    );

    // 初回ツリー構築完了時にアクティブファイルを reveal
    const initialReveal = provider.onDidChangeTreeData(function handler() {
        initialReveal.dispose();
        revealActiveFile();
    });
}

export function deactivate(): void { }

/** フォルダノード配下のすべてのファイルパスを再帰的に収集する */
function collectFiles(node: CompileTargetItem): string[] {
    const result: string[] = [];
    if (node.isFile) {
        result.push(node.filePath);
    } else if (node.children) {
        for (const child of node.children.values()) {
            result.push(...collectFiles(child));
        }
    }
    return result;
}

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
