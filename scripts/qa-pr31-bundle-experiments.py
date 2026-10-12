#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""Disposable PR31 experiment: lazy-load two optional tool UIs.

Never write to PR30 branch; operate on the temporary checked-out source tree
in a hosted runner. Inference from size measurements is NOT release approval.
"""
import argparse
from pathlib import Path


def one(source: str, old: str, new: str, label: str) -> str:
    count = source.count(old)
    if count != 1:
        raise RuntimeError(f"{label}: expected one production anchor, found {count}")
    return source.replace(old, new, 1)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--thread", type=Path, required=True)
    args = parser.parse_args()
    source = args.thread.read_text(encoding="utf-8")

    for component, module in (
        ("WebSearchToolUI", "tool-ui-web-search"),
        ("KnowledgeBaseToolUI", "tool-ui-knowledge-base"),
    ):
        source = one(
            source,
            f'import {{ {component} }} from "@/components/assistant-ui/{module}";',
            "",
            f"eager {component} import",
        )
    source = one(
        source,
        "const WebSearchToolUIConfirmable = withToolConfirmation(WebSearchToolUI);",
        """const DeferredWebSearchToolUI = lazy(() =>
  import("@/components/assistant-ui/tool-ui-web-search").then(
    ({ WebSearchToolUI }) => ({ default: WebSearchToolUI }),
  ),
);
const WebSearchToolUIConfirmable = withToolConfirmation((props) => (
  <Suspense fallback={<ToolFallback {...props} />}>
    <DeferredWebSearchToolUI {...props} />
  </Suspense>
));""",
        "WebSearchToolUI wrapper",
    )
    source = one(
        source,
        """const KnowledgeBaseToolUIConfirmable =
  withToolConfirmation(KnowledgeBaseToolUI);""",
        """const DeferredKnowledgeBaseToolUI = lazy(() =>
  import("@/components/assistant-ui/tool-ui-knowledge-base").then(
    ({ KnowledgeBaseToolUI }) => ({ default: KnowledgeBaseToolUI }),
  ),
);
const KnowledgeBaseToolUIConfirmable = withToolConfirmation((props) => (
  <Suspense fallback={<ToolFallback {...props} />}>
    <DeferredKnowledgeBaseToolUI {...props} />
  </Suspense>
));""",
        "KnowledgeBaseToolUI wrapper",
    )
    if "const ASSISTANT_PART_COMPONENTS = {" not in source:
        raise RuntimeError("stable by_name tools table absent")
    args.thread.write_text(source, encoding="utf-8")
    print("Disposable bundle candidate applied: lazy WebSearchToolUI + KnowledgeBaseToolUI")


if __name__ == "__main__":
    main()
