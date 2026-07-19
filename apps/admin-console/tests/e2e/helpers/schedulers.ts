import type { Page } from '@playwright/test';

const DNA_REGEN_ENABLED_SETTING_ID = '77000000-0000-0000-0000-000000000001';

async function readDnaRegenValue(page: Page): Promise<string | null> {
    return page.evaluate(async (id) => {
        const current = await fetch(`/api/hope/admin/settings/${id}`);
        if (!current.ok) return null;
        const body = (await current.json()) as { value: string };
        return body.value;
    }, DNA_REGEN_ENABLED_SETTING_ID);
}

async function patchDnaRegenEnabled(page: Page, value: string): Promise<boolean> {
    return page.evaluate(
        async ({ id, value }) => {
            const current = await fetch(`/api/hope/admin/settings/${id}`);
            if (!current.ok) return false;
            const body = (await current.json()) as { version: number };
            const patch = await fetch(`/api/hope/admin/settings/${id}`, {
                method: 'PATCH',
                headers: { 'content-type': 'application/json', 'if-match': `"${body.version}"` },
                body: JSON.stringify({ value }),
            });
            return patch.ok;
        },
        { id: DNA_REGEN_ENABLED_SETTING_ID, value },
    );
}

export async function withDynamicSchedulerEnabled(page: Page): Promise<() => Promise<void>> {
    const originalValue = await readDnaRegenValue(page);
    if (originalValue === null) throw new Error('Could not read the dna-regeneration dynamic scheduler setting');

    const ok = await patchDnaRegenEnabled(page, 'true');
    if (!ok) throw new Error('Could not enable the dna-regeneration dynamic scheduler for this test');

    let restored = false;
    return async () => {
        if (restored) return;
        const restoreOk = await patchDnaRegenEnabled(page, originalValue);
        if (!restoreOk) throw new Error('Could not restore the dna-regeneration dynamic scheduler setting');
        restored = true;
    };
}

