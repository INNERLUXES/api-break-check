// Report formats: text for a terminal, Markdown for a pull request, JSON for other tools, CSV for a spreadsheet.

function summary(r) {
  return `${r.counts.breaking} breaking, ${r.counts.warning} warning, ${r.counts.info} info`;
}

function spec(s) {
  const name = [s.title, s.version].filter(Boolean).join(' ');
  return `${s.source || '(input)'}${name ? ` (${name})` : ''}`;
}

function location(c) {
  return `${c.method ? `${c.method} ` : ''}${c.path}${c.where ? `  ${c.where}` : ''}`;
}

export function toText(r) {
  const lines = [
    `api-break-check: ${spec(r.old)} -> ${spec(r.new)}`,
    `${r.changes.length} change(s): ${summary(r)}`
  ];
  if (!r.changes.length) lines.push('', 'no changes found that affect clients');
  for (const c of r.changes) {
    lines.push('', `${c.severity.toUpperCase().padEnd(8)}  ${c.id.padEnd(28)}  ${location(c)}`);
    lines.push(`${''.padEnd(8)}  ${''.padEnd(28)}  ${c.message}`);
  }
  if (r.notes.length) lines.push('');
  for (const n of r.notes) lines.push(`note: ${n}`);
  if (r.ignored.count) lines.push('', `ignored: ${r.ignored.count} change(s) (${r.ignored.ids.join(', ')})`);
  lines.push('', r.gate.pass ? `GATE: PASS (--fail-on ${r.gate.failOn})` : `GATE: FAIL - ${r.gate.reason}`);
  return lines.join('\n') + '\n';
}

// A Markdown table cell: pipes escaped, line breaks flattened, so text from a description cannot break the table.
export function mdCell(t) {
  return String(t).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n|\r/g, ' ');
}

export function toMarkdown(r) {
  const lines = [
    `## api-break-check: ${summary(r)}`,
    '',
    `${mdCell(spec(r.old))} compared with ${mdCell(spec(r.new))}.`
  ];
  if (!r.changes.length) lines.push('', 'No changes found that affect clients.');
  else {
    lines.push('', '| Severity | Rule | Operation | Where | Change |', '| --- | --- | --- | --- | --- |');
    for (const c of r.changes) {
      lines.push(`| ${c.severity} | ${mdCell(c.id)} | ${mdCell(`${c.method ? `${c.method} ` : ''}${c.path}`)} | ${mdCell(c.where)} | ${mdCell(c.message)} |`);
    }
  }
  if (r.notes.length) lines.push('');
  for (const n of r.notes) lines.push(`- ${mdCell(n)}`);
  if (r.ignored.count) lines.push('', `Ignored: ${r.ignored.count} change(s) (${mdCell(r.ignored.ids.join(', '))}).`);
  lines.push('', r.gate.pass ? `**Gate passed** (--fail-on ${r.gate.failOn}).` : `**Gate failed:** ${mdCell(r.gate.reason)}.`);
  return lines.join('\n') + '\n';
}

export function toJson(r) {
  return JSON.stringify(r, null, 2) + '\n';
}

// RFC 4180 quoting, and a leading quote on cells a spreadsheet would read as a formula.
export function csvCell(value) {
  let s = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(r) {
  const rows = [['severity', 'rule', 'method', 'path', 'where', 'change']];
  for (const c of r.changes) rows.push([c.severity, c.id, c.method, c.path, c.where, c.message]);
  return rows.map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
