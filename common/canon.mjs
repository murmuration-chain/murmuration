// Canonical JSON (spec/protocol.md "State", spec/signing.md "Canonical transaction bytes").
//
// Rules (implement identically in any language):
//   * Output is a JSON text, encoded as UTF-8 by the caller (see canonicalBytes).
//   * Object keys are sorted ascending by the UTF-8 byte sequence of the key (== Unicode
//     code point order). Applied recursively. Arrays keep their order.
//   * No insignificant whitespace anywhere.
//   * Strings use the minimal JSON escaping of ECMAScript JSON.stringify: `"` `\` and the
//     control characters U+0000..U+001F are escaped (\b \t \n \f \r short forms, others as
//     \u00xx lowercase hex); everything else, including non-ASCII, is emitted raw.
//   * Numbers: integers are written as plain decimal digits (no exponent, no ".0", no "+").
//     Non-integers (only used for fractional params like quorum/threshold) use the shortest
//     round-trip decimal form (ECMAScript Number::toString). NaN/Infinity/exponent forms are
//     rejected, as are `undefined`, functions, bigint, etc.
//   * true / false / null as usual.

const enc = new TextEncoder();

function cmpUtf8(a, b) {
  const x = enc.encode(a);
  const y = enc.encode(b);
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return x.length - y.length;
}

function numberToCanonical(n) {
  if (!Number.isFinite(n)) throw new TypeError('canonicalJson: non-finite number');
  if (Number.isInteger(n) && !Number.isSafeInteger(n)) {
    throw new TypeError('canonicalJson: integer outside safe range');
  }
  const s = String(n); // -0 -> "0"
  if (/e/i.test(s)) throw new TypeError('canonicalJson: exponent form not allowed: ' + s);
  return s;
}

export function canonicalJson(value) {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      return numberToCanonical(value);
    case 'object': {
      if (Array.isArray(value)) {
        return '[' + value.map((v) => canonicalJson(v)).join(',') + ']';
      }
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) {
        throw new TypeError('canonicalJson: only plain objects are allowed');
      }
      const keys = Object.keys(value).sort(cmpUtf8);
      return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(value[k])).join(',') + '}';
    }
    default:
      throw new TypeError('canonicalJson: unsupported type ' + typeof value);
  }
}

export function canonicalBytes(value) {
  return enc.encode(canonicalJson(value));
}
