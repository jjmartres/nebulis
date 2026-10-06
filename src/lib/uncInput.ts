/**
 * Reading a share address the way a person writes one.
 *
 * Everybody who knows what a UNC path is types `\\192.168.1.12\Nebulis2`, and the form
 * collects a server and a share in two fields. Refusing the paste with "that address
 * contains characters that cannot be used" is technically correct and useless: the
 * address is fine, it is the field that is wrong. So the two fields accept what a person
 * pastes and split it themselves.
 *
 * The split is deliberately conservative. A value with no separator is a server and
 * nothing else, so typing `nas.local` or `192.168.1.12` is left alone, and the callers
 * only apply the result when the input actually looked like a path.
 */

export interface ParsedShareAddress {
  /** Server name or IP, possibly with `:port`. Never carries a leading separator. */
  host: string;
  /** Share name, or '' when only a server was given. */
  share: string;
  /** Folder inside the share, posix-separated, or '' when none was given. */
  subpath: string;
}

/** Whether a value looks like a pasted address rather than a bare server name. */
export function looksLikeShareAddress(raw: string): boolean {
  return /[\\/]/.test(raw.trim());
}

/**
 * Split `\\host\share\sub`, `//host/share/sub`, `host\share` or `host` into the fields
 * the form collects. Returns null for an empty value, and for one that is only
 * separators, so a caller never has to guess whether there was an address at all.
 */
export function parseShareAddress(raw: string): ParsedShareAddress | null {
  const trimmed = raw.trim().replace(/^[\\/]+/, '');
  if (trimmed === '') return null;

  const parts = trimmed.split(/[\\/]+/).filter(part => part !== '');
  if (parts.length === 0) return null;

  return {
    host: parts[0],
    share: parts[1] ?? '',
    subpath: parts.slice(2).join('/'),
  };
}
