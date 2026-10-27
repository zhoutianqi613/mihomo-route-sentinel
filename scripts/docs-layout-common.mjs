// 共享版式生成物 SHA256=4501806f45473c50942ca0fc2e9a08c23b4a616390ca6887e398cc4a01dc3669
// 三项目共用展示层：原始事实仍只在各项目正文与规范中维护。
export const escapeXml = (value) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function inline(value) {
  return escapeXml(value)
    .replace(/`([^`]+)`/g, '<span>$1</span>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/\[([^\]]+)\]\((https:\/\/[^)]+)\)/g, '<a href="$2">$1</a>');
}

export function applyCommonLayout(body) {
  let fence;
  let rendered = body.split('\n').map((line) => {
    const marker = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = undefined;
      return line;
    }
    if (fence) return line;
    return line.replace(/^### ([1-9]\d*\.[1-9]\d* \S[^\r\n]*?)\s*$/, (_, title) => `<h3>${escapeXml(title)}</h3>`);
  }).join('\n');
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
    const configuration = headers.length === 3 && /配置|字段|参数/.test(headers[0]);
    if ((!configuration && headers.length < 4) || !separator.every((value) => /^:?-+:?$/.test(value)) || data.some((row) => row.length !== headers.length)) return table;
    return `<table><colgroup><col width="300"/><col width="520"/></colgroup><thead><tr><th background-color="light-gray"><p>${inline(headers[0])}</p></th><th background-color="light-gray"><p>内容与边界</p></th></tr></thead><tbody>${data.map((row) => `<tr><td><p><b>${inline(row[0])}</b></p></td><td>${row.slice(1).map((value, index) => `<p><b>${inline(headers[index + 1])}：</b>${inline(value)}</p>`).join('')}</td></tr>`).join('')}</tbody></table>\n`;
  });
  return rendered;
}

// 围栏中的示例标题不参与目录；主题归属和名词短语仍须人工审读。
export function validateStructure(source, { home = false } = {}) {
  let fence;
  let chapter = 0;
  let section = 0;
  let previous;
  let documentTitle = false;
  let sectionsInChapter = 0;
  const headings = [];
  const sectionCounts = [];
  const validateChapterCount = () => {
    if (!chapter) return;
    if (home) {
      const expected = [3, 3, 3, 4, 2, 3][chapter - 1];
      if (sectionsInChapter !== expected) throw new Error(`首页第${chapter}章应有${expected}个二级目录，实际${sectionsInChapter}`);
    } else if (sectionsInChapter < 2 || sectionsInChapter > 4) {
      throw new Error(`子页主章应有2—4个二级目录：${headings.at(-1)}`);
    }
    sectionCounts.push(sectionsInChapter);
  };
  for (const line of source.split(/\r?\n/)) {
    const marker = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (marker) {
      if (!fence) {
        fence = marker[1];
        if (previous) previous.content = true;
      }
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = undefined;
      continue;
    }
    if (fence) continue;
    const heading = line.match(/^(#{1,6})\s+(.+?)\s*#*$/);
    if (!heading) {
      if (previous && line.trim() && !/^\s*<!--.*-->\s*$/.test(line)) previous.content = true;
      continue;
    }
    if (heading[1] === '#') {
      if (documentTitle || previous) throw new Error('正文只能使用两级编号目录');
      documentTitle = true;
      continue;
    }
    if (previous && !previous.content) throw new Error(`空目录容器：${previous.title}`);
    const [, level, title] = heading;
    if (level === '##') {
      validateChapterCount();
      const match = title.match(/^(\d{2}) (\S.*)$/);
      if (!match || Number(match[1]) !== chapter + 1) throw new Error(`主章必须使用连续两位编号：${title}`);
      if ([...match[2]].length > 24 || /[，。！？；：]$/.test(match[2])) throw new Error(`主章标题应精炼且不使用句末标点：${title}`);
      chapter += 1;
      section = 0;
      sectionsInChapter = 0;
      headings.push(title);
    } else if (level === '###') {
      const match = title.match(/^([1-9]\d*)\.([1-9]\d*) (\S.*)$/);
      if (!match || Number(match[1]) !== chapter || chapter === 0 || Number(match[2]) !== section + 1) throw new Error(`二级目录须归属当前主章并连续编号：${title}`);
      if ([...match[3]].length > 24 || /[，。！？；：]$/.test(match[3])) throw new Error(`二级标题应精炼且不使用句末标点：${title}`);
      section += 1;
      sectionsInChapter += 1;
    } else throw new Error(`目录最多两级，细节请用短粗体标签：${title}`);
    previous = { title, content: false };
    continue;
  }
  if (fence) throw new Error('代码围栏不成对');
  if (previous && !previous.content) throw new Error(`空目录容器：${previous.title}`);
  validateChapterCount();
  if (home ? chapter !== 6 : chapter < 4 || chapter > 5) throw new Error('首页须承载六项阅读任务，子页须有四至五个主章');
  return headings;
}

export function layoutMetrics(body) {
  return {
    headings: [...body.matchAll(/^## /gm)].length,
    subheadings: [...body.matchAll(/^#{3,6} /gm)].length + [...body.matchAll(/<h3(?:\s[^>]*)?>/gi)].length,
    images: [...body.matchAll(/!\[/g)].length,
    callouts: [...body.matchAll(/<callout /g)].length,
  };
}
