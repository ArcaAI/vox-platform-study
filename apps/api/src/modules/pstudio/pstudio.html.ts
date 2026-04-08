const STUDIO_VERSION = '0.15.0';

export function getStudioHtml(studioEndpointUrl: string, token: string): string {
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
                const executor = createStudioBFFClient({
                    url: '${studioEndpointUrl}',
                    customHeaders: { 'Authorization': 'Bearer ${token}' },
                });
                return createPostgresAdapter({ executor });
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
