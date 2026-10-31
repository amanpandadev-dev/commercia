// Makes a `.env` file with a fresh secret key, if there is none, and keeps other people on this computer out of it.
//   npm run init-env
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const file = path.resolve('.env');
if (fs.existsSync(file)) {
  console.log('  .env already exists: left as it is.');
  process.exit(0);
}
const key = crypto.randomBytes(32).toString('hex');
fs.writeFileSync(
  file,
  `# Made by "npm run init-env". Keep this file private and keep a copy of it somewhere safe (not in the backup folder):\n# without the key, backups cannot be opened. See .env.example for the other settings.\nCOMMERCIA_SECRET_KEY=${key}\n`,
  { mode: 0o600 },
);
if (process.platform === 'win32') {
  // Only the signed-in Windows user may read or change it.
  try {
    execFileSync('icacls', [file, '/inheritance:r', '/grant:r', `${process.env.USERNAME}:(R,W)`], { stdio: 'ignore' });
  } catch {
    console.log('  Could not restrict the .env file to your Windows user. Do it in the file\'s Properties > Security.');
  }
} else fs.chmodSync(file, 0o600);
console.log('  Created .env with a new secret key. Keep a copy of that file somewhere safe.');
