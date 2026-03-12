import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';

/** compile_commands.json の各エントリの型 */
interface CompileCommandEntry {
    directory: string;
    file: string;
    command?: string;
    arguments?: string[];
    output?: string;
}

/**
 * ツリービューの各ノード。
 * - フォルダの場合: children を持ち、filePath はディレクトリパス
 * - ファイルの場合: children なし、filePath はファイルの絶対パス
 */
export class CompileTargetItem extends vscode.TreeItem {
    children: Map<string, CompileTargetItem> | undefined;

    constructor(
        public readonly label: string,
        public readonly filePath: string,
        public readonly isFile: boolean,
    ) {
        super(
            label,
            isFile
                ? vscode.TreeItemCollapsibleState.None
                : vscode.TreeItemCollapsibleState.Collapsed,
        );

        if (isFile) {
            this.resourceUri = vscode.Uri.file(filePath);
            this.command = {
                command: 'vscode.open',
                title: 'Open File',
                arguments: [vscode.Uri.file(filePath)],
            };
            this.contextValue = 'file';
            this.iconPath = vscode.ThemeIcon.File;
        } else {
            this.iconPath = vscode.ThemeIcon.Folder;
            this.contextValue = 'folder';
        }
    }
}

export class CompileTargetsProvider implements vscode.TreeDataProvider<CompileTargetItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<CompileTargetItem | undefined | null>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private rootNodes: CompileTargetItem[] = [];
    private building = false;

    /** ファイル存在チェックのキャッシュ */
    private existsCache = new Map<string, boolean>();

    /** #include 解決結果のキャッシュ (includeName+searchDirs → resolvedPath | null) */
    private includeResolveCache = new Map<string, string | null>();

    /** ファイルごとの #include 解析済みフラグ（resolveIncludes の再入防止） */
    private includesParsedCache = new Set<string>();

    constructor() {
        this.refresh();
    }

    async refresh(): Promise<void> {
        if (this.building) {
            return;
        }
        this.building = true;
        try {
            await this.buildTreeAsync();
        } finally {
            this.building = false;
        }
        this._onDidChangeTreeData.fire(undefined);
    }

    getTreeItem(element: CompileTargetItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: CompileTargetItem): CompileTargetItem[] {
        if (!element) {
            return this.rootNodes;
        }
        if (element.children) {
            return Array.from(element.children.values()).sort((a, b) => {
                if (a.isFile !== b.isFile) {
                    return a.isFile ? 1 : -1;
                }
                return a.label.localeCompare(b.label);
            });
        }
        return [];
    }

    // --- private ---

    private async buildTreeAsync(): Promise<void> {
        // キャッシュをクリア
        this.existsCache.clear();
        this.includeResolveCache.clear();
        this.includesParsedCache.clear();

        const entries = await this.loadCompileCommands();
        if (!entries) {
            this.rootNodes = [];
            return;
        }

        const workspaceRoot = this.getWorkspaceRoot();
        if (!workspaceRoot) {
            this.rootNodes = [];
            return;
        }

        // ファイル一覧を取得して絶対パスのセットに正規化（並列で存在チェック）
        const absolutePaths = new Set<string>();
        const sourceEntries: { entry: CompileCommandEntry; absPath: string }[] = [];

        // まずパスを正規化
        for (const entry of entries) {
            let filePath = entry.file;
            if (!path.isAbsolute(filePath)) {
                filePath = path.resolve(entry.directory, filePath);
            }
            filePath = path.normalize(filePath);
            sourceEntries.push({ entry, absPath: filePath });
        }

        // 存在チェックを並列実行
        const uniquePaths = [...new Set(sourceEntries.map(e => e.absPath))];
        await this.batchCheckExists(uniquePaths);

        for (const { absPath } of sourceEntries) {
            if (this.existsCache.get(absPath)) {
                absolutePaths.add(absPath);
            }
        }

        // ヘッダーファイル収集（#include を再帰的に解決）
        const config = vscode.workspace.getConfiguration('cmakeCompileExplorer');
        const showHeaders = config.get<boolean>('showHeaders', true);
        if (showHeaders) {
            const headerExtensions = config.get<string[]>('headerExtensions', ['.h', '.hpp', '.hxx', '.hh']);
            const extSet = new Set(headerExtensions.map(e => e.toLowerCase()));

            // エントリごとのインクルードパスを事前計算（重複排除）
            const entryIncludeDirs = new Map<string, string[]>();
            for (const { entry, absPath } of sourceEntries) {
                if (!absolutePaths.has(absPath)) { continue; }
                if (entryIncludeDirs.has(absPath)) { continue; }
                const includeDirs = this.extractIncludePaths(entry);
                const sourceDir = path.dirname(absPath);
                entryIncludeDirs.set(absPath, [sourceDir, ...includeDirs]);
            }

            // 各ソースファイルの #include を解決
            for (const [sourceFile, searchDirs] of entryIncludeDirs) {
                await this.resolveIncludes(sourceFile, searchDirs, workspaceRoot, extSet, absolutePaths);
            }
        }

        // 相対パスに変換
        const relativePaths = new Set<string>();
        for (const absPath of absolutePaths) {
            const rel = path.relative(workspaceRoot, absPath);
            if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
                relativePaths.add(rel);
            } else {
                relativePaths.add(absPath);
            }
        }

        // ツリー構築
        const root = new Map<string, CompileTargetItem>();

        for (const rel of relativePaths) {
            const parts = rel.split(path.sep);
            let currentMap = root;
            let currentPath = workspaceRoot;

            for (let i = 0; i < parts.length; i++) {
                const part = parts[i];
                const isLast = i === parts.length - 1;
                currentPath = path.join(currentPath, part);

                if (!currentMap.has(part)) {
                    const item = new CompileTargetItem(part, currentPath, isLast);
                    if (!isLast) {
                        item.children = new Map();
                    }
                    currentMap.set(part, item);
                }

                const node = currentMap.get(part)!;
                if (!isLast) {
                    if (!node.children) {
                        node.children = new Map();
                    }
                    currentMap = node.children;
                }
            }
        }

        this.rootNodes = this.compactFolders(root).sort((a, b) => {
            if (a.isFile !== b.isFile) {
                return a.isFile ? 1 : -1;
            }
            return a.label.localeCompare(b.label);
        });
    }

    /**
     * 複数パスの存在チェックを並列実行してキャッシュに格納
     */
    private async batchCheckExists(paths: string[]): Promise<void> {
        const unchecked = paths.filter(p => !this.existsCache.has(p));
        if (unchecked.length === 0) { return; }

        const BATCH_SIZE = 100;
        for (let i = 0; i < unchecked.length; i += BATCH_SIZE) {
            const batch = unchecked.slice(i, i + BATCH_SIZE);
            const results = await Promise.all(
                batch.map(p => fs.access(p).then(() => true, () => false))
            );
            for (let j = 0; j < batch.length; j++) {
                this.existsCache.set(batch[j], results[j]);
            }
        }
    }

    /**
     * キャッシュ付きのファイル存在チェック
     */
    private async fileExists(filePath: string): Promise<boolean> {
        const cached = this.existsCache.get(filePath);
        if (cached !== undefined) {
            return cached;
        }
        const exists = await fs.access(filePath).then(() => true, () => false);
        this.existsCache.set(filePath, exists);
        return exists;
    }

    /**
     * フォルダが単一のサブフォルダのみを含む場合、
     * "src\cpp" のように結合して1ノードにまとめる（VS Code のコンパクトフォルダ表示）
     */
    private compactFolders(nodeMap: Map<string, CompileTargetItem>): CompileTargetItem[] {
        const result: CompileTargetItem[] = [];
        for (const node of nodeMap.values()) {
            result.push(this.compactNode(node));
        }
        return result;
    }

    private compactNode(node: CompileTargetItem): CompileTargetItem {
        if (node.isFile || !node.children) {
            return node;
        }

        const compactedChildren = new Map<string, CompileTargetItem>();
        for (const [key, child] of node.children) {
            const compacted = this.compactNode(child);
            compactedChildren.set(compacted.label, compacted);
        }

        const childArray = Array.from(compactedChildren.values());
        if (childArray.length === 1 && !childArray[0].isFile) {
            const onlyChild = childArray[0];
            const mergedLabel = node.label + path.sep + onlyChild.label;
            const merged = new CompileTargetItem(mergedLabel, onlyChild.filePath, false);
            merged.children = onlyChild.children;
            return merged;
        }

        node.children = compactedChildren;
        return node;
    }

    /**
     * ソースファイルの #include を再帰的に辿り、解決されたヘッダーファイルを resolved に追加する
     */
    private async resolveIncludes(
        filePath: string,
        searchDirs: string[],
        workspaceRoot: string,
        headerExtSet: Set<string>,
        resolved: Set<string>,
    ): Promise<void> {
        // 既にこのファイルの #include を解析済みならスキップ
        if (this.includesParsedCache.has(filePath)) {
            return;
        }
        this.includesParsedCache.add(filePath);

        if (!(await this.fileExists(filePath))) {
            return;
        }

        let content: string;
        try {
            content = await fs.readFile(filePath, 'utf-8');
        } catch {
            return;
        }

        // #include "..." と #include <...> の両方を抽出
        const includeRegex = /^\s*#\s*include\s*[<"]([^>"]+)[>"]/gm;
        let match: RegExpExecArray | null;

        const toResolve: string[] = [];

        while ((match = includeRegex.exec(content)) !== null) {
            const includeName = match[1];
            const resolvedPath = await this.resolveIncludePath(includeName, filePath, searchDirs);
            if (!resolvedPath) {
                continue;
            }

            // 既に解決済みならスキップ
            if (resolved.has(resolvedPath)) {
                continue;
            }

            // ワークスペース外のヘッダーはスキップ
            const rel = path.relative(workspaceRoot, resolvedPath);
            if (rel.startsWith('..') || path.isAbsolute(rel)) {
                continue;
            }

            // ヘッダー拡張子に一致するもののみ追加
            const ext = path.extname(resolvedPath).toLowerCase();
            if (headerExtSet.has(ext)) {
                resolved.add(resolvedPath);
                toResolve.push(resolvedPath);
            }
        }

        // 再帰的にヘッダー内の #include も辿る
        for (const headerPath of toResolve) {
            await this.resolveIncludes(headerPath, searchDirs, workspaceRoot, headerExtSet, resolved);
        }
    }

    /**
     * #include のファイル名をインクルードパスから解決する（キャッシュ付き）
     */
    private async resolveIncludePath(
        includeName: string,
        sourceFile: string,
        searchDirs: string[],
    ): Promise<string | null> {
        const sourceDir = path.dirname(sourceFile);
        const cacheKey = includeName + '\0' + sourceDir + '\0' + searchDirs.join('\0');
        const cached = this.includeResolveCache.get(cacheKey);
        if (cached !== undefined) {
            return cached;
        }

        // ソースファイルのディレクトリから探す（#include "..." の振る舞い）
        const fromSource = path.normalize(path.resolve(sourceDir, includeName));
        if (await this.fileExists(fromSource)) {
            this.includeResolveCache.set(cacheKey, fromSource);
            return fromSource;
        }

        // -I パスを順に探す
        for (const dir of searchDirs) {
            const candidate = path.normalize(path.resolve(dir, includeName));
            if (await this.fileExists(candidate)) {
                this.includeResolveCache.set(cacheKey, candidate);
                return candidate;
            }
        }

        this.includeResolveCache.set(cacheKey, null);
        return null;
    }

    /**
     * 1つのエントリから -I / -isystem のインクルードパスを抽出する
     */
    private extractIncludePaths(entry: CompileCommandEntry): string[] {
        const paths: string[] = [];

        if (entry.arguments) {
            for (let i = 0; i < entry.arguments.length; i++) {
                const arg = entry.arguments[i];
                if (arg === '-I' || arg === '-isystem') {
                    if (i + 1 < entry.arguments.length) {
                        paths.push(entry.arguments[++i]);
                    }
                } else if (arg.startsWith('-I')) {
                    paths.push(arg.slice(2));
                } else if (arg.startsWith('-isystem')) {
                    paths.push(arg.slice(8));
                }
            }
        } else if (entry.command) {
            const args = entry.command.split(/\s+/);
            for (let i = 0; i < args.length; i++) {
                const arg = args[i];
                if (arg === '-I' || arg === '-isystem') {
                    if (i + 1 < args.length) {
                        paths.push(args[++i]);
                    }
                } else if (arg.startsWith('-I')) {
                    paths.push(arg.slice(2));
                } else if (arg.startsWith('-isystem')) {
                    paths.push(arg.slice(8));
                }
            }
        }

        return paths.map(p => {
            if (path.isAbsolute(p)) {
                return path.normalize(p);
            }
            return path.normalize(path.resolve(entry.directory, p));
        });
    }

    private async loadCompileCommands(): Promise<CompileCommandEntry[] | undefined> {
        const workspaceRoot = this.getWorkspaceRoot();
        if (!workspaceRoot) {
            return undefined;
        }

        const config = vscode.workspace.getConfiguration('cmakeCompileExplorer');
        const dirSetting = config.get<string>('compileCommandsDir', 'build');

        let compileCommandsPath: string;
        if (path.isAbsolute(dirSetting)) {
            compileCommandsPath = path.join(dirSetting, 'compile_commands.json');
        } else {
            compileCommandsPath = path.join(workspaceRoot, dirSetting, 'compile_commands.json');
        }

        if (!(await this.fileExists(compileCommandsPath))) {
            vscode.window.showWarningMessage(
                `compile_commands.json が見つかりません: ${compileCommandsPath}`
            );
            return undefined;
        }

        try {
            const content = await fs.readFile(compileCommandsPath, 'utf-8');
            return JSON.parse(content) as CompileCommandEntry[];
        } catch (e) {
            vscode.window.showErrorMessage(
                `compile_commands.json の読み込みに失敗しました: ${e}`
            );
            return undefined;
        }
    }

    private getWorkspaceRoot(): string | undefined {
        const folders = vscode.workspace.workspaceFolders;
        if (!folders || folders.length === 0) {
            return undefined;
        }
        return folders[0].uri.fsPath;
    }
}
