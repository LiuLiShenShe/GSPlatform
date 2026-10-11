import { httpClient } from './http';

export interface SceneProcessingSettings {
  sceneType: 'UNSPECIFIED' | 'PLANT_OBJECT' | 'GREENHOUSE_SCENE' | 'FIELD_SCENE';
  conversionProfile: 'balanced' | 'eco' | 'quality';
  collisionPolicy: 'MANUAL_ONLY' | 'AUTO_WHEN_CALIBRATED';
  calibration: {
    state: 'UNVERIFIED' | 'ASSUMED' | 'VERIFIED';
    physicalWalkAllowed: boolean;
    stale: boolean;
  };
  collisionDecision: { reasonCode: string; shouldBuild: boolean } | null;
}

export async function getSceneProcessing(sceneId: string): Promise<SceneProcessingSettings> {
  const response = await httpClient.get<SceneProcessingSettings>(
    `/scenes/${encodeURIComponent(sceneId)}/processing`,
  );
  return response.data;
}
