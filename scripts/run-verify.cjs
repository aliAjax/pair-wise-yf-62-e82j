// 通过 typescript API 将 TS 用例转译为 JS 后执行（仅用于本地验证）
const ts = require('typescript');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');

function loadTs(relative) {
  const file = path.join(root, relative);
  const source = fs.readFileSync(file, 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName: file,
  });
  const moduleExports = { exports: {} };
  const dirname = path.dirname(file);
  const localRequire = (spec) => {
    if (spec.startsWith('.')) {
      const target = path.resolve(dirname, spec);
      return loadTs(path.relative(root, target) + (target.endsWith('.ts') ? '' : '.ts'));
    }
    return require(spec);
  };
  const context = { module: moduleExports, exports: moduleExports.exports, require: localRequire, process, console, structuredClone, crypto: require('crypto').webcrypto, __dirname: dirname };
  vm.runInNewContext(outputText, context, { filename: file });
  return moduleExports.exports;
}

loadTs('scripts/verify-merge.ts');
