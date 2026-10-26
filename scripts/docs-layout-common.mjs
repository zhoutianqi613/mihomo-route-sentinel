// 共享版式生成物 SHA256=b695f04e7730e5c1c654c9650e92e26377d8aa3848e4b1102426d281d4a71048
// 三项目共用展示层：原始事实仍只在各项目正文与规范中维护。
export const escapeXml = (value) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function inline(value) {
  return escapeXml(value)
    .replace(/`([^`]+)`/g, '<span>$1</span>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/\[([^\]]+)\]\((https:\/\/[^)]+)\)/g, '<a href="$2">$1</a>');
}

export function applyCommonLayout(body) {
  let rendered = body.replace(/^#{3,6} (.+)$/gm, '**$1**');
  rendered = rendered.replace(/<!-- sentinel:cards -->\s*\n([\s\S]*?)\n<!-- sentinel:\/cards -->/g, (_, table) => {
    const rows = table.trim().split('\n').slice(2).map((row) => row.trim().replace(/^\||\|$/g, '').split('|').map((value) => value.trim()));
    if (rows.length < 2 || rows.length > 3 || rows.some((row) => row.length !== 2)) throw new Error('信息卡必须为2—3张，每张仅标题与说明');
    const ratio = rows.length === 2 ? 0.5 : 0.33;
    return `<grid>${rows.map(([label, text], index) => `<column width-ratio="${index === rows.length - 1 ? 1 - (rows.length - 1) * ratio : ratio}"><callout emoji="${index === 0 ? '📌' : '🔎'}" background-color="light-gray" border-color="gray"><p><b>${inline(label)}</b></p><p>${inline(text)}</p></callout></column>`).join('')}</grid>`;
  });
  rendered = rendered.replace(/^> \[!(NOTE|WARNING|IMPORTANT)\]\r?\n((?:>[^\n]*(?:\r?\n|$))+)/gm, (_, kind, lines) => {
    const warning = kind !== 'NOTE';
    const paragraphs = lines.trimEnd().split(/\r?\n/).map((line) => line.replace(/^> ?/, '')).filter(Boolean);
    return `<callout emoji="${warning ? '⚠️' : '💡'}" background-color="light-${warning ? 'orange' : 'blue'}" border-color="${warning ? 'orange' : 'blue'}">${paragraphs.map((line) => `<p>${inline(line)}</p>`).join('')}</callout>\n`;
  });
  rendered = rendered.replace(/(?:^\|[^\n]+\|\r?\n){2,}(?:^\|[^\n]+\|(?:\r?\n|$))?/gm, (table) => {
    const rows = table.trim().split(/\r?\n/).map((row) => row.replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((value) => value.trim()));
    const [headers, separator, ...data] = rows;
    if (headers.length < 4 || !separator.every((value) => /^:?-+:?$/.test(value)) || data.some((row) => row.length !== headers.length)) return table;
    return `<table><colgroup><col width="190"/><col width="630"/></colgroup><thead><tr><th background-color="light-gray"><p>${inline(headers[0])}</p></th><th background-color="light-gray"><p>内容与边界</p></th></tr></thead><tbody>${data.map((row) => `<tr><td><p><b>${inline(row[0])}</b></p></td><td>${row.slice(1).map((value, index) => `<p><b>${inline(headers[index + 1])}：</b>${inline(value)}</p>`).join('')}</td></tr>`).join('')}</tbody></table>\n`;
  });
  return rendered;
}

export function layoutMetrics(body) {
  return { headings: [...body.matchAll(/^## /gm)].length, subheadings: [...body.matchAll(/^#{3,6} /gm)].length, images: [...body.matchAll(/!\[/g)].length, callouts: [...body.matchAll(/<callout /g)].length };
}
