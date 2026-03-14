import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import picomatch from 'picomatch';

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
            this.contextValue = 'folder';
        }
    }
}

export class CompileTargetsProvider implements vscode.TreeDataProvider<CompileTargetItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<CompileTargetItem | undefined | null>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private rootNodes: CompileTargetItem[] = [];
    private building = false;

    /** キャンセル用のジェネレーションカウンタ */
    private generation = 0;

    /** ファイル存在チェックのキャッシュ */
    private existsCache = new Map<string, boolean>();

    /** #include 解決結果のキャッシュ (includeName+searchDirs → resolvedPath | null) */
    private includeResolveCache = new Map<string, string | null>();

    /** ファイルごとの #include 解析済みフラグ（resolveIncludes の再入防止） */
    private includesParsedCache = new Set<string>();

    /** 収集済みファイルの絶対パス（ソース + ヘッダー） */
    private allFilePaths = new Set<string>();

    /** 永続化キャッシュのディレクトリパス */
    private storagePath: string | undefined;

    constructor(storagePath: string | undefined) {
        this.storagePath = storagePath;
        void this.initAsync();
    }

    async refresh(): Promise<void> {
        if (this.building) {
            return;
        }
        this.building = true;
        this.generation++;
        const gen = this.generation;

        try {
            // キャッシュをクリア
            this.existsCache.clear();
            this.includeResolveCache.clear();
            this.includesParsedCache.clear();

            const entries = await this.loadCompileCommands();
            if (!entries) {
                this.allFilePaths.clear();
                this.rootNodes = [];
                this._onDidChangeTreeData.fire(undefined);
                return;
            }

            const workspaceRoot = this.getWorkspaceRoot();
            if (!workspaceRoot) {
                this.allFilePaths.clear();
                this.rootNodes = [];
                this._onDidChangeTreeData.fire(undefined);
                return;
            }

            // Phase 1: compile_commands.json のソースファイルを収集して即座に表示
            const sourceEntries: { entry: CompileCommandEntry; absPath: string }[] = [];
            for (const entry of entries) {
                let filePath = entry.file;
                if (!path.isAbsolute(filePath)) {
                    filePath = path.resolve(entry.directory, filePath);
                }
                filePath = path.normalize(filePath);
                sourceEntries.push({ entry, absPath: filePath });
            }

            const uniquePaths = [...new Set(sourceEntries.map(e => e.absPath))];
            await this.batchCheckExists(uniquePaths);

            const newSourcePaths = new Set<string>();
            for (const { absPath } of sourceEntries) {
                if (this.existsCache.get(absPath)) {
                    newSourcePaths.add(absPath);
                }
            }

            // キャッシュからの復元パスにソースファイルをマージ
            // キャッシュ分のヘッダーは残し、Phase 2で正しく再検証される
            const previousSize = this.allFilePaths.size;
            for (const p of newSourcePaths) {
                this.allFilePaths.add(p);
            }

            // 新しいファイルが追加された場合のみツリーを再構築（ちらつき防止）
            if (this.allFilePaths.size !== previousSize || this.rootNodes.length === 0) {
                this.rebuildTree(workspaceRoot);
            }

            // Phase 2: #include の解決をバックグラウンドで実行（ノンブロッキング）
            // Phase 2 完了後に allFilePaths を正確なセットに置き換える
            const config = vscode.workspace.getConfiguration('compileTargetsExplorer');
            const showHeaders = config.get<boolean>('showHeaders', true);
            if (showHeaders) {
                void this.resolveIncludesBackground(gen, sourceEntries, newSourcePaths, workspaceRoot);
            } else {
                void this.persistPaths(workspaceRoot);
            }
        } finally {
            this.building = false;
        }
    }

    /** ツリーに含まれるすべてのファイルパスを返す */
    getAllFilePaths(): string[] {
        return [...this.allFilePaths];
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

    /** 起動時の初期化: キャッシュから即座に表示し、その後フルリフレッシュ */
    private async initAsync(): Promise<void> {
        const workspaceRoot = this.getWorkspaceRoot();
        const hasCachedView = await this.restoreFromCache(workspaceRoot);
        // キャッシュ表示済みでも最新状態に同期するためリフレッシュ
        // ただしキャッシュがあればユーザーは既にツリーを見ている
        await this.refresh();
    }

    /** キャッシュからツリーを復元。復元できたら true */
    private async restoreFromCache(workspaceRoot: string | undefined): Promise<boolean> {
        if (!workspaceRoot) { return false; }
        const cached = await this.loadCachedPaths();
        if (!cached || cached.length === 0) { return false; }
        for (const rel of cached) {
            this.allFilePaths.add(path.resolve(workspaceRoot, rel));
        }
        this.rebuildTree(workspaceRoot);
        return true;
    }

    /** 収集済みパス (this.allFilePaths) からツリーを再構築して TreeView を更新 */
    private rebuildTree(workspaceRoot: string): void {
        const config = vscode.workspace.getConfiguration('compileTargetsExplorer');
        const excludePatterns = config.get<string[]>('excludePatterns', []);
        const isExcluded = excludePatterns.length > 0
            ? picomatch(excludePatterns, { dot: true })
            : undefined;

        const relativePaths = new Set<string>();
        for (const absPath of this.allFilePaths) {
            const rel = path.relative(workspaceRoot, absPath);
            if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
                const posixRel = rel.split(path.sep).join('/');
                if (isExcluded && isExcluded(posixRel)) { continue; }
                relativePaths.add(rel);
            } else {
                relativePaths.add(absPath);
            }
        }

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
        this._onDidChangeTreeData.fire(undefined);
    }

    /** バックグラウンドで #include を解決してツリーを段階的に更新 */
    private async resolveIncludesBackground(
        gen: number,
        sourceEntries: { entry: CompileCommandEntry; absPath: string }[],
        sourcePaths: Set<string>,
        workspaceRoot: string,
    ): Promise<void> {
        // エントリごとのインクルードパスを事前計算（重複排除）
        const entryIncludeDirs = new Map<string, string[]>();
        for (const { entry, absPath } of sourceEntries) {
            if (!sourcePaths.has(absPath)) { continue; }
            if (entryIncludeDirs.has(absPath)) { continue; }
            const includeDirs = this.extractIncludePaths(entry);
            const sourceDir = path.dirname(absPath);
            entryIncludeDirs.set(absPath, [sourceDir, ...includeDirs]);
        }

        // include解決で発見されたヘッダーを別Setで追跡
        const resolvedHeaders = new Set<string>();

        let newFilesCount = 0;
        const UPDATE_THRESHOLD = 50;

        for (const [sourceFile, searchDirs] of entryIncludeDirs) {
            if (gen !== this.generation) { return; }

            const before = resolvedHeaders.size;
            await this.resolveIncludes(sourceFile, searchDirs, workspaceRoot, resolvedHeaders);

            const added = resolvedHeaders.size - before;
            if (added > 0) {
                // 新しいヘッダーを allFilePaths に追加
                for (const h of resolvedHeaders) {
                    this.allFilePaths.add(h);
                }
                newFilesCount += added;
                if (newFilesCount >= UPDATE_THRESHOLD) {
                    if (gen !== this.generation) { return; }
                    this.rebuildTree(workspaceRoot);
                    newFilesCount = 0;
                }
            }
        }

        if (gen !== this.generation) { return; }

        // 完了: allFilePaths を正確な sourcePaths ∪ resolvedHeaders に置き換え
        // （キャッシュ由来の古いエントリがあれば除去される）
        const finalPaths = new Set(sourcePaths);
        for (const h of resolvedHeaders) {
            finalPaths.add(h);
        }
        const changed = finalPaths.size !== this.allFilePaths.size;
        this.allFilePaths = finalPaths;
        if (changed || newFilesCount > 0) {
            this.rebuildTree(workspaceRoot);
        }

        // 完了後にキャッシュを永続化
        if (gen === this.generation) {
            void this.persistPaths(workspaceRoot);
        }
    }

    // --- 永続化 ---

    private get cacheFilePath(): string | undefined {
        if (!this.storagePath) { return undefined; }
        return path.join(this.storagePath, 'fileListCache.json');
    }

    private async loadCachedPaths(): Promise<string[] | undefined> {
        const cachePath = this.cacheFilePath;
        if (!cachePath) { return undefined; }

        try {
            const content = await fs.readFile(cachePath, 'utf-8');
            const data: unknown = JSON.parse(content);
            if (Array.isArray(data)) {
                return data;
            }
        } catch {
            // キャッシュなしまたは不正
        }
        return undefined;
    }

    private async persistPaths(workspaceRoot: string): Promise<void> {
        const cachePath = this.cacheFilePath;
        if (!cachePath) { return; }

        const relativePaths: string[] = [];
        for (const absPath of this.allFilePaths) {
            const rel = path.relative(workspaceRoot, absPath);
            if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
                relativePaths.push(rel);
            }
        }

        try {
            await fs.mkdir(path.dirname(cachePath), { recursive: true });
            await fs.writeFile(cachePath, JSON.stringify(relativePaths));
        } catch {
            // 書き込みエラーは無視
        }
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

            resolved.add(resolvedPath);
            toResolve.push(resolvedPath);
        }

        // 再帰的にヘッダー内の #include も辿る
        for (const headerPath of toResolve) {
            await this.resolveIncludes(headerPath, searchDirs, workspaceRoot, resolved);
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

    /**
     * compile_commands.json のパスを優先順位に従って解決し、読み込む。
     *
     * 解決順序:
     * 1. clangd.arguments の --compile-commands-dir
     * 2. .clangd の CompileFlags.CompilationDatabase
     * 3. cmake.buildDirectory（変数展開あり）
     * 4. CMakePresets.json のアクティブプリセットの binaryDir
     * 5. ${workspaceFolder}/build
     * 6. ${workspaceFolder}（ルート直下）
     */
    private async loadCompileCommands(): Promise<CompileCommandEntry[] | undefined> {
        const workspaceRoot = this.getWorkspaceRoot();
        if (!workspaceRoot) {
            return undefined;
        }

        const candidates = await this.resolveCompileCommandsCandidates(workspaceRoot);

        for (const candidate of candidates) {
            if (await this.fileExists(candidate)) {
                try {
                    const content = await fs.readFile(candidate, 'utf-8');
                    return JSON.parse(content) as CompileCommandEntry[];
                } catch (e) {
                    vscode.window.showErrorMessage(
                        vscode.l10n.t('Failed to read compile_commands.json: {0}', String(e))
                    );
                    return undefined;
                }
            }
        }

        vscode.window.showWarningMessage(
            vscode.l10n.t('compile_commands.json not found')
        );
        return undefined;
    }

    /**
     * compile_commands.json の候補パスを優先順位順に返す（重複除去済み）
     */
    private async resolveCompileCommandsCandidates(workspaceRoot: string): Promise<string[]> {
        const seen = new Set<string>();
        const candidates: string[] = [];

        const add = (dir: string) => {
            const p = path.normalize(path.join(dir, 'compile_commands.json'));
            if (!seen.has(p)) {
                seen.add(p);
                candidates.push(p);
            }
        };

        // 1. clangd.arguments の --compile-commands-dir
        const clangdDir = this.resolveFromClangdArguments(workspaceRoot);
        if (clangdDir) { add(clangdDir); }

        // 2. .clangd の CompileFlags.CompilationDatabase
        const dotClangdDir = await this.resolveFromDotClangd(workspaceRoot);
        if (dotClangdDir) { add(dotClangdDir); }

        // 3. cmake.buildDirectory
        const cmakeDir = this.resolveFromCmakeBuildDirectory(workspaceRoot);
        if (cmakeDir) { add(cmakeDir); }

        // 4. CMakePresets.json のアクティブプリセットの binaryDir
        const presetDir = await this.resolveFromCMakePresets(workspaceRoot);
        if (presetDir) { add(presetDir); }

        // 5. ${workspaceFolder}/build
        add(path.join(workspaceRoot, 'build'));

        // 6. ${workspaceFolder}
        add(workspaceRoot);

        return candidates;
    }

    /** clangd.arguments から --compile-commands-dir を抽出 */
    private resolveFromClangdArguments(workspaceRoot: string): string | undefined {
        const args = vscode.workspace.getConfiguration('clangd').get<string[]>('arguments', []);
        for (let i = 0; i < args.length; i++) {
            const arg = args[i];
            if (arg.startsWith('--compile-commands-dir=')) {
                const dir = arg.slice('--compile-commands-dir='.length);
                return this.expandVariables(dir, workspaceRoot);
            }
            if (arg === '--compile-commands-dir' && i + 1 < args.length) {
                return this.expandVariables(args[i + 1], workspaceRoot);
            }
        }
        return undefined;
    }

    /** .clangd ファイルから CompileFlags.CompilationDatabase を抽出 */
    private async resolveFromDotClangd(workspaceRoot: string): Promise<string | undefined> {
        const dotClangdPath = path.join(workspaceRoot, '.clangd');
        try {
            const content = await fs.readFile(dotClangdPath, 'utf-8');
            // CompilationDatabase: <path> を正規表現で抽出
            // 複数ドキュメント（---区切り）にも対応
            const match = /^\s*CompilationDatabase\s*:\s*(.+)$/m.exec(content);
            if (match) {
                const dir = match[1].trim();
                const expanded = this.expandVariables(dir, workspaceRoot);
                if (path.isAbsolute(expanded)) {
                    return expanded;
                }
                return path.resolve(workspaceRoot, expanded);
            }
        } catch {
            // .clangd が存在しない場合は無視
        }
        return undefined;
    }

    /** cmake.buildDirectory 設定からビルドディレクトリを取得 */
    private resolveFromCmakeBuildDirectory(workspaceRoot: string): string | undefined {
        const cmakeConfig = vscode.workspace.getConfiguration('cmake');
        const buildDir = cmakeConfig.get<string>('buildDirectory');
        if (!buildDir) { return undefined; }

        const expanded = this.expandVariables(buildDir, workspaceRoot);
        if (path.isAbsolute(expanded)) {
            return expanded;
        }
        return path.resolve(workspaceRoot, expanded);
    }

    /** CMakePresets.json / CMakeUserPresets.json からアクティブプリセットの binaryDir を取得 */
    private async resolveFromCMakePresets(workspaceRoot: string): Promise<string | undefined> {
        // アクティブなプリセット名を CMake Tools の設定から取得
        const cmakeConfig = vscode.workspace.getConfiguration('cmake');
        const activePresetName = cmakeConfig.get<string>('configurePreset');

        const presetFiles = [
            path.join(workspaceRoot, 'CMakeUserPresets.json'),
            path.join(workspaceRoot, 'CMakePresets.json'),
        ];

        for (const presetFile of presetFiles) {
            try {
                const content = await fs.readFile(presetFile, 'utf-8');
                const data = JSON.parse(content) as {
                    configurePresets?: Array<{
                        name: string;
                        binaryDir?: string;
                        inherits?: string | string[];
                    }>;
                };
                if (!data.configurePresets || data.configurePresets.length === 0) {
                    continue;
                }

                // アクティブプリセット名が設定されていればそれを探す
                let preset = activePresetName
                    ? data.configurePresets.find(p => p.name === activePresetName)
                    : undefined;

                // 見つからなければ最初のプリセットを使用
                if (!preset) {
                    preset = data.configurePresets[0];
                }

                if (preset?.binaryDir) {
                    const expanded = this.expandVariables(preset.binaryDir, workspaceRoot, preset.name);
                    if (path.isAbsolute(expanded)) {
                        return expanded;
                    }
                    return path.resolve(workspaceRoot, expanded);
                }
            } catch {
                // ファイルが存在しないまたはパースエラー
            }
        }
        return undefined;
    }

    /**
     * CMake / VS Code スタイルの変数を展開する。
     * 対応: ${workspaceFolder}, ${sourceDir}, ${presetName}, ${workspaceRoot}
     */
    private expandVariables(value: string, workspaceRoot: string, presetName?: string): string {
        let result = value;
        result = result.replace(/\$\{workspaceFolder\}/g, workspaceRoot);
        result = result.replace(/\$\{workspaceRoot\}/g, workspaceRoot);
        result = result.replace(/\$\{sourceDir\}/g, workspaceRoot);
        if (presetName) {
            result = result.replace(/\$\{presetName\}/g, presetName);
        }
        return result;
    }

    private getWorkspaceRoot(): string | undefined {
        const folders = vscode.workspace.workspaceFolders;
        if (!folders || folders.length === 0) {
            return undefined;
        }
        return folders[0].uri.fsPath;
    }
}
