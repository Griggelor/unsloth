// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

import assert from "node:assert/strict";
import test from "node:test";
import {
  AGENT_HISTORY_PAGE_SIZE, AGENT_HISTORY_MAX_LIVE_ROWS, AGENT_HISTORY_MAX_RUNNING_ROWS,
  agentHistorySlice, initialAgentHistoryPage, newerAgentHistoryPage,
  olderAgentHistoryPage, reconcileAgentHistoryPage,
} from "../src/components/assistant-ui/agent-history-page.ts";

test("latest page keeps the last 32 rows", () => {
  assert.deepEqual(agentHistorySlice(initialAgentHistoryPage(1000),1000),{
    start:968,end:1000,older:true,newer:false,latest:true,
  });
});

test("short and empty histories render completely", () => {
  for(const count of [0,1,3,32]){
    const s=agentHistorySlice(initialAgentHistoryPage(count),count);
    assert.equal(s.start,0);
    assert.equal(s.end,count);
  }
});

test("older/newer navigation covers the whole history without overlaps", () => {
  const count=197;
  let page=initialAgentHistoryPage(count);
  let slice=agentHistorySlice(page,count);
  const seen=new Set<number>();
  while(true){
    for(let i=slice.start;i<slice.end;i++){
      assert.equal(seen.has(i),false,"duplicate index "+i);
      seen.add(i);
    }
    if(!slice.older)break;
    page=olderAgentHistoryPage(slice);
    slice=agentHistorySlice(page,count);
  }
  assert.equal(seen.size,count);
  while(slice.newer){
    page=newerAgentHistoryPage(slice,count);
    slice=agentHistorySlice(page,count);
  }
  assert.equal(slice.end,count);
  assert.equal(slice.latest,true);
});

test("idle tail prunes only after 64 rows", () => {
  let page=initialAgentHistoryPage(100);
  const start=page.start;
  let count=100;
  while(count-start<AGENT_HISTORY_MAX_LIVE_ROWS){
    page=reconcileAgentHistoryPage(page,count,count+1,false);
    count++;
    assert.equal(page.start,start);
  }
  page=reconcileAgentHistoryPage(page,count,count+1,false);
  assert.equal(agentHistorySlice(page,count+1).end-agentHistorySlice(page,count+1).start,AGENT_HISTORY_PAGE_SIZE);
});

test("a running stream preserves the active message while bounding rows", () => {
  let page=initialAgentHistoryPage(120);
  const start=page.start;
  for(let count=121;count<320;count++){
    page=reconcileAgentHistoryPage(page,count-1,count,true);
    const slice=agentHistorySlice(page,count);
    assert.equal(slice.end,count);
    assert.ok(slice.end-slice.start<=AGENT_HISTORY_MAX_RUNNING_ROWS);
    if(count-start<=AGENT_HISTORY_MAX_RUNNING_ROWS)assert.equal(page.start,start);
  }
});

test("older page stays fixed while an agent appends", () => {
  let page=olderAgentHistoryPage(agentHistorySlice(initialAgentHistoryPage(500),500));
  const before=agentHistorySlice(page,500);
  page=reconcileAgentHistoryPage(page,500,510,true);
  const after=agentHistorySlice(page,510);
  assert.equal(after.start,before.start);
  assert.equal(after.end,before.end);
  assert.equal(after.newer,true);
});

test("deletion or first-load reconciles to latest", () => {
  const old=olderAgentHistoryPage(agentHistorySlice(initialAgentHistoryPage(500),500));
  assert.equal(agentHistorySlice(reconcileAgentHistoryPage(old,500,80,false),80).latest,true);
  assert.equal(agentHistorySlice(reconcileAgentHistoryPage(initialAgentHistoryPage(0),0,400,false),400).start,368);
});

test("exhaustive pages cover each message exactly once", () => {
  for(let count=0;count<500;count++){
    let page=initialAgentHistoryPage(count);
    let end=count;
    let traversed=0;
    for(let pass=0;pass<100;pass++){
      const slice=agentHistorySlice(page,count);
      assert.equal(slice.end,end);
      assert.ok(slice.start>=0&&slice.end<=count&&slice.start<=slice.end);
      assert.ok(slice.end-slice.start<=AGENT_HISTORY_PAGE_SIZE);
      traversed+=slice.end-slice.start;
      if(!slice.older)break;
      end=slice.start;
      page=olderAgentHistoryPage(slice);
    }
    assert.equal(traversed,count);
  }
});
