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
    // scroll-pt-32: keeps focus/anchor scrolls clear of the sticky console
    // chrome — topbar h-14 + up to two session banners (WCAG 2.4.11).
    <html lang="en" className={`${inter.variable} scroll-pt-32`} suppressHydrationWarning>
      <body className="bg-background text-foreground min-h-svh font-sans antialiased">{children}</body>
    </html>
  );
}
