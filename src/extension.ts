import * as vscode from 'vscode';
import os from 'os';
import path from 'path';
import semver from 'semver';
import debounce from 'lodash/debounce';
import { ExtInfo } from '@/types';
import { Commands, ContextValue } from '@/constants';

const extFolderUri = vscode.env.appName.includes('Code - Insiders')
    ? vscode.Uri.file(path.join(os.homedir(), '.vscode-insiders', 'extensions'))
    : vscode.Uri.file(path.join(os.homedir(), '.vscode', 'extensions'));
const refreshEvent = new vscode.EventEmitter<void>();
const filterEvent = new vscode.EventEmitter<boolean>();

const findAllPackageJSON = async (): Promise<ExtInfo[]> => {
    const pattern = new vscode.RelativePattern(extFolderUri, '*/package.json');
    const res = await vscode.workspace.findFiles(pattern, null);
    const jsonInfoList = await Promise.all(
        res.map(async (file) => {
            try {
                const fileUri = vscode.Uri.file(file.fsPath);
                const mtime = (await vscode.workspace.fs.stat(fileUri)).mtime;
                const text = await vscode.workspace.fs.readFile(fileUri);
                const { name, displayName, description, version, publisher } = JSON.parse(Buffer.from(text).toString());
                return { name, displayName, description, version, publisher, mtime, path: path.dirname(file.fsPath) };
            } catch {
                return null;
            }
        }),
    );
    return (jsonInfoList.filter((i) => i !== null) as ExtInfo[]).sort((a, b) => {
        if (a.name !== b.name) return a.name.localeCompare(b.name);
        return semver.gt(a.version, b.version) ? -1 : 1;
    });
};

const removeFolders = async (items: { path: string }[], message: string, detail = '') => {
    try {
        const confirm = vscode.l10n.t('confirm');
        const res = await vscode.window.showInformationMessage(message, { detail, modal: true }, confirm);
        if (res !== confirm) return;
        await Promise.all(
            items.map((item) =>
                vscode.workspace.fs.delete(vscode.Uri.file(item.path), { recursive: true, useTrash: true }),
            ),
        );
        vscode.window.showInformationMessage(vscode.l10n.t("Move to system's trashcan succeeded"));
    } catch (error: any) {
        vscode.window.showErrorMessage(error.message);
    }
};

class ColorSelector {
    private static duplicateName: string = '';
    static readonly colorList = [
        'terminal.ansiBlue',
        'terminal.ansiGreen',
        'terminal.ansiMagenta',
        'terminal.ansiRed',
        'terminal.ansiWhite',
        'terminal.ansiYellow',
    ];
    private static colorIndex: number = 0;
    static getColor(name: string): vscode.ThemeColor | undefined {
        if (name === this.duplicateName || this.duplicateName === '') {
            const color = this.colorList[this.colorIndex];
            this.duplicateName = name;
            return new vscode.ThemeColor(color);
        } else {
            if (this.colorIndex === this.colorList.length - 1) this.colorIndex = 0;
            else this.colorIndex++;
            this.duplicateName = name;
            const color = this.colorList[this.colorIndex];
            return new vscode.ThemeColor(color);
        }
    }
    static reset() {
        this.colorIndex = 0;
        this.duplicateName = '';
    }
}

class ExtTreeItem extends vscode.TreeItem {
    duplicate: boolean = false;
    contextValue = 'duplicate-extension.extInfo';
    extId: string = '';
    path: string = '';
    constructor(item: ExtInfo, isDuplicate: boolean, collapsibleState?: vscode.TreeItemCollapsibleState) {
        const extId = item.publisher + '.' + item.name;
        const ext = vscode.extensions.getExtension(extId);
        const isActiveExt = ext?.extensionPath === item.path;
        super(isActiveExt ? `${item.name} ✨` : item.name, collapsibleState);
        this.description = item.version;

        this.tooltip = new vscode.MarkdownString('');
        this.tooltip.appendMarkdown(`### ${item.name}\n`);
        this.tooltip.appendMarkdown(`- displayName: *${ext?.packageJSON.description || item.displayName}*\n`);
        this.tooltip.appendMarkdown(`- description: *${ext?.packageJSON.description || item.description}*\n`);
        this.tooltip.appendMarkdown(`- version: ${item.version}\n`);
        this.tooltip.appendMarkdown(`- publisher: *${item.publisher}*\n`);
        this.tooltip.appendMarkdown(`- mtime: ${new Date(item.mtime).toLocaleString()}\n`);
        this.tooltip.appendMarkdown(`- path: *${item.path}*\n`);

        this.iconPath = isDuplicate
            ? new vscode.ThemeIcon('check-all', ColorSelector.getColor(item.name))
            : new vscode.ThemeIcon('blank');
        this.duplicate = isDuplicate;
        this.command = {
            command: 'revealFileInOS',
            title: 'open',
            arguments: [vscode.Uri.file(item.path)],
        };
        this.extId = extId;
        this.path = item.path;
    }
}

class TreeViewProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
    static readonly id = 'duplicate-extension.extension-version-list';
    private data: ExtInfo[] = [];
    private useFilter = false;
    _onDidChangeTreeData = new vscode.EventEmitter<void>();
    onDidChangeTreeData = this._onDidChangeTreeData.event;
    constructor(context: vscode.ExtensionContext) {
        const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(extFolderUri, '*'));
        context.subscriptions.push(
            watcher.onDidChange(() => this.refresh()),
            watcher.onDidDelete(() => this.refresh()),
            watcher.onDidCreate(() => this.refresh()),
            watcher,
            refreshEvent.event(this.refresh),
            filterEvent.event(this.toggleFilter),
        );
        queueMicrotask(() => this.refresh());
    }
    toggleFilter = (useFilter: boolean) => {
        this.useFilter = useFilter;
        this.refresh();
    };
    refresh = debounce(async () => {
        ColorSelector.reset();
        this.data = await findAllPackageJSON();
        this._onDidChangeTreeData.fire();
    }, 300);
    private findDuplicateSet() {
        let set = new Set<string>();
        let map = new Map<string, number>();
        this.data.forEach((item) => {
            if (map.has(item.name)) {
                set.add(item.name);
            } else {
                map.set(item.name, 1);
            }
        });
        return set;
    }
    getOutdatedExtInfos() {
        let map = new Map<string, ExtInfo[]>();
        this.data.forEach((item) => {
            if (map.has(item.name)) {
                map.get(item.name)!.push(item);
            } else {
                map.set(item.name, [item]);
            }
        });
        let list: ExtInfo[] = [];
        map.forEach((value) => {
            if (value.length <= 1) return;
            const exts = value.sort((a, b) => (semver.gt(a.version, b.version) ? 1 : -1));
            exts.pop();
            list.push(...exts);
        });
        return list;
    }
    getUnusedExtInfos() {
        let idSet = new Set<string>();
        this.data.forEach((item) => {
            const id = item.publisher + '.' + item.name;
            if(!vscode.extensions.getExtension(id)) idSet.add(id);
        });
        return [...idSet];
    }
    async getChildren(element?: vscode.TreeItem | undefined): Promise<vscode.TreeItem[]> {
        if (!element) {
            const duplicateSet = this.findDuplicateSet();
            const items = this.data.map((item) => {
                const isDuplicate = duplicateSet.has(item.name);
                return new ExtTreeItem(item, isDuplicate);
            });
            if (this.useFilter) return items.filter((i) => i.duplicate);
            return items;
        }
        return [];
    }
    getTreeItem(element: vscode.TreeItem): vscode.TreeItem | Thenable<vscode.TreeItem> {
        return element;
    }
}

export function activate(context: vscode.ExtensionContext) {
    vscode.commands.executeCommand('setContext', ContextValue.filter, false);
    const treeDataProvider = new TreeViewProvider(context);
    context.subscriptions.push(
        vscode.window.registerTreeDataProvider(TreeViewProvider.id, treeDataProvider),
        vscode.commands.registerCommand(Commands.refresh, () => {
            refreshEvent.fire();
        }),
        vscode.commands.registerCommand(Commands.filter, () => {
            vscode.commands.executeCommand('setContext', ContextValue.filter, true);
            filterEvent.fire(true);
        }),
        vscode.commands.registerCommand(Commands.unFilter, () => {
            vscode.commands.executeCommand('setContext', ContextValue.filter, false);
            filterEvent.fire(false);
        }),
        vscode.commands.registerCommand(Commands.revealInExtensions, (item: ExtTreeItem) => {
            vscode.commands.executeCommand('workbench.extensions.action.showExtensionsWithIds', [item.extId]);
        }),
        vscode.commands.registerCommand(Commands.moveExtensionToTrashcan, (item: ExtTreeItem) => {
            removeFolders(
                [item],
                vscode.l10n.t("Move extension folder to system's trashcan?"),
                vscode.l10n.t('Selected folder is {0}', item.path),
            );
        }),
        vscode.commands.registerCommand(Commands.cleanupOutdatedExtensions, () => {
            const outdatedExtInfos = treeDataProvider.getOutdatedExtInfos();
            if (!outdatedExtInfos.length) return;
            removeFolders(
                outdatedExtInfos,
                vscode.l10n.t("Move outdated extensions to system's trashcan?"),
                vscode.l10n.t('Selected folders:\n{0}', outdatedExtInfos.map((item) => item.path).join('\n')),
            );
        }),
        vscode.commands.registerCommand(Commands.listUnusedExtension, () => {
            const ids = treeDataProvider.getUnusedExtInfos();
            console.log('ids ', ids);
            vscode.commands.executeCommand('workbench.extensions.action.showExtensionsWithIds', ids);
        }),
        refreshEvent,
        filterEvent,
    );
}

export function deactivate() {}
