"""Batch existing Mesh GLBs: default plan; --apply requires explicit owner direction confirmation.

No mesh extraction, unit correction or calibration is performed.
"""

import argparse
import json

from app.core.config import settings
from app.core.identity import RequestIdentity
from app.db.models.mesh_model import MeshModel
from app.db.models.user import User
from app.db.session import SessionLocal
from app.schemas.mesh_asset import CreateMeshAsset
from app.services.celery_client import send_task
from app.services.mesh_assets import MeshAssetService
from sqlalchemy import select


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--owner-id", required=True)
    parser.add_argument("--up-axis", choices=["+X", "-X", "+Y", "-Y", "+Z", "-Z"])
    parser.add_argument("--confirm-orientation", action="store_true")
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--model-id", action="append")
    args = parser.parse_args()
    if args.apply and not (args.up_axis and args.confirm_orientation):
        parser.error(
            "--apply requires --up-axis and --confirm-orientation; review each model first"
        )
    with SessionLocal() as db:
        user = db.get(User, args.owner_id)
        if not user:
            parser.error("Owner not found")
        identity = RequestIdentity(
            user_id=user.id, email=user.email, display_name=user.display_name
        )
        query = select(MeshModel).where(MeshModel.owner_id == user.id)
        if args.model_id:
            query = query.where(MeshModel.id.in_(args.model_id))
        result = []
        for model in db.scalars(query).unique().all():
            state = MeshAssetService(db, settings).state(model.id, identity)
            item = {
                "meshModelId": str(model.id),
                "units": model.units,
                "sourceSha256": model.sha256,
                "eligible": state["eligible"],
                "reason": state["reason"],
            }
            if args.apply and state["eligible"]:
                item["variant"] = MeshAssetService(db, settings).submit(
                    model.id,
                    CreateMeshAsset(
                        sourcePlySha256=model.sha256,
                        upAxis=args.up_axis,
                        confirmOrientation=True,
                    ),
                    identity,
                    send_task,
                )
            result.append(item)
        print(json.dumps(result, default=str, indent=2))


if __name__ == "__main__":
    main()
