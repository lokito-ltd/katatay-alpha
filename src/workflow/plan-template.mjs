/** Structural validation only. Declaration parsing remains in plan.mjs. */
import { PLAN_SECTIONS } from './plan-format.mjs';
import { fencedBlocks } from './plan.mjs';

/** Only matched backtick runs form code spans; an unmatched run is prose. */
function withoutInlineCode(text) {
  const runs = [...text.matchAll(/`+/g)];
  let result = '';
  let from = 0;
  for (let i = 0; i < runs.length; i += 1) {
    const end = runs.findIndex((run, j) => j > i && run[0].length === runs[i][0].length);
    if (end === -1) continue;
    result += text.slice(from, runs[i].index);
    from = runs[end].index + runs[end][0].length;
    i = end;
  }
  return result + text.slice(from);
}

export function templateProblems(text) {
  const source = text.replace(/<!--[\s\S]*?(?:-->|$)/g, '');
  const raw = source.split(/\r?\n/);
  const visible = [...raw];
  const contentLines = [...raw];
  // Example headings do not supply the sections of the plan around them.
  for (const block of fencedBlocks(raw)) {
    for (let i = block.start; i <= block.end; i += 1) visible[i] = '';
    // Examples can contain real content without supplying section headings.
    // The closing declarations cannot stand in for the Test delta prose.
    contentLines[block.start] = '';
    if (block.closed) contentLines[block.end] = '';
    if (block.label === 'workflow') {
      for (let i = block.start; i <= block.end; i += 1) contentLines[i] = '';
    }
  }
  const headings = visible.flatMap((line, index) => {
    const match = /^ {0,3}(#{1,6})[ \t]+(.+?)\s*$/.exec(line);
    return match ? [{ index, level: match[1].length, name: match[2].replace(/[ \t]+#+$/, ''), text: line.trim() }] : [];
  });
  const problems = [];
  const sections = headings.filter((heading) => heading.level === 2);
  const seen = new Set();
  let previous = -1;
  for (const heading of sections) {
    const position = PLAN_SECTIONS.findIndex((s) => s.heading === heading.name);
    if (position === -1 || seen.has(position)) continue;
    seen.add(position);
    if (position < previous) problems.push(`section ${heading.name} is out of order`);
    previous = position;
  }
  for (const section of PLAN_SECTIONS) {
    const found = sections.filter((h) => h.name === section.heading);
    if (!found.length) {
      const normalized = (name) => name.toLowerCase().replace(/\s+/g, '');
      const near = headings.find((h) => normalized(h.name) === normalized(section.heading));
      problems.push(`section ${section.heading} is missing` + (near
        ? `; found \`${near.text}\` — a section heading is exactly \`## ${section.heading}\`` : ''));
      continue;
    }
    if (found.length > 1) problems.push(`section ${section.heading} appears more than once`);
    for (const heading of found) {
      const end = headings.find((h) => h.index > heading.index
        && h.level <= 2)?.index ?? raw.length;
      const content = contentLines.slice(heading.index + 1, end)
        .map((line) => line.replace(/^(?:\s*>[ \t]?)+/, '').trim())
        .filter((line) => !/^#{1,6}(?:\s|$)/.test(line))
        .join('\n').trim();
      if (!content) problems.push(`section ${section.heading} is empty`);
      const body = withoutInlineCode(visible.slice(heading.index + 1, end).join('\n'));
      if (PLAN_SECTIONS.some((s) => body.includes(s.placeholder))) {
        problems.push(`section ${section.heading} still contains a template placeholder`);
      }
    }
  }
  return problems;
}
