'use client';

import { useMemo, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@arcaai/ui/components/shadcn/dialog';
import { Input } from '@arcaai/ui/components/shadcn/input';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@arcaai/ui/components/shadcn/select';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { Switch } from '@arcaai/ui/components/shadcn/switch';
import { GatewayError } from '@/shared/api';
import { useDepartmentOptions, useRoleOptions } from '@/shared/catalog';
import { useCreateUser } from '../api/hooks';
import type { CreateUserRequest } from '../api/types';

/**
 * Never assignable from this dialog — the platform-wide role is granted by a
 * super admin on the user detail, and the gateway refuses it on this path
 * anyway (`assertAssignableRoleTier`). Same exclusion the identity-provider
 * default-role picker makes.
 */
const UNASSIGNABLE_ROLE = 'SUPER_ADMIN';

/**
 * Create-user dialog (frame 20 primary action).
 *
 * Role and department are REQUIRED (TASK-983 R6 / OD-4): `User` carries no
 * `tenantId`, so membership IS the role assignment + department pair. Creating
 * a user without them produced a row belonging to no tenant — one that could
 * not sign in and that its own creator could not reopen (404 through
 * `assertUserInScope`). The gateway now refuses that create
 * (`USER_ROLE_REQUIRED` / `USER_DEPARTMENT_REQUIRED`); this form collects both
 * so an admin never meets the 400. Service accounts keep the department
 * exemption, matching `assertUserBelongsToTenant`.
 *
 * Both pickers fall back to a free-text id input when the caller cannot list
 * the catalog (the `AssignRoleDialog` precedent), so the flow never dead-ends.
 * Navigates to the new user on success.
 */
export function CreateUserDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const router = useRouter();
  const createUser = useCreateUser();
  const roles = useRoleOptions();
  const departments = useDepartmentOptions();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [email, setEmail] = useState('');
  const [externalId, setExternalId] = useState('');
  const [serviceAccount, setServiceAccount] = useState(false);
  const [roleId, setRoleId] = useState('');
  const [departmentId, setDepartmentId] = useState('');

  const roleOptions = useMemo(() => roles.options.filter((option) => option.label !== UNASSIGNABLE_ROLE), [roles.options]);
  const roleFallback = roles.isError || (!roles.isLoading && roleOptions.length === 0);
  const departmentFallback = departments.isError || (!departments.isLoading && departments.options.length === 0);

  const departmentRequired = !serviceAccount;
  const valid =
    username.trim().length > 0 && password.length > 0 && roleId.trim().length > 0 && (!departmentRequired || departmentId.trim().length > 0);

  function handleOpenChange(next: boolean) {
    if (!next) {
      setUsername('');
      setPassword('');
      setEmail('');
      setExternalId('');
      setServiceAccount(false);
      setRoleId('');
      setDepartmentId('');
      createUser.reset();
    }
    onOpenChange(next);
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!valid) return;
    const department = departmentId.trim();
    const body: CreateUserRequest = {
      username: username.trim(),
      password,
      roleId: roleId.trim(),
      // Dropped for a service account even if a department was picked before
      // the switch was flipped — the gateway exempts them, and sending a stale
      // pick would file a machine identity under a clinical department.
      ...(departmentRequired && department ? { departmentId: department } : {}),
      ...(email.trim() ? { email: email.trim() } : {}),
      ...(externalId.trim() ? { externalId: externalId.trim() } : {}),
      ...(serviceAccount ? { isServiceAccount: true } : {}),
    };
    createUser.mutate(body, {
      onSuccess: (created) => {
        toast.success('User created');
        handleOpenChange(false);
        if (created?.id) router.push(`/users/${created.id}`);
      },
      onError: (error) => toast.error(error instanceof GatewayError ? error.message : 'Could not create the user.'),
    });
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New user</DialogTitle>
          <DialogDescription>
            Grants console or SDK access. The role and department make the user a member of this tenant — without them the account cannot sign
            in.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="create-user-username">
              Username{' '}
              <span aria-hidden className="text-destructive">
                *
              </span>
            </Label>
            <Input
              id="create-user-username"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              placeholder="mia.okafor"
              autoComplete="off"
              required
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="create-user-password">
              Password{' '}
              <span aria-hidden className="text-destructive">
                *
              </span>
            </Label>
            <Input
              id="create-user-password"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="new-password"
              required
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="create-user-role">
              Role{' '}
              <span aria-hidden className="text-destructive">
                *
              </span>
            </Label>
            {roleFallback ? (
              <Input
                id="create-user-role"
                value={roleId}
                onChange={(event) => setRoleId(event.target.value)}
                placeholder="Role id"
                autoComplete="off"
                className="font-mono"
                required
              />
            ) : (
              <Select value={roleId} onValueChange={setRoleId}>
                <SelectTrigger id="create-user-role" className="w-full">
                  <SelectValue placeholder={roles.isLoading ? 'Loading roles…' : 'Select a role'} />
                </SelectTrigger>
                <SelectContent>
                  {roleOptions.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            {roleId ? null : (
              <p className="text-muted-foreground text-xs">Required — the role grants the user its permissions in this tenant.</p>
            )}
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="create-user-department">
              Department{' '}
              {departmentRequired ? (
                <span aria-hidden className="text-destructive">
                  *
                </span>
              ) : null}
            </Label>
            {departmentFallback ? (
              <Input
                id="create-user-department"
                value={departmentId}
                onChange={(event) => setDepartmentId(event.target.value)}
                placeholder="Department id"
                autoComplete="off"
                className="font-mono"
                disabled={!departmentRequired}
              />
            ) : (
              <Select value={departmentId} onValueChange={setDepartmentId} disabled={!departmentRequired}>
                <SelectTrigger id="create-user-department" className="w-full">
                  <SelectValue placeholder={departments.isLoading ? 'Loading departments…' : 'Select a department'} />
                </SelectTrigger>
                <SelectContent>
                  {departments.options.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            {departmentRequired ? (
              departmentId ? null : (
                <p className="text-muted-foreground text-xs">Required — a user with no department cannot be opened or reached in this tenant.</p>
              )
            ) : (
              <p className="text-muted-foreground text-xs">Not required for a service account.</p>
            )}
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="create-user-email">Email</Label>
            <Input
              id="create-user-email"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="mia@example.org"
              autoComplete="off"
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="create-user-external-id">External ID</Label>
            <Input
              id="create-user-external-id"
              value={externalId}
              onChange={(event) => setExternalId(event.target.value)}
              placeholder="Directory / SSO identifier"
              autoComplete="off"
              className="font-mono"
            />
          </div>
          <div className="flex items-center justify-between gap-4">
            <div className="flex flex-col gap-0.5">
              <Label htmlFor="create-user-service-account">Service account</Label>
              <p className="text-muted-foreground text-xs">Machine identity for API keys and integrations.</p>
            </div>
            <Switch id="create-user-service-account" checked={serviceAccount} onCheckedChange={setServiceAccount} />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!valid || createUser.isPending}>
              {createUser.isPending ? <Spinner /> : null}
              Create user
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
