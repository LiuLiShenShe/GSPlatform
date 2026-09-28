/**
 * SSV-07 §4 —— 场景尺度诊断（1 Scene Unit = 1 meter）。
 */
import { describe, expect, it } from 'vitest';
import {
  assessSceneScale,
  SCENE_SCALE_MAX_METERS,
  SCENE_SCALE_MIN_METERS,
  type SceneBounds,
} from '../scene-runtime/sceneScale';

const okBounds: SceneBounds = {
  min: [-5, 0, -5],
  max: [5, 3, 5],
  size: [10, 3, 10],
};

describe('assessSceneScale (SSV-07 §4)', () => {
  it('meter-scale scene → ok, needsCalibration=false', () => {
    const a = assessSceneScale(okBounds);
    expect(a.status).toBe('ok');
    expect(a.needsCalibration).toBe(false);
    expect(a.horizontalExtent).toBe(10);
    expect(a.verticalExtent).toBe(3);
  });

  it('sub-meter scene (厘米尺度) → too-small, needsCalibration=true', () => {
    const a = assessSceneScale({
      min: [0, 0, 0],
      max: [0.5, 0.4, 0.5],
      size: [0.5, 0.4, 0.5],
    });
    expect(a.status).toBe('too-small');
    expect(a.needsCalibration).toBe(true);
  });

  it('huge scene (尺度异常放大) → too-large, needsCalibration=true', () => {
    const a = assessSceneScale({
      min: [0, 0, 0],
      max: [5000, 100, 5000],
      size: [5000, 100, 5000],
    });
    expect(a.status).toBe('too-large');
    expect(a.needsCalibration).toBe(true);
  });

  it('null bounds → treated as needing calibration (不静默放行)', () => {
    const a = assessSceneScale(null);
    expect(a.needsCalibration).toBe(true);
    expect(a.status).toBe('too-small');
  });

  it('non-finite bounds → needsCalibration=true', () => {
    const a = assessSceneScale({
      min: [0, 0, 0],
      max: [Number.NaN, 1, 1],
      size: [Number.NaN, 1, 1],
    });
    expect(a.needsCalibration).toBe(true);
  });

  it('zero horizontal extent (degenerate) → needsCalibration=true', () => {
    const a = assessSceneScale({
      min: [0, 0, 0],
      max: [0, 1, 0],
      size: [0, 1, 0],
    });
    expect(a.needsCalibration).toBe(true);
  });

  it('threshold constants are meter-sensible (1m..1000m)', () => {
    expect(SCENE_SCALE_MIN_METERS).toBe(1);
    expect(SCENE_SCALE_MAX_METERS).toBe(1000);
  });
});
