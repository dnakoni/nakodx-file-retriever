import * as vscode from 'vscode';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

/**
 * ===== Types =====
 */
interface MetadataType {
  xmlName: string;
  directoryName?: string;
  childXmlNames?: string[];
}

interface MetadataItem {
  fullName: string;
  fileName?: string;
  type?: string;
  createdDate?: string;
}

interface CachedMetadataTypes {
  orgId: string;
  metadataTypes: MetadataType[];
  ts?: number; // cache timestamp (ms)
}

interface CachedMetadataItems {
  orgId: string;
  metadataType: string;
  items: MetadataItem[];
  ts?: number; // cache timestamp (ms)
}

type SfConfigGet = { status: number; result: Array<{ name: string; value?: string }> };
type SfAuthList = { status: number; result: Array<{ alias?: string; username: string; orgId: string }> };
type SfListMetadataTypes = { status: number; result: { metadataObjects: MetadataType[] } };
type SfListMetadata = { status: number; result: MetadataItem[] };
type SfRetrieve = {
  status: number;
  result?: {
    success?: boolean;
    files?: Array<{ filePath: string; state?: string; error?: string; fullName?: string; type?: string }>;
    messages?: Array<{ fileName?: string; problem?: string }> | string;
  };
  message?: string;
  code?: string;
  name?: string;
  context?: string;
  stack?: string;
  warnings?: unknown[];
  exitCode?: number;
} & Record<string, unknown>;

/**
 * ===== Globals =====
 */
const SF_BIN = process.platform === 'win32' ? 'sf.cmd' : 'sf';
// TTL is now dynamic (1-30 days) based on user configuration. Default is 30 days, matching package.json default.
let TTL_MS = 30 * 24 * 60 * 60 * 1000; // will be updated from settings on activation & config change

let metadataTypesCache: CachedMetadataTypes | null = null;
let metadataItemsCache: Map<string, CachedMetadataItems> = new Map();
let cacheDirectory: string;

let output: vscode.OutputChannel;

const inflightItems = new Map<string, Promise<MetadataItem[]>>();

/**
 * ===== Error class for richer surfacing =====
 */
class SfCliError extends Error {
  codeStr?: string;
  context?: string;
  status?: number;
  exitCode?: number;
  stderr?: string;
  rawJson?: any;

  constructor(message: string, opts?: Partial<SfCliError>) {
    super(message);
    this.name = 'SfCliError';
    Object.assign(this, opts);
  }
}

/**
 * ===== Output helpers =====
 */
function logInfo(msg: string) { output.appendLine(`[INFO] ${msg}`); }
function logWarn(msg: string) { output.appendLine(`[WARN] ${msg}`); }
function logErr(msg: string)  { output.appendLine(`[ERROR] ${msg}`); }

function pretty(obj: any) {
  try { return JSON.stringify(obj, null, 2); } catch { return String(obj); }
}

/** Show a descriptive toast (with "Open Output" button) and log details to Output. */
function showCliError(prefix: string, err: unknown) {
  const actionOpen = 'Open Output';

  if (err instanceof SfCliError) {
    const parts = [
      `${prefix}`,
      err.message && `• ${err.message}`,
      err.codeStr && `• Code: ${err.codeStr}`,
      err.context && `• Context: ${err.context}`,
      (err.exitCode !== undefined) && `• Exit: ${err.exitCode}`
    ].filter(Boolean);
    vscode.window.showErrorMessage(parts.join('\n'), actionOpen).then(choice => {
      if (choice === actionOpen) output.show(true);
    });

    logErr(`${prefix}`);
    if (err.stderr) logErr(`stderr: ${err.stderr.trim()}`);
    if (err.rawJson) {
      logErr('sf JSON:');
      output.appendLine(pretty(err.rawJson));
    }
    return;
  }

  const msg = err instanceof Error ? err.message : String(err);
  vscode.window.showErrorMessage(`${prefix}\n• ${msg}`, actionOpen).then(choice => {
    if (choice === actionOpen) output.show(true);
  });
  logErr(`${prefix}: ${msg}`);
}

/**
 * ===== Cache management =====
 */
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

function isFresh(ts?: number): boolean {
  if (!ts) return true; // old cache files (no ts) considered fresh
  return (Date.now() - ts) < TTL_MS;
}

async function loadMetadataTypesFromDisk(orgId: string): Promise<CachedMetadataTypes | null> {
  try {
    const cachePath = getMetadataTypesCachePath(orgId);
    if (!fs.existsSync(cachePath)) return null;
    const data = await fs.promises.readFile(cachePath, 'utf8');
    const parsed: CachedMetadataTypes = JSON.parse(data);
    if (!isFresh(parsed.ts)) return null;
    return parsed;
  } catch (error) {
    logErr(`Error loading metadata types cache: ${String(error)}`);
    return null;
  }
}

async function saveMetadataTypesToDisk(cache: CachedMetadataTypes): Promise<void> {
  try {
    const cachePath = getMetadataTypesCachePath(cache.orgId);
    await fs.promises.writeFile(cachePath, JSON.stringify({ ...cache, ts: Date.now() }, null, 2));
  } catch (error) {
    logErr(`Error saving metadata types cache: ${String(error)}`);
  }
}

async function loadMetadataItemsFromDisk(orgId: string, metadataType: string): Promise<CachedMetadataItems | null> {
  try {
    const cachePath = getMetadataItemsCachePath(orgId, metadataType);
    if (!fs.existsSync(cachePath)) return null;
    const data = await fs.promises.readFile(cachePath, 'utf8');
    const parsed: CachedMetadataItems = JSON.parse(data);
    if (!isFresh(parsed.ts)) return null;
    return parsed;
  } catch (error) {
    logErr(`Error loading metadata items cache: ${String(error)}`);
    return null;
  }
}

async function saveMetadataItemsToDisk(cache: CachedMetadataItems): Promise<void> {
  try {
    const cachePath = getMetadataItemsCachePath(cache.orgId, cache.metadataType);
    await fs.promises.writeFile(cachePath, JSON.stringify({ ...cache, ts: Date.now() }, null, 2));
  } catch (error) {
    logErr(`Error saving metadata items cache: ${String(error)}`);
  }
}

async function loadAllCachesFromDisk(): Promise<void> {
  try {
    if (!fs.existsSync(cacheDirectory)) return;
    const files = await fs.promises.readdir(cacheDirectory);

    for (const file of files) {
      if (file.startsWith('metadata-items-') && file.endsWith('.json')) {
        try {
          const data = await fs.promises.readFile(path.join(cacheDirectory, file), 'utf8');
          const cache: CachedMetadataItems = JSON.parse(data);
          if (!isFresh(cache.ts)) continue;
          const cacheKey = `${cache.orgId}:${cache.metadataType}`;
          metadataItemsCache.set(cacheKey, cache);
        } catch (error) {
          logErr(`Error loading cache file ${file}: ${String(error)}`);
        }
      }
    }
  } catch (error) {
    logErr(`Error loading caches from disk: ${String(error)}`);
  }
}

/**
 * ===== CLI helper =====
 * Spawns `sf ... --json`, parses stdout as JSON (even on non-zero exit).
 * Rejects with SfCliError carrying rich details.
 */
function runSfJson<T extends { status?: number; message?: string; code?: string; context?: string }>(
  args: string[],
  cwd: string,
  token?: vscode.CancellationToken
): Promise<T> {
  return new Promise((resolve, reject) => {
    const cp = spawn(SF_BIN, [...args, '--json'], { cwd, shell: false });
    let out = '';
    let err = '';

    token?.onCancellationRequested(() => {
      try { cp.kill(); } catch { /* noop */ }
      reject(new SfCliError('Operation cancelled'));
    });

    cp.stdout.on('data', d => out += d.toString());
    cp.stderr.on('data', d => {
      const s = d.toString();
      err += s;
      if (s.trim()) logWarn(`sf ${args.join(' ')}: ${s.trim()}`);
    });

    cp.on('error', (e) => reject(new SfCliError(String(e))));

    cp.on('close', (code) => {
      const tryParse = (): any | undefined => {
        try { return JSON.parse(out); } catch { return undefined; }
      };

      const json = tryParse();

      // If exit != 0, prefer parsed JSON message when available
      if (code !== 0) {
        if (json) {
          const message = buildHumanMessage(json) || (err || `sf ${args.join(' ')} failed with exit ${code}`);
          return reject(new SfCliError(message, {
            codeStr: json.code,
            context: json.context,
            status: json.status,
            exitCode: (code ?? json.exitCode) ?? undefined,
            stderr: err,
            rawJson: json
          }));
        }
        return reject(new SfCliError(err || `sf ${args.join(' ')} failed with exit ${code}`, { exitCode: code ?? undefined, stderr: err }));
      }

      // Exit 0 but internal status != 0
      if (!json) {
        return reject(new SfCliError(`Invalid JSON from sf ${args.join(' ')}`));
      }
      if (typeof json.status === 'number' && json.status !== 0) {
        const message = buildHumanMessage(json) || 'Command failed';
        return reject(new SfCliError(message, {
          codeStr: (json as any).code,
          context: (json as any).context,
          status: json.status,
          stderr: err,
          rawJson: json
        }));
      }

      resolve(json as T);
    });
  });
}

/** Extract a concise human message from sf JSON error/success payloads. */
function buildHumanMessage(json: any): string | undefined {
  // Priority 1: explicit message
  if (json?.message) {
    if (json?.code) return `${json.message} [${json.code}]`;
    return json.message;
  }

  // Priority 2: retrieve result messages (array of {problem})
  const msgs = json?.result?.messages;
  if (Array.isArray(msgs) && msgs.length) {
    const first = msgs[0];
    if (first?.problem) return first.problem;
    const joined = msgs.map((m: any) => (m.problem || m.message || m)).join('; ');
    if (joined) return joined;
  } else if (typeof msgs === 'string' && msgs.trim()) {
    return msgs.trim();
  }

  // Priority 3: failed file details
  const files: any[] = json?.result?.files ?? [];
  const failed = files.find(f => f?.state === 'Failed' || f?.error);
  if (failed?.error) return failed.error;
  if (failed?.problem) return failed.problem;

  // Priority 4: generic
  if (json?.code) return `Command failed [${json.code}]`;
  return undefined;
}

/**
 * ===== Current org helper =====
 */
async function getCurrentOrgId(): Promise<string | null> {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) return null;
  const cwd = workspaceFolder.uri.fsPath;

  try {
    const cfg = await runSfJson<SfConfigGet>(['config', 'get', 'target-org'], cwd);
    const aliasOrUsername = cfg.result?.[0]?.value;
    if (!aliasOrUsername) return null;

    const auth = await runSfJson<SfAuthList>(['org', 'list', 'auth'], cwd);
    const rec = auth.result.find(r => r.alias === aliasOrUsername || r.username === aliasOrUsername);
    return rec?.orgId ?? null;
  } catch (e) {
    logErr(`Error getting org ID: ${String(e)}`);
    return null;
  }
}

/**
 * ===== VS Code events =====
 */
export async function activate(context: vscode.ExtensionContext) {
  output = vscode.window.createOutputChannel('NAKODX');
  output.show(true);
  logInfo('NAKODX extension activating…');

  // Initialize TTL from user settings
  applyConfigSettings();

  // React to configuration changes
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
    if (e.affectsConfiguration('nakodx-file-retriever.cacheTtlDays') || e.affectsConfiguration('nakodx-file-retriever.enableCache')) {
      applyConfigSettings();
    }
  }));

  initializeCacheDirectory(context);
  await loadAllCachesFromDisk();

  try {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
    // Not all sf versions print JSON for --version; ignore errors.
    await runSfJson<any>(['--version'], workspaceFolder).then(v => {
      logInfo(`sf --version returned JSON`);
      output.appendLine(pretty(v));
    }).catch(() => {});
  } catch {}

  const retrieveCmd = vscode.commands.registerCommand('nakodx.retrieveFileFromServerCached', () => {
    retrieveFileFromServer(true);
  });

  const deleteTypesCacheCmd = vscode.commands.registerCommand('nakodx.deleteTypesCache', () => {
    deleteTypesCache();
  });

  const deleteItemsCacheCmd = vscode.commands.registerCommand('nakodx.deleteItemsCache', () => {
    deleteItemsCache();
  });

  context.subscriptions.push(retrieveCmd, deleteTypesCacheCmd, deleteItemsCacheCmd, output);

  logInfo('NAKODX extension activated.');
}

export function deactivate() {
  // no-op
}

/**
 * ===== Command flow =====
 */
async function retrieveFileFromServer(useCache: boolean = true) {
  await vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: 'Initializing NAKODX file retrieval…',
    cancellable: true
  }, async (progress, token) => {
    try {
      progress.report({ message: 'Getting metadata types…' });
      const types = await getMetadataTypes(useCache, token);
      if (!types) {
        vscode.window.showErrorMessage('Failed to retrieve metadata types');
        return;
      }

      progress.report({ message: 'Select metadata type…' });
      const selectedMetadataType = await showMetadataTypeQuickPick(types);
      if (!selectedMetadataType) return;

      progress.report({ message: `Getting ${selectedMetadataType} items…` });
      const items = await getMetadataItems(selectedMetadataType, token);
      if (!items) {
        vscode.window.showErrorMessage(`Failed to retrieve items for ${selectedMetadataType}`);
        return;
      }

      progress.report({ message: 'Select item…' });
      const selectedItem = await showMetadataItemQuickPick(items, selectedMetadataType);
      if (!selectedItem) return;

      progress.report({ message: `Retrieving ${selectedMetadataType}:${selectedItem.name}…` });
      await retrieveSelectedFile(selectedMetadataType, selectedItem.name, token);
    } catch (err) {
      showCliError('Failed to retrieve file', err);
    }
  });
}

/**
 * ===== Data providers =====
 */
async function getMetadataTypes(useCache: boolean = true, token?: vscode.CancellationToken): Promise<MetadataType[]> {
  // Respect global cache enable setting
  const config = vscode.workspace.getConfiguration('nakodx-file-retriever');
  const cachingEnabled = Boolean(config.get('enableCache', true));
  if (!cachingEnabled) useCache = false;
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) throw new Error('No workspace folder open');
  const cwd = workspaceFolder.uri.fsPath;

  const currentOrgId = await getCurrentOrgId();

  // Cache: memory & disk
  if (useCache && currentOrgId) {
    if (metadataTypesCache && metadataTypesCache.orgId === currentOrgId && isFresh(metadataTypesCache.ts)) {
      return metadataTypesCache.metadataTypes;
    }
    const diskCache = await loadMetadataTypesFromDisk(currentOrgId);
    if (diskCache) {
      metadataTypesCache = diskCache;
      return diskCache.metadataTypes;
    }
  }

  // Fetch
  const json = await runSfJson<SfListMetadataTypes>(['org', 'list', 'metadata-types'], cwd, token);
  const types = json.result?.metadataObjects ?? [];

  // Cache only if enabled
  if (cachingEnabled && currentOrgId) {
    metadataTypesCache = { orgId: currentOrgId, metadataTypes: types, ts: Date.now() };
    await saveMetadataTypesToDisk(metadataTypesCache);
  }

  return types;
}

async function getMetadataItems(metadataType: string, token?: vscode.CancellationToken): Promise<MetadataItem[]> {
  const config = vscode.workspace.getConfiguration('nakodx-file-retriever');
  const cachingEnabled = Boolean(config.get('enableCache', true));
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) throw new Error('No workspace folder open');
  const cwd = workspaceFolder.uri.fsPath;

  const currentOrgId = await getCurrentOrgId();
  const cacheKey = currentOrgId ? `${currentOrgId}:${metadataType}` : undefined;

  // Memory cache (only if enabled)
  if (cacheKey && cachingEnabled) {
    const cached = metadataItemsCache.get(cacheKey);
    if (cached && isFresh(cached.ts)) return cached.items;

    // Disk cache
    const diskCache = await loadMetadataItemsFromDisk(currentOrgId!, metadataType);
    if (diskCache) {
      metadataItemsCache.set(cacheKey, diskCache);
      return diskCache.items;
    }
  }

  // Coalesce in-flight requests for same key
  if (cacheKey && inflightItems.has(cacheKey)) return inflightItems.get(cacheKey)!;

  const fetchPromise = (async () => {
    const json = await runSfJson<SfListMetadata>(['org', 'list', 'metadata', '-m', metadataType], cwd, token);
    const items = json.result ?? [];

  if (cachingEnabled && cacheKey && currentOrgId) {
      const cacheData: CachedMetadataItems = {
        orgId: currentOrgId,
        metadataType,
        items,
        ts: Date.now()
      };
      metadataItemsCache.set(cacheKey, cacheData);
      await saveMetadataItemsToDisk(cacheData);
    }

    return items;
  })();

  if (cacheKey && cachingEnabled) inflightItems.set(cacheKey, fetchPromise);
  try {
    return await fetchPromise;
  } finally {
    if (cacheKey && cachingEnabled) inflightItems.delete(cacheKey);
  }
}

/** Apply user configuration for TTL and potentially purge caches if disabled */
function applyConfigSettings() {
  const config = vscode.workspace.getConfiguration('nakodx-file-retriever');
  const days = Math.min(30, Math.max(1, Number(config.get('cacheTtlDays', 30))));
  TTL_MS = days * 24 * 60 * 60 * 1000;
  const cachingEnabled = Boolean(config.get('enableCache', true));
  logInfo(`Cache settings applied. Enabled=${cachingEnabled} TTL_DAYS=${days}`);
  if (!cachingEnabled) {
    metadataTypesCache = null;
    metadataItemsCache.clear();
    // Remove on-disk cache files as well
    try {
      if (cacheDirectory && fs.existsSync(cacheDirectory)) {
        const files = fs.readdirSync(cacheDirectory);
        let deleted = 0;
        for (const f of files) {
          if (f.startsWith('metadata-types-') || f.startsWith('metadata-items-')) {
            try {
              fs.unlinkSync(path.join(cacheDirectory, f));
              deleted++;
            } catch (e) {
              logWarn(`Failed deleting cache file ${f}: ${String(e)}`);
            }
          }
        }
        logInfo(`Disk cache cleared (${deleted} file(s) removed).`);
      }
    } catch (e) {
      logWarn(`Error while clearing disk cache: ${String(e)}`);
    }
  }
}

/**
 * ===== QuickPick helpers =====
 */
async function showMetadataTypeQuickPick(metadataTypes: MetadataType[]): Promise<string | undefined> {
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

async function showMetadataItemQuickPick(
  metadataItems: MetadataItem[],
  metadataType: string
): Promise<{ name: string; fileName: string | null } | undefined> {
  const items: vscode.QuickPickItem[] = metadataItems.map(item => {
    const created = item.createdDate ? new Date(item.createdDate).toLocaleDateString() : 'Unknown';
    return {
      label: item.fullName,
      description: item.fileName || '',
      detail: `Type: ${item.type ?? metadataType} | Created: ${created}`
    };
  });

  const selectedItem = await vscode.window.showQuickPick(items, {
    placeHolder: `Select a ${metadataType} item`,
    matchOnDescription: true,
    matchOnDetail: true
  });

  if (selectedItem) {
    const originalItem = metadataItems.find(i => i.fullName === selectedItem.label);
    return {
      name: selectedItem.label,
      fileName: originalItem?.fileName || null
    };
  }
  return undefined;
}

/**
 * ===== Retrieve & open (with rich error handling) =====
 */
async function retrieveSelectedFile(metadataType: string, itemName: string, token?: vscode.CancellationToken): Promise<void> {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) throw new Error('No workspace folder open');
  const cwd = workspaceFolder.uri.fsPath;

  const metadataArg = `${metadataType}:${itemName}`;
  const result = await runSfJson<SfRetrieve>(['project', 'retrieve', 'start', '--metadata', metadataArg], cwd, token);

  // Even when status==0, there can be logical failures in messages/files.
  const problems = collectRetrieveProblems(result);
  if (problems.length) {
    const first = problems[0];
    // Throw with rich context; top-level will show the toast.
    throw new SfCliError(first, { rawJson: result });
  }

  vscode.window.showInformationMessage(`Successfully retrieved ${metadataType}:${itemName}`);

  // Open first non -meta.xml file if setting enabled
  const config = vscode.workspace.getConfiguration('nakodx-file-retriever');
  const autoOpen = Boolean(config.get('autoOpenAfterDownload', true));

  if (autoOpen) {
    const files = result.result?.files ?? [];
    const first = files.find(f => !f.filePath.endsWith('-meta.xml')) ?? files[0];
    if (first?.filePath) {
      const filePath = path.isAbsolute(first.filePath)
        ? first.filePath
        : path.join(cwd, first.filePath);

      if (fs.existsSync(filePath)) {
        const doc = await vscode.workspace.openTextDocument(filePath);
        await vscode.window.showTextDocument(doc);
      } else {
        logWarn(`Retrieved file does not exist on disk: ${filePath}`);
      }
    }
  }
}

/** Flatten useful “problem” strings from a retrieve JSON payload. */
function collectRetrieveProblems(json: SfRetrieve): string[] {
  const msgs: Array<{ fileName?: string; problem?: string }> | string | undefined = json.result?.messages;
  const files = json.result?.files ?? [];
  const out: string[] = [];

  if (Array.isArray(msgs)) {
    for (const m of msgs) {
      if (m?.problem) {
        out.push(m.fileName ? `${m.problem} (${m.fileName})` : m.problem);
      }
    }
  } else if (typeof msgs === 'string' && msgs.trim()) {
    out.push(msgs.trim());
  }

  for (const f of files) {
    if (f?.state === 'Failed' && f?.error) {
      const label = f.fullName && f.type ? `${f.type} ${f.fullName}` : undefined;
      out.push(label ? `${f.error} [${label}]` : f.error);
    }
  }

  // If CLI indicated overall failure via message/code (e.g., ENOTFOUND), include that
  const top = buildHumanMessage(json);
  if (top && !out.length) out.push(top);

  return out;
}

/**
 * ===== Cache clearing commands =====
 */
async function deleteTypesCache() {
  try {
    const currentOrgId = await getCurrentOrgId();
    if (!currentOrgId) {
      vscode.window.showErrorMessage('Could not determine current org ID');
      return;
    }
    let cleared = false;

    // Memory
    if (metadataTypesCache?.orgId === currentOrgId) {
      metadataTypesCache = null;
      cleared = true;
    }

    // Disk
    const cachePath = getMetadataTypesCachePath(currentOrgId);
    if (fs.existsSync(cachePath)) {
      await fs.promises.unlink(cachePath);
      cleared = true;
    }

    if (cleared) {
      vscode.window.showInformationMessage('Metadata types cache cleared for current org.');
    } else {
      vscode.window.showInformationMessage('No metadata types cache found for current org.');
    }
  } catch (error) {
    showCliError('Failed to clear metadata types cache', error);
  }
}

async function deleteItemsCache() {
  try {
    const currentOrgId = await getCurrentOrgId();
    if (!currentOrgId) {
      vscode.window.showErrorMessage('Could not determine current org ID');
      return;
    }

    let memDeleted = 0;
    for (const [key, cached] of metadataItemsCache.entries()) {
      if (cached.orgId === currentOrgId) {
        metadataItemsCache.delete(key);
        memDeleted++;
      }
    }

    let diskDeleted = 0;
    if (fs.existsSync(cacheDirectory)) {
      const files = await fs.promises.readdir(cacheDirectory);
      for (const file of files) {
        if (file.startsWith(`metadata-items-${currentOrgId}-`) && file.endsWith('.json')) {
          await fs.promises.unlink(path.join(cacheDirectory, file));
          diskDeleted++;
        }
      }
    }

    if (memDeleted + diskDeleted > 0) {
      vscode.window.showInformationMessage(
        `Metadata items cache cleared for current org (memory: ${memDeleted}, disk: ${diskDeleted}).`
      );
    } else {
      vscode.window.showInformationMessage('No metadata items cache found for current org.');
    }
  } catch (error) {
    showCliError('Failed to clear metadata items cache', error);
  }
}
