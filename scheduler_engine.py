"""Cuore del DSS: simulatore del flow shop e ottimizzazione con NSGA-II.

Il flusso:
  1. FlowShopSimulator riceve una schedulazione candidata e calcola, con i
     modelli XGBoost, quando inizia e finisce ogni fase, quanta energia
     consuma e quanto costa con i prezzi orari.
  2. FlowShopProblem descrive il problema per pymoo: variabili, due obiettivi
     (costo e throughput) e vincoli (24 h, throughput minimo).
  3. esegui_ottimizzazione lancia NSGA-II, che prova migliaia di
     schedulazioni e restituisce la frontiera di Pareto.

Una schedulazione è un vettore x di numeri, diviso in tre parti:
  - chiavi di sequenza (una per ordine, tra 0 e 1): l'ordine di lavorazione
    si ottiene ordinandole dalla più piccola alla più grande;
  - velocità (una per ordine e per macchina, in m²/h);
  - pause facoltative (0–2 h) prima di ogni ordine dal secondo in poi, su
    ogni macchina: permettono di spostare il lavoro verso ore più economiche.
"""
import time
import numpy as np
from config import MACCHINE, N_MACCHINE, log_debug
from convergence import analizza, ricerca_casuale
from pymoo.algorithms.moo.nsga2 import NSGA2
from pymoo.core.callback import Callback
from pymoo.core.problem import ElementwiseProblem
from pymoo.optimize import minimize

# Orizzonte di pianificazione: vincolo per le soluzioni di NSGA-II. La
# baseline invece può superarlo: il simulatore la calcola comunque, e oltre
# la 24ª ora usa di nuovo i prezzi del giorno, ripetuti.
ORIZZONTE_ORE = 24


def calcola_costo_intervallo(t_start, t_end, potenza, prezzi_ipex):
    """Costo (€) e consumo (kWh) di una lavorazione da t_start a t_end (ore).

    La lavorazione viene spezzata ora per ora: ogni pezzo costa
    potenza × durata del pezzo × prezzo di quell'ora. Oltre le 24 ore i
    prezzi si ripetono.
    """
    if t_start >= t_end:
        return 0.0, 0.0

    costo = 0.0
    durata_totale = t_end - t_start
    kwh = potenza * durata_totale
    n_prezzi = len(prezzi_ipex)

    t_curr = t_start
    while t_curr < t_end:
        ora_curr = int(t_curr) % n_prezzi
        t_next = min(t_end, np.floor(t_curr) + 1.0)
        durata_frazione = t_next - t_curr

        costo += potenza * durata_frazione * prezzi_ipex[ora_curr]
        t_curr = t_next

    return costo, kwh


class FlowShopSimulator:
    """Simula una giornata di produzione per una schedulazione data."""

    def __init__(self, ordini_da_schedulare, ml_predictor, tempo_setup_dict,
                 vel_baseline_dict, prezzi_ipex, potenza_ferma=None):
        # Prezzi orari in €/kWh, letti da config.json a ogni esecuzione
        self.prezzi_ipex = np.asarray(prezzi_ipex, dtype=float)
        # Potenza (kW) di ogni macchina accesa ma ferma: setup, pause, attese
        self.potenza_ferma = potenza_ferma or {}
        self.ordini = ordini_da_schedulare
        self.n_ordini = len(ordini_da_schedulare)
        self.totale_m2 = sum(o["Quantita_m2"] for o in ordini_da_schedulare)
        self.predictor = ml_predictor
        self.tempo_setup_dict = tempo_setup_dict
        self.vel_baseline_dict = vel_baseline_dict

    def ricostruisci_schedulazione(self, x_var):
        """Dal vettore x calcola tempi, consumi e costi della giornata.

        Restituisce: costo (€), consumo (kWh), throughput (m²/h), makespan
        (h), dettaglio delle fasi per il Gantt, griglia oraria e profilo
        orario di potenza.
        """
        # Sequenza: ordini dalla chiave più piccola alla più grande
        seq_indices = np.argsort(x_var[: self.n_ordini])
        ordini_seq = [self.ordini[i] for i in seq_indices]

        # Velocità: matrice (n. ordini × n. macchine)
        idx_vel_end = self.n_ordini + self.n_ordini * N_MACCHINE
        vel_matrix = np.array(
            x_var[self.n_ordini: idx_vel_end]
        ).reshape((self.n_ordini, N_MACCHINE))

        # Pause: matrice ((n. ordini − 1) × n. macchine)
        pause_matrix = np.array(
            x_var[idx_vel_end:]
        ).reshape((self.n_ordini - 1, N_MACCHINE))

        # 1. Durata e potenza di tutte le fasi, con una sola chiamata a XGBoost
        requests_list = []
        for i in range(self.n_ordini):
            p_id = ordini_seq[i]["ID_Prodotto"]
            q_val = ordini_seq[i]["Quantita_m2"]
            for m_idx in range(N_MACCHINE):
                m_id = MACCHINE[m_idx]
                v_val = float(vel_matrix[i, m_idx])
                requests_list.append({
                    "p_id": p_id,
                    "m_id": m_id,
                    "v_val": v_val,
                    "q_val": q_val
                })

        durate, potenze = self.predictor.predict_many(requests_list)

        # 2. Tempi e costi, fase per fase, nell'ordine della sequenza
        completion_times = np.zeros((self.n_ordini, N_MACCHINE))
        costo_totale = 0.0
        kwh_totali = 0.0
        dettagli_gantt = []

        idx_flat = 0
        for i in range(self.n_ordini):
            p_id = ordini_seq[i]["ID_Prodotto"]
            q_val = ordini_seq[i]["Quantita_m2"]

            for m_idx in range(N_MACCHINE):
                m_id = MACCHINE[m_idx]
                v_val = float(vel_matrix[i, m_idx])

                durata_lavoro = float(durate[idx_flat])
                potenza = float(potenze[idx_flat])
                idx_flat += 1

                # Setup tipico della coppia (mezz'ora se non c'è nello storico)
                t_setup = self.tempo_setup_dict.get((p_id, m_id), 0.5)

                # Regola del flow shop: una fase può iniziare solo quando
                #  - l'ordine ha finito sulla macchina precedente, e
                #  - la macchina ha finito l'ordine precedente.
                start_precedenza = (
                    completion_times[i, m_idx - 1] if m_idx > 0 else 0.0
                )
                start_macchina = (
                    completion_times[i - 1, m_idx] if i > 0 else 0.0
                )

                # Pausa facoltativa scelta da NSGA-II per questa macchina
                delay_pausa = float(pause_matrix[i - 1, m_idx]) if i > 0 else 0.0

                # Il setup parte quando entrambe le condizioni sono vere (più
                # l'eventuale pausa); poi segue la lavorazione vera e propria
                start_disponibilita = max(start_precedenza, start_macchina)
                start_setup = start_disponibilita + delay_pausa
                end_setup = start_setup + t_setup
                start_lavoro = end_setup
                end_lavoro = start_lavoro + durata_lavoro
                completion_times[i, m_idx] = end_lavoro

                # Energia della lavorazione
                costo_lavoro, kwh_lavoro = calcola_costo_intervallo(
                    start_lavoro, end_lavoro, potenza, self.prezzi_ipex
                )

                # Energia a macchina ferma ma accesa: dalla fine dell'ordine
                # precedente su questa macchina (o, per il primo ordine,
                # dall'inizio del setup) fino all'inizio della lavorazione.
                # Comprende attesa del pezzo, pausa e setup
                inizio_ferma = start_macchina if i > 0 else start_setup
                p_ferma = float(self.potenza_ferma.get(m_id, 0.0))
                costo_ferma, kwh_ferma = calcola_costo_intervallo(
                    inizio_ferma, start_lavoro, p_ferma, self.prezzi_ipex
                )

                costo_totale += costo_lavoro + costo_ferma
                kwh_totali += kwh_lavoro + kwh_ferma

                dettagli_gantt.append({
                    "Lotto": f"{p_id}",
                    "Quantita": int(q_val),
                    "Macchina": m_id,
                    "Macchina_Idx": m_idx,
                    "Start_Attesa": start_disponibilita,
                    "End_Attesa": start_setup,
                    "Start_Setup": start_setup,
                    "End_Setup": end_setup,
                    "Start_Lavoro": start_lavoro,
                    "End_Lavoro": end_lavoro,
                    "Velocita": v_val,
                    "Potenza_kW": potenza,
                    "Inizio_Ferma": inizio_ferma,
                    "Potenza_Ferma_kW": p_ferma,
                })

        # Makespan: fine dell'ultima fase. Throughput: m² totali prodotti
        # diviso il makespan (ogni ordine passa da tutte e 4 le macchine)
        makespan = np.max(completion_times)
        throughput = self.totale_m2 / makespan

        # Profilo orario di potenza media (per il grafico): copre almeno
        # l'orizzonte e si allunga se il makespan lo supera (di solito solo
        # per la baseline)
        n_ore = max(ORIZZONTE_ORE, int(np.ceil(makespan - 1e-9)))
        time_grid = np.arange(n_ore, dtype=float)
        potenza_profilo = np.zeros(n_ore, dtype=float)

        def aggiungi(start, end, potenza):
            # Ripartisce la potenza dell'intervallo sulle ore che tocca
            for ora in range(int(start), min(n_ore, int(np.ceil(end)))):
                overlap = min(end, ora + 1.0) - max(start, float(ora))
                if overlap > 0:
                    potenza_profilo[ora] += potenza * overlap

        for d in dettagli_gantt:
            aggiungi(d["Start_Lavoro"], d["End_Lavoro"], d["Potenza_kW"])
            aggiungi(d["Inizio_Ferma"], d["Start_Lavoro"], d["Potenza_Ferma_kW"])

        return (
            costo_totale,
            kwh_totali,
            throughput,
            makespan,
            dettagli_gantt,
            time_grid,
            potenza_profilo,
        )


class FlowShopProblem(ElementwiseProblem):
    """Problema di ottimizzazione per pymoo.

    Due obiettivi: costo energetico (da minimizzare) e throughput (da
    massimizzare: pymoo minimizza sempre, quindi si passa con il segno meno).

    Vincoli (una schedulazione è "valida" se li rispetta tutti):
      1. finire entro l'orizzonte di 24 h;
      2. (se tp_min non è None) throughput almeno pari a tp_min, cioè
         alfa × throughput della baseline. Come vincolo, e non come filtro
         finale, fa sì che NSGA-II usi tutta la popolazione nella zona utile
         per l'operatore.

    I vincoli sono espressi in forma relativa (sforamento diviso per il
    limite): così 1 ora di troppo e un 4% di throughput in meno pesano in modo
    paragonabile, anche se hanno unità di misura diverse.
    """

    def __init__(self, simulator, tp_min=None):
        self.simulator = simulator
        self.tp_min = None if tp_min is None else float(tp_min)
        n_ordini = simulator.n_ordini

        # Numero di variabili: chiavi di sequenza + velocità + pause
        # (con 5 ordini e 4 macchine: 5 + 20 + 16 = 41)
        n_vars = n_ordini + (n_ordini * N_MACCHINE) + ((n_ordini - 1) * N_MACCHINE)

        # Limiti inferiori (xl) e superiori (xu) di ogni variabile.
        # Chiavi di sequenza: tra 0 e 1
        xl_seq = [0.0] * n_ordini
        xu_seq = [1.0] * n_ordini

        # Velocità: ±30% attorno alla velocità della baseline, sempre entro
        # i limiti fisici delle macchine (500–10.000 m²/h)
        xl_vel = []
        xu_vel = []
        for ordine in simulator.ordini:
            p_id = ordine["ID_Prodotto"]
            for m_id in MACCHINE:
                v_base = simulator.vel_baseline_dict.get((p_id, m_id), 5000.0)
                v_min = max(500.0, v_base * 0.7)
                v_max = min(10000.0, v_base * 1.3)
                xl_vel.append(v_min)
                xu_vel.append(v_max)

        # Pause: da 0 a 2 ore, prima di ogni ordine (dal secondo) su ogni macchina
        xl_pause = [0.0] * ((n_ordini - 1) * N_MACCHINE)
        xu_pause = [2.0] * ((n_ordini - 1) * N_MACCHINE)

        xl = np.array(xl_seq + xl_vel + xl_pause)
        xu = np.array(xu_seq + xu_vel + xu_pause)

        n_vincoli = 1 if self.tp_min is None else 2
        super().__init__(
            n_var=n_vars, n_obj=2, n_ieq_constr=n_vincoli, xl=xl, xu=xu
        )

    def vincoli(self, tp, makespan):
        """Valori dei vincoli: <= 0 significa rispettato, > 0 violato."""
        g = [(makespan - ORIZZONTE_ORE) / ORIZZONTE_ORE]
        if self.tp_min is not None:
            g.append((self.tp_min - tp) / self.tp_min)
        return g

    def _evaluate(self, x, out, *args, **kwargs):
        """Chiamata da pymoo per ogni schedulazione: obiettivi e vincoli."""
        costo, _, tp, makespan, _, _, _ = (
            self.simulator.ricostruisci_schedulazione(x)
        )
        out["F"] = [costo, -tp]
        out["G"] = self.vincoli(tp, makespan)


def prepara_x_iniziale(problem, x_base):
    """Adatta la baseline al formato delle variabili di NSGA-II.

    Nella baseline la sequenza è scritta come 0, 1, 2, ... ; NSGA-II usa
    invece chiavi tra 0 e 1 (conta solo il loro ordine). Le converto in
    (i + 0,5) / n, che dà lo stesso ordine, e riporto tutto nei limiti.
    """
    x = np.array(x_base, dtype=float)
    n = problem.simulator.n_ordini
    x[:n] = (np.argsort(np.argsort(x[:n])) + 0.5) / n
    return np.clip(x, problem.xl, problem.xu)


class RegistraConvergenza(Callback):
    """Annota, a ogni generazione di NSGA-II, le soluzioni valide trovate.

    pymoo chiama `notify` alla fine di ogni generazione. Teniamo solo le
    soluzioni che rispettano tutti i vincoli (violazione <= 0), con i
    loro due obiettivi [costo, -throughput] e il numero di schedulazioni
    valutate finora. Serve poi a tracciare la curva dell'ipervolume.
    """

    def __init__(self):
        super().__init__()
        self.data["generazioni"] = []

    def notify(self, algorithm):
        F = np.asarray(algorithm.pop.get("F"), dtype=float)
        violazione = np.asarray(algorithm.pop.get("CV"), dtype=float)
        valide = violazione.reshape(len(F), -1).max(axis=1) <= 0
        self.data["generazioni"].append({
            "n_eval": int(algorithm.evaluator.n_eval),
            "F": F[valide].copy(),
        })


def esegui_ottimizzazione(simulator, pop_size=35, n_gen=30, seed=None,
                          registro_convergenza=None, tp_min=None,
                          x_iniziale=None):
    """Esegue NSGA-II e restituisce le soluzioni che rispettano i vincoli.

    tp_min: throughput minimo richiesto (alfa × baseline). Se None, l'unico
        vincolo è l'orizzonte di 24 h.
    x_iniziale: una schedulazione da inserire nella popolazione di partenza
        (la baseline). Il resto della popolazione iniziale resta casuale.
        Garantisce che NSGA-II parta da almeno una soluzione valida, se la
        baseline lo è: utile perché il vincolo sul throughput è severo.
    registro_convergenza: se si passa un dizionario vuoto, viene riempito con
        i dati generazione per generazione (vedi `analizza_convergenza`). Non
        cambia il risultato dell'ottimizzazione.
    """
    log_debug(
        f"Avvio ottimizzazione NSGA-II (Pop: {pop_size}, Gen: {n_gen},"
        f" Seed: {seed}, TP minimo: {tp_min})..."
    )

    start_time = time.time()

    problem = FlowShopProblem(simulator, tp_min=tp_min)

    # Popolazione iniziale: casuale nei limiti, con la baseline al primo posto
    x0 = None
    if x_iniziale is not None:
        x0 = prepara_x_iniziale(problem, x_iniziale)
        rng = np.random.default_rng(seed)
        campione = rng.uniform(problem.xl, problem.xu, size=(pop_size, problem.n_var))
        campione[0] = x0
        algorithm = NSGA2(pop_size=pop_size, sampling=campione)
    else:
        algorithm = NSGA2(pop_size=pop_size)
    callback = RegistraConvergenza() if registro_convergenza is not None else None

    # NSGA-II, a ogni generazione: crea nuove schedulazioni combinando e
    # modificando le migliori (incrocio e mutazione), poi tiene le migliori
    # secondo il rango di Pareto e la distanza di affollamento, che mantiene
    # le soluzioni ben distribuite lungo la frontiera
    res = minimize(
        problem, algorithm, ("n_gen", n_gen), seed=seed, verbose=False,
        callback=callback,
    )

    if registro_convergenza is not None:
        # pymoo lavora su una copia dell'algoritmo: il callback con i dati
        # registrati è quello salvato dentro res.algorithm
        cb_usato = res.algorithm.callback or callback
        registro_convergenza["generazioni"] = cb_usato.data["generazioni"]
        registro_convergenza["pop_size"] = pop_size
        registro_convergenza["n_gen"] = n_gen
        # Servono alla ricerca casuale per giocare alle stesse regole
        registro_convergenza["tp_min"] = tp_min
        registro_convergenza["x_iniziale"] = x0

    elapsed_time = time.time() - start_time

    soluzioni = []

    if res.X is None:
        log_debug(
            f"Nessuna soluzione valida trovata entro i vincoli (Tempo"
            f" impiegato: {elapsed_time:.2f}s)."
        )
        return soluzioni

    # res.X contiene le schedulazioni della frontiera di Pareto finale: le
    # ricalcolo per avere tutti i dettagli (Gantt, profilo di potenza)
    x_matrix = res.X if res.X.ndim == 2 else [res.X]

    for idx, x_var in enumerate(x_matrix):
        c, k, tp, m, det, tg, pg = simulator.ricostruisci_schedulazione(x_var)
        if max(problem.vincoli(tp, m)) <= 1e-9:
            soluzioni.append({
                "id": idx,
                "costo": c,
                "kwh": k,
                "tp": tp,
                "makespan": m,
                "dettagli": det,
                "p_grid": pg,
            })

    log_debug(
        f"NSGA-II completato in {elapsed_time:.2f}s: generate {len(soluzioni)}"
        " soluzioni che rispettano i vincoli."
    )
    return soluzioni


def analizza_convergenza(simulator, registro_convergenza, seed=None):
    """Valuta se NSGA-II ha raggiunto la convergenza e lo confronta con una ricerca casuale.

    La ricerca casuale prova lo stesso numero di schedulazioni di NSGA-II
    (pescate a caso nei limiti ammessi) e serve da controllo: se NSGA-II non
    fa meglio del caso, l'algoritmo non sta servendo. I calcoli sono in
    `convergence.py`. Costa circa quanto una seconda ottimizzazione: si può
    disattivare con `analisi_convergenza: false` in config.json.
    """
    generazioni = registro_convergenza.get("generazioni", [])
    if not generazioni:
        return {"disponibile": False, "motivo": "Nessuna generazione registrata."}

    # Stessi vincoli di NSGA-II, così il confronto è alla pari
    tp_min = registro_convergenza.get("tp_min")
    problem = FlowShopProblem(simulator, tp_min=tp_min)

    def valuta(x):
        costo, _, tp, makespan, _, _, _ = simulator.ricostruisci_schedulazione(x)
        return [costo, -tp], max(problem.vincoli(tp, makespan))

    n_valutazioni = generazioni[-1]["n_eval"]
    rng = np.random.default_rng(None if seed is None else int(seed) + 1)
    # Anche la ricerca casuale riceve la baseline come primo tentativo,
    # come NSGA-II nella popolazione iniziale.
    F_caso, indici_caso = ricerca_casuale(
        valuta, problem.xl, problem.xu, n_valutazioni, rng,
        x_iniziale=registro_convergenza.get("x_iniziale"),
    )

    testo_vincoli = (
        "il vincolo delle 24 h" if tp_min is None
        else "i vincoli (24 h e throughput minimo)"
    )
    risultato = analizza(
        generazioni, F_caso, indici_caso,
        pop_size=registro_convergenza.get("pop_size"),
        n_gen=registro_convergenza.get("n_gen"),
        testo_vincoli=testo_vincoli,
    )
    log_debug(
        "Convergenza NSGA-II: "
        + (" | ".join(risultato["spiegazione"][1:3]) if risultato["disponibile"]
           else risultato["motivo"])
    )
    return risultato
