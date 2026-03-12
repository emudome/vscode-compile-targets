import * as vscode from 'vscode';
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
