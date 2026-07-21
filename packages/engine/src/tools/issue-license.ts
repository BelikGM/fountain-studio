import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LicenseFile, LicensePayload } from '@fountain-studio/shared';
import { canonicalPayload } from '../license';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Инструмент вендора для выпуска лицензий (§27 доработки) — НЕ входит в
 * собираемое приложение, запускается вручную разработчиком/продавцом:
 *
 *   npx tsx src/tools/issue-license.ts keygen
 *   npx tsx src/tools/issue-license.ts issue --machine <id> --name "ООО Ромашка" --duration year
 *   npx tsx src/tools/issue-license.ts issue --machine <id> --name "ООО Ромашка" --duration forever --out license.json
 *
 * Приватный ключ — license-keys/private.pem рядом с этим пакетом (см.
 * .gitignore — никогда не в репозитории). «machine» — отпечаток компьютера
 * покупателя, показывается ему в приложении в панели активации лицензии;
 * его нужно получить от покупателя (письмом/сообщением) перед выпуском.
 */

const KEY_DIR = path.join(__dirname, '..', '..', 'license-keys');
const PRIVATE_KEY_FILE = path.join(KEY_DIR, 'private.pem');

function keygen(): void {
  if (fs.existsSync(PRIVATE_KEY_FILE)) {
    console.error(`Уже есть приватный ключ: ${PRIVATE_KEY_FILE}. Удалите вручную, если точно хотите заменить —`);
    console.error('старые лицензии перестанут проверяться новым публичным ключом.');
    process.exit(1);
  }
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  fs.mkdirSync(KEY_DIR, { recursive: true });
  fs.writeFileSync(PRIVATE_KEY_FILE, privateKey.export({ type: 'pkcs8', format: 'pem' }), 'utf8');
  console.log(`Приватный ключ сохранён: ${PRIVATE_KEY_FILE} (храните в секрете, не коммитьте)`);
  console.log('\nПубличный ключ — вставьте в PUBLIC_KEY_PEM в packages/engine/src/license.ts:\n');
  console.log(publicKey.export({ type: 'spki', format: 'pem' }).toString());
}

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i]!.startsWith('--')) {
      const key = argv[i]!.slice(2);
      out[key] = argv[i + 1] ?? '';
      i++;
    }
  }
  return out;
}

function issue(argv: string[]): void {
  const args = parseArgs(argv);
  const machineId = args.machine;
  const licenseeName = args.name;
  const duration = args.duration; // 'year' | 'forever'
  if (!machineId || !licenseeName || !duration) {
    console.error('Нужны --machine <id> --name "<имя>" --duration <year|forever>');
    process.exit(1);
  }
  if (!fs.existsSync(PRIVATE_KEY_FILE)) {
    console.error(`Нет приватного ключа (${PRIVATE_KEY_FILE}) — сначала: npx tsx src/tools/issue-license.ts keygen`);
    process.exit(1);
  }
  const privateKey = crypto.createPrivateKey(fs.readFileSync(PRIVATE_KEY_FILE, 'utf8'));
  const issuedAt = new Date();
  const expiresAt =
    duration === 'forever'
      ? null
      : duration === 'year'
        ? new Date(issuedAt.getTime() + 365 * 24 * 3600 * 1000).toISOString()
        : (() => {
            console.error('--duration должен быть "year" или "forever"');
            process.exit(1);
          })();
  const payload: LicensePayload = {
    licenseeName,
    machineId,
    issuedAt: issuedAt.toISOString(),
    expiresAt: expiresAt ?? null,
  };
  const signature = crypto.sign(null, canonicalPayload(payload), privateKey).toString('base64');
  const file: LicenseFile = { payload, signature };
  const out = args.out ?? `license-${licenseeName.replace(/[^\p{L}\p{N}_-]+/gu, '_')}.json`;
  fs.writeFileSync(out, JSON.stringify(file, null, 2), 'utf8');
  console.log(`Лицензия выпущена: ${out}`);
  console.log(`  получатель: ${licenseeName}`);
  console.log(`  компьютер:  ${machineId}`);
  console.log(`  срок:       ${expiresAt ?? 'бессрочно'}`);
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === 'keygen') keygen();
else if (cmd === 'issue') issue(rest);
else {
  console.log('Использование:');
  console.log('  npx tsx src/tools/issue-license.ts keygen');
  console.log('  npx tsx src/tools/issue-license.ts issue --machine <id> --name "<имя>" --duration <year|forever> [--out <файл>]');
  process.exit(1);
}
