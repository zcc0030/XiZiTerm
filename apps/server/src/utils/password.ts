import crypto from 'crypto';

const SCRYPT_KEYLEN = 64;
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 };

export function hashServerPassword(password: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(16).toString('base64');
    crypto.scrypt(password, salt, SCRYPT_KEYLEN, SCRYPT_PARAMS, (err, key) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(`scrypt$${salt}$${key.toString('base64')}`);
    });
  });
}

export function verifyServerPassword(
  password: string,
  storedHash: string
): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const parts = storedHash.split('$');
    if (parts.length !== 3 || parts[0] !== 'scrypt') {
      resolve(false);
      return;
    }
    const [, salt, hashB64] = parts;
    const expected = Buffer.from(hashB64, 'base64');
    crypto.scrypt(password, salt, expected.length, SCRYPT_PARAMS, (err, key) => {
      if (err) {
        reject(err);
        return;
      }
      if (key.length !== expected.length) {
        resolve(false);
        return;
      }
      resolve(crypto.timingSafeEqual(key, expected));
    });
  });
}

export function generateBearerToken(): string {
  return `nt_${crypto.randomBytes(36).toString('base64url')}`;
}

export function sha256Hex(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}
