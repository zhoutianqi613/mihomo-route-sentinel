// 按阅读块计数，避免把编辑器换行误当成短段落。URL与代码标识符不计入正文长度。
export function visibleText(value) {
  return value.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/(`+)[\s\S]*?\1/g, '')
    .replace(/https?:\/\/[^\s<>]+/g, '')
    .replace(/<[^>]*>|<!--.*?-->/g, '')
    .replace(/[*_~]|\\(?=[\\`*_[\]{}()#+.!>|-])/g, '')
    .replace(/&(?:amp|lt|gt|quot|apos|#\d+|#x[\da-f]+);/gi, '字')
    .replace(/\s+/g, ' ').trim();
}

export function checkReadability(body, filename = '文档') {
  const errors = [];
  let paragraph = [];
  let start = 0;
  let fence;
  let inComment = false;
  const flush = () => {
    const length = [...visibleText(paragraph.join(' '))].length;
    if (length > 180) errors.push(`${filename}:${start}：普通段落${length}个可见字符，超过180；请分段或拆为带短标签的要点`);
    paragraph = [];
  };
  for (const [index, raw] of body.split(/\r?\n/).entries()) {
    const line = raw.trim();
    const marker = raw.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (marker && !fence) { flush(); fence = marker[1]; continue; }
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = undefined;
      continue;
    }
    // 发布器附加的溯源信息不属于产品正文。
    if (line === '**发布溯源（用于同步核对）**') { flush(); break; }
    if (inComment || line.startsWith('<!--')) {
      flush(); inComment = !line.includes('-->'); continue;
    }
    if (/^#{4,}(?:\s|$)/.test(line) || /<h[4-6](?:\s|>)/i.test(line)) errors.push(`${filename}:${index + 1}：最多使用三级标题，避免目录过深`);
    if (!line || /^#{1,6}(?:\s|$)|^\||^!\[|^\[![A-Z]+\]|^---+$|^<\/?(?:h[1-6]|title|callout|grid|table)\b/i.test(line)) { flush(); continue; }
    const content = line.replace(/^>\s?/, '');
    if (/^\[!(NOTE|WARNING|IMPORTANT)\]$/.test(content)) { flush(); continue; }
    const item = content.match(/^(?:[-+*]|\d+[.)])\s+(.+)$/);
    if (item) flush();
    if (!paragraph.length) start = index + 1;
    paragraph.push(item ? item[1] : content);
  }
  flush();
  return errors;
}

// 主章与子章都使用稳定编号；目录层级和顺序不依赖发布器隐式推断。
export function checkOutline(body, filename = '文档') {
  const errors = [];
  let fence;
  let chapter = 0;
  let section = 0;
  let chapterHasSection = false;
  const seen = new Set();

  const finishChapter = () => {
    if (chapter && !chapterHasSection) errors.push(`${filename}：主章${String(chapter).padStart(2, '0')}缺少二级标题`);
  };

  for (const [index, raw] of body.split(/\r?\n/).entries()) {
    const line = raw.trim();
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (marker && !fence) {
      fence = marker[1];
      continue;
    }
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = undefined;
      continue;
    }

    const main = line.match(/^## (\d{2}) (.+)$/);
    if (main) {
      finishChapter();
      const next = Number(main[1]);
      if (next !== chapter + 1) errors.push(`${filename}:${index + 1}：主章编号应连续，期望${String(chapter + 1).padStart(2, '0')}，实际${main[1]}`);
      if ([...main[2]].length > 24 || /[，。！？；：]$/.test(main[2])) errors.push(`${filename}:${index + 1}：主章标题应精炼且不使用句末标点：${main[2]}`);
      chapter = next;
      section = 0;
      chapterHasSection = false;
      if (seen.has(line)) errors.push(`${filename}:${index + 1}：标题重复：${line}`);
      seen.add(line);
      continue;
    }

    const sub = line.match(/^### (\d+)\.(\d+) (.+)$/);
    if (sub) {
      if (Number(sub[1]) !== chapter) errors.push(`${filename}:${index + 1}：二级标题${sub[1]}.${sub[2]}与主章${chapter}不匹配`);
      const next = Number(sub[2]);
      if (next !== section + 1) errors.push(`${filename}:${index + 1}：二级标题编号应连续，期望${chapter}.${section + 1}，实际${sub[1]}.${sub[2]}`);
      if ([...sub[3]].length > 24 || /[，。！？；：]$/.test(sub[3])) errors.push(`${filename}:${index + 1}：二级标题应精炼且不使用句末标点：${sub[3]}`);
      section = next;
      chapterHasSection = true;
      if (seen.has(line)) errors.push(`${filename}:${index + 1}：标题重复：${line}`);
      seen.add(line);
      continue;
    }

    if (/^## |^### /.test(line)) errors.push(`${filename}:${index + 1}：导航标题必须使用“01 主章”或“1.1 二级目录”格式`);
  }
  finishChapter();
  return errors;
}
