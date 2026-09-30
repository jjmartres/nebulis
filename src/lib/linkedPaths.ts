/** Files from a linked folder carry this prefix on their library path (`@src/<sourceId>/...`).
 *  Deleting one removes the user's own original from disk, so callers word the confirmation differently. */
export const isLinkedPath = (path: string): boolean => path.startsWith('@src/');
