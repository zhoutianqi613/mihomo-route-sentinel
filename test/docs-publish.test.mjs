import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { applyLayout, layoutMetrics, layoutReadme } from '../scripts/docs-layout.mjs';
import { approvedAssets, assertPublishedContent, assertRemoteUnchanged, backlogTable, hash, pages, policyTable, projectBacklog, transformSource } from '../scripts/docs-publish.mjs';
import { checkOutline } from '../scripts/docs-readability.mjs';

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
  assert.match(policyTable(), /日常择优 \/ 故障恢复预算.*各600秒内3次/);
  assert.match(policyTable(), /额外安全恢复预算.*600秒内1次/);
});

test('更新历史在现有迭代页保留版本与阶段三列简表', async () => {
  const page = pages.find((entry) => entry.source === 'docs/iterations.md');
  const source = await readFile(new URL('../docs/iterations.md', import.meta.url), 'utf8');
  const body = applyLayout(transformSource(source, page.source), page.source);
  assert.ok(page.required.includes('01 更新历史'));
  assert.match(body, /\| 版本 \| 阶段 \| 主要变化 \|/);
  assert.doesNotMatch(body, /阶段 \/ 版本/);
  assert.ok(body.indexOf('1.8.0') < body.indexOf('1.7.1'));
  for (const label of ['原问题', '主要变化', '本地证据', '投用证据', '后台观察', '限制']) assert.ok(body.includes(`**${label}：**`), label);
  assert.match(body, /<h3>1\.2 v1\.8\.0<\/h3>/);
  assert.match(body, /<h3>1\.3 v1\.7 及更早<\/h3>/);
  assert.equal(pages.length, 4);
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

test('发布读回要求主章和飞书原生二级目录同时存在', () => {
  const expected = { inputHash: 'hash', headings: ['01 主章'], subheadings: ['1.1 主题'] };
  assert.doesNotThrow(() => assertPublishedContent('hash\n## 01 主章\n<h3>1.1 主题</h3>', expected));
  assert.throws(() => assertPublishedContent('hash\n## 01 主章\n### 1.1 主题', expected), /原生二级目录/);
  assert.throws(() => assertPublishedContent('## 01 主章\n<h3>1.1 主题</h3>', expected), /生成Hash或主章/);
  const markdown = 'hash\n## 01 主章\n### 1.1 主题';
  const native = 'hash<h2 id="main">01 主章</h2><h3 id="sub">1.1 主题</h3>';
  assert.doesNotThrow(() => assertPublishedContent(markdown, expected, native));
  assert.throws(() => assertPublishedContent(markdown, expected, markdown), /原生二级目录/);
  assert.throws(() => assertPublishedContent(markdown, expected, native.replace('hash', 'old')), /原生二级目录/);
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

test('首页6节、子页4—5节并保留两级编号目录，只复用已批准图示且保留原三图', async () => {
  const images = new Set();
  for (const page of pages) {
    const source = await readFile(new URL(`../${page.source}`, import.meta.url), 'utf8');
    const body = applyLayout(transformSource(source, page.source), page.source);
    const metrics = layoutMetrics(body);
    assert.deepEqual(checkOutline(source, page.source), []);
    assert.ok(page.source === 'PRODUCT.md' ? metrics.headings === 6 : metrics.headings >= 4 && metrics.headings <= 5, page.source);
    assert.ok(metrics.subheadings > 0, page.source);
    assert.doesNotMatch(body, /^#{4,} |<h[4-6](?:\s|>)/m, page.source);
    assert.ok(body.includes('<callout '), page.source);
    for (const heading of page.onlineRequired ?? page.required) assert.ok(body.includes(heading), `${page.source}：${heading}`);
    for (const [, image] of body.matchAll(/!\[[^\]]*\]\(@\.\/([^)]+)\)/g)) {
      assert.ok(approvedAssets.includes(image), image);
      images.add(image);
    }
    if (metrics.images) assert.match(source, /读图/);
    assert.doesNotMatch(body, /sentinel:cards/);
  }
  assert.deepEqual([...images].sort(), [...approvedAssets].sort());
});

test('交付路线图使用当前已验证、待验收和未实施口径', async () => {
  const svg = await readFile(new URL('../docs/assets/delivery-roadmap.svg', import.meta.url), 'utf8');
  assert.match(svg, /当前交付与后续顺序/);
  for (const label of ['已验证', '待验收', '未实施', '算法完成', '受控验收', '日常证据', '平台与发布']) assert.match(svg, new RegExp(label));
  assert.doesNotMatch(svg, /待 Bear 裁定|未承诺顺序|建议迭代/);
  const png = await readFile(new URL('../docs/assets/delivery-roadmap.png', import.meta.url));
  assert.ok(png.length > 1000);
});

test('手册使用固定五章并保持先只读、后控制、再配置与排障', async () => {
  const source = await readFile(new URL('../README.md', import.meta.url), 'utf8');
  const body = applyLayout(transformSource(source, 'README.md'), 'README.md');
  assert.ok(body.indexOf('01 首次运行') < body.indexOf('02 日常操作与人工接管'));
  assert.ok(body.indexOf('02 日常操作与人工接管') < body.indexOf('03 后台部署'));
  assert.ok(body.indexOf('03 后台部署') < body.indexOf('04 配置字段参考'));
  assert.ok(body.indexOf('04 配置字段参考') < body.indexOf('05 状态判读与运行维护'));
  assert.ok(body.indexOf('--force-scan') < body.indexOf('04 配置字段参考'));
  assert.ok(body.indexOf('单次检查并允许切换：') > body.indexOf('02 日常操作与人工接管'));
  assert.ok(body.indexOf('node .\\src\\cli.mjs --config .\\config.json --apply') > body.indexOf('02 日常操作与人工接管'));
  for (const heading of ['3.1 Windows', '3.2 Linux systemd', '3.3 macOS launchd', '3.4 平台边界', '4.1 基础与 Controller', '4.6 客户端与配置守卫', '5.1 状态总览', '5.3 未切换排查']) assert.ok(body.includes(`<h3>${heading}</h3>`), heading);
  const deployment = body.slice(body.indexOf('## 03 后台部署'), body.indexOf('## 04 配置字段参考'));
  assert.equal(layoutMetrics(deployment).subheadings, 4);
  for (const heading of ['安装与启动', '管理与人工接管', '卸载', '安装与验证', '凭据与访问边界']) {
    assert.ok(deployment.includes(`**${heading}**`), heading);
    assert.ok(!deployment.includes(`<h3>${heading}</h3>`), heading);
  }
  for (const [, field] of source.matchAll(/^\| `([^`]+)` \|/gm)) assert.ok(body.includes(field), field);
  assert.deepEqual(checkOutline(source, 'README.md'), []);
  assert.throws(() => layoutReadme(`${source}\n## 新的必读说明\n不能丢弃`), /手册主章节/);
});

test('多列表压成两列标注详情，原内容与字段名保留', () => {
  const body = '| 事项 | 状态 | 影响 | 验收 |\n|---|---|---|---|\n| 平台 | 候选 | 待实测 | 可重复 |\n';
  const rendered = applyLayout(body, 'docs/iterations.md');
  assert.match(rendered, /<table>/);
  assert.match(rendered, /<b>状态：<\/b>候选/);
  assert.match(rendered, /<b>验收：<\/b>可重复/);
  assert.equal((rendered.match(/<th /g) ?? []).length, 2);
});

test('配置表把默认值与说明并入第二列，为长字段保留更宽空间', () => {
  const body = '| 字段 | 默认值 | 说明 |\n|---|---:|---|\n| `policy.candidateSnapshotRefreshSeconds` | `60` | 持续运行时后台刷新候选快照的间隔。 |\n| `policy.candidateSnapshotMaxAgeSeconds` | `120` | 过期或选择不匹配即失效。 |\n';
  const rendered = applyLayout(body, 'docs/design.md');
  assert.match(rendered, /<col width="300"\/><col width="520"\/>/);
  assert.match(rendered, /<td><p><b><span>policy\.candidateSnapshotRefreshSeconds<\/span><\/b><\/p><\/td>/);
  assert.match(rendered, /<b>默认值：<\/b><span>60<\/span>/);
  assert.match(rendered, /<b>说明：<\/b>持续运行时/);
  assert.equal((rendered.match(/<th /g) ?? []).length, 2);
});

test('本地图示只映射到固定assets目录，不把路径当成远程图片URL', () => {
  assert.equal(transformSource('# 标题\n\n![图](assets/system-context.png)', 'docs/design.md'), '![图](@./docs/assets/system-context.png)');
  assert.throws(() => transformSource('# 标题\n\n![图](../../other.png)', 'docs/design.md'), /图示只能/);
  for (const image of ['![图](assets/new-image.png)', '![图](https://example.com/image.png)', '![](https://example.com/image.png)', '![图](//example.com/image.png)', '<img src="https://example.com/image.png">']) assert.throws(() => transformSource(`# 标题\n\n${image}`, 'docs/design.md'), /已批准/);
  assert.equal(transformSource('# 标题\n\n![恢复流程](docs/assets/recovery-flow.png)', 'README.md'), '![恢复流程](@./docs/assets/recovery-flow.png)');
});

test('三级标题安全转义并保留，短标签与蓝橙提示块可见，代码样例不参与变换', () => {
  const code = '```markdown\n### 示例标题\n**示例标签：**\n```';
  const body = applyLayout(`## 主章\n\n### 证据 <边界> & 次序\n\n**原问题：** 当前证据不足。\n\n> [!NOTE]\n> **已验证：** 仅只读。\n\n> [!IMPORTANT]\n> **限制：** 未完成长期观察。\n\n${code}`, 'docs/design.md');
  assert.match(body, /<h3>证据 &lt;边界&gt; &amp; 次序<\/h3>/);
  assert.match(body, /\*\*原问题：\*\* 当前证据不足/);
  assert.match(body, /background-color="light-blue"[^>]*><p><b>已验证：<\/b>/);
  assert.match(body, /background-color="light-orange"[^>]*><p><b>限制：<\/b>/);
  assert.ok(body.includes(code));
  assert.deepEqual(layoutMetrics(body), { headings: 1, subheadings: 1, images: 0, callouts: 2 });
  assert.throws(() => applyLayout('#### 层级过深', 'docs/design.md'), /最多使用三级/);
});
