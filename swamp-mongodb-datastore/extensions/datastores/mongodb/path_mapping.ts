// Local/remote path mapping for swamp core's giga-swamp namespaces.
//
// Core lays the datastore tier out as `{cache}/{namespace}/data/...` when
// `datastore.namespace` is set and `{cache}/data/...` otherwise
// (DefaultDatastorePathResolver). The remote id is always tier-relative —
// `data/...` — so a client without a core namespace (serve, today) and a
// client with one (the Mac) read and write the same documents.
//
// Only core's namespace (`options.namespace` on every sync call) drives this
// mapping. The extension's own `config.namespace` selects the collection
// prefix and must never influence the filesystem layout: the two are set
// independently and one of them is routinely unset.

/** Cache-relative local path for a tier-relative remote path. */
export function localRel(remoteRel: string, namespace?: string): string {
  return namespace ? `${namespace}/${remoteRel}` : remoteRel;
}

/**
 * Tier-relative remote id for a cache-relative local path. A path that does
 * not carry the namespace prefix is returned unchanged, which is what a
 * client without a core namespace produces.
 */
export function remoteRel(localRelPath: string, namespace?: string): string {
  return stripLegacyPrefix(localRelPath, namespace);
}

/**
 * Removes exactly one leading `<namespace>/` from a remote id. Older
 * versions stored the cache-relative path (including the namespace) as the
 * remote id; pull tolerates those until fold_namespace_prefix retires them.
 */
export function stripLegacyPrefix(
  remoteId: string,
  namespace?: string,
): string {
  if (!namespace) return remoteId;
  const prefix = `${namespace}/`;
  return remoteId.startsWith(prefix) ? remoteId.slice(prefix.length) : remoteId;
}

/** True when a remote id carries the legacy namespace prefix. */
export function hasLegacyPrefix(remoteId: string, namespace?: string): boolean {
  return namespace !== undefined && namespace !== "" &&
    remoteId.startsWith(`${namespace}/`);
}
