import { useEffect, useState } from "react";
import { resolveStorageScanUrl, storageFileInfoUrl } from "./contract.js";

/**
 * The best available 0G Storage evidence URL for a committed merkle `root`.
 *
 * It resolves in two steps so the link is NEVER a dead 404 (the bug this replaces: StorageScan has no
 * `/files/info?cid=` route, and its real file page is keyed by upload tx-sequence, not root):
 *   1. Immediately return the Turbo indexer's `/file/info/<root>` endpoint — addressed by root, always
 *      valid, and itself proof the bytes are stored + finalized under this exact root.
 *   2. In the background, resolve the root to StorageScan's human-readable `/submission/<seq>` page and
 *      upgrade to it once known. If the upload isn't indexed yet, we simply keep the direct link.
 *
 * Pass "" (or a zero root) to no-op — the hook does no fetch and returns "". Callers only render the
 * link when the root is actually present, so the empty return is never used.
 */
export function useStorageLink(root: string): string {
  const [url, setUrl] = useState(() => (root ? storageFileInfoUrl(root) : ""));
  useEffect(() => {
    if (!root) {
      setUrl("");
      return;
    }
    let alive = true;
    setUrl(storageFileInfoUrl(root)); // reset to the always-valid link whenever the root changes
    resolveStorageScanUrl(root).then((pretty) => {
      if (alive && pretty) setUrl(pretty);
    });
    return () => {
      alive = false;
    };
  }, [root]);
  return url;
}
