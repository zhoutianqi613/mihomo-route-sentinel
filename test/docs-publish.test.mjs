import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { applyLayout, layoutMetrics, layoutReadme } from '../scripts/docs-layout.mjs';
import { assertRemoteUnchanged, backlogTable, hash, pages, policyTable, projectBacklog, transformSource } from '../scripts/docs-publish.mjs';

test('发布范围固定为Mihomo四页，且云端节点不重复', () => {
  assert.equal(pages.length, 4);
  assert.equal(new Set(pages.map((page) => page.node)).size, 4);
  assert.ok(pages.every((page) => !page.source.includes('..')));
});

test('任务快照只包含关联Mihomo的记录，保留未安排版本', () => {
  const own = { record_id: 'rec1', 关联项目: [{ id: 'reczz28RgLQygfek' }], 'Backlog 项': 'Linux验收', 状态: ['候选'], 验收标准: '可重复', 目标版本: null };
  const other = { ...own, record_id: 'rec2', 关联项目: [{ id: 'other-project' }], 'Backlog 项': '不应发布' };
  assert.deepEqual(projectBacklog([other, own]), [own]);
  assert.match(backlogTable([other, own]), /Linux验收.*候选.*可重复.*未安排/);
  assert.doesNotMatch(backlogTable([other, own]), /不应发布/);
});

test('快照文本不能注入表格、HTML或Markdown资源', () => {
  const record = { record_id: 'rec1', 关联项目: [{ id: 'reczz28RgLQygfek' }], 'Backlog 项': '<img>|[x](https://example.com)', 状态: ['候选'] };
  const result = backlogTable([record]);
  assert.ok(result.includes('\\<img\\>\\|\\[x\\]'));
});

test('默认策略表反映当前配置，而不把旧评审的值当默认值', () => {
  assert.match(policyTable(), /60 \/ 120秒/);
  assert.match(policyTable(), /3000 \/ 3000ms/);
});

test('同库相对链接映射为固定Wiki链接，源文件首标题不在正文重复', () => {
  const source = '# 标题\n\n[使用](../README.md) 与 [迭代](iterations.md#后续) 与 [许可](../LICENSE)';
  const transformed = transformSource(source, 'docs/design.md');
  assert.doesNotMatch(transformed, /^# 标题/);
  assert.match(transformed, /wiki\/MntSwAfYOiJ4Yxka76jc1e6Mnjd/);
  assert.match(transformed, /wiki\/OFJBwMZYjijcXVkB1ezcSUPknPb/);
  assert.doesNotMatch(transformed, /#后续/);
  assert.match(transformed, /github.com\/zhoutianqi613\/mihomo-route-sentinel\/blob\/main\/LICENSE/);
});

test('线上正文被手改或首次基线漂移时拒绝覆盖', () => {
  const page = pages[0];
  assert.throws(() => assertRemoteUnchanged(page, { content: 'edited', revision_id: 5 }, { remoteHash: hash('before') }), /其他编辑改变/);
  assert.throws(() => assertRemoteUnchanged(page, { content: 'body', revision_id: 50 }), /首次发布基线/);
  assert.throws(() => assertRemoteUnchanged(page, { content: 'body', revision_id: page.initialRevision, reference_map: { comments: {} } }), /引用或评论/);
  assert.doesNotThrow(() => assertRemoteUnchanged(page, { content: 'same', revision_id: 7 }, { remoteHash: hash('same') }));
});

test('本工具已登记资源可继续发布，但新增资源、评论和正文手改仍停止', () => {
  const content = 'same';
  const reference_map = { img: { image1: { token: 'owned-image' } } };
  const prior = { remoteHash: hash(content), resourceHash: hash(JSON.stringify(reference_map)) };
  assert.doesNotThrow(() => assertRemoteUnchanged(pages[0], { content, reference_map }, prior));
  assert.throws(() => assertRemoteUnchanged(pages[0], { content, reference_map: { img: { new: {} } } }, prior), /资源/);
  assert.throws(() => assertRemoteUnchanged(pages[0], { content: 'edited', reference_map }, prior), /其他编辑/);
  assert.throws(() => assertRemoteUnchanged(pages[0], { content, reference_map: { ...reference_map, comments: {} } }, prior), /评论/);
});

test('四页在线目录压为4—5个主章节，三张图仍有可读文字说明', async () => {
  let images = 0;
  for (const page of pages) {
    const source = await readFile(new URL(`../${page.source}`, import.meta.url), 'utf8');
    const body = applyLayout(transformSource(source, page.source), page.source);
    const metrics = layoutMetrics(body);
    assert.ok(metrics.headings >= 4 && metrics.headings <= 5, page.source);
    assert.equal(metrics.subheadings, 0, page.source);
    assert.ok(body.includes('<callout '), page.source);
    for (const heading of page.onlineRequired ?? page.required) assert.ok(body.includes(heading), `${page.source}：${heading}`);
    images += metrics.images;
    if (metrics.images) assert.match(source, /读图/);
    assert.doesNotMatch(body, /sentinel:cards/);
  }
  assert.equal(images, 3);
});

test('阅读顺序先只读运行及人工接管，再配置；字段不丢失且未知章节不静默丢弃', async () => {
  const source = await readFile(new URL('../README.md', import.meta.url), 'utf8');
  const body = applyLayout(transformSource(source, 'README.md'), 'README.md');
  assert.ok(body.indexOf('01 首次跑通') < body.indexOf('02 日常操作与人工接管'));
  assert.ok(body.indexOf('03 后台部署') < body.indexOf('04 配置与策略参考'));
  assert.ok(body.indexOf('--force-scan') < body.indexOf('04 配置与策略参考'));
  for (const [, field] of source.matchAll(/^\| `([^`]+)` \|/gm)) assert.ok(body.includes(field), field);
  assert.throws(() => layoutReadme(`${source}\n## 新的必读说明\n不能丢弃`), /尚未安排/);
});

test('多列表压成两列标注详情，原内容与字段名保留', () => {
  const body = '| 事项 | 状态 | 影响 | 验收 |\n|---|---|---|---|\n| 平台 | 候选 | 待实测 | 可重复 |\n';
  const rendered = applyLayout(body, 'docs/iterations.md');
  assert.match(rendered, /<table>/);
  assert.match(rendered, /<b>状态：<\/b>候选/);
  assert.match(rendered, /<b>验收：<\/b>可重复/);
  assert.equal((rendered.match(/<th /g) ?? []).length, 2);
});

test('本地图示只映射到固定assets目录，不把路径当成远程图片URL', () => {
  assert.equal(transformSource('# 标题\n\n![图](assets/system-context.png)', 'docs/design.md'), '![图](@./docs/assets/system-context.png)');
  assert.throws(() => transformSource('# 标题\n\n![图](../../other.png)', 'docs/design.md'), /图示只能/);
});
