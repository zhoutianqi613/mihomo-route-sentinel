// 运行模式守卫：读取 Controller 实际 mode、按需修补并复核。
// controller 由调用方注入，不依赖 guardrails.mjs。
const RUNTIME_MODES = Object.freeze(['rule', 'global']);

function publicResult(status, details = {}) {
  return {
    status,
    ready: status === 'ok' || status === 'repaired',
    issues: details.issues ?? [],
    repairs: details.repairs ?? [],
    unresolved: details.unresolved ?? [],
  };
}

/** 期望运行模式解析：只允许 rule / global（direct 会让代理完全旁路）。 */
export function normalizeExpectedRuntimeMode(value) {
  if (!RUNTIME_MODES.includes(value)) {
    throw new Error('expectedRuntimeMode 必须是 rule 或 global；不允许 direct');
  }
  return value;
}

export async function runtimeModeIsExpected(controller, expectedMode) {
  const runtime = await controller.getConfigs();
  return runtime?.mode === expectedMode;
}

export async function enforceRuntimeMode({ controller, expectedMode, autoRepair = true, dryRun = true } = {}) {
  try {
    const runtime = await controller.getConfigs();
    if (runtime?.mode === expectedMode) return publicResult('ok');
    if (!autoRepair || dryRun) {
      return publicResult('would-repair', {
        issues: ['runtime-mode'],
        unresolved: ['runtime-mode'],
      });
    }
    await controller.patchConfigs({ mode: expectedMode });
    if (!await runtimeModeIsExpected(controller, expectedMode)) throw new Error('mode verification failed');
    return publicResult('repaired', { issues: ['runtime-mode'], repairs: ['runtime-mode'] });
  } catch {
    return publicResult('blocked', {
      issues: ['controller-unreachable'],
      unresolved: ['controller-unreachable'],
    });
  }
}
