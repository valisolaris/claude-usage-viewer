import * as path from 'node:path';
import * as fs from 'node:fs';
import Mocha from 'mocha';

/**
 * `@vscode/test-electron` 経由のExtension Development Host統合テスト用エントリ。
 * Round3(1往復)で実装。このディレクトリ配下の`*.test.js`(コンパイル済み)を
 * すべてMochaに読み込ませて実行する。`glob`パッケージは使わず`fs.readdirSync`で
 * 済ませ、依存を増やさない。
 */
export function run(): Promise<void> {
  const mocha = new Mocha({ ui: 'tdd', color: false, timeout: 20_000 });
  const testsRoot = path.resolve(__dirname);

  return new Promise((resolve, reject) => {
    const files = fs.readdirSync(testsRoot).filter((f) => f.endsWith('.test.js'));
    for (const file of files) {
      mocha.addFile(path.join(testsRoot, file));
    }
    try {
      mocha.run((failures) => {
        if (failures > 0) {
          reject(new Error(`${failures} test(s) failed.`));
        } else {
          resolve();
        }
      });
    } catch (err) {
      reject(err as Error);
    }
  });
}
