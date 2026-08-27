/**
 * Generates a DASHBOARD_PASSWORD_HASH value.
 *
 *   npm run hash-password -- 'my dashboard password'
 */
import { hashPassword } from '../infrastructure/security/password.js';

const password = process.argv[2];

if (!password) {
  console.error("Usage: npm run hash-password -- '<password>'");
  process.exit(1);
}

if (password.length < 10) {
  console.error('Refusing to hash a password shorter than 10 characters.');
  process.exit(1);
}

const hash = await hashPassword(password);
console.log(`DASHBOARD_PASSWORD_HASH=${hash}`);
