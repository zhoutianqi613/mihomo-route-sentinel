// 只负责阅读层级与飞书原生排版，不复制产品事实或配置值。
import { applyCommonLayout } from './docs-layout-common.mjs';
export { layoutMetrics } from './docs-layout-common.mjs';

const subordinate = (value) => value.replace(/^#{2,6} (.+)$/gm, '**$1**');

export function layoutReadme(body) {
  const sections = new Map();
  const first = body.search(/^## /m);
  const intro = body.slice(0, first).trim();
  const blocks = body.slice(first).split(/(?=^## )/m).filter(Boolean);
  for (const block of blocks) {
    const boundary = block.indexOf('\n');
    sections.set(block.slice(3, boundary).trim(), block.slice(boundary).trim());
  }
  const known = new Set(['特性', '快速开始', '完整配置参考', '配置守卫与自动纠正', '自动切换策略', 'Windows 后台运行', 'Linux systemd', 'macOS launchd', '运行文件', '开源许可', '产品审查 Agent']);
  for (const heading of sections.keys()) if (!known.has(heading)) throw new Error(`新增手册章节尚未安排阅读位置：${heading}`);
  const get = (name) => {
    if (!sections.has(name)) throw new Error(`手册排版缺少源章节：${name}`);
    return sections.get(name);
  };
  const quick = get('快速开始');
  const split = quick.indexOf('单次检查并允许切换：');
  if (split < 0) throw new Error('手册首次只读运行与允许控制的边界缺失');
  return [
    '> [!NOTE]\n> **先只读验证，再允许控制。** 下面按实际操作顺序阅读，完整配置保留在第四节，不必从头通读。',
    '<!-- sentinel:cards -->\n| 步骤 | 动作 |\n|---|---|\n| ① 准备环境 | 获取源码，确认Controller可达 |\n| ② 只读验证 | 填写组名，运行单次Dry Run |\n| ③ 允许控制 | 理解副作用后再开启守护 |\n<!-- sentinel:/cards -->',
    [...intro.matchAll(/\[[^\]]+\]\([^)]+\)/g)].map((match) => match[0]).join(' · '),
    '## 01 首次跑通', quick.slice(0, split).trim(),
    '## 02 日常操作与人工接管',
    '> [!WARNING]\n> **控制有副作用。** `--apply`允许改路由；启用的守卫还可能修正配置或恢复客户端。人工接管前先停止守护。',
    quick.slice(split).trim(),
    '## 03 后台部署',
    ...['Windows 后台运行', 'Linux systemd', 'macOS launchd'].map((name) => `**${name}**\n\n${get(name)}`),
    '## 04 配置与策略参考',
    '> [!NOTE]\n> **按需查阅。** 配置字段与示例逐项对应；先按字段分组定位，再看自动切换规则。',
    '**完整配置参考**', subordinate(get('完整配置参考')),
    '**配置守卫与自动纠正**', get('配置守卫与自动纠正'),
    '**自动切换策略**', get('自动切换策略'),
    '## 05 运行文件与维护',
    '**运行文件**', get('运行文件'),
    '**定位与文档说明**', intro,
    '**能力清单**', get('特性'),
    '**开源许可**', get('开源许可'),
    '**产品审查 Agent**', get('产品审查 Agent'),
  ].join('\n\n');
}

export function applyLayout(body, sourcePath) {
  return applyCommonLayout(sourcePath === 'README.md' ? layoutReadme(body) : body);
}
