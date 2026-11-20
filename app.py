"""Server web del DSS (FastAPI): dashboard e API.

Avvio: python app.py, poi aprire http://127.0.0.1:8000 nel browser.

Indirizzi principali:
  - /                         dashboard (static/index.html)
  - /static/config.html       pagina di configurazione
  - /api/run-optimization     esegue un'ottimizzazione completa e la salva
  - /api/sessions             elenco, caricamento ed eliminazione delle sessioni
  - /api/config               lettura e scrittura di config.json
  - /api/prezzi-energia       prezzi reali del giorno da Energy-Charts
"""
import copy
import json
import os
import time
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
import numpy as np

from config import CONFIG_PATH, DEBUG, MACCHINE, PARETO_SAVE_DIR, load_config
from data_generator import DataGenerator
from ml_models import XGBoostPredictor
from energy_price import ZONA_PREDEFINITA, ErrorePrezzi, prezzi_del_giorno
from scheduler_engine import (
    ORIZZONTE_ORE,
    FlowShopSimulator,
    analizza_convergenza,
    esegui_ottimizzazione,
)
from storage_manager import NpEncoder, StorageManager
from model_validation import stampa_report, valida_modelli

app = FastAPI(title="DSS FlowShop Optimizer API")

# Accesso consentito da qualunque origine: accettabile solo perché il DSS
# gira in locale (limite dichiarato nella relazione)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

os.makedirs("static", exist_ok=True)
app.mount("/static", StaticFiles(directory="static"), name="static")


def sanitize_numpy(obj):
    """Converte numeri e array numpy in tipi Python, per poterli inviare in
    JSON (stessa conversione usata per salvare le sessioni)."""
    return json.loads(json.dumps(obj, cls=NpEncoder))


@app.get("/", response_class=HTMLResponse)
def read_root():
    """Dashboard."""
    return FileResponse("static/index.html")


@app.get("/api/sessions")
def get_sessions():
    """Elenco delle sessioni salvate."""
    sessioni = StorageManager.elenca_sessioni()
    return JSONResponse(content=sessioni)


@app.get("/api/sessions/{filename}")
def load_session(filename: str):
    """Contenuto di una sessione salvata."""
    data = StorageManager.carica_sessione(filename)
    if not data:
        raise HTTPException(status_code=404, detail="Sessione non trovata.")
    return JSONResponse(content=data)


@app.get("/api/config")
def get_config():
    """Configurazione attuale (config.json)."""
    return JSONResponse(content=load_config())


@app.put("/api/config")
def update_config(payload: dict):
    """Sovrascrive config.json. Nessuna validazione dei valori: limite
    accettato perché il DSS è un prototipo per uso locale."""
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="Payload non valido.")

    with open(CONFIG_PATH, "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2, ensure_ascii=False)

    return JSONResponse(content={"status": "ok"})


@app.get("/api/prezzi-energia")
def get_prezzi_energia(data: str, zona: str = ZONA_PREDEFINITA):
    """Prezzi reali del mercato del giorno prima (Energy-Charts) per una data.

    Non modifica config.json: restituisce i 24 prezzi orari in €/kWh, che la
    pagina di configurazione inserisce nel modulo. Si salvano con "Salva".
    Se la data non è ancora pubblicata, restituisce una stima basata
    sull'ultimo giorno disponibile (campo "stima").
    """
    try:
        return JSONResponse(content=prezzi_del_giorno(data, zona))
    except ErrorePrezzi as exc:
        raise HTTPException(status_code=502, detail=str(exc))


@app.get("/api/run-optimization")
def run_optimization():
    """Esegue un'ottimizzazione completa e la salva come nuova sessione.

    Passi:
      1. legge la configurazione e fissa il seed;
      2. genera lo storico e gli ordini del giorno;
      3. allena i modelli XGBoost e li valida;
      4. calcola la potenza a macchina ferma e la baseline (velocità medie
         storiche, nessuna pausa);
      5. esegue NSGA-II con il vincolo di throughput minimo (alfa);
      6. controlla la convergenza e confronta con la ricerca casuale;
      7. salva tutto nella sessione (compresa una copia della configurazione
         usata) e lo restituisce alla dashboard.
    """
    # 1. Configurazione, riletta a ogni esecuzione
    cfg = load_config()
    ml_cfg = cfg["ml_config"]
    alfa_input = ml_cfg["alfa_input"]
    prezzi_ipex_24h = np.array(cfg["prezzi_ipex_24h"])

    # Parametri facoltativi (se mancano in config.json valgono i default):
    #   sorgente_dati        "simulato" o "reale": dice alla dashboard come
    #                        presentare la validazione dei modelli
    #   nsga2_pop_size       dimensione della popolazione di NSGA-II
    #   nsga2_n_gen          numero di generazioni di NSGA-II
    #   analisi_convergenza  false per saltare il controllo di convergenza
    #                        (che raddoppia circa il tempo di calcolo)
    sorgente_dati = cfg.get("sorgente_dati", "simulato")
    pop_size = int(ml_cfg.get("nsga2_pop_size", 35))
    n_gen = int(ml_cfg.get("nsga2_n_gen", 30))
    fai_analisi_convergenza = bool(ml_cfg.get("analisi_convergenza", True))
    #   potenza_ferma_frazione  potenza di una macchina accesa ma ferma (setup,
    #                        pause, attese) come frazione della sua potenza
    #                        media in lavorazione (default 0,30)
    frazione_ferma = float(cfg.get("potenza_ferma_frazione", 0.30))

    # Seed: se in config è vuoto ne viene estratto uno a caso, salvato
    # comunque nella sessione per poter ripetere lo stesso calcolo
    seed = ml_cfg.get("NP_SEED")
    if seed is None:
        seed = int.from_bytes(os.urandom(4), "little")
    seed = int(seed)

    # Copia della configurazione usata, salvata nella sessione: permette di
    # sapere (e rifare) esattamente il calcolo anche dopo aver cambiato
    # config.json. Il seed è quello effettivo, anche se in config era vuoto
    config_usata = copy.deepcopy(cfg)
    config_usata.setdefault("ml_config", {})["NP_SEED"] = seed

    # 2. Storico, ordini del giorno, setup e velocità tipiche
    gen = DataGenerator(seed=seed)
    df_hist = gen.genera_storico_globale()
    prods_24h, ordini_24h = gen.estrai_ordini_giornalieri(df_hist)

    tempo_setup_dict = gen.calcola_tempi_setup_trimmed(df_hist, prods_24h)
    vel_baseline_dict = gen.calcola_velocita_baseline_prodotto(
        df_hist, prods_24h
    )
    potenza_ferma = gen.calcola_potenza_ferma(df_hist, frazione_ferma)

    # 3. Addestramento dei due modelli XGBoost (durata e potenza), cronometrato
    predictor = XGBoostPredictor()
    t_inizio = time.perf_counter()
    predictor.train_on_demand(df_hist, prods_24h)
    tempo_training_s = time.perf_counter() - t_inizio

    # Validazione: quanto sbagliano i modelli su dati mai visti. Non influisce
    # sull'ottimizzazione, serve a dire quanto fidarsi delle previsioni
    validazione_ml = valida_modelli(df_hist, prods_24h, seed=seed)
    if DEBUG:
        stampa_report(validazione_ml)

    simulator = FlowShopSimulator(
        ordini_24h,
        predictor,
        tempo_setup_dict,
        vel_baseline_dict,
        prezzi_ipex=prezzi_ipex_24h,
        potenza_ferma=potenza_ferma,
    )

    # 4. Baseline: ordini nell'ordine di arrivo, velocità medie storiche,
    # nessuna pausa. È "come si lavorerebbe senza il DSS"
    velocita_base_list = []
    for ordine in ordini_24h:
        p_id = ordine["ID_Prodotto"]
        for m_id in MACCHINE:
            velocita_base_list.append(
                vel_baseline_dict.get((p_id, m_id), 5000.0)
            )

    num_pause_totali = (len(ordini_24h) - 1) * len(MACCHINE)
    x_base = (
        list(range(len(ordini_24h)))
        + velocita_base_list
        + [0.0] * num_pause_totali
    )

    costo_b, kwh_b, tp_b, m_b, gantt_b, _, pg_b = (
        simulator.ricostruisci_schedulazione(x_base)
    )

    # 5. Ottimizzazione. La soglia alfa (throughput minimo accettato
    # dall'operatore) è un vincolo di NSGA-II: ogni soluzione proposta la
    # rispetta. La baseline entra nella popolazione iniziale
    soglia_tp = tp_b * alfa_input

    # Il registro si riempie, generazione per generazione, durante NSGA-II
    registro_convergenza = {}
    t_inizio = time.perf_counter()
    soluzioni = esegui_ottimizzazione(
        simulator, pop_size=pop_size, n_gen=n_gen, seed=seed,
        registro_convergenza=registro_convergenza,
        tp_min=soglia_tp, x_iniziale=x_base,
    )
    tempo_nsga2_s = time.perf_counter() - t_inizio
    if not soluzioni:
        # Nessuna soluzione valida: lo si dice chiaramente, con i possibili rimedi
        raise HTTPException(
            status_code=400,
            detail=(
                "Nessuna schedulazione finisce entro "
                f"{ORIZZONTE_ORE} h con un throughput di almeno il "
                f"{alfa_input * 100:.0f}% della baseline. "
                + ("La baseline stessa supera le "
                   f"{ORIZZONTE_ORE} h ({m_b:.1f} h): ridurre le quantità "
                   "degli ordini. " if m_b > ORIZZONTE_ORE else "")
                + "Provare ad abbassare alfa o ad aumentare le generazioni."
            ),
        )

    # 6. Controllo di convergenza e confronto con la ricerca casuale. Non
    # cambia le soluzioni: dice se i parametri di NSGA-II bastano
    convergenza_nsga2 = None
    if fai_analisi_convergenza:
        convergenza_nsga2 = analizza_convergenza(
            simulator, registro_convergenza, seed=seed
        )

    # 7. Risultato: salvato come sessione e restituito alla dashboard
    data_ctx = {
        "alfa_input": float(alfa_input),
        "max_tp_assoluto": float(tp_b),
        "soglia_tp": float(soglia_tp),
        "costo_base": float(costo_b),
        "kwh_base": float(kwh_b),
        "makespan_base": float(m_b),
        "seed": seed,
        "orizzonte_ore": ORIZZONTE_ORE,
        "gantt_base": gantt_b,
        "p_grid_base": pg_b,  # profilo orario di potenza della baseline
        "prezzi_ipex_24h": prezzi_ipex_24h,
        # Potenza a macchina ferma (kW per macchina) e frazione usata
        "potenza_ferma_kw": potenza_ferma,
        "potenza_ferma_frazione": frazione_ferma,
        # Da dove vengono i prezzi (assente = inseriti a mano)
        "fonte_prezzi": cfg.get("fonte_prezzi"),
        "soluzioni_valide": soluzioni,
        "sorgente_dati": sorgente_dati,
        # Configurazione completa usata per questo calcolo (vedi sopra)
        "config_usata": config_usata,
        "validazione_modelli": validazione_ml,
        "convergenza_nsga2": convergenza_nsga2,
        # Tempi di calcolo in secondi, mostrati sopra il grafico di Pareto.
        # Non comprendono validazione e controllo di convergenza
        "tempi_calcolo": {
            "training_xgboost_s": float(tempo_training_s),
            "nsga2_s": float(tempo_nsga2_s),
            "nsga2_pop_size": pop_size,
            "nsga2_n_gen": n_gen,
        },
    }

    StorageManager.salva_sessione(data_ctx)
    return JSONResponse(content=sanitize_numpy(data_ctx))


@app.delete("/api/sessions/{filename}")
def delete_session(filename: str):
    """Elimina una sessione salvata."""
    filepath = os.path.join(PARETO_SAVE_DIR, filename)
    if os.path.exists(filepath):
        os.remove(filepath)
        return {"status": "ok", "message": "File eliminato"}
    raise HTTPException(status_code=404, detail="File non trovato")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("app:app", host="127.0.0.1", port=8000, reload=True)
