type CacheProgress = {
  loaded: number;
  total: number | null;
};

const pending = new Map<string, Promise<File | Blob>>();
const memoryFallback = new Map<string, Blob>();

type IterableDirectoryHandle = FileSystemDirectoryHandle & {
  keys(): AsyncIterableIterator<string>;
};

function safeName(key: string) {
  let hash = 2166136261;
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  const stem = key.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-90);
  return `${stem}-${(hash >>> 0).toString(16)}.media`;
}

async function mediaDirectory(): Promise<IterableDirectoryHandle | null> {
  if (typeof navigator === "undefined" || !navigator.storage) return null;
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(
    "reelforge-media-v1",
    { create: true }
  ) as Promise<IterableDirectoryHandle>;
}

async function existingFile(key: string): Promise<File | null> {
  try {
    const directory = await mediaDirectory();
    if (!directory) return null;
    const handle = await directory.getFileHandle(safeName(key));
    const file = await handle.getFile();
    return file.size > 0 ? file : null;
  } catch {
    return null;
  }
}

async function downloadToCache(
  key: string,
  url?: string,
  onProgress?: (progress: CacheProgress) => void
): Promise<File | Blob> {
  const local = await existingFile(key);
  if (local) {
    onProgress?.({ loaded: local.size, total: local.size });
    return local;
  }

  const memory = memoryFallback.get(key);
  if (memory) return memory;

  if (!url) {
    throw new Error("Media is not cached and no download URL is available.");
  }

  const response = await fetch(url, { cache: "force-cache" });
  if (!response.ok) throw new Error(`Media download failed (${response.status}).`);
  const totalHeader = response.headers.get("content-length");
  const total = totalHeader ? Number(totalHeader) : null;
  const directory = await mediaDirectory().catch(() => null);

  if (directory && response.body) {
    const memoryResponse = response.clone();
    try {
      const handle = await directory.getFileHandle(safeName(key), { create: true });
      const writable = await handle.createWritable();
      const reader = response.body.getReader();
      let loaded = 0;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        await writable.write(value);
        loaded += value.byteLength;
        onProgress?.({ loaded, total });
      }
      await writable.close();
      const file = await handle.getFile();
      if (!file.size) throw new Error("Cached media file is empty.");
      return file;
    } catch (error) {
      try {
        await directory.removeEntry(safeName(key));
      } catch {}
      const blob = await memoryResponse.blob();
      if (!blob.size) throw error;
      memoryFallback.set(key, blob);
      onProgress?.({ loaded: blob.size, total: blob.size });
      return blob;
    }
  }

  const blob = await response.blob();
  memoryFallback.set(key, blob);
  onProgress?.({ loaded: blob.size, total: blob.size });
  return blob;
}

export function getCachedMedia(
  key: string,
  url?: string,
  onProgress?: (progress: CacheProgress) => void
) {
  const current = pending.get(key);
  if (current) return current;
  const task = downloadToCache(key, url, onProgress).finally(() => pending.delete(key));
  pending.set(key, task);
  return task;
}

export async function getEditorStorageEstimate() {
  if (typeof navigator === "undefined" || !navigator.storage?.estimate) {
    return { usage: 0, quota: 0 };
  }
  const estimate = await navigator.storage.estimate();
  return {
    usage: estimate.usage ?? 0,
    quota: estimate.quota ?? 0,
  };
}

export async function clearEditorMediaCache() {
  memoryFallback.clear();
  pending.clear();
  const directory = await mediaDirectory().catch(() => null);
  if (!directory) return;
  for await (const name of directory.keys()) {
    await directory.removeEntry(name).catch(() => {});
  }
}
