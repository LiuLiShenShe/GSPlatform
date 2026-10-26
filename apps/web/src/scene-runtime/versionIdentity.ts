/**
 * SceneVersion 身份校验（GS-DESKTOP-04 follow-up §四）—— 保存初始视角期间
 * 场景版本是否稳定。
 *
 * ## 为什么不能用 `content.url`
 *
 * 两个不同的 `SceneVersion` 可以复用同一个内容地址（同一份资产被重新发布 /
 * 回滚到相同 asset_version），因此「保存前后 URL 相同」**不能**证明版本没有
 * 切换。把旧版本的相机姿态同步成新版本的 Reset 目标，会让用户 Reset 到一段
 * 不属于当前内容的历史视角。
 *
 * ## 权威身份
 *
 * `GET /scenes/{slug}/versions` 的 `currentVersionId`（服务端直接读
 * `Scene.current_version_id`，版本切换只重指向这一列）。该 API 已经存在且
 * 在创作页（owner-only）里由 `VersionPanel` 使用 —— 本模块只做**纯比较**，
 * 不引入新的数据库字段或描述符契约。
 */

/**
 * 一次版本身份观测。
 *
 * `unknown` = 读取失败（网络 / 鉴权 / 非 DB 场景）——**绝不**当成「未变化」。
 */
export type VersionIdentity =
  | {
      readonly status: 'known';
      /** 权威版本 ID；null = 该场景当前**没有**版本（不是「未知」）。 */
      readonly versionId: string | null;
      /**
       * 同时观察到的运行时内容地址 —— **只用于诊断**，不参与比较。
       * 保留该字段是为了让「URL 相同也可能换了版本」在类型与测试里显式可见。
       */
      readonly contentUrl: string | null;
    }
  | { readonly status: 'unknown' };

/**
 * 保存前后版本身份比较结论。
 *
 * - `unchanged`  —— 两侧都读到，且版本 ID 相同；
 * - `changed`    —— 两侧都读到，但版本 ID 不同；
 * - `unknown`    —— 至少一侧读取失败（含场景根本没有版本时读不到的情况）。
 */
export type VersionStability = 'unchanged' | 'changed' | 'unknown';

/** 保存前后版本身份比较（只比较权威版本 ID，内容 URL 一律忽略）。 */
export function compareVersionIdentity(
  before: VersionIdentity,
  after: VersionIdentity,
): VersionStability {
  if (before.status !== 'known' || after.status !== 'known') return 'unknown';
  return before.versionId === after.versionId ? 'unchanged' : 'changed';
}

/** 供 UI 提示使用的一句话原因（不参与判定）。 */
export function versionStabilityMessage(stability: VersionStability): string {
  switch (stability) {
    case 'changed':
      return '保存期间场景版本已切换：这个视角属于旧版本，已不同步到当前 Viewer。请在新版本上重新保存。';
    case 'unknown':
      return '无法确认保存期间的场景版本（版本信息读取失败），已不同步到当前 Viewer。请稍后重试。';
    default:
      return '';
  }
}
