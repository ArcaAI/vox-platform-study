import { Avatar, AvatarFallback } from '@arcaai/ui/avatar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@arcaai/ui/dropdown-menu';
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem, useSidebar } from '@arcaai/ui/sidebar';
import { useAuthStore } from '@/store/auth-store';
import { useNavigate } from '@tanstack/react-router';
import { LogOut, MoreVertical, Key } from 'lucide-react';

export function NavUser() {
  const { isMobile } = useSidebar();
  const { user, authMethod, logout } = useAuthStore();
  const navigate = useNavigate();

  const displayName = user?.username || (authMethod === 'apiKey' ? 'API Key User' : 'User');
  const displayEmail = user?.email || (authMethod === 'apiKey' ? 'Authenticated via API Key' : '');
  const initials = displayName.slice(0, 2).toUpperCase();

  const handleLogout = () => {
    logout();
    navigate({ to: '/login' });
  };

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton
              size="lg"
              className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground cursor-pointer"
            >
              <Avatar className="h-8 w-8 rounded-lg">
                <AvatarFallback className="rounded-lg">{initials}</AvatarFallback>
              </Avatar>
              <div className="grid flex-1 text-left text-sm leading-tight">
                <span className="truncate font-medium">{displayName}</span>
                <span className="text-muted-foreground truncate text-xs">{displayEmail}</span>
              </div>
              <MoreVertical className="ml-auto size-4" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className="w-(--radix-dropdown-menu-trigger-width) min-w-56 rounded-lg"
            side={isMobile ? 'bottom' : 'right'}
            align="end"
            sideOffset={4}
          >
            <DropdownMenuLabel className="p-0 font-normal">
              <div className="flex items-center gap-2 px-1 py-1.5 text-left text-sm">
                <Avatar className="h-8 w-8 rounded-lg">
                  <AvatarFallback className="rounded-lg">{initials}</AvatarFallback>
                </Avatar>
                <div className="grid flex-1 text-left text-sm leading-tight">
                  <span className="truncate font-medium">{displayName}</span>
                  <span className="text-muted-foreground truncate text-xs">{displayEmail}</span>
                </div>
              </div>
            </DropdownMenuLabel>
            {authMethod === 'apiKey' && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem disabled>
                  <Key className="size-4" />
                  API Key Authentication
                </DropdownMenuItem>
              </>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={handleLogout}>
              <LogOut className="size-4" />
              Log out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
