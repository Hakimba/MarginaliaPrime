/** Backends and models offered by the model selector. */
import type { EngineModel } from './types';

export interface EngineBackend {
  id: string;
  label: string;
  models: EngineModel[];
  /** Shown when the backend cannot be used, e.g. its CLI is missing. */
  requirement: string;
}

export const ENGINE_BACKENDS: EngineBackend[] = [
  {
    id: 'claude',
    label: 'Claude',
    requirement: 'Requires the `claude` command, logged in with your subscription.',
    models: [
      { id: 'claude-opus-5', label: 'Opus 5', effort: 'high' },
      { id: 'claude-sonnet-5', label: 'Sonnet 5', effort: 'high' },
      { id: 'claude-haiku-4-5', label: 'Haiku 4.5' },
    ],
  },
];

export const DEFAULT_BACKEND_ID = 'claude';
export const DEFAULT_MODEL_ID = 'claude-opus-5';

export const findModel = (backendId: string, modelId: string): EngineModel => {
  const backend = ENGINE_BACKENDS.find((b) => b.id === backendId) ?? ENGINE_BACKENDS[0]!;
  return backend.models.find((m) => m.id === modelId) ?? backend.models[0]!;
};
