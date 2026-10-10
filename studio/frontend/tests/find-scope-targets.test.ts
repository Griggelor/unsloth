// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0
import assert from "node:assert/strict";
import test from "node:test";
import { resolveFindScopeTargets, type FindTarget } from "../src/features/find-in-page/lib/find-targets.ts";

const make = (id: string, kind?: "chat"): FindTarget => ({
  id,
  kind,
  available: () => true,
  contains: () => false,
  search: () => {},
  step: () => {},
  result: () => ({ count: 0, active: -1 }),
});
test("chat scope explicitly uses registered logical chat search; external target stays selectable", () => {
  const browser = make("browser-tab");
  const chat = make("agent-history:fixture", "chat");
  assert.deepEqual(resolveFindScopeTargets([browser, chat], null), {
    selected: chat,
    external: [browser],
  });
  assert.deepEqual(resolveFindScopeTargets([browser, chat], "browser-tab"), {
    selected: browser,
    external: [browser],
  });
});
test("default behaviour remains DOM search when no logical chat target exists", () => {
  const browser = make("browser-tab");
  assert.equal(resolveFindScopeTargets([browser], null).selected, undefined);
});
