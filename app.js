"use strict";
/* =====================================================================
   Deg Supportdesk v2 — gedeelde data via GitHub
   Eén databestand (data/tickets.json) in de repository is de bron van
   waarheid. Deze app leest en schrijft dat bestand via de GitHub API,
   houdt lokaal een cache bij voor snelle start, en lost gelijktijdige
   wijzigingen op door samen te voegen op ticketniveau.
   ===================================================================== */

/* ================= Constanten ================= */
const STATUSSEN = ["Nieuw","In behandeling","Wacht op melder","Opgelost"];
const PRIORITEITEN = ["kritiek","hoog","normaal","laag"];
const PRIO_LABEL = {kritiek:"Kritiek",hoog:"Hoog",normaal:"Normaal",laag:"Laag"};
const PRIO_PIL = {kritiek:"kritiek",hoog:"aandacht",normaal:"info",laag:"neutraal"};
const CATEGORIEEN = ["Cirkelplanning","Competentiedashboard","Factuurdashboard","SharePoint","Deg Academy","Werkplek & accounts","Overig"];
const TYPES = ["Storing","Bug","Vraag","Wijzigingsverzoek"];
const CONFIG_SLEUTEL = "deg-supportdesk-config-v2";
const CACHE_SLEUTEL = "deg-supportdesk-cache-v2";
const DAG = 86400000;
const POLL_MS = 60000;

/* ================= Configuratie & aanmelding ================= */
function leesConfig(){
  try{ return JSON.parse(localStorage.getItem(CONFIG_SLEUTEL)) || {}; }catch(e){ return {}; }
}
function bewaarConfig(c){
  try{ localStorage.setItem(CONFIG_SLEUTEL, JSON.stringify(c)); }catch(e){}
}
function raadRepo(){
  // Op GitHub Pages: https://<owner>.github.io/<repo>/ → owner en repo afleiden.
  const h = location.hostname, p = location.pathname.split("/").filter(Boolean);
  if(h.endsWith(".github.io")) return { owner: h.split(".")[0], repo: p[0] || "" };
  return { owner:"", repo:"" };
}
let config = leesConfig();

/* ================= Gedeelde staat ================= */
function leegData(){
  return { volgnr:0, tickets:[], gebruikers:[], verwijderd:[], bijgewerkt:null };
}
let staat = leegData();
let bestandSha = null;          // sha van data/tickets.json — nodig om te schrijven
let opslaanTimer = null;        // debounce
let bezigMetOpslaan = false;
let laatsteSync = null;

function cacheLaad(){
  try{
    const r = JSON.parse(localStorage.getItem(CACHE_SLEUTEL));
    if(r && Array.isArray(r.tickets)) staat = normaliseer(r);
  }catch(e){}
}
function cacheBewaar(){
  try{ localStorage.setItem(CACHE_SLEUTEL, JSON.stringify(staat)); }catch(e){}
}
function normaliseer(d){
  return {
    volgnr: Number(d.volgnr) || 0,
    tickets: Array.isArray(d.tickets) ? d.tickets : [],
    gebruikers: Array.isArray(d.gebruikers) ? d.gebruikers : [],
    verwijderd: Array.isArray(d.verwijderd) ? d.verwijderd : [],
    bijgewerkt: d.bijgewerkt || null
  };
}

/* ================= GitHub API ================= */
function apiUrl(){
  return `https://api.github.com/repos/${config.owner}/${config.repo}/contents/${config.pad}`;
}
function kopteksten(){
  return {
    "Accept":"application/vnd.github+json",
    "Authorization":"Bearer " + config.token,
    "X-GitHub-Api-Version":"2022-11-28"
  };
}
function naarB64(s){
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for(let i=0;i<bytes.length;i+=8192) bin += String.fromCharCode(...bytes.subarray(i,i+8192));
  return btoa(bin);
}
function vanB64(b){
  const bin = atob(b.replace(/\s/g,""));
  const bytes = Uint8Array.from(bin, c=>c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}
async function ghLaad(){
  const r = await fetch(apiUrl() + "?ref=" + encodeURIComponent(config.branch), {headers: kopteksten(), cache:"no-store"});
  if(r.status === 404) return {status:404};
  if(!r.ok) return {status:r.status};
  const j = await r.json();
  return {status:200, sha:j.sha, data: normaliseer(JSON.parse(vanB64(j.content)))};
}
async function ghSchrijf(data, sha){
  const body = {
    message: `Supportdesk: bijgewerkt door ${config.naam || "onbekend"}`,
    content: naarB64(JSON.stringify(data, null, 2)),
    branch: config.branch
  };
  if(sha) body.sha = sha;
  const r = await fetch(apiUrl(), {method:"PUT", headers: kopteksten(), body: JSON.stringify(body)});
  if(!r.ok) return {status:r.status};
  const j = await r.json();
  return {status:200, sha:j.content.sha};
}

/* ================= Samenvoegen bij gelijktijdig werken ================= */
function voegSamen(lokaal, extern){
  const uit = leegData();
  uit.volgnr = Math.max(lokaal.volgnr, extern.volgnr);
  const tomb = new Map();
  [...extern.verwijderd, ...lokaal.verwijderd].forEach(v=>tomb.set(v.id, v));
  uit.verwijderd = [...tomb.values()].slice(-200);
  const kaart = new Map();
  [...extern.tickets, ...lokaal.tickets].forEach(t=>{
    const bestaand = kaart.get(t.id);
    if(!bestaand || (t.bijgewerkt || "") > (bestaand.bijgewerkt || "")) kaart.set(t.id, t);
  });
  uit.tickets = [...kaart.values()].filter(t=>!tomb.has(t.id));
  uit.gebruikers = [...new Set([...extern.gebruikers, ...lokaal.gebruikers])];
  uit.bijgewerkt = new Date().toISOString();
  return uit;
}

/* ================= Synchroniseren ================= */
function zetSync(stand, tekst){
  const el = document.getElementById("sync");
  el.dataset.stand = stand;
  document.getElementById("syncTekst").textContent = tekst;
}
async function laadVanGitHub(stil){
  if(!config.token) return false;
  if(!stil) zetSync("bezig","laden…");
  try{
    const r = await ghLaad();
    if(r.status === 200){
      bestandSha = r.sha;
      staat = r.data;
      cacheBewaar();
      laatsteSync = new Date();
      zetSync("goed","gesynchroniseerd " + tijdKort(laatsteSync));
      renderAlles();
      return true;
    }
    if(r.status === 404){
      zetSync("fout","databestand ontbreekt");
      meld("Het databestand staat nog niet in de repository. Zet " + config.pad + " klaar (zie README) of meld je opnieuw aan.");
      return false;
    }
    zetSync("fout","geen toegang (" + r.status + ")");
    return false;
  }catch(e){
    zetSync("fout","offline — lokale weergave");
    return false;
  }
}
function plannenOpslaan(){
  clearTimeout(opslaanTimer);
  zetSync("bezig","wijziging klaarzetten…");
  opslaanTimer = setTimeout(opslaanNaarGitHub, 700);
}
async function opslaanNaarGitHub(){
  if(bezigMetOpslaan){ plannenOpslaan(); return; }
  if(!config.token){ zetSync("fout","niet aangemeld"); return; }
  bezigMetOpslaan = true;
  zetSync("bezig","opslaan…");
  try{
    staat.bijgewerkt = new Date().toISOString();
    let r = await ghSchrijf(staat, bestandSha);
    if(r.status === 409 || r.status === 422){
      // Iemand anders was net eerder: verse stand ophalen, samenvoegen, nogmaals.
      const vers = await ghLaad();
      if(vers.status === 200){
        staat = voegSamen(staat, vers.data);
        renderAlles();
        r = await ghSchrijf(staat, vers.sha);
      }
    }
    if(r.status === 200){
      bestandSha = r.sha;
      cacheBewaar();
      laatsteSync = new Date();
      zetSync("goed","gesynchroniseerd " + tijdKort(laatsteSync));
    }else{
      zetSync("fout","opslaan mislukt (" + r.status + ")");
      meld("Opslaan naar GitHub lukt niet (code " + r.status + "). Je wijziging staat lokaal klaar — controleer de verbinding of je sleutel en druk op Verversen.");
    }
  }catch(e){
    zetSync("fout","offline — wijziging staat lokaal");
  }finally{
    bezigMetOpslaan = false;
  }
}
function wijzig(fn){
  fn(staat);
  cacheBewaar();
  renderAlles();
  plannenOpslaan();
}
setInterval(()=>{
  if(document.visibilityState === "visible" && !bezigMetOpslaan && !opslaanTimer_actief())
    laadVanGitHub(true);
}, POLL_MS);
function opslaanTimer_actief(){
  // Tijdens een wachtende schrijfactie niet verversen, anders raakt de wijziging kwijt.
  return document.getElementById("sync").dataset.stand === "bezig";
}

/* ================= Hulpfuncties ================= */
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
function nieuwId(){ staat.volgnr++; return "T-" + String(staat.volgnr).padStart(3,"0"); }
function nu(){ return new Date().toISOString(); }
function dagen(a,b){ return Math.max(0, Math.round((new Date(b) - new Date(a)) / DAG)); }
function datumKort(iso){
  const d = new Date(iso);
  return String(d.getDate()).padStart(2,"0") + "-" + String(d.getMonth()+1).padStart(2,"0") + "-" + d.getFullYear();
}
function tijdKort(d){
  return String(d.getHours()).padStart(2,"0") + ":" + String(d.getMinutes()).padStart(2,"0");
}
function leeftijd(t){
  const eind = t.status === "Opgelost" && t.opgelost ? t.opgelost : nu();
  const d = dagen(t.aangemaakt, eind);
  return d === 0 ? "vandaag" : d + (d === 1 ? " dag" : " dagen");
}
function ontsmet(s){ const d = document.createElement("div"); d.textContent = s ?? ""; return d.innerHTML; }
function meld(tekst){
  const m = $("#melding"); m.textContent = tekst; m.classList.add("zichtbaar");
  clearTimeout(meld._t); meld._t = setTimeout(()=>m.classList.remove("zichtbaar"), 3400);
}
function vind(id){ return staat.tickets.find(t=>t.id===id); }
function behandelaarOpties(){
  const lijst = [...staat.gebruikers].sort((a,b)=>a.localeCompare(b,"nl"));
  return `<option value="">— nog niet toegewezen —</option>` +
    lijst.map(g=>`<option value="${ontsmet(g)}">${ontsmet(g)}</option>`).join("");
}
function vulSelect(el, opties, leegLabel){
  el.innerHTML = (leegLabel ? `<option value="">${leegLabel}</option>` : "") +
    opties.map(o => `<option value="${ontsmet(o)}">${ontsmet(PRIO_LABEL[o] || o)}</option>`).join("");
}

/* ================= Renderen ================= */
let actieveTab = "bord";
function renderAlles(){
  ({bord:tekenBord, tickets:tekenTabel, dashboard:tekenDashboard, beheer:tekenBeheer, nieuw:()=>{}})[actieveTab]();
  $("#inBehandelaar").innerHTML = behandelaarOpties();
  $("#dBehandelaar").innerHTML = behandelaarOpties();
}

/* ================= Tabs ================= */
$$(".deg-tabs button").forEach(b=> b.addEventListener("click", ()=> toonTab(b.dataset.tab)));
function toonTab(naam){
  actieveTab = naam;
  $$(".deg-tabs button").forEach(b=> b.setAttribute("aria-selected", String(b.dataset.tab === naam)));
  ["bord","tickets","nieuw","dashboard","beheer"].forEach(t=> $("#scherm-"+t).hidden = t !== naam);
  $("#kruimel").textContent = "Supportdesk / Deg intern / " +
    ({bord:"Bord",tickets:"Tickets",nieuw:"Nieuw ticket",dashboard:"Dashboard",beheer:"Beheer"})[naam] +
    " / peildatum " + datumKort(nu());
  renderAlles();
}

/* ================= Bord ================= */
function tekenBord(){
  const leeg = staat.tickets.length === 0;
  $("#bordLeeg").hidden = !leeg;
  const bord = $("#bord");
  bord.hidden = leeg;
  if(leeg){ bord.innerHTML = ""; return; }
  bord.innerHTML = STATUSSEN.map(s=>{
    const items = staat.tickets.filter(t=>t.status===s)
      .sort((a,b)=> PRIORITEITEN.indexOf(a.prioriteit) - PRIORITEITEN.indexOf(b.prioriteit) || a.aangemaakt.localeCompare(b.aangemaakt));
    const icoon = s === "Wacht op melder" ? "ico-kussen" : s === "Opgelost" ? "ico-lamp" : "ico-klok";
    return `<div class="kolom" data-status="${ontsmet(s)}">
      <header><svg class="ico"><use href="#${icoon}"/></svg>
        ${ontsmet(s)} <span class="aantal num">${items.length}</span></header>
      <div class="kaarten">${items.map(kaartHtml).join("")}</div>
    </div>`;
  }).join("");
  koppelKolommen();
}
function kaartHtml(t){
  const idx = STATUSSEN.indexOf(t.status);
  return `<div class="kaart" draggable="true" data-id="${t.id}" data-prio="${t.prioriteit}" tabindex="0"
      role="button" aria-label="Ticket ${t.id}: ${ontsmet(t.titel)}">
    <div class="kop"><span class="code">${t.id}</span><span class="pil ${PRIO_PIL[t.prioriteit]}">${PRIO_LABEL[t.prioriteit]}</span></div>
    <div class="titel">${ontsmet(t.titel)}</div>
    <div class="meta"><span>${ontsmet(t.categorie)}</span>·<span>${ontsmet(t.behandelaar || "niet toegewezen")}</span>·<span class="num">${leeftijd(t)}</span></div>
    <div class="verplaats geen-print">
      <button class="knop stil klein" data-schuif="-1" ${idx===0?"disabled":""} aria-label="Naar ${STATUSSEN[idx-1]||''}">◀</button>
      <button class="knop stil klein" data-schuif="1" ${idx===STATUSSEN.length-1?"disabled":""} aria-label="Naar ${STATUSSEN[idx+1]||''}">▶</button>
    </div>
  </div>`;
}
(function bordEenmalig(){
  const bord = $("#bord");
  bord.addEventListener("click", e=>{
    const schuif = e.target.closest("[data-schuif]");
    const kaart = e.target.closest(".kaart");
    if(schuif && kaart){
      const t = vind(kaart.dataset.id);
      const ni = STATUSSEN.indexOf(t.status) + Number(schuif.dataset.schuif);
      if(ni >= 0 && ni < STATUSSEN.length) zetStatus(t, STATUSSEN[ni]);
      e.stopPropagation();
      return;
    }
    if(kaart) openDetail(kaart.dataset.id);
  });
  bord.addEventListener("keydown", e=>{
    const kaart = e.target.closest(".kaart");
    if(kaart && (e.key === "Enter" || e.key === " ")){ e.preventDefault(); openDetail(kaart.dataset.id); }
  });
  bord.addEventListener("dragstart", e=>{
    const kaart = e.target.closest(".kaart");
    if(!kaart) return;
    e.dataTransfer.setData("text/plain", kaart.dataset.id);
    e.dataTransfer.effectAllowed = "move";
    kaart.classList.add("slepend");
  });
  bord.addEventListener("dragend", e=>{
    const kaart = e.target.closest(".kaart");
    if(kaart) kaart.classList.remove("slepend");
    $$(".kolom").forEach(k=>k.classList.remove("sleep-over"));
  });
})();
function koppelKolommen(){
  $$(".kolom").forEach(kolom=>{
    kolom.addEventListener("dragover", e=>{ e.preventDefault(); kolom.classList.add("sleep-over"); });
    kolom.addEventListener("dragleave", ()=> kolom.classList.remove("sleep-over"));
    kolom.addEventListener("drop", e=>{
      e.preventDefault();
      kolom.classList.remove("sleep-over");
      const t = vind(e.dataTransfer.getData("text/plain"));
      if(t) zetStatus(t, kolom.dataset.status);
    });
  });
}
function zetStatus(t, status){
  if(t.status === status) return;
  wijzig(s=>{
    t.status = status;
    t.bijgewerkt = nu();
    t.opgelost = status === "Opgelost" ? nu() : null;
  });
  meld(t.id + " → " + status);
}

/* ================= Tabel ================= */
function tekenTabel(){
  const zoek = $("#fZoek").value.trim().toLowerCase();
  const fs = $("#fStatus").value, fp = $("#fPrio").value, fc = $("#fCat").value;
  const rijen = staat.tickets.filter(t=>{
    if(fs && t.status !== fs) return false;
    if(fp && t.prioriteit !== fp) return false;
    if(fc && t.categorie !== fc) return false;
    if(zoek && !(t.titel + " " + t.id + " " + t.melder + " " + (t.behandelaar||"")).toLowerCase().includes(zoek)) return false;
    return true;
  }).sort((a,b)=> b.aangemaakt.localeCompare(a.aangemaakt));
  $("#telling").textContent = rijen.length + " van " + staat.tickets.length;
  const tb = $("#tabel tbody");
  if(rijen.length === 0){
    tb.innerHTML = `<tr><td colspan="8" style="text-align:center;color:var(--deg-inkt-sub);padding:28px">Geen tickets binnen deze filters. Pas de filters aan of wis ze.</td></tr>`;
    return;
  }
  tb.innerHTML = rijen.map(t=>{
    const rijStatus = t.status === "Opgelost" ? "goed" : t.prioriteit === "kritiek" ? "kritiek" : t.prioriteit === "hoog" ? "aandacht" : "";
    return `<tr data-id="${t.id}" ${rijStatus?`data-status="${rijStatus}"`:""} tabindex="0">
      <td class="code">${t.id}</td>
      <td><strong>${ontsmet(t.titel)}</strong></td>
      <td>${ontsmet(t.categorie)}</td>
      <td><span class="pil ${PRIO_PIL[t.prioriteit]}">${PRIO_LABEL[t.prioriteit]}</span></td>
      <td><span class="pil ${t.status==="Opgelost"?"goed":t.status==="Nieuw"?"info":"neutraal"}">${ontsmet(t.status)}</span></td>
      <td>${ontsmet(t.melder)}</td>
      <td>${ontsmet(t.behandelaar || "—")}</td>
      <td class="r num">${leeftijd(t)}</td>
    </tr>`;
  }).join("");
}
$("#tabel").addEventListener("click", e=>{
  const rij = e.target.closest("tr[data-id]");
  if(rij) openDetail(rij.dataset.id);
});
$("#tabel").addEventListener("keydown", e=>{
  const rij = e.target.closest("tr[data-id]");
  if(rij && e.key === "Enter") openDetail(rij.dataset.id);
});
["fZoek","fStatus","fPrio","fCat"].forEach(id=> $("#"+id).addEventListener("input", tekenTabel));
$("#fWis").addEventListener("click", ()=>{
  ["fZoek","fStatus","fPrio","fCat"].forEach(id=> $("#"+id).value = "");
  tekenTabel();
});

/* ================= Nieuw ticket ================= */
function initFormulier(){
  vulSelect($("#inCategorie"), CATEGORIEEN);
  vulSelect($("#inType"), TYPES);
  vulSelect($("#inPrio"), PRIORITEITEN);
  $("#inPrio").value = "normaal";
  vulSelect($("#fStatus"), STATUSSEN, "Alle");
  vulSelect($("#fPrio"), PRIORITEITEN, "Alle");
  vulSelect($("#fCat"), CATEGORIEEN, "Alle");
  vulSelect($("#dStatus"), STATUSSEN);
  $("#inBehandelaar").innerHTML = behandelaarOpties();
  $("#dBehandelaar").innerHTML = behandelaarOpties();
}
$("#btnAanmaken").addEventListener("click", ()=>{
  const titel = $("#inTitel").value.trim();
  $("#vTitel").classList.toggle("ongeldig", !titel);
  if(!titel) return;
  let aangemaaktId;
  wijzig(s=>{
    const t = {
      id:nieuwId(), titel, omschrijving:$("#inOmschrijving").value.trim(),
      categorie:$("#inCategorie").value, type:$("#inType").value,
      prioriteit:$("#inPrio").value, melder:config.naam || "Onbekend",
      behandelaar:$("#inBehandelaar").value, status:"Nieuw",
      aangemaakt:nu(), bijgewerkt:nu(), opgelost:null, reacties:[]
    };
    s.tickets.push(t);
    aangemaaktId = t.id;
  });
  $("#inTitel").value = ""; $("#inOmschrijving").value = "";
  $("#inPrio").value = "normaal"; $("#inBehandelaar").value = "";
  meld("Ticket " + aangemaaktId + " aangemaakt en gedeeld met het team");
  toonTab("bord");
});
$("#btnEersteTicket").addEventListener("click", ()=> toonTab("nieuw"));

/* ================= Detail ================= */
let openTicketId = null;
function openDetail(id){
  const t = vind(id); if(!t) return;
  openTicketId = id;
  $("#dId").textContent = t.id;
  $("#dTitel").textContent = t.titel;
  $("#dPillen").innerHTML =
    `<span class="pil ${PRIO_PIL[t.prioriteit]}">${PRIO_LABEL[t.prioriteit]}</span>` +
    `<span class="pil ${t.status==="Opgelost"?"goed":t.status==="Nieuw"?"info":"neutraal"}">${ontsmet(t.status)}</span>` +
    `<span class="pil neutraal">${ontsmet(t.type)}</span>`;
  $("#dVelden").innerHTML = [
    ["Categorie", t.categorie],["Melder", t.melder],
    ["Aangemaakt", datumKort(t.aangemaakt) + " · " + leeftijd(t) + " geleden"],
    ["Bijgewerkt", datumKort(t.bijgewerkt)],
    ["Behandelaar", t.behandelaar || "—"],
    ["Opgelost", t.opgelost ? datumKort(t.opgelost) : "—"]
  ].map(([k,v])=>`<div class="item"><span class="eyebrow">${k}</span>${ontsmet(v)}</div>`).join("");
  $("#dOmschrijving").textContent = t.omschrijving || "Geen omschrijving.";
  $("#dReacties").innerHTML = (t.reacties || []).length
    ? t.reacties.map(r=>`<div class="reactie"><span class="wie">${ontsmet(r.wie)}</span><span class="wanneer">${datumKort(r.wanneer)}</span><div>${ontsmet(r.tekst)}</div></div>`).join("")
    : `<p class="sub">Nog geen reacties.</p>`;
  $("#dNieuweReactie").value = "";
  $("#dStatus").value = t.status;
  $("#dBehandelaar").innerHTML = behandelaarOpties();
  $("#dBehandelaar").value = t.behandelaar || "";
  $("#detail").showModal();
}
$("#dSluit").addEventListener("click", ()=> $("#detail").close());
$("#dStatus").addEventListener("change", ()=>{
  const t = vind(openTicketId); if(!t) return;
  zetStatus(t, $("#dStatus").value); openDetail(openTicketId);
});
$("#dBehandelaar").addEventListener("change", ()=>{
  const t = vind(openTicketId); if(!t) return;
  wijzig(s=>{ t.behandelaar = $("#dBehandelaar").value; t.bijgewerkt = nu(); });
  openDetail(openTicketId);
});
$("#dReactieOpslaan").addEventListener("click", ()=>{
  const t = vind(openTicketId); if(!t) return;
  const tekst = $("#dNieuweReactie").value.trim();
  if(!tekst) return;
  wijzig(s=>{
    t.reacties = t.reacties || [];
    t.reacties.push({wie: config.naam || "Supportdesk", wanneer: nu(), tekst});
    t.bijgewerkt = nu();
  });
  openDetail(openTicketId);
  meld("Reactie opgeslagen bij " + t.id);
});
$("#dVerwijder").addEventListener("click", ()=>{
  const t = vind(openTicketId); if(!t) return;
  if($("#dVerwijder").dataset.bevestig !== "1"){
    $("#dVerwijder").dataset.bevestig = "1";
    $("#dVerwijder").textContent = "Zeker weten? Nogmaals klikken";
    return;
  }
  wijzig(s=>{
    s.tickets = s.tickets.filter(x=>x.id !== t.id);
    s.verwijderd.push({id:t.id, wanneer:nu()});
  });
  $("#detail").close();
  meld(t.id + " verwijderd");
});
$("#detail").addEventListener("close", ()=>{
  $("#dVerwijder").dataset.bevestig = "";
  $("#dVerwijder").textContent = "Verwijderen";
});

/* ================= Dashboard ================= */
function tekenDashboard(){
  const open = staat.tickets.filter(t=>t.status !== "Opgelost");
  const kritiek = open.filter(t=>t.prioriteit === "kritiek").length;
  const week = new Date(Date.now() - 7*DAG).toISOString();
  const opgelostWeek = staat.tickets.filter(t=>t.opgelost && t.opgelost >= week).length;
  const doorloop = staat.tickets.filter(t=>t.opgelost);
  const gemDoorloop = doorloop.length
    ? (doorloop.reduce((s,t)=> s + dagen(t.aangemaakt, t.opgelost), 0) / doorloop.length)
    : null;
  $("#kpis").innerHTML = [
    {kop:"Open tickets", w:open.length, d:"nu in de desk", kl:open.length > 8 ? "aandacht" : ""},
    {kop:"Waarvan kritiek", w:kritiek, d:kritiek ? "vraagt nu actie" : "geen blokkades", kl:kritiek ? "kritiek" : "goed"},
    {kop:"Opgelost afgelopen week", w:opgelostWeek, d:"laatste 7 dagen", kl:""},
    {kop:"Gem. doorlooptijd", w:gemDoorloop === null ? "—" : gemDoorloop.toFixed(1), d:gemDoorloop === null ? "nog niets opgelost" : "dagen tot oplossing", kl:gemDoorloop !== null && gemDoorloop > 7 ? "aandacht" : ""}
  ].map(k=>`<div class="paneel kpi ${k.kl}"><div class="inhoud">
      <span class="eyebrow">${k.kop}</span>
      <div class="waarde num">${k.w}</div>
      <div class="duiding">${k.d}</div></div></div>`).join("");

  tekenStaafjes($("#grafCategorie"),
    CATEGORIEEN.map(c=>({label:c, waarde:open.filter(t=>t.categorie===c).length})).filter(r=>r.waarde>0));
  tekenStaafjes($("#grafPrio"),
    PRIORITEITEN.map(p=>({label:PRIO_LABEL[p], waarde:open.filter(t=>t.prioriteit===p).length, kritiek:p==="kritiek"})));
  tekenWeken($("#grafWeken"));
  tekenBevindingen(open, gemDoorloop);
}
function tekenStaafjes(el, data){
  if(!data.length || data.every(d=>!d.waarde)){
    el.innerHTML = `<p class="sub">Geen open tickets — niets te tonen.</p>`; return;
  }
  const max = Math.max(...data.map(d=>d.waarde), 1);
  const rijH = 34, labelB = 170, W = 560, H = data.length * rijH + 8;
  const balkB = W - labelB - 46;
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Staafdiagram">` +
    data.map((d,i)=>{
      const y = i * rijH + 6, b = Math.max(3, d.waarde / max * balkB);
      const kleur = d.kritiek ? "var(--sig-kritiek)" : "var(--accent)";
      return `<text x="${labelB-10}" y="${y+15}" text-anchor="end" font-size="13">${ontsmet(d.label)}</text>
        <rect x="${labelB}" y="${y}" width="${b}" height="21" rx="4" fill="${kleur}" stroke="var(--deg-inkt)" stroke-width="1.5"/>
        <text x="${labelB + b + 9}" y="${y+15}" font-size="13" font-weight="700" class="num">${d.waarde}</text>`;
    }).join("") + `</svg>`;
}
function tekenWeken(el){
  const weken = [];
  for(let i=7;i>=0;i--){
    const start = new Date(Date.now() - (i+1)*7*DAG), eind = new Date(Date.now() - i*7*DAG);
    const si = start.toISOString(), ei = eind.toISOString();
    weken.push({
      label: String(eind.getDate()).padStart(2,"0") + "-" + String(eind.getMonth()+1).padStart(2,"0"),
      nieuw: staat.tickets.filter(t=>t.aangemaakt > si && t.aangemaakt <= ei).length,
      opgelost: staat.tickets.filter(t=>t.opgelost && t.opgelost > si && t.opgelost <= ei).length
    });
  }
  const max = Math.max(...weken.flatMap(w=>[w.nieuw,w.opgelost]), 1);
  const W = 900, H = 220, pad = {l:36, r:12, t:14, b:34};
  const bw = (W - pad.l - pad.r) / weken.length, kb = Math.min(26, bw/2.6);
  const yv = v => pad.t + (H - pad.t - pad.b) * (1 - v/max);
  let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Aangemaakt en opgelost per week">`;
  for(let g=0; g<=max; g++){
    if(max > 6 && g % 2) continue;
    s += `<line x1="${pad.l}" x2="${W-pad.r}" y1="${yv(g)}" y2="${yv(g)}" stroke="var(--deg-lijn)" stroke-width="1"/>
          <text x="${pad.l-8}" y="${yv(g)+4}" text-anchor="end" font-size="11" fill="var(--deg-inkt-sub)" class="num">${g}</text>`;
  }
  weken.forEach((w,i)=>{
    const cx = pad.l + i*bw + bw/2;
    s += `<rect x="${cx-kb-2}" y="${yv(w.nieuw)}" width="${kb}" height="${H-pad.b-yv(w.nieuw)}" rx="3" fill="var(--accent)" stroke="var(--deg-inkt)" stroke-width="1.5"/>
          <rect x="${cx+2}" y="${yv(w.opgelost)}" width="${kb}" height="${H-pad.b-yv(w.opgelost)}" rx="3" fill="var(--deg-basis)" stroke="var(--deg-inkt)" stroke-width="1.5"/>
          <text x="${cx}" y="${H-12}" text-anchor="middle" font-size="11" fill="var(--deg-inkt-sub)" class="num">${w.label}</text>`;
  });
  s += `<rect x="${pad.l}" y="2" width="14" height="10" rx="2" fill="var(--accent)" stroke="var(--deg-inkt)" stroke-width="1.5"/>
        <text x="${pad.l+20}" y="11" font-size="11.5">aangemaakt</text>
        <rect x="${pad.l+110}" y="2" width="14" height="10" rx="2" fill="var(--deg-basis)" stroke="var(--deg-inkt)" stroke-width="1.5"/>
        <text x="${pad.l+130}" y="11" font-size="11.5">opgelost</text></svg>`;
  el.innerHTML = s;
}
function tekenBevindingen(open, gemDoorloop){
  const b = [];
  const kritiek = open.filter(t=>t.prioriteit === "kritiek");
  if(kritiek.length)
    b.push({s:"kritiek", t:`<strong>${kritiek.length} kritiek ticket${kritiek.length>1?"s":""} open</strong> (${kritiek.map(t=>t.id).join(", ")}). Een tool of proces ligt stil. Wijs direct een behandelaar toe en werk deze als eerste weg.`});
  const oud = open.filter(t=> dagen(t.aangemaakt, nu()) > 14);
  if(oud.length)
    b.push({s:"aandacht", t:`<strong>${oud.length} ticket${oud.length>1?"s":""} ouder dan 14 dagen.</strong> Lange wachttijd ondermijnt het vertrouwen in de desk. Loop ze na: oplossen, terugkoppelen of bewust parkeren met een reden.`});
  const zonder = open.filter(t=>!t.behandelaar);
  if(zonder.length)
    b.push({s:"info", t:`<strong>${zonder.length} open ticket${zonder.length>1?"s":""} zonder behandelaar.</strong> Zonder eigenaar beweegt er niets. Verdeel ze in de eerstvolgende dagstart.`});
  if(!b.length)
    b.push({s:"goed", t:`<strong>De desk staat er goed voor.</strong> Geen kritieke tickets, geen oude openstaande meldingen en alles heeft een eigenaar. Houd dit ritme vast.`});
  $("#dashBevindingen").innerHTML = b.map(x=>
    `<div class="bevinding" data-status="${x.s}"><div class="merk"></div><div>${x.t}</div></div>`).join("");
}

/* ================= Beheer ================= */
function tekenBeheer(){
  $("#beheerPad").textContent = config.pad || "data/tickets.json";
  const rijen = [...staat.gebruikers].sort((a,b)=>a.localeCompare(b,"nl")).map(g=>{
    const open = staat.tickets.filter(t=>t.behandelaar === g && t.status !== "Opgelost").length;
    const klaar = staat.tickets.filter(t=>t.behandelaar === g && t.status === "Opgelost").length;
    return `<tr><td>${ontsmet(g)}${g === config.naam ? ' <span class="pil info">jij</span>' : ""}</td>
      <td class="r num">${open}</td><td class="r num">${klaar}</td></tr>`;
  }).join("");
  $("#beheerGebruikers").innerHTML = staat.gebruikers.length
    ? `<div class="tabelwrap"><table class="deg"><thead><tr><th>Naam</th><th class="r">Open</th><th class="r">Opgelost</th></tr></thead><tbody>${rijen}</tbody></table></div>`
    : `<p class="sub">Nog geen deelnemers aangemeld.</p>`;
  $("#beheerVerbinding").innerHTML = [
    ["Aangemeld als", config.naam || "—"],
    ["Repository", (config.owner||"—") + "/" + (config.repo||"—")],
    ["Branch", config.branch || "—"],
    ["Databestand", config.pad || "—"],
    ["Laatste synchronisatie", laatsteSync ? datumKort(laatsteSync.toISOString()) + " " + tijdKort(laatsteSync) : "nog niet"],
    ["Tickets in de desk", String(staat.tickets.length)]
  ].map(([k,v])=>`<div class="item"><span class="eyebrow">${k}</span>${ontsmet(v)}</div>`).join("");
}

/* ================= Export / import / print ================= */
$("#btnExport").addEventListener("click", ()=>{
  const blob = new Blob([JSON.stringify(staat, null, 2)], {type:"application/json"});
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "deg-supportdesk-" + datumKort(nu()).replaceAll("-","") + ".json";
  a.click(); URL.revokeObjectURL(a.href);
  meld("Databestand gedownload — " + staat.tickets.length + " tickets");
});
$("#btnImport").addEventListener("click", ()=> $("#importBestand").click());
$("#importBestand").addEventListener("change", e=>{
  const f = e.target.files[0]; if(!f) return;
  const lezer = new FileReader();
  lezer.onload = ()=>{
    try{
      const data = normaliseer(JSON.parse(lezer.result));
      if(!Array.isArray(data.tickets)) throw new Error();
      wijzig(s=>{
        s.volgnr = data.volgnr; s.tickets = data.tickets;
        s.gebruikers = [...new Set([...data.gebruikers, config.naam].filter(Boolean))];
        s.verwijderd = data.verwijderd;
      });
      meld("Databestand teruggezet — " + staat.tickets.length + " tickets, wordt nu gedeeld met het team");
    }catch(err){
      meld("Dit bestand mist het tickets-blok. Kies een download uit deze tool.");
    }
    e.target.value = "";
  };
  lezer.readAsText(f);
});
$("#btnPrint").addEventListener("click", ()=> window.print());

/* ================= Aanmelden ================= */
function toonAanmelden(){
  const raad = raadRepo();
  $("#aNaam").value = config.naam || "";
  $("#aToken").value = config.token || "";
  $("#aOwner").value = config.owner || raad.owner;
  $("#aRepo").value = config.repo || raad.repo;
  $("#aBranch").value = config.branch || "main";
  $("#aPad").value = config.pad || "data/tickets.json";
  $("#aanmelden").showModal();
}
$("#aStart").addEventListener("click", async ()=>{
  const naam = $("#aNaam").value.trim();
  const token = $("#aToken").value.trim();
  $("#vNaam").classList.toggle("ongeldig", !naam);
  $("#vToken").classList.toggle("ongeldig", !token);
  if(!naam || !token) return;
  config = {
    naam, token,
    owner: $("#aOwner").value.trim(),
    repo: $("#aRepo").value.trim(),
    branch: $("#aBranch").value.trim() || "main",
    pad: $("#aPad").value.trim() || "data/tickets.json"
  };
  $("#aStart").disabled = true;
  $("#aStart").textContent = "Verbinden…";
  try{
    const r = await ghLaad();
    if(r.status === 200){
      bestandSha = r.sha;
      staat = r.data;
    }else if(r.status === 404){
      // Databestand bestaat nog niet: als eerste gebruiker meteen aanmaken.
      const w = await ghSchrijf(leegData(), null);
      if(w.status !== 200) throw {code:w.status};
      bestandSha = w.sha;
      staat = leegData();
    }else{
      throw {code:r.status};
    }
    bewaarConfig(config);
    if(!staat.gebruikers.includes(naam)) wijzig(s=>{ s.gebruikers.push(naam); });
    else { cacheBewaar(); renderAlles(); }
    laatsteSync = new Date();
    zetSync("goed","gesynchroniseerd " + tijdKort(laatsteSync));
    $("#aanmelden").close();
    meld("Welkom " + naam + " — de desk is bijgewerkt");
  }catch(err){
    $("#vToken").classList.add("ongeldig");
    $("#aTokenFout").textContent = err && err.code
      ? "Geen toegang (code " + err.code + "). Controleer de sleutel en de repository-instellingen bij de beheerder."
      : "Verbinden lukt niet. Controleer je internetverbinding en probeer opnieuw.";
  }finally{
    $("#aStart").disabled = false;
    $("#aStart").textContent = "Aanmelden en openen";
  }
});

/* ================= Beheer-acties ================= */
$("#btnInstellingen").addEventListener("click", toonAanmelden);
$("#btnAfmelden").addEventListener("click", ()=>{
  if($("#btnAfmelden").dataset.bevestig !== "1"){
    $("#btnAfmelden").dataset.bevestig = "1";
    $("#btnAfmelden").textContent = "Zeker weten? Nogmaals klikken";
    return;
  }
  try{ localStorage.removeItem(CONFIG_SLEUTEL); localStorage.removeItem(CACHE_SLEUTEL); }catch(e){}
  config = {}; staat = leegData(); bestandSha = null;
  $("#btnAfmelden").dataset.bevestig = "";
  $("#btnAfmelden").textContent = "Afmelden op dit apparaat";
  toonTab("bord");
  toonAanmelden();
});
$("#btnVerversen").addEventListener("click", ()=> laadVanGitHub(false));
$("#btnMenu").addEventListener("click", ()=> toonTab("beheer"));

/* ================= Start ================= */
initFormulier();
cacheLaad();
toonTab("bord");
if(config.token && config.naam && config.owner && config.repo){
  laadVanGitHub(false);
}else{
  toonAanmelden();
}
