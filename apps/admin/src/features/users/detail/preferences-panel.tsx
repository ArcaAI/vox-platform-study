import { Alert, AlertDescription } from '@arcaai/ui/alert';
import { Card } from '@arcaai/ui/card';
import { Switch } from '@arcaai/ui/switch';
import { Info } from 'lucide-react';

const EM_DASH = '—';

function PrefRow({ label, value }: { label: string; value: string }) {
    return (
        <div className="flex items-center justify-between border-b py-3 last:border-0">
            <span className="text-sm text-muted-foreground">{label}</span>
            <span className="text-sm font-medium text-muted-foreground">{value}</span>
        </div>
    );
}

function ToggleRow({ label }: { label: string }) {
    return (
        <div className="flex items-center justify-between border-b py-3 last:border-0">
            <span className="text-sm text-muted-foreground">{label}</span>
            <Switch disabled aria-label={label} />
        </div>
    );
}

/**
 * 38u **Preferences** tab. The SDK only exposes the caller's OWN settings
 * (`GET /user/me/settings`); there is no admin-for-another-user settings
 * endpoint, so the whole panel is a TARGET preview — the namespace layout is
 * drawn with disabled controls + em-dash values behind a `Target` banner rather
 * than fetching or fabricating another user's preferences.
 */
export function PreferencesPanel() {
    return (
        <div className="space-y-4">
            <Alert>
                <Info />
                <AlertDescription>
                    <span className="font-medium text-foreground">Target ·</span> Admins can view a user’s preferences here; editing another user’s
                    settings ships later. Users manage their own.
                </AlertDescription>
            </Alert>

            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                <Card className="p-5">
                    <h3 className="mb-2 text-sm font-semibold">Appearance &amp; localization</h3>
                    <PrefRow label="Theme" value={EM_DASH} />
                    <PrefRow label="Density" value={EM_DASH} />
                    <PrefRow label="Language" value={EM_DASH} />
                    <PrefRow label="Timezone" value={EM_DASH} />
                </Card>
                <Card className="p-5">
                    <h3 className="mb-2 text-sm font-semibold">Notifications &amp; clinical defaults</h3>
                    <ToggleRow label="Email digest" />
                    <ToggleRow label="System alerts" />
                    <PrefRow label="Default department" value={EM_DASH} />
                    <PrefRow label="SMR template" value={EM_DASH} />
                </Card>
            </div>
        </div>
    );
}
