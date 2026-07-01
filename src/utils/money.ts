const MONEY_DECIMAL_PATTERN = /^-?\d+(?:\.(\d+))?$/;

const normalizeMinorInput = (value: bigint | string) => {
  if (typeof value === 'bigint') {
    return value;
  }

  const trimmed = value.trim();
  if (!/^-?\d+$/.test(trimmed)) {
    throw new Error('Invalid minor-unit amount');
  }

  return BigInt(trimmed);
};

export const minorUnitsToDecimalString = (value: bigint | string, scale = 2) => {
  const minor = normalizeMinorInput(value);
  const negative = minor < 0n;
  const absolute = negative ? -minor : minor;
  const digits = absolute.toString().padStart(scale + 1, '0');
  const decimalIndex = digits.length - scale;
  const whole = digits.slice(0, decimalIndex);
  const fraction = scale > 0 ? digits.slice(decimalIndex) : '';
  const formatted = scale > 0 ? `${whole}.${fraction}` : whole;
  return negative ? `-${formatted}` : formatted;
};

export const truncateDecimalStringToBigInt = (value: string) => {
  const trimmed = value.trim();
  const match = trimmed.match(MONEY_DECIMAL_PATTERN);
  if (!match) {
    throw new Error('Invalid decimal amount');
  }

  const wholePart = trimmed.split('.')[0] ?? '0';
  return BigInt(wholePart);
};

export const minorUnitsToSafeNumber = (value: bigint | string) => {
  const minor = normalizeMinorInput(value);
  const asNumber = Number(minor);
  if (!Number.isSafeInteger(asNumber)) {
    throw new Error('Amount exceeds JavaScript safe integer range');
  }
  return asNumber;
};
