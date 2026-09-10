import React from 'react';

import { useChatStore } from '@/store/chatStore';
import { ENGINE_BACKENDS } from '@/services/engine';

/**
 * Two levels: the backend first, then one of its models. Only Claude ships
 * today, so its row is hidden until a second backend exists; the model list
 * still comes from the selected backend rather than from a flat list.
 */
const ModelSelector: React.FC = () => {
  const { backendId, modelId, setModel } = useChatStore();

  const backend = ENGINE_BACKENDS.find((b) => b.id === backendId) ?? ENGINE_BACKENDS[0]!;
  const models = backend.models;
  const currentModel = models.find((m) => m.id === modelId) ?? models[0]!;

  return (
    <div className='flex items-center gap-1'>
      {ENGINE_BACKENDS.length > 1 && (
        <select
          className='select select-ghost select-xs max-w-[7rem]'
          value={backend.id}
          onChange={(e) => {
            const next = ENGINE_BACKENDS.find((b) => b.id === e.target.value);
            if (next) setModel(next.id, next.models[0]!.id);
          }}
          title='Backend'
        >
          {ENGINE_BACKENDS.map((b) => (
            <option key={b.id} value={b.id}>
              {b.label}
            </option>
          ))}
        </select>
      )}
      <select
        className='select select-ghost select-xs max-w-[9rem]'
        value={currentModel.id}
        onChange={(e) => setModel(backend.id, e.target.value)}
        title={`${backend.label} — model`}
      >
        {models.map((m) => (
          <option key={m.id} value={m.id}>
            {ENGINE_BACKENDS.length > 1 ? m.label : `${backend.label} ${m.label}`}
          </option>
        ))}
      </select>
    </div>
  );
};

export default ModelSelector;
