// Keep in lock-step with the @prisma/studio-core version resolved in
// packages/applications (BFF executor) and apps/ui-playground (bundled UI) so
// the CDN shell speaks the same BFF wire format as the server executor.
const STUDIO_VERSION = '0.31.2';

/**
 * Server-rendered standalone Prisma Studio shell.
 *
 * BUG-003 — the shell is consumed through an authenticating BFF proxy (the
 * admin console's /api/hope/admin/pstudio route): the GET that served this
 * HTML carried the operator's credential injected server-side from the sealed
 * session cookie. The shell therefore posts its queries back to the SAME
 * path it was served from (`window.location.pathname`), so the session cookie
 * rides along and the proxy injects the bearer on every query too. No token
 * ever reaches the browser (supersedes the TASK-336 OB-11 `#token=` fragment
 * hand-off, which was unsatisfiable under the BFF cookie session and left the
 * POSTs hitting the gateway directly with an empty bearer → 401).
 *
 * TASK-336 BR-02 — HOPE's tables all live in the `core` schema; studio-core's
 * postgres adapter hardcodes `defaultSchema: "public"`, which is empty here and
 * makes the UI render "No tables found". We override the adapter's
 * `defaultSchema` to `core` so the table list resolves.
 */
export function getStudioHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>HOPE — Prisma Studio</title>
    <link rel="stylesheet" href="https://esm.sh/@prisma/studio-core@${STUDIO_VERSION}/ui/index.css">
    <style>
        *, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }
        html, body, #root { height: 100%; width: 100%; overflow: hidden; }
        body { font-family: system-ui, -apple-system, sans-serif; }

        #loading {
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            height: 100%;
            gap: 16px;
            color: #64748b;
            font-size: 14px;
        }
        #loading .spinner {
            width: 32px;
            height: 32px;
            border: 3px solid #e2e8f0;
            border-top-color: #6366f1;
            border-radius: 50%;
            animation: spin 0.8s linear infinite;
        }
        @keyframes spin { to { transform: rotate(360deg); } }

        #error-banner {
            display: none;
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            padding: 12px 20px;
            background: #fef2f2;
            border-bottom: 1px solid #fecaca;
            color: #991b1b;
            font-size: 13px;
            z-index: 9999;
        }
    </style>
</head>
<body>
    <div id="error-banner"></div>
    <div id="root">
        <div id="loading">
            <div class="spinner"></div>
            <span>Loading Prisma Studio…</span>
        </div>
    </div>

    <script type="importmap">
    {
        "imports": {
            "react": "https://esm.sh/react@18.3.1",
            "react/jsx-runtime": "https://esm.sh/react@18.3.1/jsx-runtime",
            "react-dom/client": "https://esm.sh/react-dom@18.3.1/client?deps=react@18.3.1",
            "@prisma/studio-core/ui": "https://esm.sh/@prisma/studio-core@${STUDIO_VERSION}/ui?deps=react@18.3.1,react-dom@18.3.1",
            "@prisma/studio-core/data/postgres-core": "https://esm.sh/@prisma/studio-core@${STUDIO_VERSION}/data/postgres-core?deps=react@18.3.1,react-dom@18.3.1",
            "@prisma/studio-core/data/bff": "https://esm.sh/@prisma/studio-core@${STUDIO_VERSION}/data/bff?deps=react@18.3.1,react-dom@18.3.1"
        }
    }
    </script>

    <script type="module">
        import React from 'react';
        import { createRoot } from 'react-dom/client';
        import { Studio } from '@prisma/studio-core/ui';
        import { createPostgresAdapter } from '@prisma/studio-core/data/postgres-core';
        import { createStudioBFFClient } from '@prisma/studio-core/data/bff';

        const { useMemo, createElement: h } = React;

        function showError(msg) {
            const banner = document.getElementById('error-banner');
            banner.textContent = msg;
            banner.style.display = 'block';
        }

        function App() {
            const adapter = useMemo(() => {
                // BUG-003: query the exact path that served this shell. The
                // authenticating proxy in front of it (console BFF) receives
                // the session cookie on these same-origin POSTs and injects
                // the operator's bearer server-side — no token in the browser.
                const executor = createStudioBFFClient({
                    url: window.location.pathname,
                });
                // BR-02: HOPE tables live in the core schema; studio-core defaults
                // to the (empty) public schema, which renders "No tables found".
                return Object.assign(createPostgresAdapter({ executor }), { defaultSchema: 'core' });
            }, []);

            return h(Studio, { adapter });
        }

        try {
            const root = createRoot(document.getElementById('root'));
            root.render(h(App));
        } catch (err) {
            showError('Failed to initialize Prisma Studio: ' + err.message);
        }
    </script>
</body>
</html>`;
}
