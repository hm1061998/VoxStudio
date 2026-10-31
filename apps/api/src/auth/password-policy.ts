import { ErrorCodes, VoxError } from '@voxstudio/contracts';

/**
 * Password rules beyond length: no very common passwords, no passwords built from the account's own email or name,
 * no trivially repeated or sequential strings. Length (10 to 200) is checked by the request schemas; the upper bound
 * also keeps the memory-hard hash from being used as a denial-of-service lever.
 */
const COMMON = new Set(
  [
    'password',
    'password1',
    'password12',
    'password123',
    'password1234',
    'passw0rd123',
    'p@ssw0rd123',
    'qwertyuiop',
    'qwerty123456',
    'qwertyuiop123',
    '1234567890',
    '12345678910',
    '123456789012',
    '0123456789',
    'abcdefghij',
    'abcd123456',
    'iloveyou123',
    'welcome123',
    'welcome1234',
    'admin12345',
    'administrator',
    'letmein123',
    'changeme123',
    'changeme1234',
    'trustno1234',
    'monkey12345',
    'dragon12345',
    'football123',
    'baseball123',
    'superman123',
    'sunshine123',
    'princess123',
    'whatever123',
    'zaq12wsxcde3',
    '1q2w3e4r5t',
    '1qaz2wsx3edc',
    'matkhau123',
    'matkhau1234',
    'matkhau12345',
    'vietnam1234',
    'vietnam12345',
    'voxstudio123',
    'voxstudio1234',
  ].map((p) => p.toLowerCase()),
);

type Reason = 'common' | 'repeat' | 'few-chars' | 'sequence' | 'personal' | 'same';
const bad = (reason: Reason, message: string): never => {
  throw new VoxError(ErrorCodes.PASSWORD_REJECTED, message, { field: 'password', reason });
};

const stripped = (s: string) =>
  s
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase();

export function assertPasswordAcceptable(
  password: string,
  context: { email: string; displayName: string },
): void {
  const p = password.toLowerCase();
  if (COMMON.has(p) || COMMON.has(p.replace(/[^a-z0-9]/g, '')))
    bad('common', 'This password is too common. Choose a longer, less predictable one.');
  if (/^(.)\1+$/.test(password)) bad('repeat', 'This password repeats one character.');
  if (new Set(password).size < 5) bad('few-chars', 'This password uses too few different characters.');
  const letters = p.replace(/[^a-z0-9]/g, '');
  const seq = 'abcdefghijklmnopqrstuvwxyz0123456789';
  if (letters.length >= 10 && (seq.includes(letters) || [...seq].reverse().join('').includes(letters)))
    bad('sequence', 'This password is a simple sequence.');
  const local = stripped(context.email.split('@')[0] ?? '');
  const name = stripped(context.displayName).replace(/\s+/g, '');
  const sp = stripped(password).replace(/\s+/g, '');
  if ((local.length >= 4 && sp.includes(local)) || (name.length >= 4 && sp.includes(name)))
    bad('personal', 'The password must not contain your email name or your display name.');
}
