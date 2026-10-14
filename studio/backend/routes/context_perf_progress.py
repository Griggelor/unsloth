# SPDX-License-Identifier: AGPL-3.0-only
"""Owner-authenticated QA progress probe. No message bodies or identifiers."""
from fastapi import APIRouter, Depends, HTTPException

from auth.authentication import get_current_subject
from core.inference import context_perf_trace
from core.inference.context_live_progress import snapshot
from utils.account_context import is_owner_context

router = APIRouter()


@router.get("/context-debug-progress", include_in_schema=False)
def context_debug_progress(_subject: str = Depends(get_current_subject)):
    if not is_owner_context():
        raise HTTPException(status_code=404, detail="Not found")
    if not context_perf_trace.enabled():
        return {"enabled": False}
    return snapshot()
