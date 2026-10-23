import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../scripts/', import.meta.url);

test('Unix 管理脚本覆盖完整生命周期命令', async () => {
  const source = await readFile(new URL('service-unix.sh', root), 'utf8');
  for (const action of ['start', 'stop', 'restart', 'enable', 'disable', 'status']) {
    assert.match(source, new RegExp(`\\b${action}\\b`));
  }
  assert.match(source, /systemctl/);
  assert.match(source, /launchctl/);
});

test('systemd 模板使用后台重启和安全限制', async () => {
  const source = await readFile(new URL('mihomo-route-sentinel.service', root), 'utf8');
  assert.match(source, /Restart=always/);
  assert.match(source, /NoNewPrivileges=true/);
  assert.match(source, /ExecStart=.*--run --apply --quiet/);
});

test('launchd 模板是无窗口后台任务', async () => {
  const source = await readFile(new URL('mihomo-route-sentinel.plist', root), 'utf8');
  assert.match(source, /<string>Background<\/string>/);
  assert.match(source, /<key>KeepAlive<\/key>/);
  assert.match(source, /<string>--quiet<\/string>/);
});

test('安装脚本不把 controller secret 写入命令行', async () => {
  for (const file of ['install-linux.sh', 'install-macos.sh']) {
    const source = await readFile(new URL(file, root), 'utf8');
    assert.doesNotMatch(source, /MIHOMO_CONTROLLER_SECRET=/);
  }
});

test('Windows 安装器不在参数绑定阶段读取 PSScriptRoot', async () => {
  const source = await readFile(new URL('install-windows.ps1', root), 'utf8');
  const paramBlock = source.slice(0, source.indexOf('$ErrorActionPreference'));
  assert.doesNotMatch(paramBlock, /\$PSScriptRoot/);
  assert.match(source, /IsNullOrWhiteSpace\(\$ConfigPath\)/);
});

test('Windows BAT 暴露六个服务生命周期动作', async () => {
  const source = await readFile(new URL('service-windows.bat', root), 'utf8');
  for (const action of ['start', 'stop', 'restart', 'disable', 'enable', 'status']) {
    assert.match(source, new RegExp(`\\b${action}\\b`));
  }
  assert.match(source, /service-windows\.ps1/);
});

test('Windows 服务使用隐藏宿主并按 CLI 绝对路径清理进程', async () => {
  const [service, hiddenHost] = await Promise.all([
    readFile(new URL('service-windows.ps1', root), 'utf8'),
    readFile(new URL('run-hidden.vbs', root), 'utf8'),
  ]);
  assert.match(service, /ValidateSet\('start', 'stop', 'restart', 'disable', 'enable', 'status'\)/);
  assert.match(service, /Name = 'node\.exe'/);
  assert.match(service, /IndexOf\(\$cliPath, \[StringComparison\]::OrdinalIgnoreCase\)/);
  assert.match(service, /Stop-Process -Id \$process\.ProcessId -Force/);
  assert.match(service, /wscript\.exe/);
  assert.match(hiddenHost, /shell\.Run\(command, 0, True\)/);
});
