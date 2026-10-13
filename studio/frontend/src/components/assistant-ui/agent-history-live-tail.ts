// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

/** Pure guard for auto-follow's one-shot blank-live-tail repair. */
export function shouldRepairAgentLiveTail(input: Readonly<{
  isRunning: boolean;
  following: boolean;
  readerNavigation: boolean;
  recentGesture: boolean;
  atPhysicalBottom: boolean;
  mountedRows: number;
  visibleRows: boolean;
  tailMounted: boolean;
}>): boolean {
  return input.isRunning && input.following && !input.readerNavigation &&
    !input.recentGesture && input.atPhysicalBottom && input.mountedRows > 0 &&
    (!input.visibleRows || !input.tailMounted);
}
