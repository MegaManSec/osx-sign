import child from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { isBinaryFile } from 'isbinaryfile';

import debug from 'debug';
import type { BaseSignOptions, ElectronMacPlatform } from './types.js';

export const debugLog = debug('electron-osx-sign');
debugLog.log = console.log.bind(console);

export const debugWarn = debug('electron-osx-sign:warn');
debugWarn.log = console.warn.bind(console);

function removePassword(input: string[]): string {
  const secretFlags = new Set(['-P', '--password', '-pass', '/p', 'pass:']);

  const redacted: string[] = [];
  for (let i = 0; i < input.length; i++) {
    const a = input[i];

    const eqIndex = a.indexOf('=');
    if (eqIndex > -1) {
      const flag = a.slice(0, eqIndex);
      if (secretFlags.has(flag)) {
        redacted.push(`${flag}=***`);
        continue;
      }
    }

    if (secretFlags.has(a)) {
      redacted.push(a, '***');
      i++;
      continue;
    }

    redacted.push(a);
  }
  return redacted.join(' ');
}

export async function execFileAsync(
  file: string,
  args: string[],
  options: child.ExecFileOptions = {},
): Promise<string> {
  if (debugLog.enabled) {
    debugLog('Executing...', file, args && Array.isArray(args) ? removePassword(args) : '');
  }

  return new Promise(function (resolve, reject) {
    child.execFile(file, args, options, function (err, stdout, stderr) {
      if (err) {
        debugLog('Error executing file:', '\n', '> Stdout:', stdout, '\n', '> Stderr:', stderr);
        reject(err);
        return;
      }
      resolve(stdout);
    });
  });
}

type DeepListItem<T> = null | T | DeepListItem<T>[];
type DeepList<T> = DeepListItem<T>[];

export function compactFlattenedList<T>(list: DeepList<T>): T[] {
  const result: T[] = [];

  function populateResult(list: DeepListItem<T>) {
    if (!Array.isArray(list)) {
      if (list) result.push(list);
    } else if (list.length > 0) {
      for (const item of list) if (item) populateResult(item);
    }
  }

  populateResult(list);
  return result;
}

/**
 * Returns the path to the "Contents" folder inside the application bundle
 */
export function getAppContentsPath(opts: BaseSignOptions): string {
  return path.join(opts.app, 'Contents');
}

/**
 * Returns the path to app "Frameworks" within contents.
 */
export function getAppFrameworksPath(opts: BaseSignOptions): string {
  return path.join(getAppContentsPath(opts), 'Frameworks');
}

export async function detectElectronPlatform(opts: BaseSignOptions): Promise<ElectronMacPlatform> {
  const appFrameworksPath = getAppFrameworksPath(opts);
  if (fs.existsSync(path.resolve(appFrameworksPath, 'Squirrel.framework'))) {
    return 'darwin';
  } else {
    return 'mas';
  }
}

/**
 * This function returns a promise resolving the file path if file binary.
 */
async function getFilePathIfBinary(filePath: string) {
  if (await isBinaryFile(filePath)) {
    return filePath;
  }
  return null;
}

/**
 * This function returns a promise validating opts.app, the application to be signed or flattened.
 */
export async function validateOptsApp(opts: BaseSignOptions): Promise<void> {
  if (!opts.app) {
    throw new Error('Path to application must be specified.');
  }
  if (path.extname(opts.app) !== '.app') {
    throw new Error('Extension of application must be `.app`.');
  }
  if (!fs.existsSync(opts.app)) {
    throw new Error(`Application at path "${opts.app}" could not be found`);
  }
}

/**
 * This function returns a promise validating opts.platform, the platform of Electron build. It allows auto-discovery if no opts.platform is specified.
 */
export async function validateOptsPlatform(opts: BaseSignOptions): Promise<ElectronMacPlatform> {
  if (opts.platform) {
    if (opts.platform === 'mas' || opts.platform === 'darwin') {
      return opts.platform;
    } else {
      debugWarn('`platform` passed in arguments not supported, checking Electron platform...');
    }
  } else {
    debugWarn('No `platform` passed in arguments, checking Electron platform...');
  }

  return await detectElectronPlatform(opts);
}

/**
 * This function returns a promise resolving all child paths within the directory specified.
 *
 * @param dirPath - Path to directory.
 * @returns Promise resolving child paths needing signing in order.
 * @internal
 */
export async function walk(dirPath: string): Promise<string[]> {
  debugLog('Walking... ' + dirPath);

  async function _walkAsync(dirPath: string): Promise<DeepList<string>> {
    const children = await fs.promises.readdir(dirPath);
    return await Promise.all(
      children.map(async (child) => {
        const filePath = path.resolve(dirPath, child);

        const stat = await fs.promises.stat(filePath);
        if (stat.isFile()) {
          switch (path.extname(filePath)) {
            case '.cstemp': // Temporary file generated from past codesign
              debugLog('Removing... ' + filePath);
              await fs.promises.rm(filePath, { recursive: true, force: true });
              return null;
            default:
              return await getFilePathIfBinary(filePath);
          }
        } else if (stat.isDirectory() && !stat.isSymbolicLink()) {
          const walkResult = await _walkAsync(filePath);
          switch (path.extname(filePath)) {
            case '.app': // Application
            case '.framework': // Framework
              walkResult.push(filePath);
          }
          return walkResult;
        }
        return null;
      }),
    );
  }

  const allPaths = await _walkAsync(dirPath);
  return compactFlattenedList(allPaths);
}
