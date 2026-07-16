# Hippo Session Context Store

Hippo keeps the Root Agent on the Codex session attached to a Hippo conversation. Worker nodes use isolated runtime sessions and receive only task-specific context references.

## Storage layout

Context 元数据保存在系统 SQLite 的 `context_items`、`context_versions` 和 `context_tags` 中。正文写入系统级 `objects/sha256/` 内容寻址对象库；SQLite 记录对象引用、版本、来源、标签和所属 workspace/session。工作区内不再维护 Context manifest。

Callers use immutable references instead of physical paths:

```text
ctx://<session-id>/<context-id>@<version>
```

Updating an item creates a new version. Existing references continue to resolve to their original content.

## Runtime model

- Root retains the complete Codex conversation and can access every Context Item in its Hippo session.
- At the start of a Blueprint Run, previous Hippo messages are synchronized into Context Items. The Root prompt receives only their titles, summaries, provenance, and references.
- Root resolves pronouns and task intent, reads source content when required, then dispatches selected references to a worker.
- A worker can read only dispatched references and items written by that NodeRun.
- Reusable or long worker output is written back to the Context Store. The Runtime Graph carries a summary and references rather than the full content.
- Outputs longer than 12,000 characters are externalized automatically when the worker does not return a Context reference itself.

## Dispatch contract

```json
{
  "nodeTask": "Create two illustrations for the approved post",
  "relevantContext": {
    "audience": "young professionals"
  },
  "contextRefs": [
    {
      "ref": "ctx://session-1/post-final@2",
      "title": "Approved post",
      "summary": "A six-dimension city comparison",
      "reason": "Illustrations must match the final copy"
    }
  ],
  "requirements": [
    "Return real image files"
  ],
  "expectedArtifacts": [
    {
      "type": "image",
      "count": 2
    }
  ]
}
```

`relevantContext` is for small facts and constraints. Long source text belongs in `contextRefs`.

## MCP tools

- `hippo_context_write`: create a Context Item or create a new version.
- `hippo_context_read`: read a character range or selected Markdown headings.
- `hippo_context_list`: inspect visible references without loading content.
- `hippo_context_search`: search title, summary, tags, and source content inside the authorized session scope.

MCP endpoints are scoped by workspace, session, Run, role, and optional NodeRun. These values are injected by Hippo and are not model-controlled tool arguments.

## Safety and consistency

- References cannot cross workspace or session boundaries.
- Worker nodes cannot read undispatched references or update another node's item.
- Content objects use temporary files and atomic rename; metadata updates use SQLite transactions.
- Optimistic version checks prevent stale updates.
- Content hashes make repeated writes idempotent.
- Object paths are resolved inside the system object root and reject traversal escapes.
- Summaries are navigation hints, not authoritative source content. Critical decisions must read the referenced source.
- Deleting a conversation removes its session Context Store.
