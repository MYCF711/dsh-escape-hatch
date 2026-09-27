/**
 * 宿主半边。
 *
 * 本插件的能力全在浏览器侧（降级 boot 死屏）；宿主侧只需要一个合法的
 * apply，让 Loader 能把该条目正常激活 —— 这也保证它不会出现在自己的
 * “失败条目”诊断里。同时把自检结果打进宿主日志，便于确认补丁已装载。
 */
export function apply(ctx) {
  ctx.logger?.info?.('[dsh-escape-hatch] 宿主半边已装载；boot 降级由客户端半边接管');
}
