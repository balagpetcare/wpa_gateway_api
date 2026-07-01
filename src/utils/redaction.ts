const SENSITIVE_KEY_PATTERNS = [
  'password',
  'secret',
  'token',
  'accesstoken',
  'refreshtoken',
  'apikey',
  'clientsecret',
  'authorization',
  'cookie',
  'signature',
  'xsignature',
  'privatekey',
  'publickey',
  'bearer',
  'credential',
  'encryptedsecrets',
  'accountnumber',
  'mobilenumber',
  'walletid'
];

const ACCOUNT_KEY_PATTERNS = ['accountnumber', 'mobilenumber', 'walletid'];
const SENSITIVE_VALUE_PATTERNS = [/bearer\s+[a-z0-9\-._~+/]+=*/i, /basic\s+[a-z0-9\-._~+/]+=*/i];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const normalizeKey = (key: string) => key.replace(/[^a-z0-9]/gi, '').toLowerCase();

const isSensitiveKey = (key: string) => {
  const normalized = normalizeKey(key);
  return SENSITIVE_KEY_PATTERNS.some((pattern) => normalized.includes(pattern));
};

const isAccountLikeKey = (key: string) => {
  const normalized = normalizeKey(key);
  return ACCOUNT_KEY_PATTERNS.some((pattern) => normalized.includes(pattern));
};

const maskValue = (value: string) => {
  if (value.length <= 4) return '***REDACTED***';
  return `${value.slice(0, 2)}***${value.slice(-2)}`;
};

const redactString = (key: string | null, value: string) => {
  if (key && isSensitiveKey(key)) {
    return isAccountLikeKey(key) ? maskValue(value) : '***REDACTED***';
  }

  if (SENSITIVE_VALUE_PATTERNS.some((pattern) => pattern.test(value))) {
    return '***REDACTED***';
  }

  return value;
};

export const redactSensitiveData = (value: unknown, key: string | null = null): unknown => {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactString(key, value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();

  if (Array.isArray(value)) {
    return value.map((entry) => redactSensitiveData(entry));
  }

  if (isRecord(value)) {
    const result: Record<string, unknown> = {};
    for (const [entryKey, entryValue] of Object.entries(value)) {
      if (isSensitiveKey(entryKey)) {
        result[entryKey] =
          typeof entryValue === 'string' && isAccountLikeKey(entryKey) ? maskValue(entryValue) : '***REDACTED***';
        continue;
      }

      result[entryKey] = redactSensitiveData(entryValue, entryKey);
    }
    return result;
  }

  return value;
};
