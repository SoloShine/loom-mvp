/**
 * 通知 clickCommand 与清单声明命令的一致性校验。纯计算,无 electron 依赖,可契约测试。
 * 口径:只有字符串参与校验(非字符串视为未传,dispatcher 层只透传规整后的 string);
 * 字符串但不在声明列表 → 返回中文错误文案(经 SDK promise 拒绝,拼写错当场暴露),
 * 合法 → null。
 */
export function validateClickCommand(clickCommand: unknown, declared: string[]): string | null {
  if (typeof clickCommand !== "string") return null;
  if (!declared.includes(clickCommand)) return `通知 clickCommand 未在清单命令中声明: ${clickCommand}`;
  return null;
}
