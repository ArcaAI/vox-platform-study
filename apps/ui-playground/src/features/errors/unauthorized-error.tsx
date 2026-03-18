import { Button } from '@arcaai/ui/button';
import { useNavigate } from '@tanstack/react-router';

export function UnauthorizedError() {
    const navigate = useNavigate();

    return (
        <div className="h-svh">
            <div className="m-auto flex h-full w-full flex-col items-center justify-center gap-2">
                <h1 className="text-[7rem] leading-tight font-bold">401</h1>
                <span className="font-medium">Unauthorized</span>
                <p className="text-muted-foreground text-center">
                    Your session has expired or you are not authenticated. <br />
                    Please log in again.
                </p>
                <div className="mt-6 flex gap-4">
                    <Button onClick={() => navigate({ to: '/login' })}>Go to Login</Button>
                </div>
            </div>
        </div>
    );
}
