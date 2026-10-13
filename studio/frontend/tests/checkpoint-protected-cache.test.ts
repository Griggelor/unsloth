// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved.

import assert from "node:assert/strict";
import test from "node:test";
import type { MessageRecord, ThreadRecord } from "../src/features/chat/types";
import { loadWithStubs } from "./helpers/module-stubs.ts";

const message: MessageRecord = {
  id: "protected-a", threadId: "strict-thread", parentId: null,
  role: "assistant", content: [{type: "text", text: "edited"}],
  createdAt: 1_700_000_000_000,
};
const thread: ThreadRecord = {
  id: message.threadId, title: "Synthetic", modelType: "base",
  archived: false, createdAt: 1_700_000_000_000,
};

type Storage = {
  saveStoredChatMessage: (
    message: MessageRecord, options?: { strictProtected?: boolean },
  ) => Promise<MessageRecord>;
  clearServerOwnedChatMessages: () => void;
};

function harness() {
  class ProtectedError extends Error {
    constructor(_threadId?: string, _messageId?: string) {
      super("protected 409");
      this.name = "ChatMessageProtectedError";
    }
  }
  const putCalls: string[] = [];
  const storage = loadWithStubs<Storage>(
    new URL("../src/features/chat/utils/chat-history-storage.ts", import.meta.url),
    {
      "../api/chat-api": {
        ChatThreadDeletedError: class extends Error {},
        ChatMessageProtectedError: ProtectedError,
        getChatThread: async () => thread,
        saveChatMessage: async (record: MessageRecord) => {
          putCalls.push(record.id);
          throw new ProtectedError(record.threadId, record.id);
        },
        notifyChatHistoryUpdated: () => {},
      },
      "../db": {
        DEXIE_DB_NAME: "unsloth-chat",
        db: {
          threads: { get: async () => undefined },
          messages: { where: () => ({ equals: () => ({ toArray: async () => [] }) }) },
        },
      },
      "./chat-thread-tombstones": {
        isChatThreadDeleted: () => false,
        markChatThreadDeleted: () => {},
        markChatThreadsDeleted: () => {},
      },
      "./thread-record-write-coordinator": {
        ThreadRecordWriteCoordinator: class {
          write<T>(_threadId: string, run: () => Promise<T>): Promise<T> {
            return run();
          }
        },
      },
      "../stores/fork-boundary-store": { setForkBoundary: () => {} },
    },
  );
  return { storage, putCalls };
}

test("previously rejected streaming payload must NOT acknowledge a strict delta", async () => {
  const {storage,putCalls} = harness();
  // Streaming write receives 409 and populates rejected payload cache.
  const first = await storage.saveStoredChatMessage(message);
  assert.deepEqual(first, message);
  assert.deepEqual(putCalls, [message.id]);

  // Ordinary chunk autosave must still suppress duplicate 409s.
  await storage.saveStoredChatMessage(message);
  assert.deepEqual(putCalls, [message.id]);

  // New strict checkpoint must throw, rather than accepting the cached 409.
  await assert.rejects(
    storage.saveStoredChatMessage(message, {strictProtected: true}),
    /protected 409/,
  );
  assert.deepEqual(putCalls, [message.id]);
});

test("strict checkpoint reports first-time protected conflicts as errors", async () => {
  const {storage,putCalls} = harness();
  await assert.rejects(
    storage.saveStoredChatMessage(message, {strictProtected: true}),
    /protected 409/,
  );
  assert.deepEqual(putCalls, [message.id]);
});

test("rejected payload cache is clearable without weakening strict writes", async () => {
  const {storage,putCalls} = harness();
  await storage.saveStoredChatMessage(message);
  storage.clearServerOwnedChatMessages();
  await assert.rejects(
    storage.saveStoredChatMessage(message, {strictProtected: true}),
    /protected 409/,
  );
  assert.deepEqual(putCalls, [message.id,message.id]);
});
