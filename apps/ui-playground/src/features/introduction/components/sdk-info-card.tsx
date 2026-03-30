import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@arcaai/ui/card';
import { usePlaygroundStore } from '@/store/playground-store';
import { Package, Globe } from 'lucide-react';

export function SdkInfoCard() {
  const { apiBaseUrl } = usePlaygroundStore();

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Package className="size-5" />
          <CardTitle>ArcaVox SDK</CardTitle>
        </div>
        <CardDescription>@arcaai/vox — Agentic SDK v2 for medical consultation workflows</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex items-center gap-2">
          <Globe className="text-muted-foreground size-4" />
          <span className="text-sm">API: </span>
          <code className="text-muted-foreground text-xs">{apiBaseUrl}</code>
        </div>
      </CardContent>
    </Card>
  );
}
