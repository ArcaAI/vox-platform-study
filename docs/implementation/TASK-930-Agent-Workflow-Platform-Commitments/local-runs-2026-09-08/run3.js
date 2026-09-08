const http=require('http'),fs=require('fs');
const TOKEN=process.env.ARCAAI_JWT;
function req(method,path,body){return new Promise((res,rej)=>{
  const b=body?Buffer.from(JSON.stringify(body)):null;
  const h={Authorization:'Bearer '+TOKEN}; if(b){h['Content-Type']='application/json';h['Content-Length']=b.length}
  const r=http.request({host:'127.0.0.1',port:8868,path,method,headers:h},(x)=>{let s='';x.setEncoding('utf8');x.on('data',d=>s+=d);x.on('end',()=>res({status:x.statusCode,body:s}))});
  r.on('error',rej); if(b)r.write(b); r.end();});}
const T={
 'arcaai-neur-consultation':{dept:'Neurology',visit:'new-visit',text:'Doctor: Mrs. Anitha Pillai, what brings you to neurology today?\nPatient: For two months I get a throbbing headache on the right side, two or three times a week. Before it starts I see zigzag lights for about twenty minutes. Bright light and noise make it worse. Paracetamol barely helps.\nDoctor: Any weakness, numbness, speech trouble, or fever?\nPatient: No weakness. Sometimes my right hand tingles during the aura.\nDoctor: Any family history?\nPatient: My mother had migraines.\nDoctor: On examination, cranial nerves are intact, power is 5/5 in all four limbs, reflexes are normal and symmetric, plantars downgoing, no neck stiffness, fundi normal. Blood pressure 124 over 78.\nDoctor: This looks like migraine with aura. I will start propranolol 20 milligrams twice daily as prophylaxis and sumatriptan 50 milligrams at the onset of an attack, maximum two doses in a day. Keep a headache diary. I am also ordering an MRI brain to be safe given the consistently one-sided aura.\nPatient: Understood, doctor.\nDoctor: Review in six weeks. Call 0484 555 0177 or my coordinator Meera Thomas on 98460 33218 if you develop sudden severe headache, weakness or fever.'},
 'arcaai-rheum-consultation':{dept:'Rheumatology',visit:'new-visit',text:'Doctor: Mr. Joseph Kurien, tell me about your joints.\nPatient: For about four months my hands and wrists are swollen and painful. The stiffness in the morning lasts more than an hour before it loosens.\nDoctor: Which joints exactly?\nPatient: Both wrists, and the knuckles of both hands. Also both ankles for the past three weeks.\nDoctor: Any rash, mouth ulcers, dry eyes, or fever?\nPatient: No rash. My eyes feel dry. I have been very tired.\nDoctor: On examination there is symmetrical synovitis of the second and third metacarpophalangeal joints bilaterally and both wrists, with tenderness but no deformity. No nodules. Grip strength is reduced.\nDoctor: The pattern suggests rheumatoid arthritis. I am ordering rheumatoid factor, anti-CCP, ESR, CRP, complete blood count, liver and renal profile, and hepatitis B and C serology before starting treatment. Start naproxen 500 milligrams twice daily with food, and once the baseline labs are back I plan methotrexate 15 milligrams weekly with folic acid 5 milligrams the day after.\nPatient: All right.\nDoctor: Review in two weeks with the reports. My office is 0484 555 0161 and the nurse Deepa Nair is on 97440 55123.'},
 'arcaai-gen-consultation':{dept:'General Medicine',visit:'revisit',text:'Doctor: Mrs. Fathima Beevi, this is your follow-up. How has the last month been?\nPatient: The cough is better after the antibiotics, but I still get breathless climbing the stairs, and my ankles swell by the evening.\nDoctor: Are you taking the amlodipine 5 milligrams and the metformin 1 gram twice daily?\nPatient: Yes, every day. I stopped the cough syrup last week.\nDoctor: Any chest pain, palpitations, or waking up breathless at night?\nPatient: I have to use two pillows now, otherwise I feel short of breath.\nDoctor: Blood pressure today is 152 over 94, pulse 96 and regular, oxygen saturation 95 percent on room air, weight 78 kilograms, up 3 kilograms from last visit. There is pitting oedema to mid-shin bilaterally, jugular venous pressure is raised, and there are bibasal crackles on auscultation.\nDoctor: This looks like fluid overload, possibly early heart failure. I am adding furosemide 40 milligrams each morning, and I will stop the amlodipine because it can worsen the ankle swelling. I am ordering an ECG, chest X-ray, NT-proBNP, electrolytes, renal profile and an echocardiogram.\nPatient: Should I reduce salt?\nDoctor: Yes, keep salt low and weigh yourself daily. Come back in one week, sooner if the breathlessness worsens. Reception is 0484 555 0104 and my assistant George Mathew is on 98950 77213.'}
};
(async()=>{
 const picked=JSON.parse(fs.readFileSync('picked.json','utf8'));
 const out={};
 for(const slug of picked){
  const t=T[slug];
  const input={context:{visit_type:t.visit,current_department:t.dept,language:'en',language_name:'English',safe_age:'58',safe_dob:'1968-06-02',safe_gender:'Female',formatted_previous_visits:'',formatted_vitals:'see note',clinician_notes:t.text,chief_complaint:t.text.split('\n')[1]||'',conversation_language:'en',attachments:'',formatted_test_results:'',ner_entities:'',doctor_highlights:'',prior_visit_summary:'',pre_summary_text:'',dna_style_text:'',safe_vitals:'see note'}};
  const start=await req('POST','/api/v1/workflows/'+slug+'/runs?mode=async',{input});
  let runId=null; try{runId=JSON.parse(start.body).runId}catch(e){}
  console.log('START',slug,start.status,runId||start.body.slice(0,300));
  out[slug]={startStatus:start.status,runId,startBody:start.body};
  if(!runId) continue;
  // poll until review waiting or terminal
  for(let i=0;i<20;i++){
    await new Promise(r=>setTimeout(r,3000));
    const st=await req('GET','/api/v1/workflows/'+slug+'/runs/'+runId);
    const o=JSON.parse(st.body); out[slug].last=o;
    if(o.status!=='RUNNING'){break}
    const rv=await req('GET','/api/v1/workflows/'+slug+'/runs/'+runId+'/reviews/n_review');
    const r=JSON.parse(rv.body);
    if(r.exists&&r.phase==='WAITING'&&!r.decided){
      const d=await req('POST','/api/v1/workflows/'+slug+'/runs/'+runId+'/reviews/n_review/decide',{decision:'approved',comment:'LOCAL lane proof 4'});
      out[slug].decide={status:d.status,body:d.body}; console.log('  decided',slug,d.status);
    }
  }
  const fin=await req('GET','/api/v1/workflows/'+slug+'/runs/'+runId);
  out[slug].final=JSON.parse(fin.body);
  const f=out[slug].final;
  console.log('FINAL',slug,f.status,'ended',f.endedAt);
  (f.stages||[]).forEach(s=>s.nodes.forEach(n=>console.log('   ',n.node_id,n.status,(n.reason||'').slice(0,140))));
 }
 fs.writeFileSync('proof4.json',JSON.stringify(out,null,1));
})();
