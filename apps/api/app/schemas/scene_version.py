"""SceneVersion DTOs — 历史版本列表 / 激活（回滚）契约。

设计约束（GS-NEXT-11）：

* 只暴露**真实存在**的字段：版本 ID、创建时间、资产格式、字节大小、
  可用的 Gaussian 数量、发布元信息。**不**暴露底层存储路径
  （``Asset.storage_key``）、鉴权密钥或未授权的资源地址。
* 当前版本用 ``isCurrent`` 明确标记；客户端不需要再猜。
* 空间配置（初始视角 / 视点 / 标注 / 碰撞）的绑定状态单列成一个块
  ``spatial``，让前端能直接告诉用户「切换后哪些空间配置需要重新确认」。
"""

from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import BaseModel, Field

from app.schemas.common import PageMeta


class SceneVersionOut(BaseModel):
    """一个不可变 SceneVersion 的对外表示。"""

    id: str = Field(description="SceneVersion 主键（激活时使用）")
    assetVersion: str = Field(
        description="内容寻址的资产版本号（不可变版本的稳定标识）"
    )
    format: str = Field(description="资产格式：sog/streamed-sog/ply/splat")
    sizeBytes: int = Field(description="该版本入口资产的字节数")
    sha256: str | None = Field(default=None, description="来源文件校验和")
    gaussianCount: int | None = Field(
        default=None, description="该版本可用的 Gaussian 数量（LOD0）"
    )
    lodLevels: int | None = Field(default=None, description="流式版本的 LOD 层数")
    createdAt: datetime = Field(description="版本创建时间")
    isCurrent: bool = Field(default=False, description="是否为当前使用的版本")
    manifestReady: bool = Field(
        default=False, description="该版本是否带有发布清单"
    )
    assetsReady: bool = Field(
        default=False, description="该版本的入口资产是否在磁盘上可用"
    )
    entryName: str | None = Field(
        default=None, description="入口文件名（scene.sog / lod-meta.json …）"
    )

    model_config = {"populate_by_name": True}


class SpatialBindingOut(BaseModel):
    """场景空间配置（初始视角/视点/标注/碰撞）与当前版本的绑定状态。

    ``state``:

    * ``VALID``   —— 空间配置已确认适用于当前版本；
    * ``STALE``   —— 空间配置**不可信**（几何变更或版本切换后未重新确认），
      运行时按既有契约停用它（初始视角/视点/标注不随描述符下发，碰撞停用）；
    * ``NONE``    —— 该场景没有空间绑定记录。
    """

    state: str = "NONE"
    boundVersionId: str | None = Field(
        default=None, description="空间配置当前绑定到的版本 ID"
    )
    requiresConfirmation: bool = Field(
        default=False, description="是否需要所有者重新确认空间配置"
    )
    staleAt: datetime | None = Field(default=None, description="失效时间")
    revision: int = Field(
        default=0, description="空间失效代数；每次版本切换递增"
    )
    pendingFeatures: list[str] = Field(
        default_factory=list,
        description=(
            "尚未对当前版本重新确认的空间配置项"
            "（initialCamera / worldTransform / viewpoints / annotations / "
            "collision / calibration）"
        ),
    )
    confirmedFeatures: list[str] = Field(
        default_factory=list, description="已绑定到当前版本、运行时可信的空间配置项"
    )

    model_config = {"populate_by_name": True}


class SceneVersionListOut(BaseModel):
    """历史版本列表（稳定游标分页）。"""

    items: list[SceneVersionOut]
    meta: PageMeta
    currentVersionId: str | None = Field(
        default=None, description="当前使用的版本 ID"
    )
    spatial: SpatialBindingOut = Field(default_factory=SpatialBindingOut)

    model_config = {"populate_by_name": True}


class SceneVersionActivateRequest(BaseModel):
    """激活（回滚）请求体。

    ``expectedCurrentVersionId`` 是**必填**的乐观并发令牌：客户端回传它
    看到的当前版本，服务端在行锁内比对，不一致即 409，避免多窗口/后台发布
    互相覆盖。值为 ``null`` 表示客户端认为当前还没有任何版本。
    """

    expectedCurrentVersionId: uuid.UUID | None = Field(
        description="客户端看到的当前版本 ID（乐观并发令牌）"
    )

    model_config = {"populate_by_name": True}


class SceneVersionActivateOut(BaseModel):
    """激活结果。"""

    message: str
    sceneId: str
    previousVersionId: str | None = None
    currentVersionId: str
    changed: bool = Field(description="是否真的发生了版本切换")
    spatial: SpatialBindingOut = Field(default_factory=SpatialBindingOut)
    collisionPolicy: str | None = Field(
        default=None, description="切换后场景的处理策略（碰撞策略）"
    )
    affectedSpatialFeatures: list[str] = Field(
        default_factory=list,
        description="本次切换后需要重新确认的空间配置项",
    )

    model_config = {"populate_by_name": True}
