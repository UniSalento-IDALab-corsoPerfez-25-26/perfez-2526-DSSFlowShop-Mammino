// Logica della dashboard (index.html): caricamento delle sessioni, ottimizzazione e grafici ECharts

toastr.options = {
    "closeButton": true,
    "newestOnTop": true,
    "progressBar": true,
    "positionClass": "toast-bottom-right",
    "timeOut": "4000"
};

let sessionData = null;
let currentSelectedSol = null;
let pendingDeleteFilename = null;

let paretoChart = echarts.init(document.getElementById('paretoChart'));
let ganttChart = echarts.init(document.getElementById('ganttChart'));
let energyChart = echarts.init(document.getElementById('energyChart'));
let affidabilitaChart = echarts.init(document.getElementById('affidabilitaChart'));
let convergenzaChart = echarts.init(document.getElementById('convergenzaChart'));

window.onload = () => {
    fetchSessionsList();
};

// Ridimensiona tutti i grafici (finestra ridimensionata o pannello aperto)
function resizeAllCharts() {
    paretoChart.resize();
    ganttChart.resize();
    energyChart.resize();
    affidabilitaChart.resize();
    convergenzaChart.resize();
}

window.onresize = resizeAllCharts;

// Numeri in formato italiano: punto per le migliaia, virgola per i decimali
function formatNum(val, decimals = 2) {
    if (val === undefined || val === null || isNaN(val)) return '-';
    return new Intl.NumberFormat('it-IT', {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
        useGrouping: true
    }).format(Number(val));
}

// Riempie l'elenco delle simulazioni salvate
async function fetchSessionsList() {
    try {
        const res = await fetch('/api/sessions');
        const sessions = await res.json();
        const select = document.getElementById('sessionSelect');
        select.innerHTML = '<option value="">-- Carica una simulazione salvata --</option>';
        sessions.forEach(s => {
            const opt = document.createElement('option');
            opt.value = s.filename;
            opt.innerText = `${s.data_creazione} (${s.filename})`;
            select.appendChild(opt);
        });
    } catch (e) {
        console.error("[ERROR] Recupero sessioni fallito:", e);
        toastr.error("Impossibile recuperare la lista delle simulazioni.", "Errore");
    }
}

// Carica la simulazione scelta nell'elenco e la mostra
async function loadSelectedSession() {
    const filename = document.getElementById('sessionSelect').value;
    if (!filename) return toastr.warning("Seleziona una simulazione dalla lista.", "Attenzione");

    showLoading(true);
    try {
        const res = await fetch(`/api/sessions/${filename}`);
        sessionData = await res.json();
        // Le sessioni meno recenti non contengono il proprio nome: lo ricavo dal file
        if (!sessionData.session_id) sessionData.session_id = filename.replace(/\.json$/, '');
        renderAllPanels();
        toastr.success(`Simulazione caricata.`, "Completato");
    } catch (e) {
        console.error("[ERROR] Errore caricamento:", e);
        toastr.error("Errore nel caricamento della sessione: " + e.message, "Errore");
    } finally {
        showLoading(false);
    }
}

// Chiede conferma prima di eliminare la simulazione scelta
function deleteSelectedSession() {
    const filename = document.getElementById('sessionSelect').value;
    if (!filename) return toastr.warning("Seleziona una simulazione da eliminare.", "Attenzione");

    pendingDeleteFilename = filename;
    const confirmHtml = `
            <div>
                Eliminare definitivamente <b>${filename}</b>?
                <br/>
                <button class="toast-confirm-btn" onclick="confirmDelete()">Sì, elimina</button>
                <button class="toast-cancel-btn" onclick="cancelDelete()">Annulla</button>
            </div>
        `;
    toastr.remove();
    toastr.warning(confirmHtml, "Conferma eliminazione", {timeOut: 0, extendedTimeOut: 0, closeButton: false, tapToDismiss: false});
}

function cancelDelete() {
    pendingDeleteFilename = null;
    toastr.remove();
}

// Elimina la simulazione dopo la conferma
async function confirmDelete() {
    const filename = pendingDeleteFilename;
    pendingDeleteFilename = null;
    toastr.remove();
    if (!filename) return;

    showLoading(true);
    try {
        const res = await fetch(`/api/sessions/${filename}`, {method: 'DELETE'});
        if (!res.ok) throw new Error("Errore durante la cancellazione.");

        toastr.success("Sessione eliminata.", "Eliminata");
        sessionData = null;
        document.getElementById('paretoPanel').style.display = 'none';
        document.getElementById('affidabilitaCard').style.display = 'none';
        document.getElementById('convergenzaCard').style.display = 'none';
        document.getElementById('metricsCard').style.display = 'none';
        document.getElementById('detailsCard').style.display = 'none';
        document.getElementById('dataCard').style.display = 'none';
        document.getElementById('configCard').style.display = 'none';
        await fetchSessionsList();
    } catch (e) {
        console.error("[ERROR] Errore eliminazione:", e);
        toastr.error("Impossibile eliminare la sessione: " + e.message, "Errore");
    } finally {
        showLoading(false);
    }
}

// Lancia una nuova ottimizzazione sul server e ne mostra il risultato
async function runOptimization() {
    showLoading(true);
    try {
        const response = await fetch('/api/run-optimization');
        const body = await response.json();
        if (!response.ok) {
            // Il server spiega il motivo (es. nessuna soluzione sopra la soglia alfa)
            toastr.error(body.detail || "Errore del server.", "Nessuna soluzione",
                {timeOut: 0, extendedTimeOut: 0});
            return;
        }
        sessionData = body;
        await fetchSessionsList();
        renderAllPanels();
        toastr.success("Nuova ottimizzazione calcolata!", "Ottimizzazione completata");
    } catch (err) {
        console.error("[ERROR] Ottimizzazione fallita:", err);
        toastr.error("Errore durante l'ottimizzazione: " + err.message, "Errore");
    } finally {
        showLoading(false);
    }
}

// Mostra o nasconde l'indicatore di caricamento
function showLoading(isLoading) {
    document.getElementById('spinnerOverlay').style.display = isLoading ? 'block' : 'none';
    if (isLoading) {
        document.getElementById('paretoPanel').style.display = 'none';
        document.getElementById('affidabilitaCard').style.display = 'none';
        document.getElementById('convergenzaCard').style.display = 'none';
        document.getElementById('metricsCard').style.display = 'none';
        document.getElementById('detailsCard').style.display = 'none';
        document.getElementById('dataCard').style.display = 'none';
        document.getElementById('configCard').style.display = 'none';
    }
}

// Apre o chiude un pannello
function togglePanel(bodyId, toggleId) {
    const body = document.getElementById(bodyId);
    const toggle = document.getElementById(toggleId);
    if (body.style.display === "none") {
        body.style.display = "block";
        toggle.innerText = "▼";
        // I grafici nati in un pannello chiuso vanno ridimensionati quando lo si apre
        setTimeout(resizeAllCharts, 0);
    } else {
        body.style.display = "none";
        toggle.innerText = "▲";
    }
}

// Disegna tutte le schede a partire dai dati della sessione
function renderAllPanels() {
    if (!sessionData) return;
    const hasSolutions = sessionData.soluzioni_valide && sessionData.soluzioni_valide.length > 0;
    document.getElementById('noSolutionsMessage').style.display = hasSolutions ? 'none' : 'block';
    document.getElementById('paretoPanel').style.display = hasSolutions ? 'block' : 'none';

    // Avviso se la baseline sfora l'orizzonte di pianificazione
    const orizzonte = Number(sessionData.orizzonte_ore) || 24;
    const mkBase = Number(sessionData.makespan_base);
    const warn = document.getElementById('baselineWarning');
    if (!isNaN(mkBase) && mkBase > orizzonte) {
        warn.innerText = `Attenzione: la baseline termina dopo ${formatNum(mkBase, 2)} h, oltre l'orizzonte di ${orizzonte} h. ` +
            `Per le ore successive si assumono gli stessi prezzi dell'energia del giorno; le soluzioni ottimizzate sono vincolate a ${orizzonte} h.`;
        warn.style.display = 'block';
    } else {
        warn.style.display = 'none';
    }

    renderTempiCalcolo();
    renderFontePrezzi();
    renderConfigUsata();

    // Schede su affidabilità dei modelli e convergenza: dipendono solo dalla sessione
    renderAffidabilita();
    renderConvergenza();

    if (hasSolutions) {
        renderParetoChart();
        currentSelectedSol = sessionData.soluzioni_valide[0];
        renderDetails(currentSelectedSol);
        renderDataPanel(currentSelectedSol);
    } else {
        document.getElementById('metricsCard').style.display = 'none';
        document.getElementById('detailsCard').style.display = 'none';
        document.getElementById('dataCard').style.display = 'none';
        currentSelectedSol = null;
    }
}

// Configurazione usata per la sessione caricata. Le sessioni recenti ne
// contengono una copia completa (config_usata); per quelle meno recenti si
// mostrano solo i parametri salvati nella sessione
function renderConfigUsata() {
    const card = document.getElementById('configCard');
    if (!sessionData) { card.style.display = 'none'; return; }
    card.style.display = 'block';

    const c = sessionData.config_usata || null;
    const ml = (c && c.ml_config) || {};
    const st = (c && c.dataset_storico) || {};
    const ord = (c && c.ordini_giornalieri) || {};
    const t = sessionData.tempi_calcolo || {};
    const f = sessionData.fonte_prezzi || (c && c.fonte_prezzi) || null;
    const it = (iso) => { const [a, m, g] = String(iso).split('-'); return `${g}/${m}/${a}`; };
    const intervallo = (o, u) => (o && o.min !== undefined) ? `${formatNum(o.min, 0)} – ${formatNum(o.max, 0)} ${u}` : null;

    const righe = [
        ['Seed', sessionData.seed],
        ['Soglia α (throughput minimo / baseline)', formatNum(sessionData.alfa_input, 2)],
        ['NSGA-II: popolazione × generazioni', (t.nsga2_pop_size && t.nsga2_n_gen) ? `${t.nsga2_pop_size} × ${t.nsga2_n_gen}` : null],
        ['Controllo di convergenza', c ? (ml.analisi_convergenza === false ? 'no' : 'sì') : (sessionData.convergenza_nsga2 ? 'sì' : null)],
        ['Ordini del giorno', ord.n_ordini !== undefined ? `${ord.n_ordini} (quantità ${intervallo(ord.quantita_m2, 'm²')})` : null],
        ['Storico: lavorazioni', st.n_samples !== undefined ? formatNum(st.n_samples, 0) : null],
        ['Storico: quantità', intervallo(st.quantita_m2, 'm²')],
        ['Storico: velocità', intervallo(st.velocita_m2h, 'm²/h')],
        ['Storico: setup', intervallo(st.tempo_setup_min, 'min')],
        ['Potenza a macchina ferma', sessionData.potenza_ferma_frazione !== undefined ? `${formatNum(sessionData.potenza_ferma_frazione * 100, 0)}% della potenza media in lavorazione` : null],
        ['Prezzi dell\'energia', f && f.data ? `${f.fonte}, zona ${f.zona_nome || f.zona}, ${f.stima && f.data_prezzi ? `stima per il ${it(f.data)} con i prezzi del ${it(f.data_prezzi)}` : it(f.data)}` : 'inseriti a mano'],
        ['Origine dei dati', sessionData.sorgente_dati || 'simulato'],
    ].filter(r => r[1] !== null && r[1] !== undefined);

    document.querySelector('#configTable tbody').innerHTML =
        righe.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('');

    document.getElementById('configNota').innerText = c
        ? 'Parametri principali. "Scarica config JSON" salva la configurazione completa: copiata in config.json permette di rifare lo stesso calcolo.'
        : 'Sessione salvata con una versione precedente: la configurazione completa non è disponibile, sono mostrati solo i parametri salvati nella sessione.';
    document.getElementById('configScarica').style.display = c ? '' : 'none';
}

// Scarica la configurazione completa della sessione (config_<sessione>.json)
function scaricaConfigUsata() {
    if (!sessionData || !sessionData.config_usata) return;
    const testo = JSON.stringify(sessionData.config_usata, null, 2);
    const blob = new Blob([testo], {type: 'application/json;charset=utf-8;'});
    const link = document.createElement("a");
    link.setAttribute("href", URL.createObjectURL(blob));
    link.setAttribute("download", `${nomeFile('config')}.json`);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}

// Durata in formato leggibile: "4,2 s" oppure "2 min 05 s"
function formatDurata(secondi) {
    const s = Number(secondi);
    if (isNaN(s)) return '-';
    if (s < 60) return `${formatNum(s, 1)} s`;
    const min = Math.floor(s / 60);
    const rest = Math.round(s - min * 60);
    return `${min} min ${String(rest).padStart(2, '0')} s`;
}

// Da dove vengono i prezzi dell'energia usati in questa simulazione
function renderFontePrezzi() {
    const box = document.getElementById('fontePrezziDashboard');
    const f = sessionData ? sessionData.fonte_prezzi : null;
    if (f && f.fonte && f.data) {
        const it = (iso) => { const [a, m, g] = String(iso).split('-'); return `${g}/${m}/${a}`; };
        const quando = (f.stima && f.data_prezzi)
            ? `stima per il ${it(f.data)} con i prezzi del ${it(f.data_prezzi)}`
            : it(f.data);
        box.innerText = `Prezzi: ${f.fonte}, zona ${f.zona_nome || f.zona}, ${quando} (all'ingrosso, senza oneri e imposte)`;
    } else {
        box.innerText = 'Prezzi: valori inseriti a mano (curva di esempio)';
    }

    // Potenza a macchina ferma usata nel calcolo (assente nelle sessioni meno recenti)
    const ferma = document.getElementById('potenzaFermaDashboard');
    const pf = sessionData ? sessionData.potenza_ferma_kw : null;
    if (pf && Object.keys(pf).length) {
        const elenco = Object.entries(pf).map(([m, kw]) => `${m} ${formatNum(kw, 1)} kW`).join(', ');
        ferma.innerText = `Macchina ferma ma accesa (setup, pause, attese): ` +
            `${formatNum((sessionData.potenza_ferma_frazione ?? 0) * 100, 0)}% della potenza media in lavorazione (${elenco})`;
    } else {
        ferma.innerText = 'Macchina ferma: consumo non considerato in questa simulazione';
    }
}

// Riga con i tempi di calcolo, sopra il grafico di Pareto
function renderTempiCalcolo() {
    const box = document.getElementById('tempiCalcolo');
    const t = sessionData ? sessionData.tempi_calcolo : null;
    if (!t) {
        box.style.display = 'none';
        return;
    }
    const dettaglioNsga = (t.nsga2_n_gen && t.nsga2_pop_size)
        ? ` (${t.nsga2_n_gen} generazioni × ${t.nsga2_pop_size} schedulazioni)`
        : '';
    box.innerHTML = `<b>Tempi di calcolo:</b> training XGBoost (durata e potenza) ` +
        `<b>${formatDurata(t.training_xgboost_s)}</b> · ` +
        `ottimizzazione NSGA-II${dettaglioNsga} <b>${formatDurata(t.nsga2_s)}</b>`;
    box.style.display = 'block';
}

// ------------------------------------------------------------------
// Scheda "Affidabilità dei modelli"
// Legge sessionData.validazione_modelli (prodotto da model_validation.py):
// metriche MAE / MAE% / R² dei modelli sull'"esame" (dati mai visti).
// ------------------------------------------------------------------
// Ordine: prima il riferimento (la media), poi il nostro modello, poi gli altri confronti
const MODELLI_ORDINE = ['sempre_la_media', 'xgboost', 'regressione_lineare', 'formula_q_su_v'];
const MODELLI_ETICHETTE = {
    xgboost: 'XGBoost',
    regressione_lineare: 'Regressione lineare',
    sempre_la_media: 'Sempre la media (riferimento)',
    formula_q_su_v: 'Formula q/v'
};
const MODELLI_ETICHETTE_BREVI = {
    xgboost: 'XGBoost',
    regressione_lineare: 'Regressione lineare',
    sempre_la_media: 'Sempre la media',
    formula_q_su_v: 'Formula q/v'
};

function renderAffidabilita() {
    const card = document.getElementById('affidabilitaCard');
    const vuoto = document.getElementById('affidabilitaVuoto');
    const contenuto = document.getElementById('affidabilitaContenuto');
    const v = sessionData ? sessionData.validazione_modelli : null;

    card.style.display = 'block';
    if (!v || !v.tempo_h || !v.potenza_kw || !v.tempo_h.xgboost || !v.potenza_kw.xgboost) {
        vuoto.style.display = 'block';
        contenuto.style.display = 'none';
        return;
    }
    vuoto.style.display = 'none';
    contenuto.style.display = 'block';

    const t = v.tempo_h;
    const p = v.potenza_kw;
    const xt = t.xgboost;
    const xp = p.xgboost;
    // Se il campo manca (sessioni meno recenti) i dati si considerano simulati
    const simulato = (sessionData.sorgente_dati || 'simulato') === 'simulato';

    // Banner: dichiara apertamente se i dati sono simulati (circolarità)
    const banner = document.getElementById('affidabilitaBanner');
    if (simulato) {
        banner.className = 'note-banner note-warn';
        banner.innerText = 'Dati storici SIMULATI: i dati sono prodotti da formule note e il modello le "reimpara". ' +
            'Un valore alto indica che le riproduce bene, non che funzionerebbe sulla produzione reale (risultato circolare).';
    } else {
        banner.className = 'note-banner note-info';
        banner.innerText = 'Dati storici REALI: il modello è stato messo alla prova su dati che non ha mai visto in allenamento.';
    }

    // Quattro riquadri riassuntivi
    document.getElementById('mAffDurata').innerText = `${formatNum(xt.mae, 3)} h`;
    document.getElementById('sAffDurata').innerText = `${formatNum(xt.mae_pct, 1)}% della durata media · R² ${formatNum(xt.r2, 3)}`;
    document.getElementById('mAffPotenza').innerText = `${formatNum(xp.mae, 2)} kW`;
    document.getElementById('sAffPotenza').innerText = `${formatNum(xp.mae_pct, 1)}% della potenza media · R² ${formatNum(xp.r2, 3)}`;

    // Quante volte XGBoost sbaglia meno del modello lineare
    const lt = t.regressione_lineare ? t.regressione_lineare.mae / xt.mae : NaN;
    const lp = p.regressione_lineare ? p.regressione_lineare.mae / xp.mae : NaN;
    document.getElementById('mAffVantaggio').innerText = `×${formatNum(lt, 1)} · ×${formatNum(lp, 1)}`;
    const dVant = document.getElementById('dAffVantaggio');
    if (lt > 1.05 && lp > 1.05) {
        dVant.innerHTML = '<span class="delta-pos">errore minore (durata · potenza)</span>';
    } else {
        dVant.innerHTML = '<span class="delta-neg">il modello semplice fa quasi uguale</span>';
    }

    // Sovra-adattamento: differenza tra R² sui dati di allenamento e sull'esame
    const gap = Math.max(
        (xt.r2_train ?? xt.r2) - xt.r2,
        (xp.r2_train ?? xp.r2) - xp.r2
    );
    const mOver = document.getElementById('mAffOverfit');
    const dOver = document.getElementById('dAffOverfit');
    if (gap < 0.01) {
        mOver.innerText = 'Nessuno';
        dOver.innerHTML = `<span class="delta-pos">differenza R² ${formatNum(gap, 4)}</span>`;
    } else if (gap < 0.03) {
        mOver.innerText = 'Lieve';
        dOver.innerHTML = `<span class="delta-neutral">differenza R² ${formatNum(gap, 4)}</span>`;
    } else {
        mOver.innerText = 'Sì';
        dOver.innerHTML = `<span class="delta-neg">differenza R² ${formatNum(gap, 4)}</span>`;
    }

    // Grafico: errore % di ogni modello, durata e potenza affiancati
    const modelli = MODELLI_ORDINE.filter(m => t[m] || p[m]);
    const serie = (nome, dati, colore) => ({
        name: nome,
        type: 'bar',
        data: modelli.map(m => dati[m] ? Number(dati[m].mae_pct.toFixed(2)) : null),
        itemStyle: {color: colore},
        label: {
            show: true,
            position: 'top',
            formatter: (q) => (q.value === null || q.value === undefined) ? '' : `${formatNum(q.value, 1)}%`
        }
    });
    affidabilitaChart.setOption({
        grid: {top: 40, bottom: 40, left: 60, right: 20},
        toolbox: {feature: {saveAsImage: {title: 'Salva PNG', name: nomeFile('models_reliability'), pixelRatio: 2}}},
        legend: {data: ['Durata', 'Potenza']},
        tooltip: {
            trigger: 'axis',
            axisPointer: {type: 'shadow'},
            formatter: (params) => {
                if (!params || !params.length) return '';
                let out = `<b>${params[0].axisValue}</b><br/>`;
                params.forEach(it => {
                    if (it.value !== null && it.value !== undefined) {
                        out += `${it.marker} ${it.seriesName}: <b>${formatNum(it.value, 2)}%</b><br/>`;
                    }
                });
                return out;
            }
        },
        xAxis: {type: 'category', data: modelli.map(m => MODELLI_ETICHETTE_BREVI[m])},
        yAxis: {
            type: 'value',
            name: 'Errore medio (%)',
            nameLocation: 'middle',
            nameGap: 40,
            nameTextStyle: {fontWeight: 'bold', fontSize: 13},
            axisLabel: {formatter: (val) => formatNum(val, 0)}
        },
        series: [
            serie('Durata', t, '#007bff'),
            serie('Potenza', p, '#fd7e14')
        ]
    }, true);
    affidabilitaChart.resize();

    // Tabella con tutti i numeri
    const celle = (m) => m
        ? `<td class="num">${formatNum(m.mae, 4)}</td><td class="num">${formatNum(m.mae_pct, 2)}%</td><td class="num">${formatNum(m.r2, 4)}</td>`
        : '<td class="num">-</td><td class="num">-</td><td class="num">-</td>';
    document.querySelector('#affidabilitaTable tbody').innerHTML = modelli.map(m => `
        <tr class="${m === 'xgboost' ? 'riga-xgb' : ''}">
            <td>${MODELLI_ETICHETTE[m]}</td>
            ${celle(t[m])}
            ${celle(p[m])}
        </tr>
    `).join('');

    // Spiegazione in parole semplici
    const righe = [];
    righe.push(`Il modello è stato allenato su ${formatNum(v.n_train, 0)} esempi e poi messo alla prova su ${formatNum(v.n_test, 0)} esempi mai visti (${formatNum(v.test_size * 100, 0)}% dello storico).`);
    righe.push(`Sbaglia in media ${formatNum(xt.mae, 3)} h sulla durata (${formatNum(xt.mae_pct, 1)}%) e ${formatNum(xp.mae, 2)} kW sulla potenza (${formatNum(xp.mae_pct, 1)}%).`);
    righe.push(`R² = ${formatNum(xt.r2, 3)} per la durata e ${formatNum(xp.r2, 3)} per la potenza: 1 significa previsioni perfette, 0 significa non fare meglio che indovinare sempre la media.`);
    if (lt > 1.05 || lp > 1.05) {
        righe.push('XGBoost sbaglia meno della regressione lineare, quindi aggiunge valore rispetto a un modello semplice.');
    }
    // R² della media leggermente sotto zero: la media è calcolata sui dati di
    // allenamento e verificata sugli altri, la cui media è un po' diversa
    if (t.sempre_la_media && t.sempre_la_media.r2 < 0) {
        righe.push(`"Sempre la media" è il riferimento: risponde sempre con la media dei dati di allenamento. Sui dati di verifica, che hanno una media leggermente diversa, il suo R² risulta di poco sotto zero (${formatNum(t.sempre_la_media.r2, 4)}): è atteso e conferma che la verifica è fatta su dati tenuti da parte.`);
    }
    if (t.formula_q_su_v && t.formula_q_su_v.mae < xt.mae) {
        righe.push(simulato
            ? `Sulla durata la semplice formula quantità ÷ velocità sbaglia meno (${formatNum(t.formula_q_su_v.mae, 3)} h): è normale con dati simulati, perché è proprio la formula con cui sono stati generati.`
            : `Sulla durata la semplice formula quantità ÷ velocità sbaglia meno del modello (${formatNum(t.formula_q_su_v.mae, 3)} h): da valutare se il machine learning serve davvero.`);
    }
    document.getElementById('affidabilitaSpiegazione').innerHTML = righe.map(r => `<li>${r}</li>`).join('');
}

// ------------------------------------------------------------------
// Scheda "Convergenza di NSGA-II"
// Legge sessionData.convergenza_nsga2 (prodotto da convergence.py):
// curva dell'ipervolume per generazione e confronto con ricerca casuale.
// ------------------------------------------------------------------
function renderConvergenza() {
    const card = document.getElementById('convergenzaCard');
    const vuoto = document.getElementById('convergenzaVuoto');
    const contenuto = document.getElementById('convergenzaContenuto');
    const c = sessionData ? sessionData.convergenza_nsga2 : null;

    card.style.display = 'block';
    if (!c || !c.disponibile) {
        vuoto.innerText = (c && c.motivo)
            ? `Analisi non disponibile: ${c.motivo}`
            : 'Analisi non disponibile per questa simulazione (salvata prima dell\'introduzione del controllo, ' +
              'oppure disattivato con analisi_convergenza: false in config.json).';
        vuoto.style.display = 'block';
        contenuto.style.display = 'none';
        return;
    }
    vuoto.style.display = 'none';
    contenuto.style.display = 'block';

    // Riquadri riassuntivi
    document.getElementById('mConvEsito').innerHTML = c.convergito
        ? '<span class="delta-pos">Convergenza raggiunta</span>'
        : '<span class="delta-neg">Ancora in crescita</span>';
    document.getElementById('sConvEsito').innerText = c.convergito
        ? `${c.n_gen} generazioni bastano`
        : 'servono più generazioni';
    document.getElementById('mConvMiglioramento').innerText = `+${formatNum(c.miglioramento_ultime_pct, 2)}%`;
    document.getElementById('sConvMiglioramento').innerText = `nelle ultime ${c.ultime_generazioni} generazioni`;
    document.getElementById('mConvGen95').innerText = `${c.gen_95} / ${c.n_gen}`;
    document.getElementById('mConvCaso').innerText = `${formatNum(c.casuale_finale_pct, 0)}%`;
    document.getElementById('sConvCaso').innerText =
        `dell'ipervolume di NSGA-II · valide ${c.casuale_ammissibili}/${c.casuale_totale}`;

    // Curva: asse x = schedulazioni provate, y = % del risultato finale di NSGA-II
    convergenzaChart.setOption({
        grid: {top: 50, bottom: 60, left: 70, right: 30},
        toolbox: {feature: {saveAsImage: {title: 'Salva PNG', name: nomeFile('nsga2_convergence'), pixelRatio: 2}}},
        legend: {data: ['NSGA-II', 'Ricerca casuale']},
        tooltip: {
            trigger: 'axis',
            formatter: (params) => {
                if (!params || !params.length) return '';
                let out = `<b>${params[0].axisValue} schedulazioni provate</b><br/>`;
                params.forEach(it => {
                    out += `${it.marker} ${it.seriesName}: <b>${formatNum(it.value, 1)}%</b><br/>`;
                });
                return out;
            }
        },
        xAxis: {
            type: 'category',
            name: 'Schedulazioni provate',
            nameLocation: 'middle',
            nameGap: 35,
            nameTextStyle: {fontWeight: 'bold', fontSize: 13},
            data: c.n_eval
        },
        yAxis: {
            type: 'value',
            name: 'Ipervolume (%)',
            nameLocation: 'middle',
            nameGap: 45,
            nameTextStyle: {fontWeight: 'bold', fontSize: 13},
            min: 0,
            axisLabel: {formatter: (val) => `${formatNum(val, 0)}%`}
        },
        series: [
            {
                name: 'NSGA-II',
                type: 'line',
                data: c.ipervolume_nsga2_pct.map(x => Number(x.toFixed(2))),
                itemStyle: {color: '#28a745'},
                lineStyle: {width: 3},
                markLine: {
                    silent: true,
                    symbol: ['none', 'none'],
                    data: [{yAxis: 100}],
                    lineStyle: {color: '#6c757d', type: 'dotted'},
                    label: {formatter: 'risultato finale'}
                }
            },
            {
                name: 'Ricerca casuale',
                type: 'line',
                data: c.ipervolume_casuale_pct.map(x => Number(x.toFixed(2))),
                itemStyle: {color: '#6c757d'},
                lineStyle: {type: 'dashed'}
            }
        ]
    }, true);
    convergenzaChart.resize();

    document.getElementById('convergenzaSpiegazione').innerHTML =
        (c.spiegazione || []).map(r => `<li>${r}</li>`).join('');
}

// Sequenza delle macchine attraversate da un prodotto
function getRoutingForProduct(prodId) {
    if (!sessionData || !Array.isArray(sessionData.gantt_base)) return [];
    const routing = [];
    sessionData.gantt_base.forEach(d => {
        const lotto = String(d.Lotto || '');
        if (lotto.startsWith(prodId)) {
            const machine = d.Macchina || d.macchina || '-';
            routing.push(machine);
        }
    });
    return [...new Set(routing)];
}

// Tabelle con prodotti, quantità e fasi (baseline e soluzione scelta)
function renderDataPanel(sol) {
    const dataCard = document.getElementById('dataCard');
    const dataBody = document.getElementById('dataBody');
    const prodBody = document.querySelector('#prodottiTable tbody');
    const fasiBody = document.querySelector('#fasiTable tbody');
    if (!dataCard || !dataBody || !prodBody || !fasiBody) return;

    dataCard.style.display = 'block';
    dataBody.style.display = 'none';
    document.getElementById('dataToggle').innerText = '▲';

    const prodotti = [];
    const seen = new Set();
    (sessionData.gantt_base || []).forEach(d => {
        const lotto = String(d.Lotto || '');
        const prodId = lotto.split(' ')[0];
        if (!seen.has(prodId)) {
            seen.add(prodId);
            prodotti.push({
                id: prodId,
                qty: d.Quantita,
                routing: getRoutingForProduct(prodId)
            });
        }
    });

    prodBody.innerHTML = prodotti.map(p => `
        <tr>
            <td>${p.id}</td>
            <td>${formatNum(p.qty, 0)} m²</td>
            <td>${p.routing.join(' → ')}</td>
        </tr>
    `).join('');

    const baselineMap = {};
    (sessionData.gantt_base || []).forEach(d => {
        const prodId = String(d.Lotto || '').split(' ')[0];
        if (!baselineMap[prodId]) baselineMap[prodId] = [];
        baselineMap[prodId].push(
            `M${String(d.Macchina || '').replace('MAC_', '')}: ` +
            `${convertiOrarioHHMM(d.Start_Lavoro)} - ${convertiOrarioHHMM(d.End_Lavoro)} ` +
            `(${durataOre(d.End_Lavoro - d.Start_Lavoro)}) | ` +
            `${formatNum(d.Velocita, 0)} m²/h | ` +
            `${formatNum(d.Potenza_kW * (d.End_Lavoro - d.Start_Lavoro), 2)} kWh`
        );
    });

    const selectedMap = {};
    (sol?.dettagli || []).forEach(d => {
        const prodId = String(d.Lotto || '').split(' ')[0];
        if (!selectedMap[prodId]) selectedMap[prodId] = [];
        const start = Number(d.Start_Lavoro ?? d.Start ?? 0);
        const end = Number(d.End_Lavoro ?? d.End ?? 0);
        selectedMap[prodId].push(
            `M${String(d.Macchina || '').replace('MAC_', '')}: ` +
            `${convertiOrarioHHMM(d.Start_Lavoro)} - ${convertiOrarioHHMM(d.End_Lavoro)} ` +
            `(${durataOre(end - start)}) | ` +
            `${formatNum(d.Velocita, 0)} m²/h | ` +
            `${formatNum(d.Potenza_kW * (end - start), 2)} kWh`
        );
    });

    fasiBody.innerHTML = prodotti.map(p => `
        <tr>
            <td>${p.id}</td>
            <td>${(baselineMap[p.id] || []).join('<br/>')}</td>
            <td>${(selectedMap[p.id] || []).join('<br/>')}</td>
        </tr>
    `).join('');
}

// Grafico della frontiera di Pareto: ogni punto è una schedulazione proposta
function renderParetoChart() {
    if (!sessionData.soluzioni_valide) return;

    const dataValid = sessionData.soluzioni_valide.map(s => [s.tp, s.costo, s.id]);
    const costi = dataValid.map(d => d[1]);

    // Le due soluzioni estreme della frontiera, evidenziate e disegnate sopra
    // le altre: così si riconoscono e si cliccano senza ambiguità anche quando
    // ci sono punti quasi sovrapposti. Stessa regola usata per i nomi dei file
    const solMinCosto = sessionData.soluzioni_valide.reduce((a, s) => s.costo < a.costo ? s : a);
    const solMaxTp = sessionData.soluzioni_valide.reduce((a, s) => s.tp > a.tp ? s : a);
    const ruoloPunto = (id) => id === solMinCosto.id ? 'Costo minimo'
        : (id === solMaxTp.id ? 'Throughput massimo' : null);
    const estremo = (nome, sol, colore, posizione) => ({
        name: nome,
        type: 'scatter',
        symbol: 'diamond',
        symbolSize: 22,
        z: 5,
        itemStyle: {color: colore, borderColor: '#fff', borderWidth: 2},
        // sfondo bianco: l'etichetta resta leggibile anche sopra le linee tratteggiate
        label: {show: true, position: posizione, distance: 10, formatter: `${nome} (#${sol.id})`, fontWeight: 'bold', color: colore,
                backgroundColor: 'rgba(255,255,255,0.9)', padding: [2, 4], borderRadius: 3},
        data: [[sol.tp, sol.costo, sol.id]]
    });
    const costoMin = Math.min(...costi, sessionData.costo_base || 0);
    const costoMax = Math.max(...costi, sessionData.costo_base || 100);

    const option = {
        grid: {
            bottom: '25%'
        },
        toolbox: {
            feature: {
                dataZoom: {title: {zoom: 'Zoom area', back: 'Annulla zoom'}},
                saveAsImage: {title: 'Salva PNG', name: nomeFile('pareto_chart'), pixelRatio: 2},
                restore: {title: 'Ripristina'}
            }
        },
        dataZoom: [
            {
                type: 'inside',
                xAxisIndex: 0,
                zoomOnMouseWheel: 'ctrl',
                moveOnMouseMove: true
            },
            {
                type: 'slider',
                bottom: 10,
            }
        ],
        tooltip: {
            formatter: (params) => {
                if (params && params.seriesType === 'scatter' && params.value) {
                    const ruolo = ruoloPunto(params.value[2]);
                    return `<b>Soluzione #${params.value[2]}</b>${ruolo ? ` – ${ruolo}` : ''}<br/>TP: ${formatNum(params.value[0], 2)} m²/h<br/>Costo: ${formatNum(params.value[1], 2)} €`;
                }
                return params?.seriesName || '';
            }
        },
        xAxis: {
            name: 'Throughput (m²/h)',
            type: 'value',
            min: Math.min(...dataValid.map(d => d[0]), sessionData.max_tp_assoluto * sessionData.alfa_input) * 0.98,
            max: Math.max(...dataValid.map(d => d[0]), sessionData.max_tp_assoluto) * 1.02,
            axisLabel: {formatter: (val) => typeof val === 'number' ? formatNum(val, 0) : val},
            nameLocation: 'middle',
            nameGap: 40,
            nameTextStyle: {
                fontWeight: 'bold',
                fontSize: 14
            }
        },
        yAxis: {
            name: 'Costo (€)',
            type: 'value',
            min: Math.floor(costoMin * 0.95),
            max: Math.ceil(costoMax * 1.05),
            axisLabel: {formatter: (val) => formatNum(val, 0)},
            nameLocation: 'middle',
            nameGap: 40,
            nameTextStyle: {
                fontWeight: 'bold',
                fontSize: 14
            }
        },
        series: [
            {
                name: 'Schedulazioni valide (NSGA-II)',
                type: 'scatter',
                symbolSize: 14,
                itemStyle: {color: '#dc3545'},
                data: dataValid
            },
            estremo('Costo minimo', solMinCosto, '#198754', 'bottom'),
            estremo('Throughput massimo', solMaxTp, '#6f42c1', 'top'),
            {
                name: 'Throughput baseline',
                type: 'line',
                // colore esplicito: senza, la legenda prende un colore diverso dalla linea
                color: '#007bff',
                markLine: {
                    symbol: ['none', 'none'],
                    data: [{xAxis: sessionData.max_tp_assoluto, name: 'Throughput baseline'}],
                    lineStyle: {color: '#007bff', type: 'dashed', width: 2},
                    label: {formatter: `Baseline: ${formatNum(sessionData.max_tp_assoluto, 1)} m²/h`}
                }
            },
            {
                name: 'Soglia alfa',
                type: 'line',
                // colore esplicito: senza, la legenda prende un colore diverso dalla linea
                color: '#f5a623',
                markLine: {
                    symbol: ['none', 'none'],
                    data: [{xAxis: sessionData.max_tp_assoluto * sessionData.alfa_input, name: 'Soglia alfa'}],
                    lineStyle: {color: '#f5a623', type: 'dashed', width: 2},
                    label: {formatter: `Soglia: ${formatNum(sessionData.max_tp_assoluto * sessionData.alfa_input, 1)} m²/h (${formatNum(sessionData.alfa_input * 100, 0)}%)`}
                }
            },
            {
                name: 'Costo baseline',
                type: 'line',
                // colore esplicito: senza, la legenda prende un colore diverso dalla linea
                color: '#6c757d',
                markLine: {
                    symbol: ['none', 'none'],
                    data: [{yAxis: sessionData.costo_base, name: 'Costo baseline'}],
                    lineStyle: {color: '#6c757d', type: 'dashed', width: 2},
                    label: {formatter: `Costo baseline: ${formatNum(sessionData.costo_base, 2)} €`}
                }
            }
        ],
        legend: {
            data: [
                'Schedulazioni valide (NSGA-II)',
                'Costo minimo',
                'Throughput massimo',
                'Soglia alfa',
                'Throughput baseline',
                'Costo baseline'
            ]
        }
    };

    paretoChart.setOption(option, true);
    paretoChart.resize();

    paretoChart.off('click');
    paretoChart.on('click', (params) => {
        if (params && params.seriesType === 'scatter' && params.value) {
            const solId = params.value[2];
            const solScelta = sessionData.soluzioni_valide.find(s => s.id === solId);
            if (solScelta) {
                currentSelectedSol = solScelta;
                renderDetails(solScelta);
                renderDataPanel(solScelta);
                toastr.info(`Caricati i dettagli della soluzione #${solId}`, "Info");
            }
        }
    });
}

// Indicatori, Gantt e profilo energetico della soluzione scelta
function renderDetails(sol) {
    document.getElementById('metricsCard').style.display = 'block';
    document.getElementById('detailsCard').style.display = 'block';

    function calcDelta(opt, base, isInverse = true) {
        if (!base) return `<span class="delta-neutral">-</span>`;
        const pct = ((opt - base) / base) * 100;
        const sign = pct > 0 ? '+' : '';
        const pctStr = `${sign}${formatNum(pct, 2)}%`;

        let isGood = isInverse ? (pct < 0) : (pct > 0);
        if (Math.abs(pct) < 0.01) return `<span class="delta-neutral">0,00% (vs BSL)</span>`;

        const cls = isGood ? 'delta-pos' : 'delta-neg';
        return `<span class="${cls}">${pctStr} vs BSL</span>`;
    }

    document.getElementById('mCosto').innerText = `${formatNum(sol.costo, 2)} €`;
    document.getElementById('dCosto').innerHTML = calcDelta(sol.costo, sessionData.costo_base, true);

    document.getElementById('mKwh').innerText = `${formatNum(sol.kwh, 1)} kWh`;
    document.getElementById('dKwh').innerHTML = calcDelta(sol.kwh, sessionData.kwh_base, true);

    document.getElementById('mTp').innerText = `${formatNum(sol.tp, 2)} m²/h`;
    document.getElementById('dTp').innerHTML = calcDelta(sol.tp, sessionData.max_tp_assoluto, false);

    document.getElementById('mMakespan').innerText = `${formatNum(sol.makespan, 2)} h`;
    document.getElementById('dMakespan').innerHTML = calcDelta(sol.makespan, sessionData.makespan_base, true);

    renderGanttChart(sol);
    renderEnergyChart(sol);
}

// Colore esadecimale -> rgba con trasparenza (per i blocchi della baseline)
function hexToRgba(hex, alpha) {
    const clean = hex.replace('#', '');
    const full = clean.length === 3
        ? clean.split('').map(ch => ch + ch).join('')
        : clean;
    const r = parseInt(full.slice(0, 2), 16);
    const g = parseInt(full.slice(2, 4), 16);
    const b = parseInt(full.slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

const optColorsPaletteBase = ['#28a745', '#20c997', '#17a2b8', '#6f42c1', '#e83e8c', '#fd7e14', '#6610f2', '#20b2aa'];
const optColorsPalette = [];
const lottoColorMap = {};

// Colori dei prodotti nel Gantt (stesso prodotto, stesso colore)
function buildOptimizedPalette(totalProductions = 0) {
    const paletteSize = Math.max(totalProductions, optColorsPaletteBase.length);
    optColorsPalette.length = 0;
    for (let i = 0; i < paletteSize; i++) {
        optColorsPalette.push(optColorsPaletteBase[i % optColorsPaletteBase.length]);
    }
    Object.keys(lottoColorMap).forEach(k => delete lottoColorMap[k]);
}

function getOptimizedColor(lottoName) {
    if (!lottoColorMap[lottoName]) {
        lottoColorMap[lottoName] = optColorsPalette[Object.keys(lottoColorMap).length % optColorsPalette.length];
    }
    return lottoColorMap[lottoName];
}

// Trasforma le fasi in blocchi del Gantt: setup, lavorazione e attesa
function buildItems(ganttList, isBaseline, macchine) {
    if (!Array.isArray(ganttList)) return [];

    const result = [];
    const baseFlag = isBaseline ? 1 : 0;

    ganttList.forEach((d, idx) => {
        if (!d) return;

        let yIdx = typeof d.Macchina_Idx === 'number' ? d.Macchina_Idx : (typeof d.macchina_idx === 'number' ? d.macchina_idx : -1);
        const machineName = d.Macchina || d.macchina;
        if (yIdx < 0 && machineName) {
            const cleanM = String(machineName).trim().toUpperCase();
            yIdx = macchine.findIndex(m => m.toUpperCase() === cleanM);
        }
        if (yIdx < 0 || yIdx >= macchine.length) return;

        let lottoName = String(d.Lotto || d.ID_Lotto || d.lotto || `Lotto_${idx}`);
        lottoName += " (" + formatNum(d.Quantita, 0) + " m²)";

        // 1. Setup
        const sSetup = Number(d.Start_Setup ?? d.start_setup);
        const eSetup = Number(d.End_Setup ?? d.end_setup);
        if (!isNaN(sSetup) && !isNaN(eSetup) && (eSetup - sSetup) > 0.001) {
            const setupColor = isBaseline ? hexToRgba(getOptimizedColor(lottoName), 0.22) : '#ffc107';
            result.push({
                name: `Setup: ${lottoName}`,
                value: [yIdx, sSetup, eSetup, Number((eSetup - sSetup).toFixed(2)), baseFlag, setupColor, 'S', 'SETUP'],
                itemStyle: {
                    color: setupColor,
                    borderColor: 'transparent',
                    borderWidth: 0
                },
                lineStyle: {type: 'dashed'}
            });
        }

        // 2. Lavorazione
        const sWork = Number(d.Start_Lavoro ?? d.Start ?? d.start_lavoro ?? d.start);
        const eWork = Number(d.End_Lavoro ?? d.End ?? d.end_lavoro ?? d.end);
        if (!isNaN(sWork) && !isNaN(eWork) && (eWork - sWork) > 0.001) {
            let color = isBaseline ? hexToRgba(getOptimizedColor(lottoName), 0.38) : getOptimizedColor(lottoName);
            const labelType = isBaseline ? 'BASELINE' : 'OTTIMIZZATO';

            const rawVel = d.Velocita ?? d.velocita;
            const rawPot = d.Potenza_kW ?? d.potenza_kw ?? d.potenza;
            const vel = (rawVel !== undefined && rawVel !== null) ? formatNum(rawVel, 0) : '-';
            const pot = (rawPot !== undefined && rawPot !== null) ? formatNum(rawPot, 1) : '-';

            result.push({
                name: lottoName,
                value: [
                    yIdx,
                    sWork,
                    eWork,
                    Number((eWork - sWork).toFixed(2)),
                    baseFlag,
                    color,
                    lottoName + "\n" + vel + " m²/h\n" + pot + " kW",
                    labelType,
                    vel,
                    pot
                ],
                itemStyle: {
                    color: color,
                    borderColor: '#000000',
                    borderWidth: isBaseline ? 1 : 2,
                    borderType: isBaseline ? 'dashed' : 'solid'
                }
            });
        }

        // 3. Attesa o pausa
        const sAtt = Number(d.Start_Attesa ?? d.start_attesa);
        const eAtt = Number(d.End_Attesa ?? d.end_attesa);
        if (!isNaN(sAtt) && !isNaN(eAtt) && (eAtt - sAtt) > 0.01) {
            const attesaColor = isBaseline ? hexToRgba(getOptimizedColor(lottoName), 0.22) : '#dc3545';
            result.push({
                name: `Pausa (${lottoName})`,
                value: [yIdx, sAtt, eAtt, Number((eAtt - sAtt).toFixed(2)), baseFlag, attesaColor, 'W', 'ATTESA'],
                itemStyle: {
                    color: attesaColor,
                    borderColor: 'transparent',
                    borderWidth: 0
                },
                lineStyle: {type: 'dotted'}
            });
        }
    });

    return result;
}

// Scurisce un colore della percentuale indicata (bordi dei blocchi)
function darkenColor(col, percent) {
    if (!col) return '#000000';
    // Gestione colori esadecimali (es. #FF0000 o #F00)
    if (col.startsWith('#')) {
        let num = parseInt(col.slice(1), 16);
        if (col.length === 4) {
            num = parseInt(col[1]+col[1]+col[2]+col[2]+col[3]+col[3], 16);
        }
        let r = (num >> 16);
        let g = (num >> 8) & 0x00FF;
        let b = num & 0x0000FF;

        r = Math.floor(r * (100 - percent) / 100);
        g = Math.floor(g * (100 - percent) / 100);
        b = Math.floor(b * (100 - percent) / 100);

        return `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}`;
    }
    return col; // Ritorna il colore originale se non è esadecimale
}

// Gantt per macchina: baseline (sopra) e soluzione ottimizzata (sotto)
function renderGanttChart(sol) {
    if (!sessionData) return;
    const nProductions = (sessionData.gantt_base || []).length || (sol && Array.isArray(sol.dettagli) ? sol.dettagli.length : 0);
    buildOptimizedPalette(nProductions);

    let macchineSet = new Set();
    if (Array.isArray(sessionData.gantt_base)) {
        sessionData.gantt_base.forEach(d => {
            if (d.Macchina || d.macchina) macchineSet.add(d.Macchina || d.macchina);
        });
    }
    let optDataCheck = [];
    if (sol) {
        if (Array.isArray(sol)) optDataCheck = sol;
        else if (Array.isArray(sol.dettagli)) optDataCheck = sol.dettagli;
        else if (Array.isArray(sol.gantt)) optDataCheck = sol.gantt;
    }
    optDataCheck.forEach(d => {
        const m = d.Macchina || d.macchina;
        if (m) macchineSet.add(m);
    });

    let macchine = Array.from(macchineSet);
    if (macchine.length === 0) {
        macchine = ["MAC_01", "MAC_02", "MAC_03", "MAC_04"];
    } else {
        macchine.sort();
    }

    const baseItems = buildItems(sessionData.gantt_base, true, macchine);
    const optItems = buildItems(optDataCheck, false, macchine);

    const renderCustomItem = (params, api) => {
        const categoryIndex = api.value(0);
        const startVal = api.value(1);
        const endVal = api.value(2);
        const isBaseline = api.value(4) === 1;
        const color = api.value(5);
        const blockType = api.value(7);
        const displayLabel = api.value(6);
        const startPoint = api.coord([startVal, categoryIndex]);
        const endPoint = api.coord([endVal, categoryIndex]);

        if (!startPoint || !endPoint || isNaN(startPoint[0]) || isNaN(startPoint[1])) {
            return;
        }

        const barHeight = 40;
        const y = isBaseline ? startPoint[1] - barHeight - 1 : startPoint[1] + 1;
        const rectWidth = Math.max(endPoint[0] - startPoint[0], 2);

        let lineWidth = 1, lineDash = [], showText = rectWidth > 12;
        if (blockType === 'BASELINE') {
            showText = rectWidth > 30;
            lineDash = [7, 2];
        }
        else if (blockType === 'OTTIMIZZATO') {
            showText = rectWidth > 30;
            lineWidth = 2;
        }

        return {
            type: 'group',
            children: [
                {
                    type: 'rect',
                    shape: {x: startPoint[0], y: y, width: rectWidth, height: barHeight, r: 0},
                    style: {
                        fill: color,
                        shadowBlur: 2,
                        shadowColor: 'rgba(0,0,0,0.2)',
                        stroke: darkenColor(color, 35),
                        lineWidth: lineWidth,
                        lineDash: lineDash
                    }
                },
                ...(blockType === 'SETUP' ? [{
                    type: 'rect',
                    shape: {x: startPoint[0], y: y, width: rectWidth, height: barHeight, r: 0},
                    style: {
                        fill: {
                            image: (() => {
                                const canvas = document.createElement('canvas');
                                canvas.width = 12;
                                canvas.height = 12;
                                const ctx = canvas.getContext('2d');

                                // Sfondo del blocco
                                ctx.fillStyle = color;
                                ctx.fillRect(0, 0, 12, 12);

                                // Linee continue diagonali
                                ctx.strokeStyle = 'rgba(255,255,255,0.35)';
                                ctx.lineWidth = 2;

                                // Più linee parallele, così il motivo si ripete senza interruzioni
                                const drawLine = (x1, y1, x2, y2) => {
                                    ctx.beginPath();
                                    ctx.moveTo(x1, y1);
                                    ctx.lineTo(x2, y2);
                                    ctx.stroke();
                                };

                                drawLine(0, 12, 12, 0);   // Linea centrale
                                drawLine(-6, 6, 6, -6);  // Linea superiore
                                drawLine(6, 18, 18, 6);  // Linea inferiore

                                return canvas;
                            })(),
                            repeat: 'repeat'
                        },
                        lineWidth: lineWidth,
                        lineDash: lineDash
                    }
                }] : []),
                ...(blockType === 'ATTESA' ? [{
                    type: 'rect',
                    shape: {x: startPoint[0], y: y, width: rectWidth, height: barHeight, r: 0},
                    style: {
                        fill: {
                            image: (() => {
                                const canvas = document.createElement('canvas');
                                canvas.width = 10;
                                canvas.height = 10;
                                const ctx = canvas.getContext('2d');
                                ctx.clearRect(0, 0, 10, 10);
                                ctx.fillStyle = 'rgba(255,255,255,0.55)';
                                ctx.beginPath();
                                ctx.arc(3, 3, 1.2, 0, Math.PI * 2);
                                ctx.fill();
                                ctx.beginPath();
                                ctx.arc(8, 8, 1.2, 0, Math.PI * 2);
                                ctx.fill();
                                return canvas;
                            })(),
                            repeat: 'repeat'
                        },
                        lineWidth: lineWidth,
                        lineDash: lineDash
                    }
                }] : []),
                {
                    type: 'text',
                    style: {
                        text: showText ? displayLabel : '',
                        x: startPoint[0] + (rectWidth / 2),
                        y: y + (barHeight / 2),
                        textVerticalAlign: 'middle',
                        textAlign: 'center',
                        fill: '#eeeeee',
                        font: 'bold 11px sans-serif'
                    }
                }
            ]
        };
    };

    // Asse dei tempi: 24 h, più lungo se un blocco (di solito della
    // baseline) termina oltre l'orizzonte
    const ORIZZONTE = Number(sessionData.orizzonte_ore) || 24;
    const maxFine = Math.max(0, ...[...baseItems, ...optItems].map(it => it.value[2]));
    const ganttMax = Math.max(ORIZZONTE, Math.ceil(maxFine));

    const option = {
        legend: {show: false},
        toolbox: {
            feature: {
                dataZoom: {title: {zoom: 'Zoom area', back: 'Annulla zoom'}},
                saveAsImage: {title: 'Salva PNG', name: nomeFile(`${prefissoSoluzione(sol)}_gantt`), pixelRatio: 2},
                restore: {title: 'Ripristina'}
            }
        },
        grid: {top: 40, bottom: '25%', left: 90, right: 40},
        dataZoom: [
            {type: 'inside', xAxisIndex: 0, filterMode: 'weakFilter', bottom: 10, zoomOnMouseWheel: 'ctrl', moveOnMouseMove: true},
            {type: 'slider', xAxisIndex: 0, filterMode: 'weakFilter'}
        ],
        tooltip: {
            formatter: (p) => {
                if (!p || !p.value) return '';
                const v = p.value;
                let lottoNameSplitted = v[6].split('\n');
                let lottoName = lottoNameSplitted ? lottoNameSplitted[0] : v[6];
                let text = `<b>${lottoName}</b> [${v[7]}]<br/>` +
                    `Inizio: <b>${convertiOrarioHHMM(v[1])}</b> — Fine: <b>${convertiOrarioHHMM(v[2])}</b><br/>` +
                    `Durata: ${durataOre(v[2] - v[1])}`;
                if (v[8] && v[8] !== '-') {
                    text += `<br/>Velocità: ${v[8]} m²/h<br/>Potenza: ${v[9]} kW`;
                }
                return text;
            }
        },
        xAxis: {
            type: 'value',
            name: ganttMax > ORIZZONTE ? `Ore (oltre ${ORIZZONTE}h = giorno successivo)` : `Ore (${ORIZZONTE}h)`,
            min: 0,
            max: ganttMax,
            interval: 1,
            axisLabel: {formatter: (val) => `${val % 24}:00${val >= 24 ? ' +1' : ''}`},
            splitLine: {show: true, lineStyle: {type: 'dashed'}},
            nameLocation: 'middle',
            nameGap: 40,
            nameTextStyle: {
                fontWeight: 'bold',
                fontSize: 14
            }
        },
        yAxis: {
            type: 'category',
            data: macchine,
            axisLabel: {fontWeight: 'bold', fontSize: 12}
        },
        series: [
            {
                name: 'Baseline',
                type: 'custom',
                renderItem: renderCustomItem,
                dimensions: ['macchina', 'start', 'end'],
                encode: {x: [1, 2], y: 0},
                data: baseItems,
                ...(ganttMax > ORIZZONTE ? {
                    markLine: {
                        silent: true,
                        symbol: ['none', 'none'],
                        data: [{xAxis: ORIZZONTE}],
                        lineStyle: {color: '#dc3545', type: 'dashed', width: 2},
                        label: {formatter: `Fine orizzonte ${ORIZZONTE}h`}
                    }
                } : {})
            },
            {
                name: 'Ottimizzato',
                type: 'custom',
                renderItem: renderCustomItem,
                dimensions: ['macchina', 'start', 'end'],
                encode: {x: [1, 2], y: 0},
                data: optItems
            }
        ]
    };

    ganttChart.setOption(option, true);
    ganttChart.resize();
}

// Profilo orario della potenza (baseline e ottimizzata) con i prezzi dell'energia
function renderEnergyChart(sol) {
    // Il profilo copre 24 h, o di più se la baseline supera l'orizzonte;
    // oltre la 24ª ora i prezzi ripetono quelli del giorno
    const pOptRaw = (Array.isArray(sol.p_grid) ? sol.p_grid : []).map(v => Number(v) || 0);
    const pBaseRaw = (Array.isArray(sessionData.p_grid_base) ? sessionData.p_grid_base : []).map(v => Number(v) || 0);
    const prezzi = sessionData.prezzi_ipex_24h || [];
    const nOre = Math.max(24, pOptRaw.length, pBaseRaw.length);
    const padTo = (arr) => Array.from({length: nOre}, (_, i) => arr[i] ?? 0);
    const hours = Array.from({length: nOre}, (_, i) => `${i % 24}:00${i >= 24 ? ' +1' : ''}`);
    const prezziEstesi = Array.from({length: nOre}, (_, i) => prezzi.length ? prezzi[i % prezzi.length] : 0);

    const option = {
        grid: {
            bottom: '25%'
        },
        toolbox: {
            feature: {
                dataZoom: {title: {zoom: 'Zoom area', back: 'Annulla zoom'}},
                saveAsImage: {title: 'Salva PNG', name: nomeFile(`${prefissoSoluzione(sol)}_energy_profile`), pixelRatio: 2},
                restore: {title: 'Ripristina'}
            }
        },
        dataZoom: [
            {
                type: 'inside',
                xAxisIndex: 0,
                zoomOnMouseWheel: 'ctrl',
                moveOnMouseMove: true
            },
            {
                type: 'slider',
                bottom: 10
            }
        ],
        tooltip: {
            trigger: 'axis',
            formatter: (params) => {
                if (!params || !params.length) return '';
                let output = `<b>Ora: ${params[0].axisValue}</b><br/>`;
                params.forEach(item => {
                    const unit = item.seriesName.includes('Prezzo') ? '€/kWh' : 'kW';
                    const decimals = item.seriesName.includes('Prezzo') ? 3 : 2;
                    output += `${item.marker} ${item.seriesName}: <b>${formatNum(item.value, decimals)} ${unit}</b><br/>`;
                });
                return output;
            }
        },
        legend: {data: ['Prezzo MGP (€/kWh)', 'Potenza ottimizzata (kW)', 'Potenza baseline (kW)']},
        xAxis: {
            name: 'Ore (24 h)', type: 'category', data: hours, nameLocation: 'middle',
            nameGap: 40,
            nameTextStyle: {
                fontWeight: 'bold',
                fontSize: 14
            }
        },
        yAxis: [
            {
                type: 'value', name: 'Prezzo MGP (€/kWh)', position: 'left', axisLabel: {formatter: (v) => formatNum(v, 2)}, nameLocation: 'middle',
                nameGap: 40,
                nameTextStyle: {
                    fontWeight: 'bold',
                    fontSize: 14
                }
            },
            {
                type: 'value', name: 'Potenza (kW)', position: 'right', axisLabel: {formatter: (v) => formatNum(v, 1)}, nameLocation: 'middle',
                nameGap: 40,
                nameTextStyle: {
                    fontWeight: 'bold',
                    fontSize: 14
                }
            }
        ],
        series: [
            {
                name: 'Prezzo MGP (€/kWh)',
                type: 'line',
                step: 'end',
                data: prezziEstesi,
                itemStyle: {color: '#dc3545'}
            },
            {
                name: 'Potenza ottimizzata (kW)',
                type: 'line',
                yAxisIndex: 1,
                step: 'end',
                data: padTo(pOptRaw),
                itemStyle: {color: '#28a745'}
            },
            {
                name: 'Potenza baseline (kW)',
                type: 'line',
                yAxisIndex: 1,
                step: 'end',
                data: padTo(pBaseRaw),
                lineStyle: {type: 'dashed'},
                itemStyle: {color: '#17a2b8'}
            }
        ]
    };

    energyChart.setOption(option, true);
    energyChart.resize();
}

// Istante in ore dall'inizio della giornata -> orario "hh:mm"
// (es. 7,5 -> "07:30"; oltre la mezzanotte: 25,5 -> "01:30 +1", come sull'asse del Gantt)
function convertiOrarioHHMM(valore) {
    if (isNaN(valore)) return "00:00";
    const minutiTotali = Math.round(Number(valore) * 60);  // arrotondo prima: mai "07:60"
    const ore = Math.floor(minutiTotali / 60);
    const minuti = minutiTotali % 60;
    const testo = `${String(ore % 24).padStart(2, '0')}:${String(minuti).padStart(2, '0')}`;
    return ore >= 24 ? `${testo} +1` : testo;
}

// Durata in ore -> testo leggibile (es. 0,75 -> "45 min"; 1,5 -> "1 h 30 min")
function durataOre(valore) {
    if (isNaN(valore)) return '-';
    const minutiTotali = Math.round(Number(valore) * 60);
    const ore = Math.floor(minutiTotali / 60);
    const minuti = minutiTotali % 60;
    if (ore === 0) return `${minuti} min`;
    return minuti === 0 ? `${ore} h` : `${ore} h ${minuti} min`;
}

// Scarica un testo come file CSV
// Nome della sessione per i file esportati: "session_AAAAMMGG_HHMMSS"
// (le sessioni salvate con il vecchio nome "sessione_..." vengono adattate)
function idSessione() {
    const id = (sessionData && sessionData.session_id) || 'session';
    return id.replace(/^sessione_/, 'session_');
}

// Nome di un file esportato, senza estensione: <base>_<sessione>
function nomeFile(base) {
    return `${base}_${idSessione()}`;
}

// Ruolo di una soluzione sulla frontiera: cost_obj = costo minimo,
// best_throughput_obj = throughput massimo, '' per le altre
function ruoloSoluzione(sol) {
    const soluzioni = (sessionData && sessionData.soluzioni_valide) || [];
    if (!sol || !soluzioni.length) return '';
    const minCosto = soluzioni.reduce((a, s) => s.costo < a.costo ? s : a);
    const maxTp = soluzioni.reduce((a, s) => s.tp > a.tp ? s : a);
    if (sol.id === minCosto.id) return 'cost_obj';
    if (sol.id === maxTp.id) return 'best_throughput_obj';
    return '';
}

// Prefisso di una soluzione nei nomi dei file: ruolo (se c'è) e id,
// es. "cost_obj_sol_3", "best_throughput_obj_sol_12", "sol_7"
function prefissoSoluzione(sol) {
    if (!sol) return 'sol';
    const ruolo = ruoloSoluzione(sol);
    return ruolo ? `${ruolo}_sol_${sol.id}` : `sol_${sol.id}`;
}

// Esporta in CSV i risultati della validazione dei modelli. Le righe che
// iniziano con "#" riassumono gli indicatori della scheda (in Python:
// pandas.read_csv(..., comment="#") le salta)
function exportAffidabilitaCSV() {
    const v = sessionData ? sessionData.validazione_modelli : null;
    if (!v || !v.tempo_h) return toastr.warning("Nessun dato di validazione in questa simulazione.");
    const xt = v.tempo_h.xgboost, xp = v.potenza_kw.xgboost;
    const righe = [
        `# sorgente_dati: ${sessionData.sorgente_dati || 'simulato'}`,
        `# esempi_allenamento: ${v.n_train}`,
        `# esempi_esame: ${v.n_test}`,
        `# xgboost_vs_lineare_durata: ${(v.tempo_h.regressione_lineare.mae / xt.mae).toFixed(2)}`,
        `# xgboost_vs_lineare_potenza: ${(v.potenza_kw.regressione_lineare.mae / xp.mae).toFixed(2)}`,
        `# differenza_R2_allenamento_esame: ${Math.max((xt.r2_train ?? xt.r2) - xt.r2, (xp.r2_train ?? xp.r2) - xp.r2).toFixed(4)}`,
        "Target,Modello,MAE,MAE_percentuale,R2,R2_allenamento"
    ];
    [["Durata_h", v.tempo_h], ["Potenza_kW", v.potenza_kw]].forEach(([nome, target]) => {
        MODELLI_ORDINE.filter(m => target[m]).forEach(m => {
            const r = target[m];
            righe.push([nome, m, r.mae.toFixed(4), r.mae_pct.toFixed(2), r.r2.toFixed(4), r.r2_train != null ? r.r2_train.toFixed(4) : ''].join(","));
        });
    });
    downloadCSV(righe.join("\n") + "\n", `${nomeFile('models_reliability_data')}.csv`);
}

// Esporta in CSV la curva dell'ipervolume per generazione e gli indicatori
// della scheda di convergenza (righe con "#")
function exportConvergenzaCSV() {
    const c = sessionData ? sessionData.convergenza_nsga2 : null;
    if (!c || !c.disponibile) return toastr.warning("Nessun dato di convergenza in questa simulazione.");
    const righe = [
        `# esito: ${c.convergito ? 'convergenza raggiunta' : 'ancora in crescita'}`,
        `# generazioni: ${c.n_gen}`,
        `# popolazione: ${c.pop_size}`,
        `# miglioramento_ultime_${c.ultime_generazioni}_generazioni_pct: ${Number(c.miglioramento_ultime_pct).toFixed(2)}`,
        `# generazione_95pct: ${c.gen_95}`,
        `# ricerca_casuale_valide: ${c.casuale_ammissibili}/${c.casuale_totale}`,
        `# ricerca_casuale_ipervolume_pct: ${Number(c.casuale_finale_pct).toFixed(1)}`,
        "Generazione,Schedulazioni_provate,Ipervolume_NSGA2_pct,Ipervolume_Ricerca_Casuale_pct"
    ];
    c.n_eval.forEach((n, i) => righe.push([i + 1, n, Number(c.ipervolume_nsga2_pct[i]).toFixed(2), Number(c.ipervolume_casuale_pct[i]).toFixed(2)].join(",")));
    downloadCSV(righe.join("\n") + "\n", `${nomeFile('nsga2_convergence_data')}.csv`);
}

function downloadCSV(csvContent, filename) {
    const blob = new Blob([csvContent], {type: 'text/csv;charset=utf-8;'});
    const link = document.createElement("a");
    const url = URL.createObjectURL(blob);
    link.setAttribute("href", url);
    link.setAttribute("download", filename);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}

// Esporta in CSV le soluzioni della frontiera
function exportParetoCSV() {
    if (!sessionData || !sessionData.soluzioni_valide) return toastr.warning("Nessun dato Pareto da esportare.");
    // Ruolo: cost_obj / best_throughput_obj, come nei nomi degli altri file esportati
    let csv = "ID_Soluzione,Ruolo,Throughput_m2h,Costo_Euro,KWh,Makespan_h\n";
    sessionData.soluzioni_valide.forEach(s => {
        csv += `${s.id},${ruoloSoluzione(s)},${s.tp},${s.costo},${s.kwh},${s.makespan}\n`;
    });
    downloadCSV(csv, `${nomeFile('pareto_data')}.csv`);
}

// Esporta in CSV le fasi della soluzione scelta
function exportGanttCSV() {
    if (!currentSelectedSol || !currentSelectedSol.dettagli) return toastr.warning("Seleziona prima una soluzione.");
    let csv = "Macchina,Lotto,Start_Setup,End_Setup,Start_Lavoro,End_Lavoro,Velocita,Potenza_kW\n";
    currentSelectedSol.dettagli.forEach(d => {
        const m = d.Macchina || d.macchina || '';
        const l = d.Lotto || d.ID_Lotto || d.lotto || '';
        csv += `${m},${l},${d.Start_Setup ?? ''},${d.End_Setup ?? ''},${d.Start_Lavoro ?? d.Start ?? ''},${d.End_Lavoro ?? d.End ?? ''},${d.Velocita ?? ''},${d.Potenza_kW ?? ''}\n`;
    });
    downloadCSV(csv, `${nomeFile(`${prefissoSoluzione(currentSelectedSol)}_gantt_data`)}.csv`);
}

// Esporta in CSV le fasi di baseline e soluzione scelta (scheda "Dati dei
// prodotti schedulati"): una riga per prodotto e macchina, tempi in ore
// dall'inizio della giornata e anche come orario, energia in kWh
function exportDatiCSV() {
    if (!sessionData || !Array.isArray(sessionData.gantt_base)) return toastr.warning("Nessuna simulazione caricata.");
    const intestazione = [
        "Schedulazione", "Prodotto", "Quantita_m2", "Macchina",
        "Inizio_Setup_h", "Inizio_Lavoro_h", "Fine_Lavoro_h",
        "Inizio_Lavoro_ora", "Fine_Lavoro_ora", "Durata_Lavoro_h",
        "Velocita_m2h", "Potenza_kW", "Energia_Lavoro_kWh", "Energia_Macchina_Ferma_kWh"
    ];
    const righe = [intestazione.join(",")];
    const aggiungi = (nome, fasi) => (fasi || []).forEach(d => {
        const durata = d.End_Lavoro - d.Start_Lavoro;
        // Le sessioni meno recenti non hanno il consumo a macchina ferma
        const energiaFerma = (d.Potenza_Ferma_kW != null && d.Inizio_Ferma != null)
            ? d.Potenza_Ferma_kW * (d.Start_Lavoro - d.Inizio_Ferma) : '';
        const n = (v, dec) => (v === '' || v == null) ? '' : Number(v).toFixed(dec);
        righe.push([
            nome, d.Lotto, d.Quantita, d.Macchina,
            n(d.Start_Setup, 4), n(d.Start_Lavoro, 4), n(d.End_Lavoro, 4),
            convertiOrarioHHMM(d.Start_Lavoro), convertiOrarioHHMM(d.End_Lavoro), n(durata, 4),
            n(d.Velocita, 1), n(d.Potenza_kW, 3), n(d.Potenza_kW * durata, 3), n(energiaFerma, 3)
        ].join(","));
    });
    aggiungi("Baseline", sessionData.gantt_base);
    if (currentSelectedSol) aggiungi(`Soluzione ${currentSelectedSol.id}`, currentSelectedSol.dettagli);
    const prefisso = currentSelectedSol ? prefissoSoluzione(currentSelectedSol) : "baseline";
    downloadCSV(righe.join("\n") + "\n", `${nomeFile(`${prefisso}_scheduled_product_data`)}.csv`);
}

// Esporta in CSV il profilo orario di potenza e prezzi
function exportEnergyCSV() {
    if (!currentSelectedSol || !currentSelectedSol.p_grid) return toastr.warning("Seleziona prima una soluzione.");
    let csv = "Ora,Prezzo_MGP_Euro_kWh,Potenza_Ottimizzata_kW,Potenza_Baseline_kW\n";
    const ipex = sessionData.prezzi_ipex_24h || [];
    const pOpt = currentSelectedSol.p_grid || [];
    const pBase = (Array.isArray(sessionData.p_grid_base) ? sessionData.p_grid_base : []).map(v => Number(v) || 0);
    const nOre = Math.max(24, pOpt.length, pBase.length);
    for (let i = 0; i < nOre; i++) {
        const prezzo = ipex.length ? ipex[i % ipex.length] : '';
        csv += `${i}:00,${prezzo},${pOpt[i] ?? ''},${pBase[i] ?? ''}\n`;
    }
    downloadCSV(csv, `${nomeFile(`${prefissoSoluzione(currentSelectedSol)}_energy_profile_data`)}.csv`);
}
