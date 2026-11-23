import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { ApiError, CONVERSATION_ANSWERS_KEPT, CONVERSATION_RESTORED_EVENT, STORED_CONVERSATION_MS, fetchPaneConversation, flushConversations, forgetStoredConversations, observePaneSessions, paneSessionEvents, peekPaneConversation, setConversationStore } from "./api.ts";
import { indexedConversationStore, type ConversationStore, type StoredConversation } from "./conversationStore.ts";
import { fakeIndexedDB } from "./indexedDB.fake.ts";
import type { ConversationResponse } from "../../shared/protocol.ts";

const realFetch = globalThis.fetch;
const globals = globalThis as unknown as { window?: unknown; indexedDB?: unknown };
const realWindow = globals.window;

type MemoryStore = ConversationStore & { rows: Map<string, StoredConversation> };

/** What IndexedDB would hold, readable by the test. */
function memoryStore(): MemoryStore {
  const rows = new Map<string, StoredConversation>();
  return {
    rows,
    all: async () => [...rows.values()].map((row) => structuredClone(row)),
    put: async (written) => { for (const row of written) rows.set(row.url, structuredClone(row)); },
    remove: async (urls) => { for (const url of urls) rows.delete(url); },
    clear: async () => { rows.clear(); },
  };
}

function named(sessions: Record<string, string | null>): void {
  observePaneSessions([{ id: "local", snapshot: { panes: Object.entries(sessions).map(([pane_id, value]) => ({ pane_id, agent: "claude", agent_session: value === null ? null : { agent: "claude", kind: "id", source: "herdr:claude", value } })) } }], paneSessionEvents());
}

// restoring and forgetting run behind the roster and the read with no promise to await: drain the task queue, no wall-clock wait
const settled = async (): Promise<void> => { for (let turn = 0; turn < 10; turn++) await new Promise((resolve) => setTimeout(resolve, 0)); };

/** The server: a transcript per pane, answered 304 to the ETag it last sent. */
function serve(source = "claude-transcript"): { sent: { pane: string; etag: string | null }[]; turns: Map<string, string> } {
  const sent: { pane: string; etag: string | null }[] = [];
  const turns = new Map<string, string>();
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const pane = new URL(url, "http://fixture").searchParams.get("pane_id")!;
    const etag = new Headers(init?.headers).get("if-none-match");
    sent.push({ pane, etag });
    const text = turns.get(pane) ?? "hello";
    if (etag === `"${pane}:${text}"`) return new Response(null, { status: 304 });
    if (text === "409") return Response.json({ error: { code: "history_changed", message: "rewritten" } }, { status: 409 });
    return Response.json({ source, history_id: `${pane}-history`, cursor: null, turns: [{ role: "assistant", text }] }, { headers: { etag: `"${pane}:${text}"` } });
  }) as typeof fetch;
  return { sent, turns };
}

/** A cold start: the page's memory is gone, and what this device kept is read again. */
async function coldStart(store: MemoryStore): Promise<void> {
  const kept = new Map(store.rows);
  await forgetStoredConversations();
  for (const [url, row] of kept) store.rows.set(url, row);
  setConversationStore(store);
}

let store: MemoryStore;
beforeEach(() => {
  store = memoryStore();
  setConversationStore(store);
});
afterEach(async () => {
  globalThis.fetch = realFetch;
  globals.window = realWindow;
  await forgetStoredConversations();
  setConversationStore(indexedConversationStore);
  observePaneSessions([{ id: "local", snapshot: { panes: [] } }], paneSessionEvents());
});

describe("chat pages kept on this device", () => {
  it("paints a cold start from the kept page, and the chat's read comes back a 304", async () => {
    const server = serve();
    named({ p1: "s1" });
    const read = await fetchPaneConversation("p1", "local", { prompts: 10 });
    await flushConversations();
    expect([...store.rows.values()]).toMatchObject([{ pane: "local\u0000p1", etag: "\"p1:hello\"", body: read }]);

    await coldStart(store);
    expect(peekPaneConversation("p1", "local", 10)).toBeUndefined();
    const restored: string[] = [];
    const window = new EventTarget();
    window.addEventListener(CONVERSATION_RESTORED_EVENT, (event) => restored.push((event as CustomEvent<string>).detail));
    globals.window = window;
    named({ p1: "s1" });
    await settled();
    const painted = peekPaneConversation("p1", "local", 10);
    expect(painted).toEqual(read);
    expect(restored).toEqual(["local\u0000p1"]);
    expect(await fetchPaneConversation("p1", "local", { prompts: 10 })).toBe(painted!);
    expect(server.sent.at(-1)).toEqual({ pane: "p1", etag: "\"p1:hello\"" });
  });

  it("drops a kept page once its pane closes, its session changes or a day has passed", async () => {
    serve();
    named({ p1: "s1", p2: "s2", p3: "s3" });
    for (const pane of ["p1", "p2", "p3"]) await fetchPaneConversation(pane, "local", { prompts: 10 });
    await flushConversations();
    const p3 = [...store.rows.values()].find((row) => row.pane === "local\u0000p3")!;
    store.rows.set(p3.url, { ...p3, saved: Date.now() - STORED_CONVERSATION_MS - 1 });

    await coldStart(store);
    // p1 is gone from the roster, p2 runs another conversation
    named({ p2: "another", p3: "s3" });
    await settled();
    expect(store.rows.size).toBe(0);
    expect([peekPaneConversation("p1", "local", 10), peekPaneConversation("p2", "local", 10), peekPaneConversation("p3", "local", 10)]).toEqual([undefined, undefined, undefined]);
  });

  it("keeps a named session's own transcript alone", async () => {
    serve("scrollback");
    named({ p1: "s1", p2: null });
    await fetchPaneConversation("p1", "local", { prompts: 10 });
    serve();
    await fetchPaneConversation("p2", "local", { prompts: 10 });
    // an older page, read past a cursor
    named({ p1: "s1", p2: null, p3: "s3" });
    await fetchPaneConversation("p3", "local", { prompts: 10, before: "cursor-1" });
    await flushConversations();
    expect(store.rows.size).toBe(0);
  });

  it("forgets a pane's kept page when the server says its history changed", async () => {
    const server = serve();
    named({ p1: "s1" });
    await fetchPaneConversation("p1", "local", { prompts: 10 });
    await flushConversations();
    expect(store.rows.size).toBe(1);
    server.turns.set("p1", "409");
    await expect(fetchPaneConversation("p1", "local", { prompts: 10, fresh: true })).rejects.toBeInstanceOf(ApiError);
    await settled();
    expect(store.rows.size).toBe(0);
  });

  it("keeps as many pages as the in-memory cache, the oldest going first", async () => {
    serve();
    const sessions = Object.fromEntries(Array.from({ length: CONVERSATION_ANSWERS_KEPT + 2 }, (_, index) => [`p${index}`, `s${index}`]));
    named(sessions);
    for (const pane of Object.keys(sessions)) {
      await fetchPaneConversation(pane, "local", { prompts: 10 });
      await flushConversations();
    }
    expect(store.rows.size).toBe(CONVERSATION_ANSWERS_KEPT);
    expect([...store.rows.values()].some((row) => row.pane === "local\u0000p0" || row.pane === "local\u0000p1")).toBe(false);
  });

  it("leaves nothing on the device or in memory once this browser signs out", async () => {
    serve();
    named({ p1: "s1" });
    await fetchPaneConversation("p1", "local", { prompts: 10 });
    await forgetStoredConversations();
    await flushConversations();
    expect(store.rows.size).toBe(0);
    expect(peekPaneConversation("p1", "local", 10)).toBeUndefined();
  });
});

describe("indexedConversationStore", () => {
  const realIndexedDB = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  afterEach(() => {
    if (realIndexedDB) Object.defineProperty(globalThis, "indexedDB", realIndexedDB);
    else delete globals.indexedDB;
  });

  it("writes, reads, removes and clears pages by URL", async () => {
    const db = fakeIndexedDB();
    Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: db.factory });
    const row = (url: string): StoredConversation => ({ url, pane: "local\u0000p1", session: "s", etag: "\"e\"", body: { source: "claude-transcript", turns: [] } as unknown as ConversationResponse, bytes: 10, saved: 1 });
    await indexedConversationStore.put([row("/a"), row("/b")]);
    expect((await indexedConversationStore.all()).map((each) => each.url).sort()).toEqual(["/a", "/b"]);
    await indexedConversationStore.remove(["/a"]);
    expect((await indexedConversationStore.all()).map((each) => each.url)).toEqual(["/b"]);
    await indexedConversationStore.clear();
    expect(await indexedConversationStore.all()).toEqual([]);
  });
});
