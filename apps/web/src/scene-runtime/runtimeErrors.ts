/**
 * SuperSplatRuntime 生命周期错误（SSV-02）。
 *
 * 操作在错误时机调用时的可恢复失败分类。官方 handle 自身抛出的错误
 * （如 frameScene 在未加载时抛出）原样向上传播，不在此包装 —— wrapper
 * 只对「runtime 不存在 / 已销毁」这两个 wrapper 自身的状态错误负责。
 */

/** 错误发生的生命周期位置。 */
export type SuperSplatRuntimeErrorKind =
  | 'NOT_CREATED' // create() 尚未 resolve（不可达于正常调用，防御用）
  | 'DESTROYED' // destroy() 已调用后的操作
  | 'NOT_LOADED'; // 需要 state.loaded 的操作（尚未渲染首帧）

export class SuperSplatRuntimeError extends Error {
  readonly kind: SuperSplatRuntimeErrorKind;

  constructor(kind: SuperSplatRuntimeErrorKind, message: string) {
    super(message);
    this.name = 'SuperSplatRuntimeError';
    this.kind = kind;
  }
}
