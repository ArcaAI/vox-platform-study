import { Button } from '@arcaai/ui/button';
import { useNavigate, useRouter } from '@tanstack/react-router';

export function ForbiddenError() {
  const navigate = useNavigate();
  const { history } = useRouter();

  return (
    <div className="h-svh">
      <div className="m-auto flex h-full w-full flex-col items-center justify-center gap-2">
        <h1 className="text-[7rem] leading-tight font-bold">403</h1>
        <span className="font-medium">Access Forbidden</span>
        <p className="text-muted-foreground text-center">
          You don't have permission to access this resource. <br />
          Please contact your administrator.
        </p>
        <div className="mt-6 flex gap-4">
          <Button variant="outline" onClick={() => history.go(-1)}>
            Go Back
          </Button>
          <Button onClick={() => navigate({ to: '/' })}>Back to Home</Button>
        </div>
      </div>
    </div>
  );
}
