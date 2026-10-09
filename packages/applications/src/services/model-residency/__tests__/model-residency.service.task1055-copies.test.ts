import { describe, expect, it } from 'vitest';
import { MiB, NER, agentModel, build } from './task1055-harness';

/**
 * TASK-1055 §8b D4 — end to end through the controller: the nlp agent reports Medical NER as two
 * copies (`cuda:0` and `cuda:1`, matched to DCGM by card UUID). The catalogue row names both copies
 * in `gpu<N>` ids with their own bytes, so the console can unload one of them; each GPU card lists
 * only the copy it holds.
 */
describe('D4 — Medical NER resident on both GPUs', () => {
  const twoCopies = () => {
    const h = build();
    h.state.models.nlp = [
      agentModel({ modelRef: NER, aiModelId: 'model-ner', cache: 'nlp_ner', device: 'cuda:0', bytes: 736 * MiB }),
      agentModel({ modelRef: NER, aiModelId: 'model-ner', cache: 'nlp_ner', device: 'cuda:1', bytes: 737 * MiB }),
    ];
    return h;
  };

  it('the catalogue row lists each copy (gpu0, gpu1) with its bytes; device = the first copy', async () => {
    const catalogue = await twoCopies().service.getCatalogue();
    const row = catalogue.services.find((s) => s.service === 'nlp')!.models.find((m) => m.aiModelId === 'model-ner')!;
    expect(row.residency).toMatchObject({
      device: 'gpu0',
      bytes: 1473 * MiB,
      deviceBytes: [
        { device: 'gpu0', bytes: 736 * MiB },
        { device: 'gpu1', bytes: 737 * MiB },
      ],
    });
  });

  it('each GPU card lists the copy it holds, with that copy`s bytes', async () => {
    const catalogue = await twoCopies().service.getCatalogue();
    const ner = (id: string) => catalogue.devices.find((d) => d.id === id)!.models.filter((m) => m.modelRef === NER);
    expect(ner('gpu0')).toEqual([expect.objectContaining({ bytes: 736 * MiB, bytesSource: 'measured', name: 'Medical NER' })]);
    expect(ner('gpu1')).toEqual([expect.objectContaining({ bytes: 737 * MiB, bytesSource: 'measured', name: 'Medical NER' })]);
  });

  it('the copy the console names (`gpu1`) is the one unloaded (agent device `cuda:1`)', async () => {
    const h = twoCopies();
    const catalogue = await h.service.getCatalogue();
    const row = catalogue.services.find((s) => s.service === 'nlp')!.models.find((m) => m.aiModelId === 'model-ner')!;
    const choice = row.residency!.deviceBytes![1].device;
    await h.service.unload({ service: 'nlp', modelRef: NER, device: choice, reason: 'free GPU 1' });
    expect(h.agents.unload).toHaveBeenCalledTimes(1);
    expect(h.agents.unload).toHaveBeenCalledWith('nlp', expect.objectContaining({ modelRef: NER, device: 'cuda:1' }));
  });
});
