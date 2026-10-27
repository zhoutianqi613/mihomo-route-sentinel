import test from 'node:test';
import assert from 'node:assert/strict';
import { checkOutline, checkReadability, visibleText } from '../scripts/docs-readability.mjs';

test('连续非空行合并为段落，超长错误定位段落首行', () => {
  const body = `# 标题\n\n${'字'.repeat(100)}\n${'字'.repeat(90)}\n`;
  assert.match(checkReadability(body, 'docs/example.md')[0], /docs\/example.md:3：普通段落191个可见字符/);
  assert.deepEqual(checkReadability(`${'字'.repeat(100)}\n\n${'字'.repeat(90)}`), []);
  assert.deepEqual(checkReadability('字'.repeat(180)), []);
  assert.equal(checkReadability('字'.repeat(181)).length, 1);
});

test('保留链接展示文本，忽略链接目的URL和代码标识符', () => {
  const url = `https://example.com/${'a'.repeat(300)}`;
  assert.equal(visibleText(`**原问题：** [可见说明](${url}) 与 \`policy.${'field'.repeat(50)}\``), '原问题： 可见说明 与');
  assert.deepEqual(checkReadability(`[链接](${url})\n\n\`${'identifier'.repeat(50)}\``), []);
  assert.equal(checkReadability(`[${'字'.repeat(181)}](${url})`).length, 1);
});

test('忽略围栏代码、表格和发布脚注，代码中的深层标题不报错', () => {
  const long = '字'.repeat(300);
  assert.deepEqual(checkReadability(`\`\`\`markdown\n#### 示例\n${long}\n\`\`\`\n\n~~~text\n${long}\n~~~\n\n| 字段 | 解释 |\n|---|---|\n| 名称 | ${long} |\n\n**发布溯源（用于同步核对）**\n${long}`), []);
});

test('正文和原生标题最多三级，清楚定位四级违规', () => {
  assert.deepEqual(checkReadability('# 一\n\n## 二\n\n### 三'), []);
  assert.match(checkReadability('# 一\n\n#### 四', 'README.md')[0], /README.md:3：最多使用三级标题/);
  assert.match(checkReadability('<h4>四</h4>', 'README.md')[0], /README.md:1/);
});

test('列表各项独立，续行仍属于同一阅读块', () => {
  assert.deepEqual(checkReadability(`- ${'字'.repeat(100)}\n- ${'字'.repeat(100)}`), []);
  assert.match(checkReadability(`- **原问题：** ${'字'.repeat(100)}\n  ${'字'.repeat(90)}`, 'docs/iterations.md')[0], /docs\/iterations.md:1/);
});

test('主章和二级标题使用连续两组编号，代码块中的井号不参与检查', () => {
  const valid = '# 标题\n\n## 01 主章\n\n### 1.1 二级\n\n### 1.2 二级\n\n## 02 主章\n\n### 2.1 二级\n\n```sh\n## 代码中的标题\n```';
  assert.deepEqual(checkOutline(valid), []);
  assert.match(checkOutline('## 01 主章\n\n### 2.1 二级', 'README.md')[0], /与主章1不匹配/);
  assert.match(checkOutline('## 01 主章\n\n### 1.2 二级', 'README.md')[0], /期望1\.1/);
  assert.ok(checkOutline('## 01 主章\n\n### 1.1 二级\n\n## 03 主章\n\n### 3.1 二级', 'README.md').some((error) => /期望02/.test(error)));
  assert.match(checkOutline('## 01 主章\n\n### 二级', 'README.md')[0], /导航标题必须/);
  assert.match(checkOutline('## 01 主章\n\n## 02 主章\n\n### 2.1 二级', 'README.md')[0], /主章01缺少二级标题/);
  assert.match(checkOutline('## 01 主章\n\n### 1.1 这是一段过长而且带有解释口吻并且以句号结尾的二级目录。', 'README.md')[0], /二级标题应精炼/);
});
