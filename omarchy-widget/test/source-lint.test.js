import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const pluginDir = fileURLToPath(new URL('../plugin/', import.meta.url));

// Every .js in plugin/ is loaded by QML as a script resource, so all of them live under the same
// syntax subset -- not just the one file this test used to name. Discovering them from disk means a
// new model file is covered the day it lands, rather than the day someone remembers to list it.
const modelFiles = readdirSync(pluginDir)
  .filter((name) => name.endsWith('.js'))
  .sort();

// Strips comments before linting: only real code is a syntax-subset violation, not prose mentioning it.
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

test('plugin/ contains the QML script resources this lint expects to cover', () => {
  // A rename or a move that empties the glob would turn every check below into a silent no-op.
  assert.ok(modelFiles.length >= 4, `expected several model files, found ${modelFiles.join(', ')}`);
  assert.ok(modelFiles.includes('CalendarModel.js'));
  assert.ok(modelFiles.includes('TaskModel.js'));
});

for (const name of modelFiles) {
  test(`${name} stays within the QML JavaScript resource syntax subset`, () => {
    const code = stripComments(readFileSync(new URL(name, `file://${pluginDir}`), 'utf8'));

    assert.doesNotMatch(code, /\bimport\b/, 'no import statements (QML script resource style)');
    assert.doesNotMatch(code, /\bexport\b/, 'no export statements');
    assert.doesNotMatch(code, /\brequire\s*\(/, 'no require(...)');
    assert.doesNotMatch(code, /\bclass\s+\w/, 'no class declarations');
    assert.doesNotMatch(code, /Date\.now\s*\(/, 'no Date.now() -- callers pass nowMs');
    assert.doesNotMatch(
      code,
      /new\s+Date\s*\(\s*\)/,
      'no argument-less new Date() -- callers pass nowMs'
    );
    assert.doesNotMatch(code, /\bIntl\./, 'no Intl');
    assert.doesNotMatch(code, /\.toLocale\w*/, 'no toLocale*');
  });
}
