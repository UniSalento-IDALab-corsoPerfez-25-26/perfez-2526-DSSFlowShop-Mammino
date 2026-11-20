// Logica della pagina di configurazione (config.html): lettura, modifica e salvataggio di config.json, download dei prezzi

toastr.options = {
    "closeButton": true,
    "newestOnTop": true,
    "progressBar": true,
    "positionClass": "toast-bottom-right",
    "timeOut": "4000"
};

// Valori usati dal server quando la chiave manca in config.json
const DEFAULT_POP = 35;
const DEFAULT_GEN = 30;

let currentConfig = null;
// Fonte dei prezzi mostrati nel modulo (null = inseriti a mano)
let fontePrezzi = null;

// Data AAAA-MM-GG -> GG/MM/AAAA
function dataIt(iso) {
    const [a, m, g] = String(iso).split('-');
    return `${g}/${m}/${a}`;
}

// Descrizione della fonte dei prezzi, compresa l'eventuale stima
function testoFonte(f) {
    const zona = f.zona_nome || f.zona;
    if (f.stima && f.data_prezzi) {
        return `${f.fonte}, zona ${zona}: stima per il ${dataIt(f.data)} con i prezzi del ${dataIt(f.data_prezzi)}`;
    }
    return `${f.fonte}, zona ${zona}, ${dataIt(f.data)}`;
}

function mostraFontePrezzi() {
    const box = document.getElementById('fontePrezzi');
    box.textContent = (fontePrezzi && fontePrezzi.fonte)
        ? `Prezzi attuali: ${testoFonte(fontePrezzi)}.`
        : 'Prezzi attuali: inseriti a mano.';
}

// Data predefinita: domani (il DSS pianifica il giorno successivo)
function domaniISO() {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Testo gg/mm/aaaa -> AAAA-MM-GG (null se la data non esiste)
function dataIso(testo) {
    const m = String(testo).trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (!m) return null;
    const [g, me, a] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const d = new Date(a, me - 1, g);
    if (d.getFullYear() !== a || d.getMonth() !== me - 1 || d.getDate() !== g) return null;
    const pad = (n) => String(n).padStart(2, '0');
    return `${a}-${pad(me)}-${pad(g)}`;
}

// Imposta la data (AAAA-MM-GG) nel campo di testo, in formato italiano
function impostaData(iso) {
    document.getElementById('dataPrezzi').value = dataIt(iso);
}

async function scaricaPrezzi() {
    const data = dataIso(document.getElementById('dataPrezzi').value);
    const zona = document.getElementById('zonaPrezzi').value;
    if (!data) throw new Error('Data non valida: usare il formato gg/mm/aaaa.');
    const btn = document.getElementById('scaricaPrezziBtn');
    btn.disabled = true;
    btn.textContent = 'Download in corso...';
    try {
        const res = await fetch(`/api/prezzi-energia?data=${encodeURIComponent(data)}&zona=${encodeURIComponent(zona)}`);
        const body = await res.json();
        if (!res.ok) throw new Error(body.detail || 'Download non riuscito.');
        document.getElementById('ipex').value = JSON.stringify(body.prezzi_ipex_24h, null, 2);
        fontePrezzi = {fonte: body.fonte, zona: body.zona, zona_nome: body.zona_nome,
                       data: body.data, data_prezzi: body.data_prezzi, stima: body.stima};
        mostraFontePrezzi();
        const f = (v) => v.toLocaleString('it-IT', {minimumFractionDigits: 3, maximumFractionDigits: 3});
        const dettaglio = `24 prezzi orari (medie di ${body.valori_ricevuti} valori ogni 15 minuti), ` +
            `da ${f(body.min_kwh)} a ${f(body.max_kwh)} €/kWh. Premere "Salva" per usarli.`;
        if (body.stima) {
            // Il giorno scelto non è ancora pubblicato: si usa l'ultimo disponibile
            toastr.warning(`I prezzi del ${dataIt(body.data)} non sono ancora pubblicati: ` +
                `come stima si usano quelli del ${dataIt(body.data_prezzi)}. ${dettaglio}`,
                'Prezzi stimati', {timeOut: 12000});
        } else {
            toastr.success(dettaglio, 'Prezzi scaricati', {timeOut: 8000});
        }
    } finally {
        btn.disabled = false;
        btn.textContent = 'Scarica prezzi del giorno';
    }
}

function aggiornaControlli() {
    // Totale schedulazioni provate
    const pop = parseInt(document.getElementById('nsga2_pop_size').value, 10) || 0;
    const gen = parseInt(document.getElementById('nsga2_n_gen').value, 10) || 0;
    document.getElementById('totaleProve').textContent =
        `Schedulazioni provate da NSGA-II: ${pop * gen}`;

    // Ordini dentro l'intervallo dello storico?
    const qmin = parseFloat(document.getElementById('qmin').value);
    const qmax = parseFloat(document.getElementById('qmax').value);
    const oqmin = parseFloat(document.getElementById('ord_qmin').value);
    const oqmax = parseFloat(document.getElementById('ord_qmax').value);
    const fuori = oqmin < qmin || oqmax > qmax;
    document.getElementById('avvisoIntervallo').style.display = fuori ? 'block' : 'none';
}

function fillForm(cfg) {
    currentConfig = cfg;
    const ml = cfg.ml_config || {};
    document.getElementById('NP_SEED').value = ml.NP_SEED ?? '';
    document.getElementById('alfa_input').value = ml.alfa_input;
    document.getElementById('sorgente_dati').value = cfg.sorgente_dati ?? 'simulato';
    document.getElementById('potenza_ferma_pct').value = Math.round((cfg.potenza_ferma_frazione ?? 0.30) * 100);
    document.getElementById('nsga2_pop_size').value = ml.nsga2_pop_size ?? DEFAULT_POP;
    document.getElementById('nsga2_n_gen').value = ml.nsga2_n_gen ?? DEFAULT_GEN;
    document.getElementById('analisi_convergenza').checked = ml.analisi_convergenza ?? true;
    document.getElementById('n_samples').value = cfg.dataset_storico.n_samples;
    document.getElementById('qmin').value = cfg.dataset_storico.quantita_m2.min;
    document.getElementById('qmax').value = cfg.dataset_storico.quantita_m2.max;
    document.getElementById('vmin').value = cfg.dataset_storico.velocita_m2h.min;
    document.getElementById('vmax').value = cfg.dataset_storico.velocita_m2h.max;
    document.getElementById('smin').value = cfg.dataset_storico.tempo_setup_min.min;
    document.getElementById('smax').value = cfg.dataset_storico.tempo_setup_min.max;
    document.getElementById('ord_n').value = cfg.ordini_giornalieri.n_ordini;
    document.getElementById('ord_qmin').value = cfg.ordini_giornalieri.quantita_m2.min;
    document.getElementById('ord_qmax').value = cfg.ordini_giornalieri.quantita_m2.max;
    document.getElementById('ipex').value = JSON.stringify(cfg.prezzi_ipex_24h, null, 2);
    fontePrezzi = cfg.fonte_prezzi || null;
    mostraFontePrezzi();
    // Zona dell'ultimo download, se è ancora tra quelle disponibili
    const selZona = document.getElementById('zonaPrezzi');
    if (fontePrezzi && [...selZona.options].some(o => o.value === fontePrezzi.zona)) {
        selZona.value = fontePrezzi.zona;
    }
    if (!document.getElementById('dataPrezzi').value) {
        impostaData((fontePrezzi && fontePrezzi.data) || domaniISO());
    }
    aggiornaControlli();
}

async function loadConfig() {
    const res = await fetch('/api/config');
    fillForm(await res.json());
}

async function saveConfig() {
    // Copia completa: le chiavi non presenti nel modulo restano invariate
    const cfg = structuredClone(currentConfig);
    const seedRaw = document.getElementById('NP_SEED').value.trim();
    cfg.ml_config.NP_SEED = seedRaw === '' ? null : parseInt(seedRaw, 10);
    cfg.ml_config.alfa_input = parseFloat(document.getElementById('alfa_input').value);
    cfg.sorgente_dati = document.getElementById('sorgente_dati').value;
    const pctFerma = parseFloat(document.getElementById('potenza_ferma_pct').value);
    if (!(pctFerma >= 0 && pctFerma <= 100)) throw new Error('Potenza a macchina ferma: valore tra 0 e 100.');
    cfg.potenza_ferma_frazione = pctFerma / 100;
    cfg.ml_config.nsga2_pop_size = parseInt(document.getElementById('nsga2_pop_size').value, 10);
    cfg.ml_config.nsga2_n_gen = parseInt(document.getElementById('nsga2_n_gen').value, 10);
    cfg.ml_config.analisi_convergenza = document.getElementById('analisi_convergenza').checked;
    cfg.dataset_storico.n_samples = parseInt(document.getElementById('n_samples').value, 10);
    cfg.dataset_storico.quantita_m2.min = parseFloat(document.getElementById('qmin').value);
    cfg.dataset_storico.quantita_m2.max = parseFloat(document.getElementById('qmax').value);
    cfg.dataset_storico.velocita_m2h.min = parseFloat(document.getElementById('vmin').value);
    cfg.dataset_storico.velocita_m2h.max = parseFloat(document.getElementById('vmax').value);
    cfg.dataset_storico.tempo_setup_min.min = parseFloat(document.getElementById('smin').value);
    cfg.dataset_storico.tempo_setup_min.max = parseFloat(document.getElementById('smax').value);
    cfg.ordini_giornalieri.n_ordini = parseInt(document.getElementById('ord_n').value, 10);
    cfg.ordini_giornalieri.quantita_m2.min = parseFloat(document.getElementById('ord_qmin').value);
    cfg.ordini_giornalieri.quantita_m2.max = parseFloat(document.getElementById('ord_qmax').value);
    cfg.prezzi_ipex_24h = JSON.parse(document.getElementById('ipex').value);
    if (!Array.isArray(cfg.prezzi_ipex_24h) || cfg.prezzi_ipex_24h.length !== 24
        || cfg.prezzi_ipex_24h.some(v => typeof v !== 'number' || isNaN(v))) {
        throw new Error('I prezzi devono essere una lista di 24 numeri.');
    }
    // Fonte dei prezzi: salvata in config.json e riportata nei risultati
    if (fontePrezzi) cfg.fonte_prezzi = fontePrezzi;
    else delete cfg.fonte_prezzi;

    // Controlli minimi sui valori dell'ottimizzatore
    if (!(cfg.ml_config.nsga2_pop_size >= 10)) throw new Error('Popolazione: almeno 10');
    if (!(cfg.ml_config.nsga2_n_gen >= 1)) throw new Error('Generazioni: almeno 1');

    const res = await fetch('/api/config', {
        method: 'PUT',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(cfg)
    });
    if (!res.ok) throw new Error('Salvataggio fallito');
    currentConfig = cfg;
    toastr.success('Configurazione salvata.');
}

['nsga2_pop_size', 'nsga2_n_gen', 'qmin', 'qmax', 'ord_qmin', 'ord_qmax'].forEach(id =>
    document.getElementById(id).addEventListener('input', aggiornaControlli));

// Se i prezzi vengono modificati a mano, non sono più quelli scaricati
document.getElementById('ipex').addEventListener('input', () => {
    fontePrezzi = null;
    mostraFontePrezzi();
});
document.getElementById('scaricaPrezziBtn').addEventListener('click', async () => {
    try { await scaricaPrezzi(); } catch (e) { toastr.error(e.message, 'Prezzi non scaricati', {timeOut: 10000}); }
});

document.getElementById('saveBtn').addEventListener('click', async () => {
    try { await saveConfig(); } catch (e) { toastr.error(e.message); }
});
document.getElementById('reloadBtn').addEventListener('click', async () => {
    try { await loadConfig(); } catch (e) { toastr.error(e.message); }
});

// Prima il menu delle zone, poi la configurazione (che può selezionare una zona)
// Pulsante del calendario: apre il selettore del browser sul campo nascosto
document.getElementById('calendarioBtn').addEventListener('click', () => {
    const cal = document.getElementById('dataPrezziCalendario');
    cal.value = dataIso(document.getElementById('dataPrezzi').value) || domaniISO();
    if (cal.showPicker) cal.showPicker(); else cal.focus();
});
document.getElementById('dataPrezziCalendario').addEventListener('change', (e) => {
    if (e.target.value) impostaData(e.target.value);
});

loadConfig().catch(e => toastr.error(e.message));
