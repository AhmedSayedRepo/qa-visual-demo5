// DOM harvester — returns a compact JSON list of interactable elements for the
// AI healer to choose from. Body is QA Studio's shared harvest script.
function __qaHarvest() {

function robustCss(el){
  if(el.id) return '#'+CSS.escape(el.id);
  if(el.name) return el.tagName.toLowerCase()+'[name="'+el.name+'"]';
  let path=[], e=el;
  while(e && e.nodeType===1 && path.length<5){
    let sel=e.tagName.toLowerCase();
    if(e.className && typeof e.className==='string'){
      let c=e.className.trim().split(/\s+/).filter(Boolean).slice(0,2);
      if(c.length) sel+='.'+c.map(x=>CSS.escape(x)).join('.');
    }
    let p=e.parentNode, idx=1, sib=e;
    while(sib=sib.previousElementSibling){ if(sib.tagName===e.tagName) idx++; }
    sel+=':nth-of-type('+idx+')';
    path.unshift(sel);
    e=e.parentNode;
    if(e && e.id){ path.unshift('#'+CSS.escape(e.id)); break; }
  }
  return path.join(' > ');
}
function xpathOf(el){
  if(el.id) return '//*[@id="'+el.id+'"]';
  let parts=[], e=el;
  while(e && e.nodeType===1){
    let idx=1, sib=e;
    while(sib=sib.previousElementSibling){ if(sib.tagName===e.tagName) idx++; }
    parts.unshift(e.tagName.toLowerCase()+'['+idx+']');
    e=e.parentNode;
  }
  return '/'+parts.join('/');
}
function selectorCandidates(el){
  const out=[];
  const add=(s)=>{if(s&&!out.includes(s))out.push(s);};
  const esc=(v)=>String(v||'').replace(/\\/g,'\\\\').replace(/"/g,'\\"');
  const tag=el.tagName.toLowerCase();
  const tid=el.getAttribute('data-testid')||el.getAttribute('data-test')||el.getAttribute('data-cy')||'';
  if(tid) add('[data-testid="'+esc(tid)+'"]');
  if(el.id) add('#'+CSS.escape(el.id));
  if(el.getAttribute('name')) add(tag+'[name="'+esc(el.getAttribute('name'))+'"]');
  if(el.getAttribute('aria-label')) add('[aria-label="'+esc(el.getAttribute('aria-label'))+'"]');
  add(robustCss(el));
  return out.slice(0,5);
}
const sel='input,button,a,select,textarea,iframe,frame,[role=button],[role=link],[role=tab],[role=menuitem],[role=option],[role=checkbox],[role=switch],[role=combobox],[contenteditable=true],[draggable=true],.ui-draggable,[data-rbd-draggable-id],[aria-roledescription=draggable],[aria-roledescription=sortable]';
const textSel='[role=heading],[role=status],[role=alert],h1,h2,h3,h4,h5,h6,.inventory_item_name,.cart_item,.shopping_cart_badge,.title,.flash,.figcaption,.subheader,#result,#uploaded-files,[data-testid],'+
  // Result/response/output areas a page writes into after an action (a JS
  // dialog's answer, a form echo): matched by id, not one site's exact id.
  'output,[id*=result i],[id*=response i],[id*=output i],[id$=message i],[id*=status i]';
function adjacentText(el){
  // Some plain HTML forms put a checkbox's human label in an unwrapped text
  // node immediately after the input (<input> checkbox 1), so no associated
  // <label> exists.  Capture only nearby visible label text, never a value.
  let out='', n=el.nextSibling;
  while(n && out.length<80){
    if(n.nodeType===3) out+=' '+(n.textContent||'');
    else if(n.nodeType===1 && n.tagName!=='BR') out+=' '+(n.innerText||'');
    if(n.nodeType===1 && n.tagName==='BR') break;
    n=n.nextSibling;
  }
  return out.trim().replace(/\s+/g,' ').slice(0,80);
}
function anameOf(el){
  // best-effort accessible name: aria-label, associated <label>, title, alt, text
  let n = el.getAttribute('aria-label') || '';
  if(!n && el.id){
    try{ var lab=document.querySelector('label[for="'+CSS.escape(el.id)+'"]');
         if(lab) n=(lab.innerText||'').trim(); }catch(e){}
  }
  if(!n){ var pl=el.closest('label'); if(pl) n=(pl.innerText||'').trim(); }
  if(!n) n = el.getAttribute('title') || el.getAttribute('alt') || '';
  if(!n) n = adjacentText(el);
  return (n||'').trim().slice(0,80);
}
// Open shadow roots (web components): their controls are harvested too, with
// `shadow` = the host chain ("host-css >>> inner-host-css"); css stays
// relative to the element's own shadow root.
function shadowRoots(){
  const out=[];
  const walk=(root)=>{ root.querySelectorAll('*').forEach(e=>{
    if(e.shadowRoot && out.length<50){ out.push(e.shadowRoot); walk(e.shadowRoot); } }); };
  try{ walk(document); }catch(e){}
  return out;
}
function hostChain(el){
  const parts=[]; let r=el.getRootNode ? el.getRootNode() : document;
  while(r && r!==document && r.host){
    const h=r.host, hr=h.getRootNode(), tag=h.tagName.toLowerCase();
    // A custom element's tag is usually unique and stable: prefer it (or its id).
    let part=h.id ? '#'+CSS.escape(h.id)
      : (tag.indexOf('-')>0 && hr.querySelectorAll(tag).length===1 ? tag : robustCss(h));
    parts.unshift(part); r=hr;
  }
  return parts.join(' >>> ');
}
const uniq=new Set();
const pool=[...document.querySelectorAll(sel),...document.querySelectorAll(textSel)];
shadowRoots().forEach(r=>{ pool.push(...r.querySelectorAll(sel), ...r.querySelectorAll(textSel)); });
const els=pool.filter(el=>{
  if(uniq.has(el)) return false; uniq.add(el);
  return !!(el.offsetWidth||el.offsetHeight||el.getClientRects().length);
});
return els.slice(0,350).map((el,i)=>({
  idx: i,
  tag: el.tagName.toLowerCase(),
  type: el.getAttribute('type')||'',
  role: el.getAttribute('role')||'',
  id: el.id||'',
  name: el.getAttribute('name')||'',
  testid: el.getAttribute('data-testid')||el.getAttribute('data-test')||el.getAttribute('data-cy')||'',
   // Never harvest field values: a live inspection may have just typed test
   // credentials or other test data. Labels, placeholders and accessible names
   // remain available for deterministic locator matching.
  // A submit/button/reset input's value IS its visible label ("Upload"),
  // never user data; every other input/textarea/select value stays out.
  text: ((el.matches && el.matches('input[type=submit],input[type=button],input[type=reset]'))
         ? (el.value||'')
         : ((el.matches && el.matches('input,textarea,select')) ? '' : (el.innerText||''))).trim().slice(0,60),
  // Option captions describe a control's supported actions; unlike a selected
  // field value, they are safe and necessary for matching "select Option 2".
  // Keep this bounded so a huge country/product list cannot bloat the report.
  options: (el.tagName.toLowerCase()==='select'
            ? [...el.options].map(o=>(o.textContent||'').trim()).filter(Boolean).slice(0,30)
            : []),
  placeholder: el.getAttribute('placeholder')||'',
  aria: el.getAttribute('aria-label')||'',
  aname: anameOf(el),
  required: !!(el.required||el.getAttribute('aria-required')==='true'),
  readonly: !!(el.readOnly||el.getAttribute('aria-readonly')==='true'),
  checked: !!el.checked,
  selectedOptionText: (el.tagName.toLowerCase()==='select' && el.selectedOptions && el.selectedOptions[0]
                       ? (el.selectedOptions[0].textContent||'').trim().slice(0,80) : ''),
  autocomplete: el.getAttribute('autocomplete')||'',
  inputmode: el.getAttribute('inputmode')||'',
  cls: ((typeof el.className==='string'?el.className:'')+' '+
        (el.querySelector('i,svg,[class*=icon i]')?
          (el.querySelector('i,svg,[class*=icon i]').getAttribute('class')||''):'')).trim().slice(0,120),
  svgicon: (function(){
    var s=el.getAttribute('data-svgicon')||el.getAttribute('data-svg-icon')||
          el.getAttribute('ng-reflect-svg-icon')||el.getAttribute('data-icon')||'';
    if(!s){var d=el.querySelector('[data-svgicon],[data-svg-icon],[ng-reflect-svg-icon],[data-icon]');
           if(d) s=d.getAttribute('data-svgicon')||d.getAttribute('data-svg-icon')||
                   d.getAttribute('ng-reflect-svg-icon')||d.getAttribute('data-icon')||'';}
    return (s||'').trim().slice(0,40);
  })(),
  disabled: !!(el.disabled||el.getAttribute('aria-disabled')==='true'),
  visible: !!(el.offsetWidth||el.offsetHeight||el.getClientRects().length),
  css: robustCss(el),
  shadow: hostChain(el),
  xpath: hostChain(el) ? '' : xpathOf(el),
  selectorCandidates: selectorCandidates(el)
}));

}
module.exports = { HARVEST_EXPR: '(' + __qaHarvest.toString() + ')()' };
