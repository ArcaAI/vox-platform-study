/**
 * Byte counter store tests (TASK-351 P0-6 / H7)
 *
 * The streaming byte counter lives outside React state so 4×/s commits no
 * longer re-render the transcript subtree — only leaf subscribers update.
 */

import { createByteCounter } from '../byte-counter';

describe('createByteCounter', () => {
    it('starts at zero', () => {
        const counter = createByteCounter();
        expect(counter.handle.getSnapshot()).toBe(0);
    });

    it('accumulates added bytes', () => {
        const counter = createByteCounter();
        counter.add(2560);
        counter.add(1024);
        expect(counter.handle.getSnapshot()).toBe(3584);
    });

    it('notifies subscribers on add and stops after unsubscribe', () => {
        const counter = createByteCounter();
        const listener = vi.fn();
        const unsubscribe = counter.handle.subscribe(listener);

        counter.add(100);
        expect(listener).toHaveBeenCalledTimes(1);

        unsubscribe();
        counter.add(100);
        expect(listener).toHaveBeenCalledTimes(1);
    });

    it('reset zeroes the value and notifies', () => {
        const counter = createByteCounter();
        const listener = vi.fn();
        counter.handle.subscribe(listener);

        counter.add(512);
        counter.reset();

        expect(counter.handle.getSnapshot()).toBe(0);
        expect(listener).toHaveBeenCalledTimes(2);
    });

    it('skips notifications for no-op updates', () => {
        const counter = createByteCounter();
        const listener = vi.fn();
        counter.handle.subscribe(listener);

        counter.add(0);
        counter.reset(); // already 0

        expect(listener).not.toHaveBeenCalled();
    });
});
