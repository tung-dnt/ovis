import type { ConversationResponse } from "../../shared/protocol.ts";

/**
 * A chat's newest page as this device keeps it between page loads (api.ts, `saveConversation`): the answer the server
 * last sent for the page's URL, under the session it was read in. A row is only ever the server's own answer.
 */
export interface StoredConversation {
  url: string;
  /** `machine\0pane` */
  pane: string;
  /** the pane's session when it was read (api.ts `sessionNow`): another one is another conversation */
  session: string;
  etag: string;
  body: ConversationResponse;
  bytes: number;
  /** when it was read, ms since the epoch */
  saved: number;
}

export interface ConversationStore {
  all(): Promise<StoredConversation[]>;
  put(rows: readonly StoredConversation[]): Promise<void>;
  remove(urls: readonly string[]): Promise<void>;
  clear(): Promise<void>;
}

const DATABASE = "ovis-chat";
const STORE = "pages";

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => { request.result.createObjectStore(STORE); };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function transact<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => () => T): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const result = run(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(result());
      tx.onabort = () => reject(tx.error);
    });
  } finally { db.close(); }
}

/** A browser without IndexedDB (a private window that refuses it, a test runner) keeps nothing. */
export const indexedConversationStore: ConversationStore = {
  async all() {
    if (typeof indexedDB === "undefined") return [];
    return transact("readonly", (store) => {
      const request: IDBRequest<StoredConversation[]> = store.getAll();
      return () => request.result ?? [];
    });
  },
  async put(rows) {
    if (typeof indexedDB === "undefined" || rows.length === 0) return;
    await transact("readwrite", (store) => {
      for (const row of rows) store.put(row, row.url);
      return () => undefined;
    });
  },
  async remove(urls) {
    if (typeof indexedDB === "undefined" || urls.length === 0) return;
    await transact("readwrite", (store) => {
      for (const url of urls) store.delete(url);
      return () => undefined;
    });
  },
  async clear() {
    if (typeof indexedDB === "undefined") return;
    await transact("readwrite", (store) => {
      store.clear();
      return () => undefined;
    });
  },
};
