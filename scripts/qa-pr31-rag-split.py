#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""Scratch-only RAG import-graph experiment against the checked-out PR30 SHA.

Extract the CitationBadge used by eager transcript sources before dynamically
loading the full knowledge-base tool UI. The runner is disposable; never push the
edited app tree or claim a production bundle pass from this experiment.
"""
import argparse
from pathlib import Path


def exactly_once(source: str, old: str, new: str, label: str) -> str:
    count = source.count(old)
    if count != 1:
        raise RuntimeError(f"{label}: expected exactly one anchor; got {count}")
    return source.replace(old, new, 1)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--frontend-root", type=Path, required=True)
    args = parser.parse_args()
    root = args.frontend_root.resolve()
    directory = root / "src" / "components" / "assistant-ui"
    kb_path = directory / "tool-ui-knowledge-base.tsx"
    rag_path = directory / "rag-sources.tsx"
    thread_path = directory / "thread.tsx"
    badge_path = directory / "citation-badge.tsx"
    if badge_path.exists():
        raise RuntimeError("Citation badge was already extracted: refusing to overwrite")
    kb = kb_path.read_text(encoding="utf-8")
    begin = kb.index("export function CitationBadge(")
    end = kb.index("\nconst KnowledgeBaseToolUIImpl:", begin)
    implementation = kb[begin:end].rstrip()
    if kb.count("export function CitationBadge(") != 1 or kb.count("const KnowledgeBaseToolUIImpl:") != 1:
        raise RuntimeError("Knowledge Base source shape unexpectedly changed")
    badge_path.write_text(
        '// SPDX-License-Identifier: AGPL-3.0-only\n'
        '"use client";\n\n'
        'import { FileGlyph } from "@/lib/file-icon";\n'
        'import { useDocumentPreviewStore } from "@/features/rag/components/preview-store";\n'
        'import { Badge } from "./badge";\n'
        'import type { Citation } from "./citation-utils";\n\n'
        + implementation + "\n",
        encoding="utf-8",
    )
    kb = kb[:begin] + "export { CitationBadge } from \"./citation-badge\";\n" + kb[end:]
    kb = exactly_once(kb, 'import { FileGlyph } from "@/lib/file-icon";\n', "", "FileGlyph import")
    kb = exactly_once(kb, 'import { Badge } from "./badge";\n', "", "Badge import")
    kb = exactly_once(
        kb, 'import { useDocumentPreviewStore } from "@/features/rag/components/preview-store";\n',
        "", "preview-store import",
    )
    kb = exactly_once(kb, "import { type Citation, parseCitations } from \"./citation-utils\";",
        "import { parseCitations } from \"./citation-utils\";", "Citation type import")
    kb_path.write_text(kb, encoding="utf-8")

    rag = rag_path.read_text(encoding="utf-8")
    rag = exactly_once(rag, 'import { CitationBadge } from "./tool-ui-knowledge-base";',
        'import { CitationBadge } from "./citation-badge";', "eager RAG badge import")
    rag_path.write_text(rag, encoding="utf-8")

    thread = thread_path.read_text(encoding="utf-8")
    thread = exactly_once(
        thread, 'import { KnowledgeBaseToolUI } from "@/components/assistant-ui/tool-ui-knowledge-base";',
        "", "eager KnowledgeBaseToolUI import",
    )
    thread = exactly_once(
        thread,
        'const KnowledgeBaseToolUIConfirmable =\n  withToolConfirmation(KnowledgeBaseToolUI);',
        '''const DeferredKnowledgeBaseToolUI = lazy(() =>
  import("@/components/assistant-ui/tool-ui-knowledge-base").then(
    ({ KnowledgeBaseToolUI }) => ({ default: KnowledgeBaseToolUI }),
  ),
);
const KnowledgeBaseToolUIConfirmable = withToolConfirmation((props) => (
  <Suspense fallback={<ToolFallback {...props} />}>
    <DeferredKnowledgeBaseToolUI {...props} />
  </Suspense>
));''',
        "KnowledgeBaseToolUI wrapper",
    )
    thread_path.write_text(thread, encoding="utf-8")
    print("Extracted CitationBadge, removed eager RAG->tool UI dependency, and deferred KB tool")
    print("Changes are limited to the ephemeral CI checkout; PR30 remains unchanged.")


if __name__ == "__main__":
    main()
