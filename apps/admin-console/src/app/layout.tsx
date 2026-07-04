import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import type { ReactNode } from 'react';
import './globals.css';

const inter = Inter({
    subsets: ['latin'],
    variable: '--font-inter',
});

export const metadata: Metadata = {
    title: {
        default: 'HOPE Admin Console',
        template: '%s | HOPE Admin Console',
    },
    description: 'Administration console for the HOPE healthcare AI platform',
};

export default function RootLayout({ children }: { children: ReactNode }) {
    return (
        // suppressHydrationWarning: next-themes mutates <html> before hydration.
        <html lang="en" className={inter.variable} suppressHydrationWarning>
            <body className="bg-background text-foreground min-h-svh font-sans antialiased">{children}</body>
        </html>
    );
}
