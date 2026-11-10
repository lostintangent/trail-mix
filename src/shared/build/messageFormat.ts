/**
 * A drop-in for the slice of `intl-messageformat` that Astryx's shipped messages use:
 * plain `{name}` and `{name, number}` arguments. The build refuses any reachable message
 * that needs more, so this can't silently mis-format.
 */
const ARGUMENT = /\{\s*(\w+)\s*(?:,\s*(number)\s*)?\}/g;

export function isSimpleMessage(message: string): boolean {
  const rest = message.replace(ARGUMENT, '');
  return !/[{}]/.test(rest) && !/'['{}]/.test(message);
}

export default class MessageFormat {
  readonly #message: string;
  readonly #locale: string;

  constructor(message: string, locale: string) {
    this.#message = message;
    this.#locale = locale;
  }

  format(values: Readonly<Record<string, unknown>> = {}): string {
    return this.#message.replace(ARGUMENT, (_, name: string, type?: string) => {
      const value = values[name];
      if (type === 'number') return new Intl.NumberFormat(this.#locale).format(Number(value));
      if (typeof value === 'string') return value;
      return typeof value === 'number' || typeof value === 'boolean' ? String(value) : '';
    });
  }
}
