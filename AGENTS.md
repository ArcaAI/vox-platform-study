# AGENTS.md

- **MUST** use `vscode_askQuestions` to ask questions when you need confirmation, more information, clarification, or context from the user.
- **MUST** not write long python/node scripts into the Terminal interface.

<!-- GITHUB-INDEX-START -->

## Available Agents

Located in `.github/agents/`:

| Agent | Description |
|-------|-------------|
| Architect | Software architecture specialist for system design, scalability, and technical decision-making. Use PROACTIVELY when planning new features, refactoring large systems, or making architectural decisions. |
| Brainstormer | Elite software engineering expert specializing in system architecture design, technical decision-making, and solution optimization. Use PROACTIVELY for architectural decisions, feasibility analysis, trade-off evaluation, and technical strategy. Emphasizes YAGNI, KISS, and DRY principles with brutal honesty about constraints and alternatives. |
| Build Error Resolver | Build and TypeScript error resolution specialist. Use PROACTIVELY when build fails or type errors occur. Fixes build/type errors only with minimal diffs, no architectural edits. Focuses on getting the build green quickly. |
| Chief Of Staff | Personal communication chief of staff that triages email, Slack, LINE, and Messenger. Classifies messages into 4 tiers (skip/info_only/meeting_info/action_required), generates draft replies, and enforces post-send follow-through via hooks. Use when managing multi-channel communication workflows. |
| Code Reviewer | Expert code review specialist. Proactively reviews code for quality, security, and maintainability. Use immediately after writing or modifying code. MUST BE USED for all code changes. |
| Codex Analyzer | Senior technical analyst agent for architecture evaluation, solution design, and strategic technical decisions. Provides structured analysis reports with recommendations, focusing on system architecture, scalability, security, and technology stack assessment. |
| Codex Architect | Senior backend architect specializing in scalable API design, database architecture, and production-grade code. Provides architectural analysis, design decisions, and implementation guidance with unified diff patch output. Operates in a read-only sandbox with zero file system write permissions. |
| Codex Debugger | Senior backend debugging specialist for diagnosing API, database, and server-side issues. Provides structured diagnostic reports with hypotheses, validation strategies, and root cause analysis. Operates in a read-only environment with zero file system write permissions. |
| Codex Optimizer | Senior performance engineer agent for backend, database, and system optimization. Analyzes code and queries for bottlenecks, recommends improvements, and provides unified diff patches. Operates in a read-only sandbox with zero file system write permission. |
| Codex Reviewer | Senior backend code reviewer agent for quality, security, performance, and reliability validation. Provides structured review reports with scores and actionable feedback. |
| Codex Tester | Senior backend test engineer specializing in API and backend testing.
- Focus: Unit, integration, and contract tests for backend systems.
- Constraints: Read-only sandbox, never modify production code, output only Unified Diff Patch for test files.
- Approach: AAA and BDD patterns, test isolation, descriptive test names, edge case coverage. |
| Database Reviewer | PostgreSQL database specialist for query optimization, schema design, security, and performance. Use PROACTIVELY when writing SQL, creating migrations, designing schemas, or troubleshooting database performance. Incorporates Supabase best practices. |
| Doc Updater | Documentation and codemap specialist. Use PROACTIVELY for updating codemaps and documentation. Runs /update-codemaps and /update-docs, generates docs/CODEMAPS/*, updates READMEs and guides. |
| E2e Runner | End-to-end testing specialist using Vercel Agent Browser (preferred) with Playwright fallback. Use PROACTIVELY for generating, maintaining, and running E2E tests. Manages test journeys, quarantines flaky tests, uploads artifacts (screenshots, videos, traces), and ensures critical user flows work. |
| Gemini Analyzer | Senior UI/UX analyst agent for structured design system, user experience, and frontend architecture analysis. Provides read-only, actionable reports with recommendations, focusing on consistency, accessibility, performance, and progressive enhancement. No code changes; strictly analysis and guidance. |
| Gemini Architect | Senior frontend architect specializing in UI/UX design systems, scalable component architecture, and modern web application structure. |
| Gemini Debugger | Senior frontend debugging specialist for diagnosing UI, component, styling, and interaction issues. Provides structured diagnostic reports with hypotheses, validation strategies, and root cause analysis. No code changes or file system writes. |
| Gemini Optimizer | Senior frontend performance engineer specializing in React optimization, bundle size reduction, and Core Web Vitals improvement. Analyze, measure, and recommend optimizations for rendering, bundle, loading, and runtime performance. Provide actionable reports and unified diff patches. No file system write access; read-only sandbox. |
| Gemini Reviewer | Gemini Reviewer is a senior UI review agent specializing in frontend code quality, accessibility, and design system compliance. It provides structured reviews with scores, focusing on UX, accessibility, consistency, performance, and responsive design. The agent operates in a read-only sandbox and outputs validation reports for bugfix validation. |
| Gemini Tester | Senior frontend test engineer agent specializing in component, user interaction, accessibility, and visual regression testing. Operates in a strict read-only sandbox, providing unified diff patch outputs for test files only. Focuses on user-facing behaviors, edge cases, and accessibility compliance using React Testing Library, Cypress, Playwright, and best practices for accessible queries and async operations. |
| Harness Optimizer | Analyze and improve the local agent harness configuration for reliability, cost, and throughput. |
| Loop Operator | Operate autonomous agent loops, monitor progress, and intervene safely when loops stall. |
| Planner | Expert planning specialist for complex features and refactoring. Use PROACTIVELY when users request feature implementation, architectural changes, or complex refactoring. Automatically activated for planning tasks. |
| Python Reviewer | Expert Python code reviewer specializing in PEP 8 compliance, Pythonic idioms, type hints, security, and performance. Use for all Python code changes. MUST BE USED for Python projects. |
| Refactor Cleaner | Dead code cleanup and consolidation specialist. Use PROACTIVELY for removing unused code, duplicates, and refactoring. Runs analysis tools (knip, depcheck, ts-prune) to identify dead code and safely removes it. |
| Security Reviewer | Security vulnerability detection and remediation specialist. Use PROACTIVELY after writing code that handles user input, authentication, API endpoints, or sensitive data. Flags secrets, SSRF, injection, unsafe crypto, and OWASP Top 10 vulnerabilities. |
| Tdd Guide | Test-Driven Development specialist enforcing write-tests-first methodology. Use PROACTIVELY when writing new features, fixing bugs, or refactoring code. Ensures 80%+ test coverage. |


## Available Skills

Located in `.github/skills/`:

| Skill | Description |
|-------|-------------|
| Agent Browser | Browser automation CLI for AI agents. Use when the user needs to interact with websites, including navigating pages, filling forms, clicking buttons, taking screenshots, extracting data, testing web apps, or automating any browser task. Triggers include requests to "open a website", "fill out a form", "click a button", "take a screenshot", "scrape data from a page", "test this web app", "login to a site", "automate browser actions", or any task requiring programmatic web interaction. |
| Api Designer | Use when designing REST or GraphQL APIs, creating OpenAPI specifications, or planning API architecture. Invoke for resource modeling, versioning strategies, pagination patterns, error handling standards. |
| Architecture Designer | Use when designing new system architecture, reviewing existing designs, or making architectural decisions. Invoke for system design, architecture review, design patterns, ADRs, scalability planning. |
| Backend Patterns | Backend architecture patterns, API design, database optimization, and server-side best practices for Node.js, Express, and Next.js API routes. |
| Brainstorming | You MUST use this before any creative work - creating features, building components, adding functionality, or modifying behavior. Explores user intent, requirements and design before implementation. |
| Cli Developer | Use when building CLI tools, implementing argument parsing, or adding interactive prompts. Invoke for CLI design, argument parsing, interactive prompts, progress indicators, shell completions. |
| Code Documenter | Use when adding docstrings, creating API documentation, or building documentation sites. Invoke for OpenAPI/Swagger specs, JSDoc, doc portals, tutorials, user guides. |
| Code Reviewer | Use when reviewing pull requests, conducting code quality audits, or identifying security vulnerabilities. Invoke for PR reviews, code quality checks, refactoring suggestions. |
| Database Optimizer | Use when investigating slow queries, analyzing execution plans, or optimizing database performance. Invoke for index design, query rewrites, configuration tuning, partitioning strategies, lock contention resolution. |
| Devops Engineer | Use when setting up CI/CD pipelines, containerizing applications, or managing infrastructure as code. Invoke for pipelines, Docker, Kubernetes, cloud platforms, GitOps. |
| Docs Seeker | Search library/framework documentation via llms.txt (context7.com). Use for API docs, GitHub repository analysis, technical documentation lookup, latest library features. |
| Document Skills | Create, edit, and analyze documents (.docx, .pdf, .pptx, .xlsx, .csv, .tsv). Use for document generation, data analysis, spreadsheet formulas, formatting, charts, pivot tables, and document manipulation. |
| E2e Testing | Playwright E2E testing patterns, Page Object Model, configuration, CI/CD integration, artifact management, and flaky test strategies. |
| Enhance Prompt | Transforms vague UI ideas into polished, Stitch-optimized prompts. Enhances specificity, adds UI/UX keywords, injects design system context, and structures output for better generation results. |
| Find Skills | Helps users discover and install agent skills when they ask questions like "how do I do X", "find a skill for X", "is there a skill that can...", or express interest in extending capabilities. This skill should be used when the user is looking for functionality that might exist as an installable skill. |
| Integration Testing | Integration testing patterns for APIs, databases, and authenticated endpoints using Supertest and pytest. Covers API testing, authentication flows, database operations, and request/response validation. |
| Microservices Architect | Use when designing distributed systems, decomposing monoliths, or implementing microservices patterns. Invoke for service boundaries, DDD, saga patterns, event sourcing, service mesh, distributed tracing. |
| Monitoring Expert | Use when setting up monitoring systems, logging, metrics, tracing, or alerting. Invoke for dashboards, Prometheus/Grafana, load testing, profiling, capacity planning. |
| Performance Testing | Load testing, stress testing, spike testing, and performance metrics with k6. Includes threshold configuration, API testing with authentication, and performance benchmarking strategies. |
| Problem Solving | Apply systematic problem-solving techniques when stuck. Use for complexity spirals, innovation blocks, recurring patterns, assumption constraints, simplification cascades, scale uncertainty. |
| Prompt Engineer | Use when designing prompts for LLMs, optimizing model performance, building evaluation frameworks, or implementing advanced prompting techniques like chain-of-thought, few-shot learning, or structured outputs. |
| Scout | Fast codebase scouting using parallel agents. Use for file discovery, task context gathering, quick searches across directories. Supports internal (Explore) and external (Gemini/OpenCode) agents. |
| Secure Code Guardian | Use when implementing authentication/authorization, securing user input, or preventing OWASP Top 10 vulnerabilities. Invoke for authentication, authorization, input validation, encryption, OWASP Top 10 prevention. |
| Security Reviewer | Use when conducting security audits, reviewing code for vulnerabilities, or analyzing infrastructure security. Invoke for SAST scans, penetration testing, DevSecOps practices, cloud security reviews. |
| Security Testing | Security testing patterns for authentication, authorization, input validation, and vulnerability detection. Covers OWASP Top 10 testing, rate limiting, security headers, and common attack vectors. |
| Shadcn | Manages shadcn components and projects — adding, searching, fixing, debugging, styling, and composing UI. Provides project context, component docs, and usage examples. Applies when working with shadcn/ui, component registries, presets, --preset codes, or any project with a components.json file. Also triggers for "shadcn init", "create an app with --preset", or "switch to --preset". |
| Skill Creator | Guide for creating effective skills. This skill should be used when users want to create a new skill (or update an existing skill) that extends Claude's capabilities with specialized knowledge, workflows, or tool integrations. |
| Sql Pro | Use when optimizing SQL queries, designing database schemas, or tuning database performance. Invoke for complex queries, window functions, CTEs, indexing strategies, query plan analysis. |
| Systematic Debugging | Use when encountering any bug, test failure, or unexpected behavior, before proposing fixes |
| Tanstack Query | Powerful asynchronous state management, server-state utilities, and data fetching for TS/JS, React, Vue, Solid, Svelte & Angular. |
| Test Driven Development | Use when implementing any feature or bugfix, before writing implementation code |
| Typescript | Senior TypeScript developer expertise for writing clean, efficient, and type-safe code. Use when building TypeScript applications, optimizing TypeScript code, reviewing TypeScript for best practices, debugging TypeScript issues, implementing advanced type systems, or when user mentions TypeScript, generics, or needs help with full-stack type safety |
| Ui Ux Pro Max | UI/UX design intelligence for web and mobile. Includes 50+ styles, 161 color palettes, 57 font pairings, 161 product types, 99 UX guidelines, and 25 chart types across 10 stacks (React, Next.js, Vue, Svelte, SwiftUI, React Native, Flutter, Tailwind, shadcn/ui, and HTML/CSS). Actions: plan, build, create, design, implement, review, fix, improve, optimize, enhance, refactor, and check UI/UX code. Projects: website, landing page, dashboard, admin panel, e-commerce, SaaS, portfolio, blog, and mobile app. Elements: button, modal, navbar, sidebar, card, table, form, and chart. Styles: glassmorphism, claymorphism, minimalism, brutalism, neumorphism, bento grid, dark mode, responsive, skeuomorphism, and flat design. Topics: color systems, accessibility, animation, layout, typography, font pairing, spacing, interaction states, shadow, and gradient. Integrations: shadcn/ui MCP for component search and examples. |
| Unit Testing | Unit testing patterns and best practices for Jest, Vitest, and pytest. Covers mocking strategies, test organization, and common assertions for isolated component testing. |
| Verification Before Completion | Use when about to claim work is complete, fixed, or passing, before committing or creating PRs - requires running verification commands and confirming output before making any success claims; evidence before assertions always |
| Web Design Guidelines | Review UI code for Web Interface Guidelines compliance. Use when asked to "review my UI", "check accessibility", "audit design", "review UX", or "check my site against best practices". |

<!-- GITHUB-INDEX-END -->
