// 只负责阅读层级与飞书原生排版，不复制产品事实或配置值。
import { applyCommonLayout, escapeXml, layoutMetrics as commonMetrics } from './docs-layout-common.mjs';

// 代码样例不属于展示层；公共变换只处理围栏之外的正文。
function mapProse(body, transform) {
  const chunks = [];
  let buffer = [];
  let fence;
  const flush = () => { chunks.push(fence ? buffer.join('') : transform(buffer.join(''))); buffer = []; };
  for (const line of body.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})([^\r\n]*)/);
    if (!fence && marker) {
      flush();
      fence = marker[1];
      buffer.push(line);
    } else if (fence && marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) {
      buffer.push(line);
      flush();
      fence = undefined;
    } else buffer.push(line);
  }
  flush();
  return chunks.join('');
}

export function layoutMetrics(body) {
  let prose = '';
  mapProse(body, (text) => { prose += text; return text; });
  return { ...commonMetrics(prose), subheadings: (prose.match(/^### /gm) ?? []).length + (prose.match(/<h3(?:\s[^>]*)?>/gi) ?? []).length };
}

const README_SECTIONS = Object.freeze(['01 首次运行', '02 日常操作与人工接管', '03 后台部署', '04 配置字段参考', '05 状态判读与运行维护']);

export function layoutReadme(body) {
  const headings = [...body.matchAll(/^## (.+)$/gm)].map((match) => match[1].trim());
  if (headings.join('\n') !== README_SECTIONS.join('\n')) {
    throw new Error(`手册主章节必须依次为：${README_SECTIONS.join('、')}`);
  }
  return body.trim();
}

export function applyLayout(body, sourcePath) {
  return mapProse(sourcePath === 'README.md' ? layoutReadme(body) : body, (text) => {
    if (/^#{4,} /m.test(text) || /<h[4-6](?:\s|>)/i.test(text)) throw new Error('阅读层级最多使用三级标题');
    const structured = text.replace(/^### (.+)$/gm, (_, heading) => `<h3>${escapeXml(heading.trim())}</h3>`);
    return applyCommonLayout(structured);
  });
}
