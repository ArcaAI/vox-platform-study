import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@arcaai/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@arcaai/ui/tabs';
import { Zap } from 'lucide-react';
import { ApiKeyForm } from './api-key-form';
import { CredentialsForm } from './credentials-form';

export function LoginForm() {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col items-center gap-2 text-center">
        <div className="bg-primary text-primary-foreground flex size-12 items-center justify-center rounded-xl">
          <Zap className="size-6" />
        </div>
        <h1 className="text-2xl font-bold">ArcaVox Admin Console</h1>
        <p className="text-muted-foreground text-sm">Sign in to access the interactive SDK playground</p>
      </div>
      <Card>
        <CardHeader className="pb-4">
          <CardTitle className="text-lg">Authentication</CardTitle>
          <CardDescription>Choose your authentication method</CardDescription>
        </CardHeader>
        <CardContent>
          <Tabs defaultValue="apiKey">
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="apiKey">API Key</TabsTrigger>
              <TabsTrigger value="credentials">Credentials</TabsTrigger>
            </TabsList>
            <TabsContent value="apiKey" className="mt-4">
              <ApiKeyForm />
            </TabsContent>
            <TabsContent value="credentials" className="mt-4">
              <CredentialsForm />
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>
    </div>
  );
}
