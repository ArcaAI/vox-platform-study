#!/usr/bin/env python3
"""
Render the standalone HOPE API Gateway explorer.

Inputs:
  review/api_explore_3/inventory/endpoint-catalog.json
  review/api_explore_3/inventory/coverage-report.json

Output:
  review/api_explore_3/api-gateway-explorer.html

No external assets, no build step, no network required. The generated HTML
embeds the catalog as JSON and opens directly from disk.
"""
from __future__ import annotations

import json
from pathlib import Path

ROOT = Path('/Users/apple/repos/VOX')
OUT = ROOT / 'review/api_explore_3'
CATALOG = OUT / 'inventory/endpoint-catalog.json'
COVERAGE = OUT / 'inventory/coverage-report.json'
TARGET = OUT / 'api-gateway-explorer.html'

catalog = json.loads(CATALOG.read_text())
coverage = json.loads(COVERAGE.read_text())

payload = json.dumps(catalog, ensure_ascii=False, separators=(',', ':')).replace('</', '<\\/')
coverage_json = json.dumps(coverage, ensure_ascii=False, separators=(',', ':')).replace('</', '<\\/')
revision = catalog['meta']['revision']
short_revision = revision[:12]
generated = catalog['meta']['generatedAt']

HTML = r'''<!doctype html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>HOPE API Gateway Explorer</title>
<style>
:root{
  --bg:#0a0d13; --bg-2:#0e131b; --panel:#111722; --panel-2:#151d2b; --panel-3:#1a2434;
  --line:#243044; --line-2:#2f3d55; --text:#e8edf5; --muted:#97a5bc; --faint:#6f7d93;
  --accent:#7dd3fc; --accent-2:#38bdf8; --green:#34d399; --amber:#fbbf24; --red:#fb7185;
  --violet:#c084fc; --blue:#60a5fa; --orange:#fb923c; --pink:#f472b6;
  --mono:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,"Liberation Mono",monospace;
  --sans:ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,Helvetica,Arial,sans-serif;
  --shadow:0 18px 50px rgba(0,0,0,.38);
}
html[data-theme="light"]{
  --bg:#f5f7fb; --bg-2:#eef2f8; --panel:#ffffff; --panel-2:#f7f9fc; --panel-3:#eef3fa;
  --line:#dbe3ee; --line-2:#c7d2e2; --text:#111827; --muted:#5b6b82; --faint:#7b8aa0;
  --accent:#0369a1; --accent-2:#0284c7; --green:#047857; --amber:#b45309; --red:#be123c;
  --violet:#7e22ce; --blue:#1d4ed8; --orange:#c2410c; --pink:#be185d;
  --shadow:0 18px 45px rgba(15,23,42,.12);
}
*{box-sizing:border-box}
html,body{height:100%}
body{margin:0;background:var(--bg);color:var(--text);font-family:var(--sans);font-size:14px;line-height:1.5}
button,input,select{font:inherit}
button{cursor:pointer}
a{color:var(--accent);text-decoration:none}
a:hover{text-decoration:underline}
::-webkit-scrollbar{width:10px;height:10px}
::-webkit-scrollbar-thumb{background:var(--line-2);border-radius:99px;border:2px solid var(--bg)}
::-webkit-scrollbar-track{background:transparent}

.topbar{position:sticky;top:0;z-index:30;display:flex;align-items:center;justify-content:space-between;gap:20px;padding:12px 20px;background:color-mix(in srgb,var(--bg) 88%,transparent);backdrop-filter:blur(16px);border-bottom:1px solid var(--line)}
.brand{display:flex;align-items:center;gap:12px;min-width:0}
.mark{width:36px;height:36px;border-radius:10px;display:grid;place-items:center;font-weight:800;color:#06111e;background:linear-gradient(135deg,var(--accent),var(--violet));box-shadow:0 8px 22px rgba(56,189,248,.25);flex:none}
.brand h1{font-size:15px;line-height:1.2;margin:0;letter-spacing:.01em}
.brand p{margin:2px 0 0;color:var(--muted);font-size:11.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.topnav{display:flex;align-items:center;gap:6px;flex-wrap:wrap;justify-content:flex-end}
.topnav a,.topnav button{color:var(--muted);background:transparent;border:1px solid transparent;border-radius:8px;padding:6px 9px;font-size:12px;text-decoration:none}
.topnav a:hover,.topnav button:hover{color:var(--text);background:var(--panel-2);border-color:var(--line);text-decoration:none}

.coverage-strip{display:flex;gap:0;overflow:auto;border-bottom:1px solid var(--line);background:var(--bg-2)}
.stat{display:flex;align-items:baseline;gap:7px;padding:8px 16px;border-right:1px solid var(--line);white-space:nowrap}
.stat strong{font-family:var(--mono);font-size:12px;color:var(--text)}
.stat span{font-size:10.5px;color:var(--faint);text-transform:uppercase;letter-spacing:.06em}
.stat .rev{font-size:10px;color:var(--accent)}

.app{display:grid;grid-template-columns:minmax(330px,390px) minmax(0,1fr);height:calc(100vh - 96px);min-height:560px}
.rail{display:flex;flex-direction:column;min-height:0;border-right:1px solid var(--line);background:var(--bg-2)}
.rail-tools{padding:12px;border-bottom:1px solid var(--line);background:color-mix(in srgb,var(--bg-2) 92%,var(--panel))}
.search{display:flex;align-items:center;gap:8px;border:1px solid var(--line-2);background:var(--panel);border-radius:10px;padding:8px 10px}
.search:focus-within{border-color:var(--accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 18%,transparent)}
.search span{color:var(--faint);font-size:16px;line-height:1}
.search input{flex:1;min-width:0;border:0;outline:0;background:transparent;color:var(--text);font-size:12.5px}
.search kbd{border:1px solid var(--line);border-radius:5px;padding:0 5px;color:var(--faint);font-family:var(--mono);font-size:10px}
.filters{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:8px}
.filters select{width:100%;border:1px solid var(--line);border-radius:8px;background:var(--panel);color:var(--text);padding:6px 7px;font-size:11.5px;outline:none}
.filters select:focus{border-color:var(--accent)}
.toggle-row{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-top:8px}
.toggle-row label{display:flex;align-items:center;gap:5px;color:var(--muted);font-size:11.5px;cursor:pointer}
.toggle-row input{accent-color:var(--accent-2)}
.result-line{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:8px;color:var(--faint);font-size:11px}
.result-line b{color:var(--muted);font-family:var(--mono);font-weight:600}
.clear-btn{border:1px solid var(--line);background:transparent;color:var(--muted);border-radius:6px;padding:2px 7px;font-size:10px}
.clear-btn:hover{color:var(--text);border-color:var(--line-2)}
.endpoint-list{overflow:auto;min-height:0;padding:7px}
.ep-row{display:block;width:100%;text-align:left;border:1px solid transparent;border-left:3px solid transparent;border-radius:9px;background:transparent;color:var(--text);padding:8px 9px;margin:0 0 3px;transition:background .12s,border-color .12s}
.ep-row:hover{background:var(--panel);border-color:var(--line)}
.ep-row.active{background:color-mix(in srgb,var(--accent) 11%,var(--panel));border-color:color-mix(in srgb,var(--accent) 40%,var(--line));border-left-color:var(--accent)}
.ep-line{display:flex;align-items:center;gap:7px;min-width:0}
.method{display:inline-flex;align-items:center;justify-content:center;border-radius:5px;padding:1px 6px;font-family:var(--mono);font-size:9.5px;font-weight:800;letter-spacing:.04em;flex:none}
.method.GET{color:#86efac;background:rgba(52,211,153,.12);border:1px solid rgba(52,211,153,.25)}
.method.POST{color:#7dd3fc;background:rgba(56,189,248,.12);border:1px solid rgba(56,189,248,.25)}
.method.PUT{color:#fcd34d;background:rgba(251,191,36,.12);border:1px solid rgba(251,191,36,.25)}
.method.PATCH{color:#d8b4fe;background:rgba(192,132,252,.12);border:1px solid rgba(192,132,252,.25)}
.method.DELETE{color:#fda4af;background:rgba(251,113,133,.12);border:1px solid rgba(251,113,133,.25)}
.method.HEAD,.method.OPTIONS{color:#cbd5e1;background:rgba(148,163,184,.12);border:1px solid rgba(148,163,184,.25)}
.ep-path{font-family:var(--mono);font-size:11.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0;color:var(--text)}
.ep-sub{margin-top:3px;color:var(--muted);font-size:10.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ep-tags{display:flex;gap:4px;flex-wrap:wrap;margin-top:5px}
.mini-tag{border:1px solid var(--line);border-radius:999px;padding:1px 6px;color:var(--faint);font-size:9.5px;line-height:1.45;white-space:nowrap}
.mini-tag.micro{color:var(--violet);border-color:color-mix(in srgb,var(--violet) 35%,var(--line));background:color-mix(in srgb,var(--violet) 8%,transparent)}
.mini-tag.doc{color:var(--green);border-color:color-mix(in srgb,var(--green) 30%,var(--line))}
.mini-tag.plane{color:var(--blue);border-color:color-mix(in srgb,var(--blue) 28%,var(--line))}

.main{overflow:auto;min-width:0;background:radial-gradient(1100px 500px at 80% -10%,color-mix(in srgb,var(--accent) 8%,transparent),transparent 60%),var(--bg)}
.main-inner{max-width:1440px;margin:0 auto;padding:18px 20px 60px}
.empty{height:100%;display:grid;place-items:center;text-align:center;color:var(--muted);padding:40px}
.empty .big{font-size:18px;color:var(--text);margin-bottom:8px}
.hero{border:1px solid var(--line);border-radius:14px;background:linear-gradient(180deg,var(--panel),color-mix(in srgb,var(--panel) 88%,var(--bg)));box-shadow:var(--shadow);padding:16px 18px}
.crumb{display:flex;gap:7px;align-items:center;color:var(--faint);font-size:10.5px;text-transform:uppercase;letter-spacing:.08em}
.crumb b{color:var(--muted);font-weight:600}
.hero h2{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:6px 0 6px;font-family:var(--mono);font-size:20px;line-height:1.35;word-break:break-word}
.hero h2 .method{font-size:11px;padding:3px 8px}
.hero p.summary{margin:0;color:var(--muted);max-width:95ch;font-size:13px}
.hero-actions{display:flex;gap:6px;flex-wrap:wrap;margin-top:10px}
.btn{border:1px solid var(--line-2);background:var(--panel-2);color:var(--text);border-radius:8px;padding:6px 9px;font-size:11.5px}
.btn:hover{border-color:var(--accent);background:var(--panel-3)}
.btn.primary{background:color-mix(in srgb,var(--accent) 16%,var(--panel));border-color:color-mix(in srgb,var(--accent) 45%,var(--line));color:var(--accent)}
.meta{display:flex;gap:5px;flex-wrap:wrap;margin-top:10px}
.chip{border:1px solid var(--line);border-radius:7px;padding:3px 7px;font-size:10.5px;color:var(--muted);background:var(--panel-2)}
.chip b{color:var(--text);font-weight:600}
.chip.green{color:var(--green);border-color:color-mix(in srgb,var(--green) 32%,var(--line))}
.chip.amber{color:var(--amber);border-color:color-mix(in srgb,var(--amber) 32%,var(--line))}
.chip.red{color:var(--red);border-color:color-mix(in srgb,var(--red) 32%,var(--line))}
.chip.violet{color:var(--violet);border-color:color-mix(in srgb,var(--violet) 32%,var(--line))}

.grid{display:grid;grid-template-columns:minmax(0,1fr) 330px;gap:14px;margin-top:14px;align-items:start}
.stack{display:flex;flex-direction:column;gap:14px;min-width:0}
.panel{border:1px solid var(--line);border-radius:12px;background:var(--panel);overflow:hidden}
.panel-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:13px 15px;border-bottom:1px solid var(--line);background:color-mix(in srgb,var(--panel) 84%,var(--bg))}
.panel-head h3{margin:0;font-size:13px}
.panel-head p{margin:3px 0 0;color:var(--faint);font-size:11px;max-width:75ch}
.panel-body{padding:13px 15px}
.legend{display:flex;gap:5px;flex-wrap:wrap;justify-content:flex-end}
.conf{border-radius:999px;padding:1px 7px;font-size:9.5px;font-weight:700;letter-spacing:.03em;text-transform:uppercase;border:1px solid}
.conf.verified{color:var(--green);border-color:rgba(52,211,153,.35);background:rgba(52,211,153,.08)}
.conf.inferred{color:var(--amber);border-color:rgba(251,191,36,.35);background:rgba(251,191,36,.08)}
.conf.inferred-chain{color:var(--orange);border-color:rgba(251,146,60,.35);background:rgba(251,146,60,.08)}

.path-stage{margin-bottom:12px}
.path-stage:last-child{margin-bottom:0}
.stage-head{display:flex;align-items:center;gap:8px;margin-bottom:6px}
.stage-num{width:20px;height:20px;border-radius:6px;display:grid;place-items:center;background:var(--panel-3);border:1px solid var(--line);color:var(--faint);font-family:var(--mono);font-size:9.5px;flex:none}
.stage-title{font-size:10.5px;text-transform:uppercase;letter-spacing:.08em;color:var(--faint);font-weight:700}
.stage-count{font-size:10px;color:var(--faint);margin-left:auto}
.node-list{display:flex;flex-direction:column;gap:6px;margin-left:9px;padding-left:14px;border-left:1px dashed var(--line-2)}
.node{display:flex;align-items:flex-start;gap:9px;width:100%;text-align:left;border:1px solid var(--line);border-radius:9px;background:var(--panel-2);color:var(--text);padding:8px 9px;transition:transform .1s,border-color .12s,background .12s;position:relative}
.node::before{content:"";position:absolute;left:-16px;top:18px;width:9px;height:1px;background:var(--line-2)}
.node:hover{transform:translateX(2px);border-color:var(--line-2);background:var(--panel-3)}
.node.client{border-left:3px solid var(--blue)}
.node.gateway{border-left:3px solid var(--amber)}
.node.controller{border-left:3px solid var(--accent)}
.node.service{border-left:3px solid var(--green)}
.node.helper{border-left:3px solid color-mix(in srgb,var(--green) 55%,var(--line))}
.node.downstream{border-left:3px solid var(--violet)}
.node.external{border-left:3px solid var(--pink)}
.node.infrastructure{border-left:3px solid var(--faint)}
.node-icon{width:22px;height:22px;border-radius:6px;display:grid;place-items:center;background:var(--panel-3);border:1px solid var(--line);font-size:11px;flex:none;margin-top:1px}
.node-main{min-width:0;flex:1}
.node-label{display:block;font-size:12px;font-weight:650;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.node-sub{display:block;color:var(--muted);font-size:10.5px;margin-top:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.node-ref{display:block;color:var(--faint);font-family:var(--mono);font-size:9.5px;margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.node-right{display:flex;flex-direction:column;align-items:flex-end;gap:4px;flex:none}
.node-arrow{color:var(--faint);font-size:14px;line-height:1}
.none-note{color:var(--faint);font-size:11px;font-style:italic;padding:5px 0 2px 14px;margin-left:9px;border-left:1px dashed var(--line-2)}

.ds-card{display:block;width:100%;text-align:left;border:1px solid var(--line);border-radius:9px;background:var(--panel-2);color:var(--text);padding:9px 10px;margin-bottom:6px}
.ds-card:hover{border-color:var(--violet);background:var(--panel-3)}
.ds-top{display:flex;align-items:center;gap:7px;justify-content:space-between}
.ds-name{font-weight:700;font-size:12px}
.ds-evidence{color:var(--muted);font-size:10.5px;margin-top:3px}
.ds-src{color:var(--faint);font-family:var(--mono);font-size:9.5px;margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.subhead{font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:var(--faint);font-weight:700;margin:12px 0 5px}
.kv{display:grid;grid-template-columns:88px minmax(0,1fr);gap:5px 8px;font-size:11.5px}
.kv div:nth-child(odd){color:var(--faint)}
.kv div:nth-child(even){color:var(--muted);word-break:break-word}
.notice{border:1px dashed var(--line-2);border-radius:9px;padding:10px;color:var(--faint);font-size:11px;background:var(--panel-2)}
.notice b{color:var(--muted)}
.callout{border-left:3px solid var(--amber);background:rgba(251,191,36,.06);border-radius:0 8px 8px 0;padding:8px 10px;color:var(--muted);font-size:11px;margin-top:9px}

.tabs{display:flex;gap:4px;flex-wrap:wrap;padding:9px 15px 0;border-bottom:1px solid var(--line);background:var(--panel)}
.tab{border:1px solid transparent;border-bottom:0;background:transparent;color:var(--muted);border-radius:7px 7px 0 0;padding:6px 9px;font-size:11px}
.tab:hover{color:var(--text);background:var(--panel-2)}
.tab.active{color:var(--accent);background:var(--panel-2);border-color:var(--line)}
.tab-body{padding:13px 15px}
pre{margin:0;padding:10px 12px;border:1px solid var(--line);border-radius:8px;background:var(--bg-2);color:var(--text);font-family:var(--mono);font-size:11px;line-height:1.55;overflow:auto;max-height:420px}
.code-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:5px}
.code-head span{color:var(--faint);font-size:10.5px;font-family:var(--mono)}
.code-block{max-height:430px;overflow:auto;border:1px solid var(--line);border-radius:8px;background:var(--bg-2);font-family:var(--mono);font-size:10.8px;line-height:1.5}
.code-line{display:flex;min-width:max-content}
.code-line:hover{background:var(--panel-2)}
.ln{flex:none;width:46px;text-align:right;padding:0 8px 0 4px;color:var(--faint);border-right:1px solid var(--line);user-select:none;background:color-mix(in srgb,var(--bg-2) 88%,var(--panel))}
.lc{padding:0 10px;white-space:pre;color:var(--text)}
.table{width:100%;border-collapse:collapse;font-size:11.5px}
.table th,.table td{text-align:left;border-bottom:1px solid var(--line);padding:5px 7px;vertical-align:top}
.table th{color:var(--faint);font-size:10px;text-transform:uppercase;letter-spacing:.06em;font-weight:700}
.table td{color:var(--muted)}
.table td code,.mono{font-family:var(--mono);font-size:10.5px;color:var(--text)}
.resp{margin-bottom:8px}
.resp-top{display:flex;align-items:center;gap:7px;margin-bottom:3px}
.status{font-family:var(--mono);font-size:10.5px;font-weight:800;color:var(--green);border:1px solid rgba(52,211,153,.3);background:rgba(52,211,153,.08);border-radius:5px;padding:1px 6px}
.status.err{color:var(--red);border-color:rgba(251,113,133,.3);background:rgba(251,113,133,.08)}
.resp-desc{color:var(--faint);font-size:10.5px}

.modal{position:fixed;inset:0;z-index:80;display:flex;align-items:center;justify-content:center;padding:18px}
.modal[hidden]{display:none}
.modal-backdrop{position:absolute;inset:0;background:rgba(2,6,15,.72);backdrop-filter:blur(5px)}
.modal-card{position:relative;width:min(980px,100%);max-height:92vh;overflow:auto;border:1px solid var(--line-2);border-radius:14px;background:var(--panel);box-shadow:0 30px 100px rgba(0,0,0,.55)}
.modal-head{position:sticky;top:0;z-index:2;display:flex;align-items:flex-start;justify-content:space-between;gap:14px;padding:14px 16px;border-bottom:1px solid var(--line);background:color-mix(in srgb,var(--panel) 92%,var(--bg));backdrop-filter:blur(10px)}
.modal-title-line{display:flex;align-items:center;gap:7px;flex-wrap:wrap}
.modal-head h2{margin:5px 0 2px;font-size:16px;line-height:1.3}
.modal-head p{margin:0;color:var(--faint);font-family:var(--mono);font-size:10.5px}
.modal-close{border:1px solid var(--line);background:var(--panel-2);color:var(--muted);border-radius:8px;width:30px;height:30px;font-size:18px;line-height:1;flex:none}
.modal-close:hover{color:var(--text);border-color:var(--line-2)}
.modal-body{padding:14px 16px 22px}
.modal-body section{margin-bottom:15px}
.modal-body h3{margin:0 0 5px;font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:var(--faint)}
.modal-body p{margin:0;color:var(--muted);font-size:12px}
.modal-meta{display:flex;gap:5px;flex-wrap:wrap;margin-bottom:13px}
.two-col{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.dialog-contract{border:1px solid var(--line);border-radius:9px;background:var(--panel-2);padding:10px}
.dialog-contract .route{font-family:var(--mono);font-size:11.5px;color:var(--text);margin-bottom:4px}
.dialog-contract .auth{color:var(--faint);font-size:10.5px;margin-bottom:8px}
.dialog-contract h4{margin:8px 0 3px;font-size:10px;text-transform:uppercase;letter-spacing:.07em;color:var(--faint)}
.dialog-contract pre{max-height:200px;font-size:10.3px}

@media (max-width:1100px){
  .grid{grid-template-columns:1fr}
  .app{grid-template-columns:330px minmax(0,1fr)}
}
@media (max-width:820px){
  .app{display:block;height:auto}
  .rail{height:46vh;border-right:0;border-bottom:1px solid var(--line)}
  .main{height:auto}
  .main-inner{padding:14px}
  .topbar{align-items:flex-start}
  .brand p{display:none}
  .coverage-strip{display:none}
  .two-col{grid-template-columns:1fr}
}
</style>
</head>
<body>
<header class="topbar">
  <div class="brand">
    <div class="mark">H</div>
    <div>
      <h1>HOPE API Gateway Explorer</h1>
      <p>Every route, controller, application service and downstream microservice · code-pinned</p>
    </div>
  </div>
  <nav class="topnav">
    <a href="api-gateway-overview.html">Architecture overview</a>
    <a href="../api_explore/diagrams/api-system-context.html">System context</a>
    <a href="../api_explore/diagrams/api-gateway-internals-deep-dive.html">Gateway deep dive</a>
    <button id="themeToggle" type="button">Theme</button>
  </nav>
</header>

<div class="coverage-strip" id="coverageStrip"></div>

<div class="app">
  <aside class="rail">
    <div class="rail-tools">
      <label class="search" for="search">
        <span>⌕</span>
        <input id="search" type="search" placeholder="Search routes, controllers, services, evidence…" autocomplete="off" spellcheck="false">
        <kbd>/</kbd>
      </label>
      <div class="filters">
        <select id="methodFilter" aria-label="Filter by method"><option value="ALL">All methods</option></select>
        <select id="planeFilter" aria-label="Filter by plane"><option value="ALL">All planes</option></select>
        <select id="moduleFilter" aria-label="Filter by module"><option value="ALL">All modules</option></select>
        <select id="authFilter" aria-label="Filter by auth"><option value="ALL">All auth</option></select>
      </div>
      <div class="toggle-row">
        <label><input type="checkbox" id="hasMicro"> Has microservice</label>
        <label><input type="checkbox" id="documentedOnly"> OpenAPI contract</label>
        <label><input type="checkbox" id="internalOnly"> Internal /admin</label>
      </div>
      <div class="result-line">
        <span><b id="resultCount">0</b> of 818 routes</span>
        <button class="clear-btn" id="clearFilters" type="button">Reset</button>
      </div>
    </div>
    <div class="endpoint-list" id="endpointList" role="listbox" aria-label="Endpoints"></div>
  </aside>

  <main class="main" id="main">
    <div class="main-inner">
      <div class="empty" id="emptyState">
        <div>
          <div class="big">Select an endpoint</div>
          <div>Search the 818-route gateway surface, or press <span class="mono">/</span> to focus search.</div>
        </div>
      </div>
      <div id="endpointView" hidden>
        <section class="hero">
          <div class="crumb"><span id="heroPlane"></span><span>·</span><b id="heroModule"></b></div>
          <h2><span id="heroMethod" class="method"></span><span id="heroPath"></span></h2>
          <p class="summary" id="heroSummary"></p>
          <div class="hero-actions">
            <button class="btn primary" id="copyCurl" type="button">Copy curl</button>
            <a class="btn" id="githubLink" target="_blank" rel="noreferrer">GitHub source</a>
            <a class="btn" id="localLink" target="_blank" rel="noreferrer">Local file</a>
            <button class="btn" id="openController" type="button">Controller dialog</button>
          </div>
          <div class="meta" id="heroMeta"></div>
        </section>

        <div class="grid">
          <div class="stack">
            <section class="panel">
              <div class="panel-head">
                <div>
                  <h3>Request path</h3>
                  <p>Static reading order: edge → controller → application services/helpers → downstream microservices → infrastructure. Click any box for the code excerpt, contract and evidence.</p>
                </div>
                <div class="legend">
                  <span class="conf verified">verified</span>
                  <span class="conf inferred">inferred</span>
                  <span class="conf inferred-chain">chain</span>
                </div>
              </div>
              <div class="panel-body" id="pathGroups"></div>
            </section>

            <section class="panel" id="contractPanel">
              <div class="panel-head">
                <div>
                  <h3>API contract &amp; client examples</h3>
                  <p id="contractNote"></p>
                </div>
              </div>
              <div class="tabs" id="contractTabs">
                <button class="tab active" data-tab="input" type="button">Input</button>
                <button class="tab" data-tab="output" type="button">Output</button>
                <button class="tab" data-tab="curl" type="button">curl</button>
                <button class="tab" data-tab="fetch" type="button">fetch</button>
              </div>
              <div class="tab-body" id="contractBody"></div>
            </section>
          </div>

          <aside class="stack">
            <section class="panel">
              <div class="panel-head"><div><h3>Downstream verdict</h3><p>Which other services this route reaches.</p></div></div>
              <div class="panel-body" id="downstreamPanel"></div>
            </section>
            <section class="panel">
              <div class="panel-head"><div><h3>Callers &amp; access</h3></div></div>
              <div class="panel-body" id="callersPanel"></div>
            </section>
            <section class="panel">
              <div class="panel-head"><div><h3>How to read confidence</h3></div></div>
              <div class="panel-body">
                <div class="kv">
                  <div>verified</div><div>URL/env/port, HTTP route, proxy ownership, or a resolved code line proves the hop.</div>
                  <div>inferred</div><div>Module or handler naming suggests the hop; no direct URL/client evidence was found.</div>
                  <div>inferred-chain</div><div>A verified upstream hop runs this service internally (for example Harness → Temporal/Text/Guardrail).</div>
                </div>
                <div class="callout">This is static analysis of the pinned revision, not runtime tracing. Queues, Temporal activities and Python-internal calls may be wider than the code shows.</div>
              </div>
            </section>
          </aside>
        </div>
      </div>
    </div>
  </main>
</div>

<div class="modal" id="modal" hidden>
  <div class="modal-backdrop" data-close="1"></div>
  <div class="modal-card" role="dialog" aria-modal="true" aria-labelledby="modalTitle">
    <div class="modal-head">
      <div>
        <div class="modal-title-line"><span id="modalKind" class="chip"></span><span id="modalConfidence" class="conf verified">verified</span></div>
        <h2 id="modalTitle"></h2>
        <p id="modalSymbol"></p>
      </div>
      <button class="modal-close" id="modalClose" type="button" aria-label="Close">×</button>
    </div>
    <div class="modal-body">
      <div class="modal-meta" id="modalMeta"></div>
      <section><h3>What it is</h3><p id="modalWhat"></p></section>
      <section><h3>What it does</h3><p id="modalDoes"></p></section>
      <section id="modalEvidenceSection"><h3>Evidence</h3><p id="modalEvidence"></p></section>
      <section>
        <div class="code-head"><h3>Code excerpt</h3><span id="modalCodeRef"></span></div>
        <div id="modalCode"></div>
      </section>
      <section>
        <h3>Route contract (this box belongs to)</h3>
        <div id="modalContract"></div>
      </section>
    </div>
  </div>
</div>

<script id="catalog" type="application/json">__CATALOG__</script>
<script id="coverage" type="application/json">__COVERAGE__</script>
<script>
(() => {
  'use strict';
  const DATA = JSON.parse(document.getElementById('catalog').textContent);
  const COVERAGE = JSON.parse(document.getElementById('coverage').textContent);
  const ENDPOINTS = DATA.endpoints;
  const REVISION = DATA.meta.revision;
  const BY_ID = new Map(ENDPOINTS.map(e => [e.id, e]));
  const PLANE_ORDER = Object.keys(COVERAGE.planes || {});
  const STATE = {
    selected: null, query: '', method: 'ALL', plane: 'ALL', module: 'ALL', auth: 'ALL',
    hasMicro: false, documentedOnly: false, internalOnly: false, tab: 'input'
  };
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const dot = '·';
  const METHOD_ICON = {GET:'↗', POST:'＋', PUT:'↻', PATCH:'✎', DELETE:'−', HEAD:'◇', OPTIONS:'…'};
  const KIND_ICON = {client:'☁', gateway:'⛩', controller:'⌘', service:'⚙', helper:'ƒ', downstream:'⬡', external:'☼', infrastructure:'▤'};
  const KIND_LABEL = {client:'Client', gateway:'Gateway', controller:'Controller', service:'Service', helper:'Helper', downstream:'Microservice', external:'External', infrastructure:'Infrastructure'};
  const AUTH_CLASS = {public:'green', jwt:'violet', 'api-key':'amber', service:'amber', internal:'red'};

  function colorForPlane(plane) {
    return {'Clinical & Consultation':'green','AI Models & Guardrails':'violet','Agentic & Workflows':'blue','Speech & Audio':'orange','Platform Admin & Tenancy':'amber'}[plane] || 'violet';
  }
  function sourceLinks(file, line) {
    if (!file) return {github:'', local:'', vscode:''};
    const anchor = line ? '#L' + line : '';
    return {
      github: file.startsWith('node_modules/') ? '' : `https://github.com/ArcaAI/project-hope/blob/${REVISION}/${file}${anchor}`,
      local: `file:///Users/apple/repos/VOX/project-hope/${file}${anchor}`,
      vscode: `vscode://file/Users/apple/repos/VOX/project-hope/${file}:${line || 1}`
    };
  }
  function codeBlock(snippet, startLine) {
    if (!snippet) return `<div class="notice">No source excerpt stored for this box. ${esc('This is usually an external caller, a module hint, or a vendored dependency.')}</div>`;
    const lines = snippet.split('\n');
    return `<div class="code-block" data-code>${lines.map((line, i) => `<div class="code-line"><span class="ln">${(startLine || 1) + i}</span><span class="lc">${esc(line) || ' '}</span></div>`).join('')}</div>`;
  }
  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text).catch(() => {});
    const ta = document.createElement('textarea');
    ta.value = text; document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); } catch (e) {}
    ta.remove();
    return Promise.resolve();
  }
  function sampleFor(name) {
    const n = String(name).toLowerCase();
    if (n.includes('id') || n.endsWith('key')) return '00000000-0000-0000-0000-000000000000';
    if (n.includes('slug')) return 'example-slug';
    if (n.includes('email')) return 'clinician@example.com';
    if (n.includes('date')) return '2026-11-07';
    if (n.includes('version')) return '7';
    if (n.includes('service')) return 'text';
    return 'example';
  }
  function fillPath(path, input) {
    const provided = (input && input.path) || {};
    return String(path).replace(/\{([^}]+)\}/g, (_, name) => encodeURIComponent(provided[name] ?? sampleFor(name)));
  }
  function queryString(input) {
    const q = (input && input.query) || {};
    const entries = Object.entries(q);
    if (!entries.length) return '';
    return '?' + entries.slice(0, 4).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v ?? sampleFor(k))}`).join('&');
  }
  function headersFor(e, fetchObject) {
    const h = {Accept: 'application/json'};
    if (e.auth.kind === 'internal' || e.auth.kind === 'service') h['X-Service-Token'] = '$SERVICE_TOKEN';
    else if (e.auth.kind === 'api-key') h['X-API-Key'] = '$API_KEY';
    else if (e.auth.kind !== 'public') h.Authorization = 'Bearer $TOKEN';
    if (e.requestBody && Object.keys(e.requestBody).length) h['Content-Type'] = 'application/json';
    if (e.requiresIfMatch) h['If-Match'] = '"7"';
    const examples = (e.input && e.input.header) || {};
    for (const [k, v] of Object.entries(examples)) {
      if (!(k in h) && !/authorization|content-type/i.test(k)) h[k] = String(v);
    }
    return h;
  }
  function bodyText(e) {
    if (!e.requestBody || !Object.keys(e.requestBody).length) return '';
    return JSON.stringify(e.requestBody, null, 2);
  }
  function curlFor(e) {
    const url = `http://localhost:3000${fillPath(e.path, e.input)}${queryString(e.input)}`;
    const h = headersFor(e);
    const parts = [`curl -X ${e.method} '${url}'`];
    for (const [k, v] of Object.entries(h)) parts.push(`  -H '${k}: ${v}'`);
    const body = bodyText(e);
    if (body) parts.push(`  --data-raw '${body.replace(/'/g, "'\\''")}'`);
    return parts.join(' \\\n');
  }
  function fetchFor(e) {
    const url = `http://localhost:3000${fillPath(e.path, e.input)}${queryString(e.input)}`;
    const h = headersFor(e);
    const body = bodyText(e);
    const lines = [`const response = await fetch('${url}', {`, `  method: '${e.method}',`, `  headers: ${JSON.stringify(h, null, 2).replace(/\n/g, '\n  ')},`];
    if (body) lines.push(`  body: JSON.stringify(${body.replace(/\n/g, '\n  ')}),`);
    lines.push('});', '', 'if (!response.ok) throw new Error(`HTTP ${response.status}`);', 'const data = await response.json();', 'console.log(data);');
    return lines.join('\n');
  }

  function initFilters() {
    const methods = [...new Set(ENDPOINTS.map(e => e.method))].sort();
    for (const m of methods) $('#methodFilter').insertAdjacentHTML('beforeend', `<option value="${esc(m)}">${esc(m)}</option>`);
    for (const p of PLANE_ORDER) $('#planeFilter').insertAdjacentHTML('beforeend', `<option value="${esc(p)}">${esc(p)}</option>`);
    const modules = [...new Set(ENDPOINTS.map(e => e.module))].sort((a,b) => a.localeCompare(b));
    for (const m of modules) $('#moduleFilter').insertAdjacentHTML('beforeend', `<option value="${esc(m)}">${esc(m)}</option>`);
    const auths = [...new Set(ENDPOINTS.map(e => e.auth.label))].sort();
    for (const a of auths) $('#authFilter').insertAdjacentHTML('beforeend', `<option value="${esc(a)}">${esc(a)}</option>`);
    $('#coverageStrip').innerHTML = [
      [COVERAGE.routes, 'routes'],
      [COVERAGE.withControllerLine, 'handler lines'],
      [COVERAGE.withOpenApiContract, 'OpenAPI contracts'],
      [COVERAGE.withServiceNode, 'service-resolved'],
      [COVERAGE.withMicroserviceDetection, 'microservice hops'],
      [COVERAGE.withInfrastructureDetection, 'infra-resolved'],
      [COVERAGE.withExternalProviderDetection, 'external-provider'],
    ].map(([n, label]) => `<div class="stat"><strong>${esc(n)}</strong><span>${esc(label)}</span></div>`).join('') +
    `<div class="stat"><strong class="rev">${esc(REVISION.slice(0,12))}</strong><span>pinned revision</span></div>`;
  }

  function haystack(e) {
    return [e.id, e.path, e.method, e.module, e.plane, e.controller, e.handler, e.summary, e.description,
      e.auth.label, e.auth.detail, ...(e.callers||[]).map(c => c.name + ' ' + c.detail),
      ...(e.microservices||[]).map(m => m.name + ' ' + m.evidence),
      ...(e.infrastructure||[]).map(m => m.name + ' ' + m.evidence),
      ...(e.external||[]).map(m => m.name + ' ' + m.evidence),
      ...(e.pathNodes||[]).map(n => n.label + ' ' + n.sublabel)
    ].join(' ').toLowerCase();
  }
  function filtered() {
    const q = STATE.query.trim().toLowerCase();
    return ENDPOINTS.filter(e => {
      if (STATE.method !== 'ALL' && e.method !== STATE.method) return false;
      if (STATE.plane !== 'ALL' && e.plane !== STATE.plane) return false;
      if (STATE.module !== 'ALL' && e.module !== STATE.module) return false;
      if (STATE.auth !== 'ALL' && e.auth.label !== STATE.auth) return false;
      if (STATE.hasMicro && !(e.microservices||[]).length) return false;
      if (STATE.documentedOnly && !e.documented) return false;
      if (STATE.internalOnly && !(e.path.startsWith('/api/v1/internal/') || e.path.startsWith('/api/v1/admin/'))) return false;
      return !q || haystack(e).includes(q);
    }).sort((a,b) => {
      const pa = PLANE_ORDER.indexOf(a.plane), pb = PLANE_ORDER.indexOf(b.plane);
      if (pa !== pb) return pa - pb;
      if (a.module !== b.module) return a.module.localeCompare(b.module);
      return a.path.localeCompare(b.path);
    });
  }
  function epRow(e) {
    const micro = (e.microservices||[]).map(m => `<span class="mini-tag micro">${esc(m.name)}</span>`).join('');
    const doc = e.documented ? `<span class="mini-tag doc">OpenAPI</span>` : '';
    return `<button class="ep-row ${STATE.selected === e.id ? 'active' : ''}" data-id="${esc(e.id)}" role="option" aria-selected="${STATE.selected === e.id}">
      <div class="ep-line"><span class="method ${esc(e.method)}">${esc(e.method)}</span><span class="ep-path">${esc(e.path)}</span></div>
      <div class="ep-sub">${esc(e.controller)}.${esc(e.handler)} ${dot} ${esc(e.module)}</div>
      <div class="ep-tags"><span class="mini-tag plane">${esc(e.plane)}</span>${doc}${micro}</div>
    </button>`;
  }
  function renderList() {
    const rows = filtered();
    $('#resultCount').textContent = rows.length;
    $('#endpointList').innerHTML = rows.map(epRow).join('') || `<div class="notice" style="margin:10px">No routes match these filters.</div>`;
    $$('.ep-row').forEach(btn => btn.addEventListener('click', () => selectEndpoint(btn.dataset.id)));
  }

  function nodeHTML(n) {
    const ref = n.file ? `${n.file}${n.line ? ':' + n.line : ''}` : (n.kind === 'downstream' ? 'microservice boundary' : 'no source file');
    return `<button class="node ${esc(n.kind)}" data-node-id="${esc(n.id)}">
      <span class="node-icon">${KIND_ICON[n.kind] || '•'}</span>
      <span class="node-main">
        <span class="node-label">${esc(n.label)}</span>
        <span class="node-sub">${esc(n.sublabel || n.symbol || '')}</span>
        <span class="node-ref">${esc(ref)}</span>
      </span>
      <span class="node-right"><span class="conf ${esc(n.confidence)}">${esc(n.confidence)}</span><span class="node-arrow">›</span></span>
    </button>`;
  }
  function stageHTML(num, title, nodes, emptyNote) {
    return `<div class="path-stage">
      <div class="stage-head"><span class="stage-num">${num}</span><span class="stage-title">${esc(title)}</span><span class="stage-count">${nodes.length}</span></div>
      <div class="node-list">${nodes.length ? nodes.map(nodeHTML).join('') : `<div class="none-note">${esc(emptyNote)}</div>`}</div>
    </div>`;
  }
  function renderPath(e) {
    const nodes = e.pathNodes || [];
    const pick = (...kinds) => nodes.filter(n => kinds.includes(n.kind));
    const groups = [
      stageHTML(1, 'Edge & gateway', pick('client','gateway'), 'No edge nodes.'),
      stageHTML(2, 'Controller', pick('controller'), 'Controller source not resolved.'),
      stageHTML(3, 'Application services & helpers', pick('service','helper'), 'No application-service call resolved from this handler.'),
      stageHTML(4, 'Downstream microservices', pick('downstream'), 'No Python microservice hop detected.'),
      stageHTML(5, 'External providers', pick('external'), 'No external provider detected.'),
      stageHTML(6, 'Infrastructure', pick('infrastructure'), 'No shared infrastructure detected.'),
    ];
    $('#pathGroups').innerHTML = groups.join('');
    $$('#pathGroups .node').forEach(btn => btn.addEventListener('click', () => {
      const n = nodes.find(x => x.id === btn.dataset.nodeId);
      if (n) openNode(n, e);
    }));
  }

  function dsCard(m, e) {
    const node = (e.pathNodes||[]).find(n => n.label === m.name);
    return `<button class="ds-card" data-ds="${esc(m.name)}">
      <div class="ds-top"><span class="ds-name">${esc(m.name)}${m.port ? ` <span class="mono">:${esc(m.port)}</span>` : ''}</span><span class="conf ${esc(m.confidence)}">${esc(m.confidence)}</span></div>
      <div class="ds-evidence">${esc(m.evidence || 'No evidence string stored.')}</div>
      ${m.file ? `<div class="ds-src">${esc(m.file)}${m.line ? ':' + m.line : ''}</div>` : ''}
    </button>`;
  }
  function renderDownstream(e) {
    const micro = e.microservices || [];
    const infra = e.infrastructure || [];
    const ext = e.external || [];
    const head = `<div class="kv" style="margin-bottom:10px">
      <div>Microservices</div><div><b>${micro.length}</b>${micro.length ? ' hop(s)' : ' — gateway + data layer only'}</div>
      <div>Infrastructure</div><div>${infra.length ? infra.map(x => `<span class="mini-tag">${esc(x.name)}</span>`).join(' ') : 'none detected'}</div>
      <div>External</div><div>${ext.length ? ext.map(x => `<span class="mini-tag micro">${esc(x.name)}</span>`).join(' ') : 'none detected'}</div>
    </div>`;
    const cards = micro.length ? micro.map(m => dsCard(m, e)).join('') : `<div class="notice"><b>No Python microservice call found.</b><br>This route still passes through the gateway pipeline and may use PostgreSQL/Redis. Absence here means the handler did not show a URL, client, or proxy call.</div>`;
    $('#downstreamPanel').innerHTML = head + cards;
    $$('#downstreamPanel .ds-card').forEach(btn => btn.addEventListener('click', () => {
      const m = micro.find(x => x.name === btn.dataset.ds);
      if (!m) return;
      const node = (e.pathNodes||[]).find(n => n.label === m.name) || {id:'downstream:'+m.name, kind:'downstream', label:m.name, sublabel:m.port ? 'port '+m.port : 'microservice', file:m.file||'', line:m.line||null, symbol:m.name, confidence:m.confidence, whatItIs:'A downstream microservice called by the gateway.', whatItDoes:m.evidence, snippet:'', evidence:m.evidence};
      openNode(node, e);
    }));
  }
  function renderCallers(e) {
    const callers = e.callers || [];
    $('#callersPanel').innerHTML = `<div class="kv">
      <div>Auth</div><div><span class="chip ${AUTH_CLASS[e.auth.kind]||''}">${esc(e.auth.label)}</span><br>${esc(e.auth.detail)}</div>
      <div>Callers</div><div>${callers.map(c => `<b>${esc(c.name)}</b> — ${esc(c.detail)}`).join('<br>') || 'Unknown'}</div>
      <div>Source</div><div>${e.sourceKind === 'vendored' ? 'Vendored dependency (node_modules)' : 'Application source'}</div>
      <div>OpenAPI</div><div>${e.documented ? 'Documented operation' : 'Not in the public OpenAPI document'}</div>
      ${e.requiresIfMatch ? '<div>Concurrency</div><div>If-Match required</div>' : ''}
      ${e.apiExcluded ? '<div>API surface</div><div>Excluded from the public API-key surface</div>' : ''}
    </div>`;
  }

  function inputTable(e) {
    const sections = [];
    for (const [loc, obj] of Object.entries(e.input || {})) {
      const entries = Object.entries(obj || {});
      if (!entries.length) continue;
      sections.push(`<div class="subhead">${esc(loc)}</div><table class="table"><thead><tr><th>Name</th><th>Example</th></tr></thead><tbody>${entries.map(([k,v]) => `<tr><td><code>${esc(k)}</code></td><td><code>${esc(typeof v === 'string' ? v : JSON.stringify(v))}</code></td></tr>`).join('')}</tbody></table>`);
    }
    if (e.requestBody && Object.keys(e.requestBody).length) {
      sections.push(`<div class="subhead">Request body</div><pre>${esc(JSON.stringify(e.requestBody, null, 2))}</pre>`);
    }
    if (!sections.length) sections.push(`<div class="notice">No OpenAPI parameters or request body were recorded for this operation. The route may be internal, excluded, or body-less.</div>`);
    return sections.join('');
  }
  function outputView(e) {
    const responses = Object.entries(e.responses || {});
    if (!responses.length) return `<div class="notice">No OpenAPI response schema was recorded. Check the controller return type or the source excerpt above.</div>`;
    return responses.map(([status, r]) => {
      const err = Number(status) >= 400;
      const example = r && r.example != null ? JSON.stringify(r.example, null, 2) : '';
      return `<div class="resp"><div class="resp-top"><span class="status ${err ? 'err' : ''}">${esc(status)}</span><span class="resp-desc">${esc((r && r.description) || '')}</span></div>${example ? `<pre>${esc(example)}</pre>` : '<div class="resp-desc">No example body.</div>'}</div>`;
    }).join('');
  }
  function renderContractTab() {
    if (!STATE.selected) return;
    const e = BY_ID.get(STATE.selected);
    let html = '';
    if (STATE.tab === 'input') html = inputTable(e);
    else if (STATE.tab === 'output') html = outputView(e);
    else if (STATE.tab === 'curl') html = `<div class="code-head"><span>bash</span><button class="clear-btn" data-copy="curl">Copy</button></div><pre>${esc(curlFor(e))}</pre>`;
    else html = `<div class="code-head"><span>javascript</span><button class="clear-btn" data-copy="fetch">Copy</button></div><pre>${esc(fetchFor(e))}</pre>`;
    $('#contractBody').innerHTML = html;
    $$('#contractBody [data-copy]').forEach(b => b.addEventListener('click', () => copyText(b.dataset.copy === 'curl' ? curlFor(e) : fetchFor(e))));
  }

  function renderDetail(e) {
    $('#emptyState').hidden = true;
    $('#endpointView').hidden = false;
    $('#heroPlane').textContent = e.plane;
    $('#heroModule').textContent = e.module;
    $('#heroMethod').textContent = e.method;
    $('#heroMethod').className = 'method ' + e.method;
    $('#heroPath').textContent = e.path;
    $('#heroSummary').textContent = e.summary || e.description || 'No summary recorded.';
    $('#heroMeta').innerHTML = [
      `<span class="chip ${AUTH_CLASS[e.auth.kind]||''}">${esc(e.auth.label)}</span>`,
      `<span class="chip ${e.documented ? 'green' : 'amber'}">${e.documented ? 'OpenAPI documented' : 'No OpenAPI operation'}</span>`,
      `<span class="chip">${esc(e.controller)}.${esc(e.handler)}()</span>`,
      `<span class="chip">${esc(e.sourceKind)}</span>`,
      e.requiresIfMatch ? '<span class="chip red">If-Match required</span>' : '',
      e.apiExcluded ? '<span class="chip amber">API-key surface excluded</span>' : '',
      ...(e.microservices||[]).map(m => `<span class="chip violet">${esc(m.name)} · ${esc(m.confidence)}</span>`),
    ].join('');
    const links = sourceLinks(e.file, e.line);
    $('#githubLink').style.display = links.github ? '' : 'none';
    $('#githubLink').href = links.github || '#';
    $('#localLink').href = links.local || '#';
    $('#contractNote').textContent = e.documented ? `Generated from the OpenAPI operation, with a client example for ${e.method} ${e.path}.` : `No OpenAPI operation found; the example is inferred from the route manifest and request body shape.`;
    renderPath(e);
    renderDownstream(e);
    renderCallers(e);
    renderContractTab();
  }

  function selectEndpoint(id, updateHash = true) {
    if (!BY_ID.has(id)) return;
    STATE.selected = id;
    STATE.tab = 'input';
    $$('.ep-row').forEach(r => { const on = r.dataset.id === id; r.classList.toggle('active', on); r.setAttribute('aria-selected', String(on)); });
    $$('#contractTabs .tab').forEach(t => t.classList.toggle('active', t.dataset.tab === 'input'));
    if (updateHash) {
      try { history.replaceState(null, '', '#' + encodeURIComponent(id)); }
      catch (err) { /* file:// history can be restricted; selection still works */ }
    }
    renderDetail(BY_ID.get(id));
    document.querySelector('.main').scrollTop = 0;
  }

  function openNode(n, e) {
    const links = sourceLinks(n.file, n.line);
    const kind = n.kind || 'service';
    $('#modalKind').textContent = KIND_LABEL[kind] || kind;
    $('#modalKind').className = 'chip ' + (kind === 'downstream' ? 'violet' : kind === 'infrastructure' ? '' : kind === 'external' ? 'red' : 'green');
    $('#modalConfidence').textContent = n.confidence || 'inferred';
    $('#modalConfidence').className = 'conf ' + (n.confidence || 'inferred');
    $('#modalTitle').textContent = n.label || n.symbol || 'Path node';
    $('#modalSymbol').textContent = n.symbol || '';
    $('#modalMeta').innerHTML = [
      n.file ? `<span class="chip mono">${esc(n.file)}${n.line ? ':' + n.line : ''}</span>` : '<span class="chip">No source file</span>',
      n.sublabel ? `<span class="chip">${esc(n.sublabel)}</span>` : '',
      links.github ? `<a class="chip" href="${esc(links.github)}" target="_blank" rel="noreferrer">GitHub ↗</a>` : '',
      links.local ? `<a class="chip" href="${esc(links.local)}" target="_blank" rel="noreferrer">Local ↗</a>` : '',
      `<span class="chip">${esc(e.method)} ${esc(e.path)}</span>`,
    ].join('');
    $('#modalWhat').textContent = n.whatItIs || '';
    $('#modalDoes').textContent = n.whatItDoes || '';
    const evidence = n.evidence || (n.microservices && n.microservices[0] && n.microservices[0].evidence) || '';
    $('#modalEvidenceSection').hidden = !evidence;
    $('#modalEvidence').textContent = evidence;
    $('#modalCodeRef').textContent = n.file ? `${n.file}${n.line ? ':' + n.line : ''}` : 'no code excerpt';
    $('#modalCode').innerHTML = codeBlock(n.snippet, n.line);
    $('#modalContract').innerHTML = `<div class="dialog-contract">
      <div class="route"><span class="method ${esc(e.method)}">${esc(e.method)}</span> ${esc(e.path)}</div>
      <div class="auth">${esc(e.auth.label)} — ${esc(e.auth.detail)}</div>
      <div class="two-col">
        <div><h4>Input</h4><pre>${esc(JSON.stringify({parameters: e.input, body: e.requestBody}, null, 2))}</pre></div>
        <div><h4>Output</h4><pre>${esc(JSON.stringify(e.responses, null, 2))}</pre></div>
      </div>
    </div>`;
    $('#modal').hidden = false;
    document.body.style.overflow = 'hidden';
    $('#modalClose').focus();
  }
  function closeModal() {
    $('#modal').hidden = true;
    document.body.style.overflow = '';
  }

  function bind() {
    $('#search').addEventListener('input', ev => { STATE.query = ev.target.value; renderList(); });
    $('#methodFilter').addEventListener('change', ev => { STATE.method = ev.target.value; renderList(); });
    $('#planeFilter').addEventListener('change', ev => { STATE.plane = ev.target.value; renderList(); });
    $('#moduleFilter').addEventListener('change', ev => { STATE.module = ev.target.value; renderList(); });
    $('#authFilter').addEventListener('change', ev => { STATE.auth = ev.target.value; renderList(); });
    $('#hasMicro').addEventListener('change', ev => { STATE.hasMicro = ev.target.checked; renderList(); });
    $('#documentedOnly').addEventListener('change', ev => { STATE.documentedOnly = ev.target.checked; renderList(); });
    $('#internalOnly').addEventListener('change', ev => { STATE.internalOnly = ev.target.checked; renderList(); });
    $('#clearFilters').addEventListener('click', () => {
      Object.assign(STATE, {query:'', method:'ALL', plane:'ALL', module:'ALL', auth:'ALL', hasMicro:false, documentedOnly:false, internalOnly:false});
      $('#search').value = ''; $('#methodFilter').value = 'ALL'; $('#planeFilter').value = 'ALL'; $('#moduleFilter').value = 'ALL'; $('#authFilter').value = 'ALL';
      $('#hasMicro').checked = false; $('#documentedOnly').checked = false; $('#internalOnly').checked = false;
      renderList();
    });
    $('#contractTabs').addEventListener('click', ev => {
      const tab = ev.target.closest('[data-tab]'); if (!tab) return;
      STATE.tab = tab.dataset.tab;
      $$('#contractTabs .tab').forEach(t => t.classList.toggle('active', t === tab));
      renderContractTab();
    });
    $('#copyCurl').addEventListener('click', () => {
      if (!STATE.selected) return;
      copyText(curlFor(BY_ID.get(STATE.selected))).then(() => { const b = $('#copyCurl'); const old = b.textContent; b.textContent = 'Copied'; setTimeout(() => b.textContent = old, 900); });
    });
    $('#openController').addEventListener('click', () => {
      if (!STATE.selected) return;
      const e = BY_ID.get(STATE.selected);
      const n = (e.pathNodes||[]).find(x => x.kind === 'controller') || (e.pathNodes||[])[0];
      if (n) openNode(n, e);
    });
    $('#modalClose').addEventListener('click', closeModal);
    $('#modal').addEventListener('click', ev => { if (ev.target.dataset.close) closeModal(); });
    document.addEventListener('keydown', ev => {
      if (ev.key === '/' && document.activeElement.tagName !== 'INPUT' && document.activeElement.tagName !== 'TEXTAREA') { ev.preventDefault(); $('#search').focus(); }
      if (ev.key === 'Escape' && !$('#modal').hidden) closeModal();
    });
    $('#themeToggle').addEventListener('click', () => {
      const root = document.documentElement;
      root.dataset.theme = root.dataset.theme === 'dark' ? 'light' : 'dark';
    });
    window.addEventListener('hashchange', () => {
      const id = decodeURIComponent(location.hash.slice(1));
      if (id && BY_ID.has(id) && id !== STATE.selected) selectEndpoint(id, false);
    });
  }

  function boot() {
    initFilters();
    bind();
    const id = decodeURIComponent(location.hash.slice(1));
    const featured = 'POST /api/v1/consultations/{id}/summary/async';
    if (id && BY_ID.has(id)) selectEndpoint(id, false);
    else if (BY_ID.has(featured)) selectEndpoint(featured, false);
    else if (ENDPOINTS.length) selectEndpoint(ENDPOINTS[0].id, false);
    renderList();
  }
  boot();
})();
</script>
</body>
</html>
'''

html = (HTML
        .replace('__CATALOG__', payload)
        .replace('__COVERAGE__', coverage_json))
TARGET.write_text(html)
print(f'Wrote {TARGET} ({TARGET.stat().st_size / 1024 / 1024:.1f} MiB)')
