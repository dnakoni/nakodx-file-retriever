import * as vscode from 'vscode';
import * as child from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

interface CachedMetadataTypes {
    orgId: string;
    metadataTypes: any[];
}

interface CachedMetadataItems {
    orgId: string;
    metadataType: string;
    items: any[];
}

let metadataTypesCache: CachedMetadataTypes | null = null;
let metadataItemsCache: Map<string, CachedMetadataItems> = new Map();
let cacheDirectory: string;

// Cache management utilities
function initializeCacheDirectory(context: vscode.ExtensionContext) {
    cacheDirectory = path.join(context.globalStorageUri.fsPath, 'cache');
    if (!fs.existsSync(cacheDirectory)) {
        fs.mkdirSync(cacheDirectory, { recursive: true });
    }
}

function getMetadataTypesCachePath(orgId: string): string {
    return path.join(cacheDirectory, `metadata-types-${orgId}.json`);
}

function getMetadataItemsCachePath(orgId: string, metadataType: string): string {
    const safeMetadataType = metadataType.replace(/[^a-zA-Z0-9]/g, '_');
    return path.join(cacheDirectory, `metadata-items-${orgId}-${safeMetadataType}.json`);
}

async function loadMetadataTypesFromDisk(orgId: string): Promise<CachedMetadataTypes | null> {
    try {
        const cachePath = getMetadataTypesCachePath(orgId);
        if (fs.existsSync(cachePath)) {
            const data = await fs.promises.readFile(cachePath, 'utf8');
            return JSON.parse(data);
        }
    } catch (error) {
        console.error('Error loading metadata types cache:', error);
    }
    return null;
}

async function saveMetadataTypesToDisk(cache: CachedMetadataTypes): Promise<void> {
    try {
        const cachePath = getMetadataTypesCachePath(cache.orgId);
        await fs.promises.writeFile(cachePath, JSON.stringify(cache, null, 2));
    } catch (error) {
        console.error('Error saving metadata types cache:', error);
    }
}

async function loadMetadataItemsFromDisk(orgId: string, metadataType: string): Promise<CachedMetadataItems | null> {
    try {
        const cachePath = getMetadataItemsCachePath(orgId, metadataType);
        if (fs.existsSync(cachePath)) {
            const data = await fs.promises.readFile(cachePath, 'utf8');
            return JSON.parse(data);
        }
    } catch (error) {
        console.error('Error loading metadata items cache:', error);
    }
    return null;
}

async function saveMetadataItemsToDisk(cache: CachedMetadataItems): Promise<void> {
    try {
        const cachePath = getMetadataItemsCachePath(cache.orgId, cache.metadataType);
        await fs.promises.writeFile(cachePath, JSON.stringify(cache, null, 2));
    } catch (error) {
        console.error('Error saving metadata items cache:', error);
    }
}

async function loadAllCachesFromDisk(): Promise<void> {
    try {
        if (!fs.existsSync(cacheDirectory)) {
            return;
        }

        const files = await fs.promises.readdir(cacheDirectory);
        
        // Load metadata items caches
        for (const file of files) {
            if (file.startsWith('metadata-items-') && file.endsWith('.json')) {
                try {
                    const data = await fs.promises.readFile(path.join(cacheDirectory, file), 'utf8');
                    const cache: CachedMetadataItems = JSON.parse(data);
                    const cacheKey = `${cache.orgId}:${cache.metadataType}`;
                    metadataItemsCache.set(cacheKey, cache);
                } catch (error) {
                    console.error(`Error loading cache file ${file}:`, error);
                }
            }
        }
    } catch (error) {
        console.error('Error loading caches from disk:', error);
    }
}

export function activate(context: vscode.ExtensionContext) {
    console.log('NAKODX extension is now active!');
    
    // Initialize cache directory and load existing caches
    initializeCacheDirectory(context);
    loadAllCachesFromDisk();

    // Register the cached command
    let cachedDisposable = vscode.commands.registerCommand('nakodx.retrieveFileFromServerCached', () => {
        retrieveFileFromServer(true);
    });

    // Register the delete types cache command
    let deleteTypesCacheDisposable = vscode.commands.registerCommand('nakodx.deleteTypesCache', () => {
        deleteTypesCache();
    });

    // Register the delete items cache command
    let deleteItemsCacheDisposable = vscode.commands.registerCommand('nakodx.deleteItemsCache', () => {
        deleteItemsCache();
    });

    context.subscriptions.push(cachedDisposable, deleteTypesCacheDisposable, deleteItemsCacheDisposable);
}

export function deactivate() {}

async function retrieveFileFromServer(useCache: boolean = true) {
    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: "Initializing NAKODX file retrieval...",
        cancellable: true
    }, async (progress, token) => {
        try {
            // Step 1: Get metadata types
            progress.report({ message: "Getting metadata types..." });
            const metadataTypes = await getMetadataTypes(useCache, token);
            if (!metadataTypes) {
                vscode.window.showErrorMessage('Failed to retrieve metadata types');
                return;
            }

            // Step 2: Show metadata types in QuickPick
            progress.report({ message: "Select metadata type..." });
            const selectedMetadataType = await showMetadataTypeQuickPick(metadataTypes);
            if (!selectedMetadataType) {
                return; // User cancelled
            }

            // Step 3: Get metadata items for selected type
            progress.report({ message: `Getting ${selectedMetadataType} items...` });
            const metadataItems = await getMetadataItems(selectedMetadataType, token);
            if (!metadataItems) {
                vscode.window.showErrorMessage(`Failed to retrieve items for ${selectedMetadataType}`);
                return;
            }

            // Step 4: Show metadata items in QuickPick
            progress.report({ message: "Select item..." });
            const selectedItem = await showMetadataItemQuickPick(metadataItems, selectedMetadataType);
            if (!selectedItem) {
                return; // User cancelled
            }

            // Step 5: Retrieve the selected file
            progress.report({ message: `Retrieving ${selectedMetadataType}:${selectedItem}...` });
            await retrieveSelectedFile(selectedMetadataType, selectedItem, token);

        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            vscode.window.showErrorMessage(`Error: ${errorMessage}`);
        }
    });
}

async function getCurrentOrgId(): Promise<string | null> {
    try {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            return null;
        }

        // Step 1: Get the target-org alias
        const aliasResult = await execCommand('sf config get target-org --json | jq -r \'.result[0].value\'', workspaceFolder.uri.fsPath);
        if (!aliasResult || aliasResult.trim() === 'null') {
            return null;
        }

        const alias = aliasResult.trim();

        // Step 2: Get the org ID using the alias
        const orgIdResult = await execCommand(`sf org list auth --json | jq -r '.result[] | select(.alias=="${alias}") | .orgId'`, workspaceFolder.uri.fsPath);
        if (!orgIdResult || orgIdResult.trim() === 'null') {
            return null;
        }

        return orgIdResult.trim();
    } catch (error) {
        console.error('Error getting org ID:', error);
        return null;
    }
}

function execCommand(command: string, cwd: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const process = child.exec(command, {
            maxBuffer: 1024 * 1024,
            cwd: cwd
        });

        let bufferOutData = '';

        if (process.stdout) {
            process.stdout.on('data', (data) => {
                bufferOutData += data;
            });
        }

        process.on('exit', (code) => {
            if (code !== 0) {
                reject(new Error(`Command failed with exit code ${code}`));
                return;
            }
            resolve(bufferOutData);
        });

        process.on('error', (error) => {
            reject(error);
        });
    });
}

function getMetadataTypes(useCache: boolean = true, token?: vscode.CancellationToken): Promise<any[]> {
    return new Promise(async (resolve, reject) => {
        // Check cache if enabled
        if (useCache) {
            const currentOrgId = await getCurrentOrgId();
            if (currentOrgId) {
                // Check memory cache first
                if (metadataTypesCache && metadataTypesCache.orgId === currentOrgId) {
                    resolve(metadataTypesCache.metadataTypes);
                    return;
                }
                
                // Check disk cache
                const diskCache = await loadMetadataTypesFromDisk(currentOrgId);
                if (diskCache) {
                    metadataTypesCache = diskCache;
                    resolve(diskCache.metadataTypes);
                    return;
                }
            }
        }

        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            reject(new Error('No workspace folder open'));
            return;
        }

        const process = child.exec('sf org list metadata-types --json', {
            maxBuffer: 1024 * 1024 * 10,
            cwd: workspaceFolder.uri.fsPath
        });

        let bufferOutData = '';
        let cancelled = false;

        if (token) {
            token.onCancellationRequested(() => {
                cancelled = true;
                process.kill();
                reject(new Error('Operation cancelled'));
            });
        }

        if (process.stdout) {
            process.stdout.on('data', (data) => {
                bufferOutData += data;
            });
        }

        if (process.stderr) {
            process.stderr.on('data', (data) => {
                console.error('stderr:', data);
            });
        }

        process.on('exit', async (code, signal) => {
            if (cancelled) return;

            if (code !== 0) {
                reject(new Error(`Command failed with exit code ${code}`));
                return;
            }

            try {
                const result = JSON.parse(bufferOutData);
                if (result.status === 1) {
                    reject(new Error(result.message || 'Command failed'));
                    return;
                }
                
                const metadataTypes = result.result.metadataObjects;
                
                // Always cache the result for future use
                const currentOrgId = await getCurrentOrgId();
                if (currentOrgId) {
                    metadataTypesCache = {
                        orgId: currentOrgId,
                        metadataTypes: metadataTypes
                    };
                    // Save to disk
                    await saveMetadataTypesToDisk(metadataTypesCache);
                }
                
                resolve(metadataTypes);
            } catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                reject(new Error(`Failed to parse JSON: ${errorMessage}`));
            }
        });

        process.on('error', (error) => {
            reject(error);
        });
    });
}

async function showMetadataTypeQuickPick(metadataTypes: any[]): Promise<string | undefined> {
    const items: vscode.QuickPickItem[] = metadataTypes.map(type => ({
        label: type.xmlName,
        description: type.directoryName,
        detail: `${type.childXmlNames?.length || 0} child types`
    }));

    const selectedItem = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select a metadata type (e.g., ApexClass)',
        matchOnDescription: true,
        matchOnDetail: true
    });

    return selectedItem?.label;
}

function getMetadataItems(metadataType: string, token?: vscode.CancellationToken): Promise<any[]> {
    return new Promise(async (resolve, reject) => {
        // Check cache first
        const currentOrgId = await getCurrentOrgId();
        if (currentOrgId) {
            const cacheKey = `${currentOrgId}:${metadataType}`;
            
            // Check memory cache first
            const cached = metadataItemsCache.get(cacheKey);
            if (cached) {
                resolve(cached.items);
                return;
            }
            
            // Check disk cache
            const diskCache = await loadMetadataItemsFromDisk(currentOrgId, metadataType);
            if (diskCache) {
                metadataItemsCache.set(cacheKey, diskCache);
                resolve(diskCache.items);
                return;
            }
        }

        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            reject(new Error('No workspace folder open'));
            return;
        }

        const process = child.exec(`sf org list metadata --json -m ${metadataType}`, {
            maxBuffer: 1024 * 1024 * 10,
            cwd: workspaceFolder.uri.fsPath
        });

        let bufferOutData = '';
        let cancelled = false;

        if (token) {
            token.onCancellationRequested(() => {
                cancelled = true;
                process.kill();
                reject(new Error('Operation cancelled'));
            });
        }

        if (process.stdout) {
            process.stdout.on('data', (data) => {
                bufferOutData += data;
            });
        }

        if (process.stderr) {
            process.stderr.on('data', (data) => {
                console.error('stderr:', data);
            });
        }

        process.on('exit', async (code) => {
            if (cancelled) return;

            if (code !== 0) {
                reject(new Error(`Command failed with exit code ${code}`));
                return;
            }

            try {
                const result = JSON.parse(bufferOutData);
                if (result.status === 1) {
                    reject(new Error(result.message || 'Command failed'));
                    return;
                }
                
                const items = result.result || [];
                
                // Cache the result
                if (currentOrgId) {
                    const cacheKey = `${currentOrgId}:${metadataType}`;
                    const cacheData = {
                        orgId: currentOrgId,
                        metadataType: metadataType,
                        items: items
                    };
                    metadataItemsCache.set(cacheKey, cacheData);
                    // Save to disk
                    await saveMetadataItemsToDisk(cacheData);
                }
                
                resolve(items);
            } catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                reject(new Error(`Failed to parse JSON: ${errorMessage}`));
            }
        });

        process.on('error', (error) => {
            reject(error);
        });
    });
}

async function showMetadataItemQuickPick(metadataItems: any[], metadataType: string): Promise<string | undefined> {
    const items: vscode.QuickPickItem[] = metadataItems.map(item => ({
        label: item.fullName,
        description: item.fileName || '',
        detail: `Type: ${item.type} | Created: ${item.createdDate ? new Date(item.createdDate).toLocaleDateString() : 'Unknown'}`
    }));

    const selectedItem = await vscode.window.showQuickPick(items, {
        placeHolder: `Select a ${metadataType} item`,
        matchOnDescription: true,
        matchOnDetail: true
    });

    return selectedItem?.label;
}

function retrieveSelectedFile(metadataType: string, itemName: string, token?: vscode.CancellationToken): Promise<void> {
    return new Promise((resolve, reject) => {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            reject(new Error('No workspace folder open'));
            return;
        }

        const metadataString = `${metadataType}:${itemName}`;
        const process = child.exec(`sf project retrieve start --metadata "${metadataString}"`, {
            maxBuffer: 1024 * 1024 * 10,
            cwd: workspaceFolder.uri.fsPath
        });

        let bufferOutData = '';
        let bufferErrData = '';
        let cancelled = false;

        if (token) {
            token.onCancellationRequested(() => {
                cancelled = true;
                process.kill();
                reject(new Error('Operation cancelled'));
            });
        }

        if (process.stdout) {
            process.stdout.on('data', (data) => {
                bufferOutData += data;
            });
        }

        if (process.stderr) {
            process.stderr.on('data', (data) => {
                bufferErrData += data;
                console.error('stderr:', data);
            });
        }

        process.on('exit', (code) => {
            if (cancelled) return;

            if (code !== 0) {
                reject(new Error(`Failed to retrieve file: ${bufferErrData || bufferOutData}`));
                return;
            }

            vscode.window.showInformationMessage(`Successfully retrieved ${metadataType}:${itemName}`);
            resolve();
        });

        process.on('error', (error) => {
            reject(error);
        });
    });
}

async function deleteTypesCache() {
    try {
        const currentOrgId = await getCurrentOrgId();
        if (currentOrgId) {
            let cleared = false;
            
            // Clear memory cache
            if (metadataTypesCache && metadataTypesCache.orgId === currentOrgId) {
                metadataTypesCache = null;
                cleared = true;
            }
            
            // Clear disk cache
            const cachePath = getMetadataTypesCachePath(currentOrgId);
            if (fs.existsSync(cachePath)) {
                await fs.promises.unlink(cachePath);
                cleared = true;
            }
            
            if (cleared) {
                vscode.window.showInformationMessage('Metadata types cache cleared for current org');
            } else {
                vscode.window.showInformationMessage('No metadata types cache found for current org');
            }
        } else {
            vscode.window.showErrorMessage('Could not determine current org ID');
        }
    } catch (error) {
        vscode.window.showErrorMessage('Failed to clear metadata types cache');
    }
}

async function deleteItemsCache() {
    try {
        const currentOrgId = await getCurrentOrgId();
        if (currentOrgId) {
            let deletedCount = 0;
            
            // Clear memory cache
            for (const [key, cached] of metadataItemsCache.entries()) {
                if (cached.orgId === currentOrgId) {
                    metadataItemsCache.delete(key);
                    deletedCount++;
                }
            }
            
            // Clear disk cache
            if (fs.existsSync(cacheDirectory)) {
                const files = await fs.promises.readdir(cacheDirectory);
                for (const file of files) {
                    if (file.startsWith(`metadata-items-${currentOrgId}-`) && file.endsWith('.json')) {
                        await fs.promises.unlink(path.join(cacheDirectory, file));
                        deletedCount++;
                    }
                }
            }
            
            if (deletedCount > 0) {
                vscode.window.showInformationMessage(`Metadata items cache cleared for current org (${deletedCount} cached types)`);
            } else {
                vscode.window.showInformationMessage('No metadata items cache found for current org');
            }
        } else {
            vscode.window.showErrorMessage('Could not determine current org ID');
        }
    } catch (error) {
        vscode.window.showErrorMessage('Failed to clear metadata items cache');
    }
}