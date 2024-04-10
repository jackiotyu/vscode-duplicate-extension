import * as vscode from 'vscode';
import os from 'os';
import path from 'path';
import fs from 'fs/promises';
import semver from 'semver';
import debounce from 'lodash/debounce';
import { ExtInfo } from '@/types';
import { Commands } from '@/constants';

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
                const mtime = (await fs.stat(file.fsPath)).mtime.getTime();
                const text = await fs.readFile(file.fsPath, 'utf-8');
                const { name, displayName, description, version, publisher } = JSON.parse(text);
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

class ExtTreeItem extends vscode.TreeItem {
    duplicate: boolean = false;
    contextValue = 'duplicate-extension.extInfo';
    extId: string = '';
}

class TreeViewProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
    static readonly id = 'duplicate-extension.extension-version-list';
    private data: ExtInfo[] = [];
    private readonly colorList = [
        'terminal.ansiBlue',
        'terminal.ansiGreen',
        'terminal.ansiMagenta',
        'terminal.ansiRed',
        'terminal.ansiWhite',
        'terminal.ansiYellow',
    ];
    private useFilter = false;
    _onDidChangeTreeData = new vscode.EventEmitter<void>();
    onDidChangeTreeData = this._onDidChangeTreeData.event;
    constructor(context: vscode.ExtensionContext) {
        const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(extFolderUri, '*'));
        context.subscriptions.push(
            watcher.onDidChange(() => this.refresh()),
            watcher,
            refreshEvent.event(this.refresh),
            filterEvent.event(this.toggleFilter),
        );
        this.refresh();
    }
    toggleFilter = (useFilter: boolean) => {
        this.useFilter = useFilter;
        this.refresh();
    };
    refresh = debounce(async () => {
        this.colorIndex = 0;
        this.duplicateName = '';
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
    private colorIndex: number = 0;
    private duplicateName: string = '';
    private getColor(name: string): vscode.ThemeColor | undefined {
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
    getChildren(element?: vscode.TreeItem | undefined): vscode.ProviderResult<vscode.TreeItem[]> {
        if (!element) {
            const duplicateSet = this.findDuplicateSet();
            const items = this.data.map((item) => {
                const isDuplicate = duplicateSet.has(item.name);
                const extId = item.publisher + '.' + item.name;
                const ext = vscode.extensions.getExtension(extId);
                const isActiveExt = ext?.extensionPath === item.path;
                const treeItem = new ExtTreeItem(isActiveExt ? `${item.name} ✨` : item.name);
                treeItem.description = item.version;

                treeItem.tooltip = new vscode.MarkdownString('');
                treeItem.tooltip.appendMarkdown(`### ${item.name}\n`);
                treeItem.tooltip.appendMarkdown(
                    `- displayName: *${ext?.packageJSON.description || item.displayName}*\n`,
                );
                treeItem.tooltip.appendMarkdown(
                    `- description: *${ext?.packageJSON.description || item.description}*\n`,
                );
                treeItem.tooltip.appendMarkdown(`- version: ${item.version}\n`);
                treeItem.tooltip.appendMarkdown(`- publisher: *${item.publisher}*\n`);
                treeItem.tooltip.appendMarkdown(`- mtime: ${new Date(item.mtime).toLocaleString()}\n`);
                treeItem.tooltip.appendMarkdown(`- path: *${item.path}*\n`);

                treeItem.iconPath = isDuplicate
                    ? new vscode.ThemeIcon('check-all', this.getColor(item.name))
                    : new vscode.ThemeIcon('blank');
                treeItem.duplicate = isDuplicate;
                treeItem.command = {
                    command: 'revealFileInOS',
                    title: 'open',
                    arguments: [vscode.Uri.file(item.path)],
                };
                treeItem.extId = extId;
                return treeItem;
            });
            if(this.useFilter) return items.filter(i => i.duplicate);
            return items;
        }
        return [];
    }
    getTreeItem(element: vscode.TreeItem): vscode.TreeItem | Thenable<vscode.TreeItem> {
        return element;
    }
}

export function activate(context: vscode.ExtensionContext) {
    vscode.commands.executeCommand('setContext', 'duplicate-extension.filter', false);
    context.subscriptions.push(
        vscode.window.registerTreeDataProvider(TreeViewProvider.id, new TreeViewProvider(context)),
        vscode.commands.registerCommand(Commands.refresh, () => {
            refreshEvent.fire();
        }),
        vscode.commands.registerCommand(Commands.filter, () => {
            vscode.commands.executeCommand('setContext', 'duplicate-extension.filter', true);
            filterEvent.fire(true);
        }),
        vscode.commands.registerCommand(Commands.unFilter, () => {
            vscode.commands.executeCommand('setContext', 'duplicate-extension.filter', false);
            filterEvent.fire(false);
        }),
        vscode.commands.registerCommand(Commands.revealInExtensions, (item: ExtTreeItem) => {
            vscode.commands.executeCommand('workbench.extensions.action.showExtensionsWithIds', [[item.extId]]);
        }),
        refreshEvent,
        filterEvent,
    );
}

export function deactivate() {}
