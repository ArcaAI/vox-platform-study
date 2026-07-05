import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { Button } from '@arcaai/ui/button';
import { Input } from '@arcaai/ui/input';
import { Label } from '@arcaai/ui/label';
import { useAuthStore } from '@/store/auth-store';
import { useAuth } from '@arcaai/vox';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useState } from 'react';
import { toast } from 'sonner';
import { User, Lock, Building2 } from 'lucide-react';

const credentialsSchema = z.object({
  username: z.string().min(1, 'Username is required'),
  password: z.string().min(1, 'Password is required'),
  tenantKey: z.string().optional(),
});

type CredentialsFormValues = z.infer<typeof credentialsSchema>;

export function CredentialsForm() {
  const setCredentialsAuth = useAuthStore((s) => s.setCredentialsAuth);
  const { login } = useAuth();
  const navigate = useNavigate();
  const search = useSearch({ from: '/(auth)/login' });
  const [isLoading, setIsLoading] = useState(false);

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<CredentialsFormValues>({
    resolver: zodResolver(credentialsSchema),
  });

  const onSubmit = async (data: CredentialsFormValues) => {
    setIsLoading(true);
    try {
      const response = await login(data.username, data.password, data.tenantKey || undefined);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const userPayload = response.user as any;
      const resolvedTenantId = userPayload.tenantId || '';
      const resolvedTenantKey = userPayload.tenantKey || data.tenantKey || '';
      setCredentialsAuth(
        response.token,
        {
          id: response.user.id,
          email: response.user.email,
          username: response.user.username,
          roles: response.user.roles || [],
          permissions: response.user.permissions || [],
        },
        resolvedTenantId,
        resolvedTenantKey,
        response.refreshToken,
      );
      navigate({ to: search.redirect || '/' });
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
    } catch (error) {
      toast.error('Login failed. Please check your credentials.');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="username">Username</Label>
        <div className="relative">
          <User className="text-muted-foreground absolute left-3 top-1/2 size-4 -translate-y-1/2" />
          <Input id="username" type="text" placeholder="Enter your username" className="pl-10" {...register('username')} />
        </div>
        {errors.username && <p className="text-destructive text-sm">{errors.username.message}</p>}
      </div>
      <div className="space-y-2">
        <Label htmlFor="password">Password</Label>
        <div className="relative">
          <Lock className="text-muted-foreground absolute left-3 top-1/2 size-4 -translate-y-1/2" />
          <Input id="password" type="password" placeholder="Enter your password" className="pl-10" {...register('password')} />
        </div>
        {errors.password && <p className="text-destructive text-sm">{errors.password.message}</p>}
      </div>
      <div className="space-y-2">
        <Label htmlFor="tenantKey-creds">
          Tenant Key <span className="text-muted-foreground text-xs">(optional for global admin)</span>
        </Label>
        <div className="relative">
          <Building2 className="text-muted-foreground absolute left-3 top-1/2 size-4 -translate-y-1/2" />
          <Input id="tenantKey-creds" type="text" placeholder="Leave empty for global admin access" className="pl-10" {...register('tenantKey')} />
        </div>
        {errors.tenantKey && <p className="text-destructive text-sm">{errors.tenantKey.message}</p>}
      </div>
      <Button type="submit" className="w-full" disabled={isLoading}>
        {isLoading ? 'Signing in...' : 'Sign In'}
      </Button>
    </form>
  );
}
