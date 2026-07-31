import { Card, CardContent, CardHeader, CardTitle } from '@arcaai/ui';

/**
 * Placeholder for grid columns 2 and 3 before `<ArcaCompatProvider>` is mounted.
 * Returns a fragment of two cards so they occupy the same two grid slots the
 * live controller/transcript columns will fill once connected.
 */
export function DisconnectedColumns() {
  return (
    <>
      <Card className="flex items-center justify-center">
        <CardContent className="text-muted-foreground py-12 text-center text-sm">
          Connect on the left to drive the session — language, engine toggle, and metadata controls appear here.
        </CardContent>
      </Card>
      <Card className="flex flex-col">
        <CardHeader>
          <CardTitle>Live results</CardTitle>
        </CardHeader>
        <CardContent className="text-muted-foreground flex flex-1 items-center justify-center py-12 text-center text-sm">
          The live transcript and returned metadata will stream here once you connect and start a consultation.
        </CardContent>
      </Card>
    </>
  );
}
