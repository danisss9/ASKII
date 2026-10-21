// Fails when the extension and CLI versions differ, or when a release tag
// (passed as the first argument, e.g. "askii_1.0.0" or "1.0.0") does not
// match them. Used by CI and the release workflow.
const path = require('path');

const root = require(path.join(__dirname, '..', 'package.json')).version;
const cli = require(path.join(__dirname, '..', 'cli', 'package.json')).version;
const tag = process.argv[2]?.replace(/^askii_/, '').replace(/^v/, '');

const problems = [];
if (root !== cli) {
  problems.push(`package.json is ${root} but cli/package.json is ${cli}`);
}
if (tag && tag !== root) {
  problems.push(`tag version ${tag} does not match package.json ${root}`);
}

if (problems.length > 0) {
  for (const problem of problems) {
    console.error(`✘ ${problem}`);
  }
  process.exit(1);
}
console.log(`✔ versions match: ${root}${tag ? ` (tag ${tag})` : ''}`);
