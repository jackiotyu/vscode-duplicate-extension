import * as vscode from 'vscode';
import os from 'os';
import path from 'path';
import fs from 'fs/promises';
import { ExtInfo } from '@/types';

const extFolderUri = vscode.Uri.file(path.join(os.homedir(), '.vscode', 'extensions'));

const findAllPackageJSON = async (): Promise<ExtInfo[]> => {
    console.log(vscode.env.appName);
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
    console.log(res, 'res', jsonInfoList);
    return (jsonInfoList.filter((i) => i !== null) as ExtInfo[]).sort((a, b) =>
        (a.name + a.version).localeCompare(b.name + b.version),
    );
};

class ExtTreeItem extends vscode.TreeItem {
    duplicate: boolean = false;
}

class TreeViewProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
    static readonly id = 'extension-version-list';
    private data: ExtInfo[] = [];
    private readonly colorList = [
        'terminal.ansiBlue',
        'terminal.ansiGreen',
        'terminal.ansiMagenta',
        'terminal.ansiRed',
        'terminal.ansiWhite',
        'terminal.ansiYellow',
    ];
    _onDidChangeTreeData = new vscode.EventEmitter<void>();
    onDidChangeTreeData: vscode.Event<void | vscode.TreeItem | vscode.TreeItem[] | null | undefined> | undefined =
        this._onDidChangeTreeData.event;
    constructor(context: vscode.ExtensionContext) {
        const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(extFolderUri, '*'));
        context.subscriptions.push(
            watcher.onDidChange(() => this.refresh()),
            watcher,
        );
        this.refresh();
    }
    async refresh() {
        this.data = await findAllPackageJSON();
        this._onDidChangeTreeData.fire();
    }
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
        if (name === this.duplicateName) {
            const color = this.colorList[this.colorIndex];
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
            return this.data.map((item, index) => {
                const treeItem = new ExtTreeItem(item.name);
                treeItem.description = item.version;
                treeItem.tooltip = new vscode.MarkdownString('');
                treeItem.tooltip.appendMarkdown(`${item.name}\n`);
                treeItem.tooltip.appendMarkdown(`- displayName: ${item.displayName}\n`);
                treeItem.tooltip.appendMarkdown(`- description: ${item.description}\n`);
                treeItem.tooltip.appendMarkdown(`- version: ${item.version}\n`);
                treeItem.tooltip.appendMarkdown(`- publisher: ${item.publisher}\n`);
                treeItem.tooltip.appendMarkdown(`- mtime: ${new Date(item.mtime).toLocaleString()}\n`);
                treeItem.tooltip.appendMarkdown(`- path: ${item.path}\n`);
                const isDuplicate = duplicateSet.has(item.name);
                treeItem.iconPath = isDuplicate
                    ? new vscode.ThemeIcon('check-all', this.getColor(item.name))
                    : new vscode.ThemeIcon('blank');
                treeItem.duplicate = isDuplicate;
				treeItem.command = {
					command: 'revealFileInOS',
					title: 'open',
					arguments: [vscode.Uri.file(item.path)]
				};
                return treeItem;
            });
        }
        return [];
    }
    getTreeItem(element: vscode.TreeItem): vscode.TreeItem | Thenable<vscode.TreeItem> {
        return element;
    }
}

export function activate(context: vscode.ExtensionContext) {
    vscode.window.registerTreeDataProvider(TreeViewProvider.id, new TreeViewProvider(context));
}

export function deactivate() {}
