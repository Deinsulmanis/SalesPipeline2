'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {STAFFING_CAMPAIGN,isStaffingCampaign,renderStaffingPreview,LOCKED_EMAILS}=require('../integrations/staffing-campaign');
const {CHECKS,SYSTEM,FACT_AUDIT_SYSTEM,AUDIT_SYSTEM,evidenceBlocks,attachEvidence,filterFacts,checkDraft,rebuildFromFacts,
  personalizeStaffingLead,previewStaffingPersonalization,flagBatchDuplicates}=require('../integrations/staffing-personalization');
const {researchStaffingCompany,safeUrl,publicIp}=require('../integrations/staffing-research');
const {registerStaffingPreviewRoutes}=require('../integrations/staffing-preview-route');
const {CAMPAIGN_VERSIONS}=require('../integrations/campaign-versions');
const {templateById,validateCampaignVersionRoute}=require('../integrations/campaign-routing');
const {parseCsv,csv}=require('../scripts/staffing-personalization-qa');

const lead={campaign:STAFFING_CAMPAIGN.name,campaignId:STAFFING_CAMPAIGN.id,company:'Example Staffing',firstName:'Ada',
  companyDomain:'example.com',companyWebsite:'https://example.com',companyCity:'Houston',emailStatus:'verified (NOT catch-all) — Tier 1 send-ready',staffingSpecialization:'Invented aerospace'};
const page={url:'https://example.com/services',title:'Example Staffing',text:'Example Staffing supplies welders, machinists and electricians to manufacturers and serves employers across Northeast Ohio.\nOur headquarters is in Houston.'};
const research={pages:[page],failures:[],reviewRequired:false};
const facts=[['r','role','welders'],['r2','role','machinists'],['r3','role','electricians'],['m','employer_market','manufacturing'],['g','geography','Northeast Ohio']]
  .map(([id,kind,value])=>({id,kind,value,evidenceIds:['p0b0']}));
const good={hyperPersonalizedOpening:'Saw you place welders and machinists with manufacturers across Northeast Ohio.',usedFactIds:['r','r2','m','g']};
const noGeo={hyperPersonalizedOpening:'Saw you place welders, machinists and electricians for manufacturing employers.',usedFactIds:['r','r2','r3','m']};
const draft={companyIdentityConfirmed:true,icpFit:'FIT',fitEvidenceIds:['p0b0'],researchNotes:'Industrial staffing service.',facts,...good};
const audit={checks:Object.fromEntries(CHECKS.map(k=>[k,true])),companySpecific:true,rejectedFactIds:[],reasons:[]};
function opts({extract=draft,fit='FIT',identity=true,factChanges={},rebuilt=noGeo,copyAudit=audit,site=research}={}) {
  const calls=[];
  return {calls,researchCompany:async()=>structuredClone(site),createMessage:async args=>{
    assert.equal(args.model,'claude-haiku-4-5');assert.equal(args.temperature,0);
    const data=JSON.parse(args.messages[0].content);calls.push({system:args.system,data});
    let result;
    if(args.system===SYSTEM){assert.equal(data.companyCity,undefined);assert.equal(data.staffingSpecialization,undefined);result=extract;}
    else if(args.system===FACT_AUDIT_SYSTEM)result={companyIdentityConfirmed:identity,icpFit:fit,fitEvidenceIds:['p0b0'],reason:fit==='FIT'?'Services explicitly match':'Business evidence',
      facts:data.candidateFacts.map(f=>({id:f.id,kind:f.kind,valid:true,staffingRelationship:true,specificRole:f.kind==='role',explicitServiceTerritory:f.kind==='geography',...factChanges[f.id]}))};
    else if(args.system===AUDIT_SYSTEM)result=typeof copyAudit==='function'?copyAudit(data,calls):copyAudit;
    else throw new Error('Unexpected model stage');
    return {content:[{type:'text',text:JSON.stringify(result)}]};
  }};
}
function acceptedFacts(){return attachEvidence(facts,evidenceBlocks(research)).accepted.map(f=>({...f,specificRole:f.kind==='role',explicitServiceTerritory:f.kind==='geography'}));}
test('exact staffing dispatch rejects dental and conflicting assignments before research',async()=>{
  assert.equal(isStaffingCampaign(lead),true);assert.equal(isStaffingCampaign({campaign:STAFFING_CAMPAIGN.id}),true);
  for(const x of [{campaign:'Some other staffing campaign'},{...lead,leadNiche:'dental'},{...lead,intendedCampaignVersion:'dental_v3_pay_per_booking'},{...lead,emailTemplateId:'dental-guarantee-v1'}]) {
    assert.equal(isStaffingCampaign(x),false);
    await assert.rejects(()=>personalizeStaffingLead(x,{researchCompany:()=>{throw new Error('must not research');}}),/exact staffing campaign/);
  }
});
test('staffing remains a non-sendable draft and dental ready routing is preserved',()=>{
  assert.equal(CAMPAIGN_VERSIONS[STAFFING_CAMPAIGN.id].status,'draft');assert.equal(templateById(STAFFING_CAMPAIGN.emailTemplateId).ready,false);
  assert.equal(templateById('dental-guarantee-v1').ready,true);
  assert.equal(validateCampaignVersionRoute({niche:STAFFING_CAMPAIGN.niche,emailTemplateId:STAFFING_CAMPAIGN.emailTemplateId,campaignVersionId:STAFFING_CAMPAIGN.id}).ok,false);
});
test('strong industrial roles and market remain HIGH with locked copy and exactly one bold phrase',async()=>{
  const o=opts(),r=await previewStaffingPersonalization(lead,o);
  assert.equal(r.confidence,'HIGH');assert.equal(r.safeToSend,true);assert.equal(r.regenerationCount,0);assert.equal(o.calls.length,3);
  assert.equal(r.emailPreview.subject,'employer accounts');
  assert.equal(r.emailPreview.body,`Hi Ada,\n\n${good.hyperPersonalizedOpening}\n\nWe help industrial staffing agencies turn that exact market into qualified employer meetings — and we get paid based on the meetings we generate.\n\nWorth seeing how we'd do this for Example Staffing?\n\n— Deins`);
  assert.equal((r.emailPreview.html.match(/<strong>/g)||[]).length,1);assert.match(r.emailPreview.html,/<strong>we get paid based on the meetings we generate\.<\/strong>/);
});
test('valid roles and employer market survive invalid optional geography',async()=>{
  const o=opts({factChanges:{g:{valid:false,reason:'HQ only'}}}),r=await personalizeStaffingLead(lead,o);
  assert.equal(r.confidence,'HIGH');assert.match(r.hyperPersonalizedOpening,/welders and machinists for manufacturers/);
  assert.equal(r.regenerationCount,1);assert.ok(r.supportingReasons.includes('OPTIONAL_GEOGRAPHY_DROPPED'));
  assert.ok(r.facts.every(f=>f.kind!=='geography'));assert.equal(o.calls.length,3);
});
test('three valid roles survive one rejected role',async()=>{
  const bad={id:'bad',kind:'role',value:'astronauts',evidenceIds:['p0b0']};
  const r=await personalizeStaffingLead(lead,opts({extract:{...draft,facts:[...facts,bad]},factChanges:{bad:{valid:false,reason:'Role not supported'}}}));
  assert.equal(r.confidence,'HIGH');assert.ok(r.validatedFacts.filter(f=>f.kind==='role').length===3);assert.ok(r.facts.filter(f=>f.kind==='role').length>=2);
  assert.ok(r.rejectedFacts.some(f=>f.id==='bad'));assert.doesNotMatch(r.hyperPersonalizedOpening,/astronauts/);
});
test('HQ-only geography is deterministically removed even if semantic validator approves it',async()=>{
  const r=await personalizeStaffingLead(lead,opts({extract:{...draft,facts:facts.map(f=>f.id==='g'?{...f,value:'Houston',evidenceIds:['p0b1']}:f)}}));
  assert.equal(r.confidence,'HIGH');assert.ok(r.rejectedFacts.some(f=>f.reason==='SERVICE_TERRITORY_NOT_PROVEN'));
  assert.doesNotMatch(r.hyperPersonalizedOpening,/Houston/);
});
test('job-location geography is removed and non-geographic opening remains valid',async()=>{
  const r=await personalizeStaffingLead(lead,opts({factChanges:{g:{explicitServiceTerritory:false}}}));
  assert.equal(r.confidence,'HIGH');assert.ok(r.facts.every(f=>f.kind!=='geography'));
});
for(const [failure,reason] of [['Request failed with status code 403','RETRIEVAL_BLOCKED_403'],['Request failed with status code 404','RETRIEVAL_PAGE_NOT_FOUND'],['unusable_or_blocked_page','RETRIEVAL_UNUSABLE']]) {
  test(`${failure} becomes RETRY_REQUIRED without any model call or fallback`,async()=>{
    const o=opts({site:{pages:[],failures:[failure],reviewRequired:true}}),r=await previewStaffingPersonalization(lead,o);
    assert.equal(r.confidence,'RETRY_REQUIRED');assert.equal(r.primaryReason,reason);assert.equal(r.hyperPersonalizedOpening,'');assert.equal(r.emailPreview,null);
    assert.equal(o.calls.length,0);assert.equal(r.retrieval.homepageFailed,true);assert.equal(r.retrieval.attempts[0].url,lead.companyWebsite);
  });
}
test('retrieved but unclear industrial fit gives one useful primary reason',async()=>{
  const r=await personalizeStaffingLead(lead,opts({fit:'UNCLEAR',extract:{...draft,hyperPersonalizedOpening:''}}));
  assert.equal(r.confidence,'REVIEW_REQUIRED');assert.equal(r.primaryReason,'INDUSTRIAL_STAFFING_NOT_CONFIRMED');
  assert.deepEqual(r.reviewReasons,['INDUSTRIAL_STAFFING_NOT_CONFIRMED']);assert.equal(r.hyperPersonalizedOpening,'');
});
test('affirmative professional-only evidence agreed by both stages gives ICP_MISMATCH',async()=>{
  const r=await personalizeStaffingLead(lead,opts({extract:{...draft,icpFit:'MISMATCH',facts:[],hyperPersonalizedOpening:''},fit:'MISMATCH'}));
  assert.equal(r.confidence,'ICP_MISMATCH');assert.equal(r.hyperPersonalizedOpening,'');assert.equal(r.safeToSend,false);
});
test('disagreement about ICP mismatch remains review rather than declaring the business unsuitable',async()=>{
  const r=await personalizeStaffingLead(lead,opts({fit:'MISMATCH'}));assert.equal(r.confidence,'REVIEW_REQUIRED');
});
test('identity mismatch is retrieval/identity retry and never copy uncertainty',async()=>{
  const r=await personalizeStaffingLead(lead,opts({identity:false}));assert.equal(r.confidence,'RETRY_REQUIRED');assert.equal(r.primaryReason,'DOMAIN_IDENTITY_UNRESOLVED');
});
test('light-industrial fact misclassified as a role is recognized as an employer market',async()=>{
  const extract={...draft,facts:[{id:'m',kind:'role',value:'light industrial staffing',evidenceIds:['p0b0']}],
    hyperPersonalizedOpening:'Saw you specialize in light industrial staffing for employers.',usedFactIds:['m']};
  const r=await personalizeStaffingLead(lead,opts({extract,factChanges:{m:{kind:'employer_market',specificRole:false}}}));
  assert.equal(r.confidence,'MEDIUM');assert.equal(r.facts[0].kind,'employer_market');
});
test('roles plus explicit service territory satisfy minimum without requiring industry',async()=>{
  const r=await personalizeStaffingLead(lead,opts({extract:{...draft,hyperPersonalizedOpening:'Saw you place welders and machinists for employers across Northeast Ohio.',usedFactIds:['r','r2','g']}}));
  assert.equal(r.confidence,'HIGH');assert.ok(!r.facts.some(f=>f.kind==='employer_market'));
});
test('true but irrelevant history and staffing-model facts cannot qualify; no fallback fluff',async()=>{
  const o=opts({extract:{...draft,facts:[{id:'history',kind:'history',value:'Founded 1990',evidenceIds:['p0b0']},{id:'temp',kind:'staffing_model',value:'temporary',evidenceIds:['p0b0']}],hyperPersonalizedOpening:'',usedFactIds:[]}});
  const r=await personalizeStaffingLead(lead,o);assert.equal(r.primaryReason,'VALID_FACTS_INSUFFICIENT');assert.equal(r.hyperPersonalizedOpening,'');
  assert.equal(o.calls.length,2);
});
test('rebuild cannot reintroduce an unsupported fact through an old proposal ID',async()=>{
  const r=await personalizeStaffingLead(lead,opts({factChanges:{g:{valid:false}},rebuilt:good}));
  assert.equal(r.confidence,'HIGH');assert.ok(r.facts.every(f=>f.id!=='g'));assert.doesNotMatch(r.hyperPersonalizedOpening,/Ohio/);assert.equal(r.regenerationCount,1);
});
test('unsupported wording with valid IDs is caught by independent copy audit; loop is bounded',async()=>{
  const o=opts({factChanges:{g:{valid:false}},rebuilt:{...noGeo,hyperPersonalizedOpening:'Saw you place welders and machinists for manufacturing employers across Houston.'},
    copyAudit:{...audit,checks:{...audit.checks,supportedGeography:false,supportedByValidatedFacts:false},reasons:['Houston not validated']}});
  const r=await personalizeStaffingLead(lead,o);assert.equal(r.confidence,'REVIEW_REQUIRED');assert.equal(r.hyperPersonalizedOpening,'');
  assert.equal(r.regenerationCount,1);assert.equal(o.calls.length,3);
});
test('market referent failure triggers at most one rebuild and remains held if unresolved',async()=>{
  const o=opts({copyAudit:{...audit,checks:{...audit.checks,marketReferent:false},reasons:['No employer market']}}),r=await personalizeStaffingLead(lead,o);
  assert.equal(r.confidence,'REVIEW_REQUIRED');assert.equal(r.regenerationCount,1);assert.equal(o.calls.length,4);
});
test('Skillforce-style project destination is rebuilt with supported employer nouns',async()=>{
  const extract={...draft,facts:[{...facts[0],value:'electricians'},{...facts[1],value:'carpenters'},{...facts[3],value:'construction'}],
    hyperPersonalizedOpening:'Saw you place electricians and carpenters into construction projects.',usedFactIds:['r','r2','m']};
  const rebuilt={...noGeo,hyperPersonalizedOpening:'Saw you place electricians and carpenters for construction contractors.'};
  const r=await personalizeStaffingLead(lead,opts({extract,rebuilt}));assert.equal(r.regenerationCount,1);assert.match(r.hyperPersonalizedOpening,/construction contractors/);
});
test('Saw your team places is corrected once rather than accepted',async()=>{
  const r=await personalizeStaffingLead(lead,opts({extract:{...draft,hyperPersonalizedOpening:'Saw your team places welders and machinists for manufacturing employers.'}}));
  assert.equal(r.confidence,'HIGH');assert.doesNotMatch(r.hyperPersonalizedOpening,/Saw your team places/);assert.equal(r.regenerationCount,1);
});
test('HIGH requires quality and concrete roles, not only truthful words',async()=>{
  const r=await personalizeStaffingLead(lead,opts({copyAudit:{...audit,companySpecific:false}}));assert.equal(r.confidence,'MEDIUM');
});
test('deterministic sentence and word counts override model miscounting, while semantic checks still apply',async()=>{
  const r=await personalizeStaffingLead(lead,opts({copyAudit:{...audit,checks:{...audit.checks,oneSentence:false,reasonableLength:false},reasons:['Incorrect model count']}}));
  assert.equal(r.confidence,'HIGH');assert.equal(r.regenerationCount,0);assert.equal(r.qaChecks.reasonableLength,true);
});
test('sentence, compliments, candidate sourcing, generic language and repetition are rejected',()=>{
  for(const opening of ['Saw you place welders. You are impressive.','Saw you manage a candidate database with excellent results.','"Saw you focus on industrial staffing for manufacturing employers."','Saw you provide staffing solutions to many companies around here.'])
    assert.ok(checkDraft({...good,hyperPersonalizedOpening:opening},acceptedFacts()).errors.length);
});
test('fabricated block references cannot yield a factual opening',async()=>{
  const r=await personalizeStaffingLead(lead,opts({extract:{...draft,facts:facts.map(f=>({...f,evidenceIds:['imaginary']}))}}));
  assert.equal(r.confidence,'REVIEW_REQUIRED');assert.equal(r.primaryReason,'VALID_FACTS_INSUFFICIENT');assert.equal(r.hyperPersonalizedOpening,'');
});
test('distinct claims sharing one source ID are retained with unique IDs and require remapping',()=>{
  const attached=attachEvidence([{...facts[0],id:'p0b0'},{...facts[1],id:'p0b0'},{...facts[3],id:'p0b0'}],evidenceBlocks(research));
  assert.equal(attached.accepted.length,3);assert.equal(new Set(attached.accepted.map(f=>f.id)).size,3);
  assert.equal(attached.rejected.length,0);
  assert.ok(checkDraft({...good,usedFactIds:['p0b0']},attached.accepted).errors.includes('UNVALIDATED_FACT_REFERENCE'));
});
test('rebuild cannot use neighboring rejected claims embedded in a valid fact quotation',()=>{
  const candidate=rebuildFromFacts(acceptedFacts().filter(f=>f.kind!=='geography').map(f=>({...f,quote:'Headquarters Houston, Northeast Ohio. Astronauts.'})));
  assert.doesNotMatch(candidate.hyperPersonalizedOpening,/Houston|Northeast Ohio|astronauts/i);
  assert.ok(candidate.usedFactIds.every(id=>['r','r2','r3','m'].includes(id)));
});
test('one complete JSON response with trailing explanation is accepted; conflicting objects are rejected',async()=>{
  for(const trailing of ['\nThis is the requested analysis.','\n{"icpFit":"MISMATCH"}']) {
    const o=opts(),original=o.createMessage;o.createMessage=async args=>{const response=await original(args);response.content[0].text+=trailing;return response;};
    const r=await personalizeStaffingLead(lead,o);assert.equal(r.confidence,trailing.includes('{')?'REVIEW_REQUIRED':'HIGH');
  }
});
test('model credit exhaustion is a technical retry, not ambiguous ICP or invented fallback',async()=>{
  const r=await personalizeStaffingLead(lead,{researchCompany:async()=>research,createMessage:async()=>{
    const e=new Error('400');e.error={error:{message:'Your credit balance is too low to access the Anthropic API.'}};throw e;
  }});
  assert.equal(r.classification,'RETRY_REQUIRED');assert.equal(r.primaryReason,'MODEL_CREDITS_EXHAUSTED');
  assert.equal(r.executionBlocked,true);assert.equal(r.hyperPersonalizedOpening,'');assert.equal(r.safeToSend,false);
});
test('fit disagreement does not turn an uncertain diversified agency into an approved lead',async()=>{
  const r=await personalizeStaffingLead(lead,opts({extract:{...draft,icpFit:'MISMATCH'},fit:'FIT'}));
  assert.equal(r.classification,'REVIEW_REQUIRED');assert.equal(r.primaryReason,'ICP_ASSESSMENT_CONFLICT');
});
test('professional roles and markets are filtered without losing proven industrial facts',()=>{
  const candidates=attachEvidence([...facts,{id:'office',kind:'role',value:'administrative coordinator',evidenceIds:['p0b0']},
    {id:'finance',kind:'employer_market',value:'finance and accounting staffing',evidenceIds:['p0b0']}],evidenceBlocks(research)).accepted;
  const reviewed=filterFacts(candidates,{facts:candidates.map(f=>({id:f.id,valid:true,kind:f.kind,staffingRelationship:true,explicitServiceTerritory:true,specificRole:true}))});
  assert.ok(reviewed.rejected.some(f=>f.id==='office'));assert.ok(reviewed.rejected.some(f=>f.id==='finance'));assert.ok(reviewed.accepted.some(f=>f.id==='m'));
});
test('absent fact audits, string booleans and incomplete copy audits fail closed',async()=>{
  const attached=attachEvidence(facts,evidenceBlocks(research)).accepted;
  assert.equal(filterFacts(attached,{facts:[]}).accepted.length,0);
  const r=await personalizeStaffingLead(lead,opts({identity:'true'}));assert.equal(r.confidence,'RETRY_REQUIRED');
  const incomplete=await personalizeStaffingLead(lead,opts({copyAudit:{checks:{oneSentence:true}}}));assert.equal(incomplete.confidence,'REVIEW_REQUIRED');
});
test('catch-all, missing status and malformed model responses fail closed',async()=>{
  for(const emailStatus of ['catch-all','verified','']) {
    const r=await personalizeStaffingLead({...lead,emailStatus},{researchCompany:()=>{throw new Error('must not fetch');}});assert.equal(r.primaryReason,'TIER1_NON_CATCHALL_REQUIRED');
  }
  const r=await personalizeStaffingLead(lead,{researchCompany:async()=>research,createMessage:async()=>({content:[{type:'text',text:'invalid'}]})});
  assert.equal(r.confidence,'REVIEW_REQUIRED');assert.equal(r.primaryReason,'MODEL_OR_RESPONSE_ERROR');
});
// ── duplicate diversity and role preference ─────────────────────────────────
const dRole=(id,v)=>({id,kind:'role',value:v,specificRole:true,evidence:[{sourceUrl:'https://example.com',quote:'q'}]});
const dMarket=(id,v)=>({id,kind:'employer_market',value:v,evidence:[{sourceUrl:'https://example.com',quote:'q'}]});
const dPool=p=>[dRole(p+'1','carpenters'),dRole(p+'2','electricians'),dRole(p+'3','welders'),dMarket(p+'4','construction')];
const COLLIDE='Saw you place carpenters and electricians for construction contractors.';
const dRow=(company,pool)=>({company,companyDomain:'example.com',companyWebsite:'https://example.com',firstName:'Ada',
  campaign:STAFFING_CAMPAIGN.name,campaignId:STAFFING_CAMPAIGN.id,hyperPersonalizedOpening:COLLIDE,
  validatedFacts:pool,facts:pool.slice(0,2).concat(pool[3]),confidence:'HIGH',classification:'HIGH',safeToSend:true,
  reviewFlag:false,reviewReasons:[],supportingReasons:[],emailPreview:{},research:{pages:[]},modelCalls:3});
const auditStub=(verdict=true)=>{let n=0;const fn=async()=>{n++;return {content:[{type:'text',text:JSON.stringify(
  {checks:Object.fromEntries(CHECKS.map(k=>[k,verdict])),companySpecific:verdict,rejectedFactIds:[],reasons:[]})}]};};
  fn.count=()=>n;return fn;};

test('a later duplicate gets one bounded alternate; the first accepted lead is never invalidated',async()=>{
  const rows=[dRow('First Co',dPool('a')),dRow('Second Co',dPool('b'))];
  const audit=auditStub(true);
  await flagBatchDuplicates(rows,{createMessage:audit});
  // The earlier lead keeps exactly what it had — it did nothing wrong.
  assert.equal(rows[0].hyperPersonalizedOpening,COLLIDE);
  assert.equal(rows[0].safeToSend,true);
  assert.equal(rows[0].classification,'HIGH');
  assert.ok(!rows[0].duplicateAlternateUsed);
  // The later lead is re-composed from its OWN validated facts and stays accepted.
  assert.notEqual(rows[1].hyperPersonalizedOpening,COLLIDE);
  assert.equal(rows[1].hyperPersonalizedOpening,'Saw you place carpenters and welders for construction contractors.');
  assert.equal(rows[1].safeToSend,true);
  assert.equal(rows[1].duplicateAlternateUsed,true);
  assert.ok(rows[1].supportingReasons.includes('DUPLICATE_ALTERNATE_COMPOSITION'));
  // Exactly one alternate audit: no unbounded retry loop.
  assert.equal(audit.count(),1);
});

test('the deterministic alternate is reproducible and uses only validated facts',async()=>{
  const run=async()=>{const rows=[dRow('First Co',dPool('a')),dRow('Second Co',dPool('b'))];
    await flagBatchDuplicates(rows,{createMessage:auditStub(true)});return rows[1];};
  const a=await run(),b=await run();
  assert.equal(a.hyperPersonalizedOpening,b.hyperPersonalizedOpening,'same input yields the same alternate');
  const allowed=new Set(dPool('b').map(f=>f.id));
  assert.ok(a.facts.every(f=>allowed.has(f.id)),'alternate cites only that lead\'s validated facts');
  for(const f of a.facts)assert.ok(a.hyperPersonalizedOpening.toLowerCase().includes(f.value.split(' ')[0].toLowerCase().slice(0,6))
    ||f.kind==='employer_market','every cited fact is actually used');
});

test('an alternate that fails the copy audit is held, and no audit means no acceptance',async()=>{
  const rejected=[dRow('First Co',dPool('a')),dRow('Second Co',dPool('b'))];
  const audit=auditStub(false);
  await flagBatchDuplicates(rejected,{createMessage:audit});
  assert.equal(rejected[0].safeToSend,true,'the first lead is still untouched');
  assert.equal(rejected[1].safeToSend,false);
  assert.equal(rejected[1].hyperPersonalizedOpening,'');
  assert.equal(rejected[1].primaryReason,'DUPLICATE_OPENING_IN_BATCH');
  assert.equal(audit.count(),1,'one attempt only');
  // Without a model the alternate cannot be audited, so it must not be accepted.
  const noModel=[dRow('First Co',dPool('a')),dRow('Second Co',dPool('b'))];
  await flagBatchDuplicates(noModel,{createMessage:null});
  assert.equal(noModel[0].safeToSend,true);
  assert.equal(noModel[1].safeToSend,false);
  assert.equal(noModel[1].hyperPersonalizedOpening,'');
});

test('a lead with no alternate material is held rather than differentiated by invention',async()=>{
  const thin=()=>[dRole('t1','carpenters'),dMarket('t2','construction')];
  const rows=[dRow('First Co',thin()),dRow('Second Co',thin())];
  rows.forEach(r=>{r.hyperPersonalizedOpening='Saw your team placing carpenters for construction contractors.';});
  await flagBatchDuplicates(rows,{createMessage:auditStub(true)});
  assert.equal(rows[0].safeToSend,true);
  assert.equal(rows[1].safeToSend,false,'identical evidence must not be forced apart');
  assert.equal(rows[1].hyperPersonalizedOpening,'');
});

test('concrete validated roles are preferred over generic market-only copy',()=>{
  const withRoles=[dRole('p1','forklift operators'),dRole('p2','machine operators'),dMarket('p3','manufacturing')];
  assert.equal(rebuildFromFacts(withRoles).hyperPersonalizedOpening,
    'Saw you place forklift operators and machine operators for manufacturers.');
  // A bare skilled-trades label must not push a role-capable lead into market-only copy.
  const tradesFirst=[dRole('q1','welders'),dRole('q2','millwrights'),dMarket('q3','skilled trades staffing'),dMarket('q4','construction')];
  assert.equal(rebuildFromFacts(tradesFirst).hyperPersonalizedOpening,
    'Saw you place welders and millwrights for construction contractors.');
});

test('market-only copy survives only when no usable concrete role exists',()=>{
  const marketOnly=[dMarket('m1','oil & gas industry')];
  assert.equal(rebuildFromFacts(marketOnly).hyperPersonalizedOpening,'Saw you focus on oil & gas staffing for employers.');
  // A role is never invented to avoid the generic form.
  assert.ok(!/place/.test(rebuildFromFacts(marketOnly).hyperPersonalizedOpening));
  // Roles the fact audit refused to call specific cannot rescue it either.
  const vague=[{id:'v1',kind:'role',value:'entry level positions',specificRole:false,evidence:[{sourceUrl:'u',quote:'q'}]},dMarket('v2','manufacturing')];
  assert.equal(rebuildFromFacts(vague).hyperPersonalizedOpening,'Saw you focus on manufacturing staffing for employers.');
});

test('HIGH needs a concrete placed role, not a broad label that is merely true',async()=>{
  const {concreteRole}=require('../integrations/staffing-personalization');
  for(const v of ['general labor','skilled construction workers','skilled trades','light industrial workers','entry level positions'])
    assert.equal(concreteRole({kind:'role',value:v,specificRole:true}),false,`${v} is a category, not a placed role`);
  for(const v of ['forklift operators','welders','CNC machinists','Warehouse workers'])
    assert.equal(concreteRole({kind:'role',value:v,specificRole:true}),true,`${v} is a concrete role`);
  // End to end: a broad-label role yields MEDIUM, a concrete one yields HIGH.
  const broad=[['b1','role','general labor'],['b2','employer_market','construction']].map(([id,kind,value])=>({id,kind,value,evidenceIds:['p0b0']}));
  const graded=async factSet=>{
    const o=opts({extract:{companyIdentityConfirmed:true,icpFit:'FIT',fitEvidenceIds:['p0b0'],researchNotes:'n',facts:factSet,
      hyperPersonalizedOpening:'',usedFactIds:[]}});
    return (await personalizeStaffingLead(lead,o)).classification;
  };
  assert.equal(await graded(broad),'MEDIUM');
  const sharp=[['s1','role','welders'],['s2','employer_market','construction']].map(([id,kind,value])=>({id,kind,value,evidenceIds:['p0b0']}));
  assert.equal(await graded(sharp),'HIGH');
});
test('research preserves prioritized pages and structured partial-failure diagnostics',async()=>{
  const visited=[];
  const r=await researchStaffingCompany(lead,{fetch:async url=>{visited.push(url);if(url===lead.companyWebsite)return {...page,url,links:[{href:'/about',label:'About'},{href:'/manufacturing',label:'Manufacturing'},{href:'https://elsewhere.com',label:'Services'}]};if(url.endsWith('/about'))throw new Error('403');return {...page,url};}});
  assert.deepEqual(visited,['https://example.com','https://example.com/manufacturing','https://example.com/about']);
  assert.equal(r.pages.length,2);assert.equal(r.retrieval.homepageFailed,false);assert.equal(r.retrieval.alternateCompanyPageAttempted,true);
  assert.equal(r.retrieval.attempts[2].status,403);assert.equal(r.retrieval.usableAlternateEvidence,true);
});
test('failed homepage captures URL and status without unrestricted alternate scraping',async()=>{
  const r=await researchStaffingCompany(lead,{fetch:async()=>{throw new Error('404');}});
  assert.equal(r.retrieval.homepageFailed,true);assert.equal(r.retrieval.alternateCompanyPageAttempted,false);
  assert.equal(r.retrieval.attempts[0].url,lead.companyWebsite);assert.equal(r.retrieval.attempts[0].status,404);
});
test('domain conflicts and private URLs cannot be fetched',async()=>{
  const r=await researchStaffingCompany({...lead,companyDomain:'wrong.com'},{fetch:()=>{throw new Error('must not fetch');}});assert.equal(r.reviewRequired,true);
  for(const url of ['http://127.0.0.1','http://localhost','http://169.254.169.254','http://[::1]','file:///etc/passwd','https://user:password@example.com'])assert.throws(()=>safeUrl(url));
  assert.equal(publicIp('10.1.2.3'),false);assert.equal(publicIp('8.8.8.8'),true);
});
test('authenticated preview API remains isolated from storage and sending',async()=>{
  const handlers={},auth=()=>{},app={get:(url,middleware,fn)=>{assert.equal(middleware,auth);handlers[url]=fn;},post:(url,middleware,fn)=>{assert.equal(middleware,auth);handlers[url]=fn;}};
  registerStaffingPreviewRoutes(app,auth,async x=>({previewOnly:true,company:x.company}));let output,status;
  const res={json:x=>output=x,status:s=>{status=s;return res;}};
  await handlers['/api/staffing/personalization/preview']({body:{lead}},res);assert.equal(output.previewOnly,true);
  await handlers['/api/staffing/personalization/preview']({body:{lead:{campaign:'Dental'}}},res);assert.equal(status,422);
});
test('locked follow-ups, HTML escaping and review preview suppression are preserved',()=>{
  const r=renderStaffingPreview({...lead,company:'A & B <Partners>'},null,2);
  assert.match(r.body,/If we don't generate qualified employer meetings, there are no meeting fees\./);assert.match(r.html,/A &amp; B &lt;Partners&gt;/);
  // Each locked step bolds exactly one phrase — step 2 bolds the fulfilment line.
  assert.equal((r.html.match(/<strong>/g)||[]).length,1);
  assert.match(r.html,/<strong>We handle the prospecting, outreach and qualification, then put interested employers directly on your calendar\.<\/strong>/);
  assert.equal(LOCKED_EMAILS.length,3);assert.equal(renderStaffingPreview(lead,{reviewFlag:true},1),null);
});
test('QA CSV round-trips multiline evidence and quotes',()=>{
  const rows=[{company:'A, B',evidence:'First line\nSecond "quoted" line'}];assert.deepEqual(parseCsv(csv(rows,['company','evidence'])),rows);
});
