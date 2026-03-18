import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { Button } from '@arcaai/ui/button';
import { Input } from '@arcaai/ui/input';
import { Label } from '@arcaai/ui/label';
import { useAuthStore } from '@/store/auth-store';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useState } from 'react';
import { Key, Building2 } from 'lucide-react';

const apiKeySchema = z.object({
    apiKey: z.string().min(1, 'API key is required'),
    tenantId: z.string().min(1, 'Tenant ID is required'),
});

type ApiKeyFormValues = z.infer<typeof apiKeySchema>;

export function ApiKeyForm() {
    const setApiKeyAuth = useAuthStore((s) => s.setApiKeyAuth);
    const navigate = useNavigate();
    const search = useSearch({ from: '/(auth)/login' });
    const [isLoading, setIsLoading] = useState(false);

    const {
        register,
        handleSubmit,
        formState: { errors },
    } = useForm<ApiKeyFormValues>({
        resolver: zodResolver(apiKeySchema),
    });

    const onSubmit = async (data: ApiKeyFormValues) => {
        setIsLoading(true);
        try {
            setApiKeyAuth(data.apiKey, data.tenantId);
            navigate({ to: search.redirect || '/' });
        } finally {
            setIsLoading(false);
        }
    };

    return (
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
            <div className="space-y-2">
                <Label htmlFor="apiKey">API Key</Label>
                <div className="relative">
                    <Key className="text-muted-foreground absolute left-3 top-1/2 size-4 -translate-y-1/2" />
                    <Input
                        id="apiKey"
                        type="password"
                        placeholder="Enter your API key"
                        className="pl-10"
                        {...register('apiKey')}
                    />
                </div>
                {errors.apiKey && (
                    <p className="text-destructive text-sm">{errors.apiKey.message}</p>
                )}
            </div>
            <div className="space-y-2">
                <Label htmlFor="tenantId-api">Tenant ID</Label>
                <div className="relative">
                    <Building2 className="text-muted-foreground absolute left-3 top-1/2 size-4 -translate-y-1/2" />
                    <Input
                        id="tenantId-api"
                        type="text"
                        placeholder="Enter your tenant UUID"
                        className="pl-10"
                        {...register('tenantId')}
                    />
                </div>
                {errors.tenantId && (
                    <p className="text-destructive text-sm">{errors.tenantId.message}</p>
                )}
            </div>
            <Button type="submit" className="w-full" disabled={isLoading}>
                {isLoading ? 'Connecting...' : 'Connect with API Key'}
            </Button>
        </form>
    );
}
