import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaults, CURRENT_CONFIG_VERSION } from '../src/config.mjs';
import { applyLayout, layoutMetrics } from './docs-layout.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'var', 'docs-publish');
const base = 'FUeHbS3Oma51SyswC0OchmDcnxg';
const projectRecord = 'reczz28RgLQygfek';
const wikiHost = 'https://vcnx8wvfgn4h.feishu.cn/wiki/';
export const pages = Object.freeze([
  { source: 'PRODUCT.md', title: '002 Mihomo Route Sentinel', doc: 'B5YSdbF1oobdPsxGjJZcpAbNnBg', node: 'NC0qwAr3Jibgw8kmeJRc2rAzn5e', initialRevision: 4, required: ['01 背景与价值', '02 系统与边界', '05 维护方式'] },
  { source: 'README.md', title: '安装配置与使用手册', doc: 'YVRKdVUYqoov0xxPjvgcwFuxnxh', node: 'MntSwAfYOiJ4Yxka76jc1e6Mnjd', initialRevision: 9, required: ['快速开始', '完整配置参考', 'Windows 后台运行', '运行文件'], onlineRequired: ['01 首次跑通', '02 日常操作与人工接管', '03 后台部署', '04 配置与策略参考', '05 运行文件与维护'] },
  { source: 'docs/design.md', title: '工作原理与业务流程', doc: 'FOGCdWedDowSolx2R0FcGzLXndb', node: 'FbndwuzAJiUPlnkRm2DclPLunJF', initialRevision: 2, required: ['01 三个关键角色', '02 恢复流程', '05 设计取舍与代码定位'] },
  { source: 'docs/iterations.md', title: '迭代计划与遗留问题', doc: 'Dlqhd8Le1oNK97xCIGlcYQnynKb', node: 'OFJBwMZYjijcXVkB1ezcSUPknPb', initialRevision: 2, required: ['01 演进履历', '02 当前遗留', '03 下一轮建议', '04 文档维护闭环'] },
]);

export const hash = (value) => createHash('sha256').update(value).digest('hex');
const cell = (value) => String(value ?? '未填写').replace(/\r?\n/g, '；').replace(/[\\`*_[\]|<>]/g, (item) => `\\${item}`);

export function policyTable(config = defaults) {
  const p = config.policy;
  const q = config.probes;
  return [
    '| 策略 | 当前源码默认值 | 解释 |', '|---|---|---|',
    `| 当前链路检查 | ${p.intervalSeconds}秒 | 固定起始节拍 |`,
    `| 当前健康线 | 成功率${q.currentMinSuccessRate * 100}%；平均≤${q.currentMaxAverageMs}ms；最大≤${q.currentMaxSingleMs}ms | 非瞬时面板延迟 |`,
    `| 严格候选线 | 成功率${q.candidateMinSuccessRate * 100}%；平均≤${q.candidateMaxAverageMs}ms；最大≤${q.candidateMaxSingleMs}ms；${q.validationRounds}轮 | 独立复测 |`,
    `| 部分失败 / 纯延迟确认 | ${p.partialFailureCycles} / ${p.latencyFailureCycles}个连续周期 | 根据异常类型处理 |`,
    `| 硬故障确认 | ${p.hardFailureConfirmSeconds}秒 | 不等于总恢复时间 |`,
    `| 快照刷新 / 最大年龄 | ${p.candidateSnapshotRefreshSeconds} / ${p.candidateSnapshotMaxAgeSeconds}秒 | 还须匹配Selector与叶子 |`,
    `| 扫描 / 常规切前复核截止 | ${q.scanDeadlineMs} / ${q.preSwitchValidationDeadlineMs}ms | 两个独立时间窗口 |`,
    `| 紧急决策与选择目标 | ${p.emergencySwitchDeadlineMs}ms | 有新鲜快照等前提，不是硬实时保证 |`,
    `| 实际选择预算 | ${p.switchBudgetWindowSeconds}秒内${p.switchBudgetCount}次 | 切前拒绝不占选择次数 |`,
    `| 失败候选隔离 / 无候选退避 | ${p.failedNodeQuarantineSeconds} / ${p.candidateScanBackoffSeconds}秒 | 降低重复试错和抖动 |`,
  ].join('\n');
}

export function projectBacklog(records) {
  return records.filter((record) => record['关联项目']?.some((link) => link.id === projectRecord))
    .sort((left, right) => left.record_id.localeCompare(right.record_id));
}

export function backlogTable(records) {
  const selected = projectBacklog(records);
  if (!selected.length) return '发布时查询已完整完成，当前没有关联本项目的Backlog记录；这不证明没有尚未录入的问题。';
  return ['| 待办 | 状态 | 验收标准 | 目标版本 |', '|---|---|---|---|',
    ...selected.map((record) => `| ${cell(record['Backlog 项'])} | ${cell(record['状态']?.join('、'))} | ${cell(record['验收标准'])} | ${cell(record['目标版本'] ?? '未安排')} |`),
    '\n[到飞书Backlog维护状态](https://vcnx8wvfgn4h.feishu.cn/wiki/Xs4jwccMji7tOfkfapGcxQx2nff?table=tblk1CQDE3LIpV4f)',
  ].join('\n');
}

export function transformSource(source, sourcePath, records = []) {
  const mapped = source.replace(/^# .+\r?\n/, '').trim()
    .replace('<!-- sentinel:policy-table -->', policyTable())
    .replace('<!-- sentinel:backlog -->', backlogTable(records));
  return mapped.replace(/(!?)\[([^\]]+)\]\(([^)]+)\)/g, (match, image, label, target) => {
    if (/^(https?:|#)/.test(target)) return match;
    const relative = path.posix.normalize(path.posix.join(path.posix.dirname(sourcePath), target.split('#')[0]));
    if (image) {
      if (!/^docs\/assets\/[a-z-]+\.png$/.test(relative)) throw new Error('图示只能使用项目docs/assets下的PNG');
      return `![${label}](@./${relative})`;
    }
    const page = pages.find((candidate) => candidate.source === relative);
    if (page) return `[${label}](${wikiHost}${page.node})`;
    return `[${label}](https://github.com/zhoutianqi613/mihomo-route-sentinel/blob/main/${relative.split('/').map(encodeURIComponent).join('/')})`;
  });
}

export async function checkSources() {
  const sources = {};
  for (const page of pages) {
    const content = await readFile(path.join(root, page.source), 'utf8');
    if (!content.startsWith('# ') || content.length < 600) throw new Error(`正文不完整：${page.source}`);
    for (const heading of page.required) {
      if (!content.includes(`## ${heading}`)) throw new Error(`缺少必要问题：${page.source} / ${heading}`);
    }
    if ((content.match(/^```/gm)?.length ?? 0) % 2) throw new Error(`代码围栏不成对：${page.source}`);
    for (const [, , link] of content.matchAll(/\[([^\]]+)\]\(([^)]+)\)/g)) {
      if (/^(https?:|#)/.test(link)) continue;
      const resolved = path.resolve(root, path.dirname(page.source), link.split('#')[0]);
      if (!resolved.startsWith(`${root}${path.sep}`)) throw new Error('文档链接越出项目目录');
      await readFile(resolved, { encoding: 'utf8' });
    }
    sources[page.source] = content;
    const metrics = layoutMetrics(applyLayout(transformSource(content, page.source), page.source));
    if (metrics.headings < 4 || metrics.headings > 5 || metrics.subheadings) throw new Error(`阅读目录层级异常：${page.source}`);
  }
  for (const [source, marker] of [['docs/design.md', 'policy-table'], ['docs/iterations.md', 'backlog']]) {
    if (sources[source].split(`<!-- sentinel:${marker} -->`).length !== 2) throw new Error(`动态标记必须恰好一个：${source}`);
  }
  const help = spawnSync(process.execPath, ['src/cli.mjs', '--help'], { cwd: root, encoding: 'utf8' });
  if (help.status !== 0 || !help.stdout.includes('--status-json')) throw new Error('CLI帮助校验失败');
  return sources;
}

function lark(args) {
  // 参数通过标准输入传JSON，固定PowerShell桥接程序不拼接用户内容或凭据。
  const bridge = "$ErrorActionPreference='Stop'; [Console]::InputEncoding=[Text.UTF8Encoding]::new(); [Console]::OutputEncoding=[Text.UTF8Encoding]::new(); $publishArgs=ConvertFrom-Json ([Console]::In.ReadToEnd()); & lark-cli @publishArgs; exit $LASTEXITCODE";
  const cliArgs = [...args, '--as', 'user', ...(args.includes('--format') ? [] : ['--format', 'json'])];
  const result = process.platform === 'win32'
    ? spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', bridge], { cwd: root, input: JSON.stringify(cliArgs), encoding: 'utf8', timeout: 60000, windowsHide: true })
    : spawnSync('lark-cli', cliArgs, { cwd: root, encoding: 'utf8', timeout: 60000 });
  if (result.error || result.status !== 0) {
    let detail = `退出码${result.status ?? '未知'}`;
    try {
      const { error } = JSON.parse(result.stderr || result.stdout);
      const safe = [error?.type, error?.subtype, error?.param].filter((value) => typeof value === 'string' && /^[a-zA-Z0-9_+-]+$/.test(value));
      detail += `；${safe.join(' / ')}`;
    } catch { /* 不回显可能含敏感内容的原始输出。 */ }
    throw new Error(`飞书命令失败：${args[0]} ${args[1]}（${detail}）。没有打印凭据；请核查具体错误类型，不要默认重做授权。`);
  }
  const response = JSON.parse(result.stdout.replace(/^\uFEFF/, ''));
  if (response.ok === false) throw new Error(`飞书未返回成功：${args[0]} ${args[1]}`);
  return response.data ?? response;
}

async function saveJson(filename, value) {
  const destination = path.join(output, filename);
  await writeFile(`${destination}.tmp`, JSON.stringify(value, null, 2), 'utf8');
  await rename(`${destination}.tmp`, destination);
}

export function assertRemoteUnchanged(page, current, prior) {
  const resources = current.reference_map ?? {};
  if (Object.hasOwn(resources, 'comments')) throw new Error(`线上含引用或评论，需先人工核对：${page.title}`);
  if (Object.keys(resources).length && (!prior?.resourceHash || hash(JSON.stringify(resources)) !== prior.resourceHash)) throw new Error(`线上含非本工具登记的引用或资源，需先人工核对：${page.title}`);
  if (prior) {
    if (hash(current.content) !== prior.remoteHash) throw new Error(`线上正文已被其他编辑改变，停止覆盖：${page.title}`);
  } else if (current.revision_id !== page.initialRevision) {
    throw new Error(`首次发布基线已变化，停止覆盖：${page.title}`);
  }
}

export async function main(argv) {
  if (argv.some((arg) => !['--check', '--apply'].includes(arg)) || (argv.includes('--check') && argv.includes('--apply'))) throw new Error('只支持 --check 或 --apply；默认预览。');
  const sources = await checkSources();
  if (argv.includes('--check')) { console.log('四页正文、必要章节、相对链接、动态标记与CLI帮助检查通过。'); return; }
  await mkdir(output, { recursive: true });
  const metadata = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const git = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
  if (git.status !== 0) throw new Error('无法取得源码基线');
  const codeHead = git.stdout.trim();
  let state = { pages: {} };
  try { state = JSON.parse(await readFile(path.join(output, 'receipt.json'), 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await saveJson('backlog-filter.json', { logic: 'and', conditions: [['关联项目', 'intersects', [{ id: projectRecord }]]] });
  const summary = lark(['base', '+record-list', '--base-token', base, '--table-id', 'tblk1CQDE3LIpV4f', '--filter-json', '@./var/docs-publish/backlog-filter.json',
    '--field-id', '关联项目', '--field-id', 'Backlog 项', '--field-id', '状态', '--field-id', '验收标准', '--field-id', '目标版本',
    '--output', './var/docs-publish/backlog.ndjson', '--overwrite', '--format', 'ndjson']);
  if (summary.has_more !== false) throw new Error('Backlog未完整读取，停止发布');
  const rows = (await readFile(path.join(output, 'backlog.ndjson'), 'utf8')).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  const queue = [];
  for (const page of pages) {
    const current = lark(['docs', '+fetch', '--doc', page.doc, '--doc-format', 'markdown', '--detail', 'full']).document;
    const prior = state.pages[page.doc];
    assertRemoteUnchanged(page, current, prior);
    const body = applyLayout(transformSource(sources[page.source], page.source, rows), page.source);
    const sourceHash = hash(sources[page.source]);
    const assets = [...body.matchAll(/!\[[^\]]*\]\(@\.\/([^\)]+)\)/g)].map((match) => match[1]);
    const assetHashes = {};
    for (const asset of assets) assetHashes[asset] = hash(await readFile(path.join(root, asset)));
    const inputHash = hash(JSON.stringify({ body, assetHashes, codeHead, version: metadata.version, config: CURRENT_CONFIG_VERSION }));
    const changed = prior?.inputHash !== inputHash;
    const stamp = new Date().toISOString();
    const content = `<title>${page.title}</title>\n\n${body}\n\n---\n\n<callout emoji="📄" background-color="light-gray" border-color="gray"><p>发布快照 · 来源：${page.source} · 源码版本${metadata.version} / 配置格式${CURRENT_CONFIG_VERSION}</p><p>发布/任务读取：${stamp}。不是新的产品验收；可能包含未提交文档，GitHub版本以仓库为准。</p></callout>\n\n**发布溯源（用于同步核对）**\n\n\`\`\`text\n源码HEAD=${codeHead}\n源文件SHA256=${sourceHash}\n生成Hash=${inputHash}\n\`\`\``;
    const draftPath = `./var/docs-publish/${page.node}.md`;
    await writeFile(path.join(root, draftPath), content, 'utf8');
    queue.push({ page, current, inputHash, sourceHash, assetHashes, draftPath, changed });
    console.log(`${changed ? '待发布' : '无变化'}：${page.title} ← ${page.source}`);
  }
  if (!argv.includes('--apply')) { console.log('预览完成；飞书未修改。执行 npm run docs:publish -- --apply 才发布。'); return; }
  for (const entry of queue) {
    if (!entry.changed) continue;
    const { page } = entry;
    if (hash(await readFile(path.join(root, page.source), 'utf8')) !== entry.sourceHash) throw new Error('源文档在本轮生成后发生变化，停止发布');
    for (const [asset, expected] of Object.entries(entry.assetHashes)) {
      if (hash(await readFile(path.join(root, asset))) !== expected) throw new Error('图示在生成后发生变化，停止发布');
    }
    await saveJson(`before-${page.node}-${entry.current.revision_id}.json`, entry.current);
    const updated = lark(['docs', '+update', '--doc', page.doc, '--revision-id', String(entry.current.revision_id), '--command', 'overwrite', '--doc-format', 'markdown', '--content', `@${entry.draftPath}`]);
    if (updated.result !== 'success' || updated.warnings?.length) throw new Error(`正文发布不完整：${page.title}。已停止后续写入，线上可能已部分改变；上一版备份位于var/docs-publish，请先核对再决定恢复。`);
    lark(['drive', '+update-title', '--url', `${wikiHost}${page.node}`, '--title', page.title]);
    const verified = lark(['docs', '+fetch', '--doc', page.doc, '--doc-format', 'markdown', '--detail', 'full']).document;
    if (!verified.content.includes(entry.inputHash) || (page.onlineRequired ?? page.required).some((heading) => !verified.content.includes(heading))) throw new Error(`读回缺少源Hash或必要章节：${page.title}`);
    state.pages[page.doc] = { inputHash: entry.inputHash, sourceHash: entry.sourceHash, assetHashes: entry.assetHashes, resourceHash: hash(JSON.stringify(verified.reference_map ?? {})), remoteHash: hash(verified.content), revision: verified.revision_id, source: page.source, node: page.node, publishedAt: new Date().toISOString() };
    state.pendingLedger = true;
    await saveJson('receipt.json', state);
    console.log(`已发布并读回：${page.title}（revision ${verified.revision_id}）`);
  }
  if (state.pendingLedger) {
    const date = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date());
    await saveJson('ledger-update.json', { update_records: { [projectRecord]: { 文档同步日期: `${date}T00:00:00+08:00` } } });
    lark(['base', '+record-batch-update', '--base-token', base, '--table-id', 'tblgXWTgxQ1bU3IP', '--json', '@./var/docs-publish/ledger-update.json']);
    state.pendingLedger = false;
    await saveJson('receipt.json', state);
  }
  console.log('四页发布闭环完成；没有提交或推送Git，没有修改其他项目。');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
