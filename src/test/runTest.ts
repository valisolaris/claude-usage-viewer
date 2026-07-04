import * as path from 'node:path';
import { runTests } from '@vscode/test-electron';

/**
 * `@vscode/test-electron` によるExtension Development Host統合テストのランナー。
 * Round3(1往復)で実装・実行。`npm run test:e2e`から呼ばれる
 * (先に`npm run compile`でextension.js本体、`tsc -p tsconfig.e2e.json`で
 * このファイルとsuite/配下をコンパイル済みであることが前提)。
 */
async function main(): Promise<void> {
  const extensionDevelopmentPath = path.resolve(__dirname, '../../');
  const extensionTestsPath = path.resolve(__dirname, './suite/index');

  await runTests({ extensionDevelopmentPath, extensionTestsPath });
}

main().catch((err) => {
  console.error('Failed to run integration tests');
  console.error(err);
  process.exit(1);
});
