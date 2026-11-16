// Local debug integrity record. CI NSIS provenance remains the installer authority.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';

const [exePath, outputPath] = process.argv.slice(2);
if (!exePath || !outputPath) throw new Error('Usage: node scripts/grand-candidate-manifest.mjs <debug.exe> <manifest.json>');
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const sourceSha = git('rev-parse', 'HEAD');
if (!/^[a-f0-9]{40}$/.test(sourceSha)) throw new Error('Full source SHA required');
if (git('status', '--porcelain')) throw new Error('Candidate manifest requires a clean source checkout');
const bytes = readFileSync(exePath);
if (bytes.subarray(0, 2).toString() !== 'MZ' || !bytes.includes(Buffer.from(sourceSha))) {
  throw new Error('Candidate is not a PE containing the current embedded source SHA');
}
const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
writeFileSync(outputPath, JSON.stringify({
  schemaVersion: 1, version, sourceSha, sourceDirty: false,
  buildType: 'local-debug-no-bundle', createdAt: new Date().toISOString(),
  artifact: { name: basename(exePath), sizeBytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') },
  signatureVerified: false, computerUseVerified: false, hardwareAccepted: false,
  limitations: ['Integrity record only; not a signature or CI attestation.', 'Shares installation data and single-instance identity.', 'Installation and stable release are not authorized.'],
}, null, 2) + '\n');
