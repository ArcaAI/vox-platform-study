#!/bin/bash
API=http://127.0.0.1:8868/api/v1
jq_get(){ node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const o=JSON.parse(s);console.log(o$1??'')}catch(e){console.error('PARSE_FAIL',s.slice(0,300))}})"; }
