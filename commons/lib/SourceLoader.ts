import * as fs from 'fs';
import { URL } from 'url';
import ISourceCodeLocation from '../interfaces/ISourceCodeLocation';
import { SourceMapSupport } from './SourceMapSupport';

export default class SourceLoader {
  private static sourceLines: { [source: string]: string[] } = {};
  private static fileContentsCache: { [filepath: string]: string } = {};

  static resetCache(): void {
    this.sourceLines = {};
    this.fileContentsCache = {};
  }

  static clearFileCache(filepath: string): void {
    delete this.fileContentsCache[filepath];
  }

  static getSource(codeLocation: ISourceCodeLocation): ISourceCodeLocation & { code: string } {
    if (!codeLocation) return null;

    const sourcePosition = SourceMapSupport.getOriginalSourcePosition(codeLocation, true);
    console.log('sourcePosition', sourcePosition);

    const code = sourcePosition.content;
    if (!this.sourceLines[sourcePosition.source]) {
      const file = code || this.getFileContents(sourcePosition.source);
      console.log('filecontens', file);
      if (!file) return null;
      this.sourceLines[sourcePosition.source] = file.split(/\r?\n/);
    }

    (sourcePosition as any).code =
      this.sourceLines[sourcePosition.source][sourcePosition.line - 1];
    return sourcePosition as any;
  }

  static getFileContents(filepath: string, cache = true): string {
    const cacheKey = SourceMapSupport.getCacheKey(filepath);
    console.log('cacche key', cacheKey);
    if (cache && this.fileContentsCache[cacheKey]) return this.fileContentsCache[cacheKey];

    // Trim the path to make sure there is no extra whitespace.
    let lookupFilepath: string | URL = filepath.trim();
    if (filepath.startsWith('file://')) {
      lookupFilepath = new URL(filepath);
    }

    let data: string = null;
    try {
      data = fs.readFileSync(lookupFilepath, 'utf8');
    } catch (err) {
      // couldn't read
    }
    if (cache) {
      this.fileContentsCache[cacheKey] = data;
    }
    return data;
  }

  static setFileContents(filepath: string, data: string): void {
    const cacheKey = SourceMapSupport.getCacheKey(filepath);
    this.fileContentsCache[cacheKey] = data;
  }
}
