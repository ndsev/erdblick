import type {InfoMessageInput} from '../diagnostics/info-message.model';

export const GPU_BUFFER_RENDERING_ACTION = 'rendering-preferences';

/** GPU recovery advice belongs to rendering; presentation and occurrence handling remain generic. */
export const GPU_BUFFER_EXHAUSTED_NOTICE: InfoMessageInput = {
    severity: 'warn', scope: 'gpu-buffer-exhausted', life: 'sticky', position: 'top-right',
    summary: 'GPU material buffer exhausted',
    detail: 'Some features could not be rendered because a GPU material buffer reached its capacity.',
    action: {id: GPU_BUFFER_RENDERING_ACTION, label: 'Adjust downsampling to reduce GPU load'}
};
