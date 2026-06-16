// Pure project-label resolution for tree grouping.
//
// Algorithm (kept stable so server-side aggregation, command palette, and
// sidebar all bucket the same way):
//   1. First label starting with an uppercase letter — treat as a project tag.
//   2. Else, a `[Bracketed]` prefix in the title — strip & use as label.
//   3. Else, fall back to '(unlabeled)'.
//
// Worker 1 inlined an identical stub in src/state/tree.ts; this file is the
// canonical home and tree.ts now imports from here.

export function projectLabelFor(issue: { labels?: string[] | null; title?: string }): string {
  const labels = issue.labels ?? [];
  const project = labels.find((l) => /^[A-Z]/.test(l));
  if (project) return project;
  const m = (issue.title || '').match(/^\s*\[([^\]]+)\]/);
  if (m) return m[1].trim();
  return '(unlabeled)';
}
