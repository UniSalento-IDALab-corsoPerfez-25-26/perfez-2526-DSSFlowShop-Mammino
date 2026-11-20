"""Analisi della convergenza di NSGA-II e confronto con una ricerca casuale.

Domanda a cui risponde: "NSGA-II ha smesso di migliorare, o servono più
generazioni? E fa davvero meglio di una ricerca a caso?"

Come funziona:
  1. Durante l'ottimizzazione registriamo, a ogni generazione, le soluzioni
     valide (quelle che rispettano i vincoli: entro le 24 h e, se attivo,
     throughput minimo) con costo e throughput.
  2. Per ogni generazione calcoliamo l'ipervolume: un numero che misura
     quanta "area" copre la frontiera di Pareto. Più è alto, migliore e più
     ampia è la frontiera. Se la curva dell'ipervolume si appiattisce,
     l'algoritmo ha smesso di migliorare (convergenza raggiunta).
  3. Come controllo, facciamo una ricerca casuale con lo stesso numero di
     schedulazioni valutate: pesca soluzioni a caso e tiene le migliori.
     Se NSGA-II non batte il caso, l'algoritmo non sta servendo a nulla.

Questo modulo contiene solo i calcoli (usa solo numpy), quindi non dipende
da pymoo né dal tipo di dati (simulati o reali).

Convenzione: ogni soluzione è un punto F = [costo, -throughput]. Entrambi gli
obiettivi vanno minimizzati (il throughput ha il segno meno perché lo
vogliamo alto).
"""
import numpy as np

# Punto di riferimento dell'ipervolume, dopo aver riportato i due obiettivi
# tra 0 (migliore trovato) e 1 (peggiore trovato). Sta un po' oltre il
# peggiore (1,1) in modo che anche le soluzioni peggiori contino qualcosa.
RIFERIMENTO = np.array([1.1, 1.1])

# Quante generazioni finali guardare per decidere se la curva è piatta, e
# quanto deve migliorare (in %) per dire che sta ancora salendo.
ULTIME_GENERAZIONI = 5
SOGLIA_MIGLIORAMENTO_PCT = 1.0


def frontiera_non_dominata(F):
    """Tiene solo le soluzioni "non dominate".

    Una soluzione è dominata se ne esiste un'altra migliore o uguale su
    entrambi gli obiettivi (e diversa). Le non dominate formano la frontiera
    di Pareto. Con due obiettivi basta ordinare per il primo e tenere i
    punti in cui il secondo scende. Restituisce i punti ordinati per il
    primo obiettivo crescente.
    """
    F = np.asarray(F, dtype=float).reshape(-1, 2)
    if len(F) == 0:
        return F
    ordine = np.lexsort((F[:, 1], F[:, 0]))  # prima per f1, poi per f2
    fronte = []
    miglior_f2 = np.inf
    for f1, f2 in F[ordine]:
        if f2 < miglior_f2:
            fronte.append((f1, f2))
            miglior_f2 = f2
    return np.array(fronte)


def ipervolume_2d(F, riferimento=RIFERIMENTO):
    """Ipervolume (in 2 obiettivi: un'area) coperto dai punti F.

    È l'area compresa tra la frontiera e il punto di riferimento. Si somma
    a "strisce": per ogni punto della frontiera, la striscia di area che
    solo lui aggiunge rispetto al punto precedente.
    """
    fronte = frontiera_non_dominata(F)
    if len(fronte) == 0:
        return 0.0
    ref = np.asarray(riferimento, dtype=float)
    fronte = fronte[(fronte[:, 0] < ref[0]) & (fronte[:, 1] < ref[1])]
    area = 0.0
    f2_precedente = ref[1]
    for f1, f2 in fronte:  # f1 crescente, f2 decrescente
        area += (ref[0] - f1) * (f2_precedente - f2)
        f2_precedente = f2
    return float(area)


def normalizza(F, ideale, peggiore):
    """Riporta gli obiettivi tra 0 (ideale) e 1 (peggiore), colonna per colonna."""
    F = np.asarray(F, dtype=float).reshape(-1, 2)
    scala = np.where(peggiore - ideale > 0, peggiore - ideale, 1.0)
    return (F - ideale) / scala


def ricerca_casuale(valuta, xl, xu, n_valutazioni, rng, x_iniziale=None):
    """Ricerca casuale: pesca soluzioni a caso nei limiti ammessi.

    valuta(x) deve restituire ([costo, -throughput], violazione), dove
    violazione <= 0 significa "rispetta tutti i vincoli".

    x_iniziale: se indicato, è il primo tentativo (la baseline), come nella
    popolazione iniziale di NSGA-II; tutti gli altri sono casuali.

    Restituisce i punti validi trovati e, per ciascuno, a quale tentativo
    (0, 1, 2, ...) è stato trovato: serve a ricostruire la curva nel tempo.
    """
    xl = np.asarray(xl, dtype=float)
    xu = np.asarray(xu, dtype=float)
    punti, indici = [], []
    for i in range(int(n_valutazioni)):
        if i == 0 and x_iniziale is not None:
            x = np.asarray(x_iniziale, dtype=float)
        else:
            x = rng.uniform(xl, xu)
        F, violazione = valuta(x)
        if violazione <= 0:
            punti.append(F)
            indici.append(i)
    return np.array(punti, dtype=float).reshape(-1, 2), np.array(indici, dtype=int)


def _fmt(v, decimali=1):
    """Numero in formato italiano (virgola decimale) per i testi."""
    return f"{v:.{decimali}f}".replace(".", ",")


def analizza(generazioni, F_casuale, indici_casuale, pop_size=None, n_gen=None,
             testo_vincoli="il vincolo delle 24 h"):
    """Costruisce il risultato dell'analisi (dizionario serializzabile in JSON).

    generazioni    : lista di {"n_eval": int, "F": array (n x 2)} con le sole
                     soluzioni valide di ogni generazione di NSGA-II.
    F_casuale      : punti validi della ricerca casuale.
    indici_casuale : tentativo in cui è stato trovato ciascun punto casuale.
    """
    if not generazioni:
        return {"disponibile": False,
                "motivo": "Nessuna generazione registrata."}

    n_eval = [int(g["n_eval"]) for g in generazioni]
    F_gen = [np.asarray(g["F"], dtype=float).reshape(-1, 2) for g in generazioni]
    F_casuale = np.asarray(F_casuale, dtype=float).reshape(-1, 2)
    indici_casuale = np.asarray(indici_casuale, dtype=int)

    # Scala comune: 0 = miglior valore visto, 1 = peggiore visto (su tutte le
    # soluzioni valide di NSGA-II e della ricerca casuale). Così le due curve
    # sono confrontabili.
    tutti = np.vstack([F for F in F_gen + [F_casuale] if len(F)] or [np.empty((0, 2))])
    if len(tutti) == 0:
        return {"disponibile": False,
                "motivo": f"Nessuna soluzione rispetta {testo_vincoli}."}
    ideale, peggiore = tutti.min(axis=0), tutti.max(axis=0)

    hv_nsga = [ipervolume_2d(normalizza(F, ideale, peggiore)) if len(F) else 0.0
               for F in F_gen]
    hv_caso = []
    for n in n_eval:
        F = F_casuale[indici_casuale < n]
        hv_caso.append(ipervolume_2d(normalizza(F, ideale, peggiore)) if len(F) else 0.0)

    hv_finale = hv_nsga[-1]
    if hv_finale <= 0:
        return {"disponibile": False,
                "motivo": "L'ultima generazione non ha soluzioni valide."}

    # Tutto in % dell'ipervolume finale di NSGA-II (100% = risultato finale).
    pct_nsga = [100.0 * h / hv_finale for h in hv_nsga]
    pct_caso = [100.0 * h / hv_finale for h in hv_caso]

    # Prima generazione (1, 2, 3, ...) che raggiunge il 95% del risultato finale
    gen_95 = next(i + 1 for i, p in enumerate(pct_nsga) if p >= 95.0)

    # Quanto è migliorato nelle ultime generazioni (in % del valore finale)
    k = min(ULTIME_GENERAZIONI, len(pct_nsga) - 1)
    miglioramento = (pct_nsga[-1] - pct_nsga[-1 - k]) if k > 0 else 0.0
    convergenza_raggiunta = miglioramento < SOGLIA_MIGLIORAMENTO_PCT

    n_tot_caso = int(n_eval[-1])
    n_ok_caso = int(len(F_casuale))
    caso_finale = pct_caso[-1]
    n_gen = n_gen or len(generazioni)

    spiegazione = [
        f"NSGA-II ha provato {n_eval[-1]} schedulazioni in {n_gen} generazioni"
        + (f" (popolazione di {pop_size})." if pop_size else ".")
        + " L'ipervolume misura quanta area copre la frontiera di Pareto: "
          "più è alto, migliore e più ampia è la frontiera trovata.",
    ]
    if convergenza_raggiunta:
        spiegazione.append(
            f"La curva si è appiattita: nelle ultime {k} generazioni l'ipervolume "
            f"è migliorato solo dello {_fmt(miglioramento, 2)}%. L'algoritmo ha "
            f"praticamente finito di migliorare, quindi {n_gen} generazioni bastano."
        )
    else:
        spiegazione.append(
            f"La curva sta ancora salendo: +{_fmt(miglioramento)}% nelle ultime {k} "
            f"generazioni. Conviene aumentare il numero di generazioni "
            f"(chiave nsga2_n_gen in config.json) e rifare la prova."
        )
    spiegazione.append(
        f"Il 95% del risultato finale è stato raggiunto alla generazione {gen_95} "
        f"di {n_gen}."
    )
    if n_ok_caso == 0:
        spiegazione.append(
            f"Controllo con la ricerca casuale: su {n_tot_caso} schedulazioni "
            f"pescate a caso, nessuna rispetta {testo_vincoli}. NSGA-II "
            "trova soluzioni valide dove il caso non ne trova."
        )
    else:
        spiegazione.append(
            f"Controllo con la ricerca casuale (stesso numero di schedulazioni): "
            f"solo {n_ok_caso} su {n_tot_caso} ({_fmt(100.0 * n_ok_caso / n_tot_caso, 0)}%) "
            f"rispettano {testo_vincoli} e l'ipervolume raggiunge il {_fmt(caso_finale, 0)}% "
            "di quello di NSGA-II."
        )
        if caso_finale >= 100.0:
            spiegazione.append(
                "Attenzione: la ricerca casuale fa almeno quanto NSGA-II. "
                "I parametri dell'algoritmo andrebbero rivisti."
            )

    return {
        "disponibile": True,
        "pop_size": pop_size,
        "n_gen": int(n_gen),
        "n_valutazioni": n_tot_caso,
        "n_eval": n_eval,
        "ipervolume_nsga2_pct": [float(p) for p in pct_nsga],
        "ipervolume_casuale_pct": [float(p) for p in pct_caso],
        "ipervolume_nsga2": [float(h) for h in hv_nsga],
        "ipervolume_casuale": [float(h) for h in hv_caso],
        "gen_95": int(gen_95),
        "ultime_generazioni": int(k),
        "miglioramento_ultime_pct": float(miglioramento),
        # Il campo si chiama "convergito" per compatibilità con le sessioni salvate
        "convergito": bool(convergenza_raggiunta),
        "casuale_ammissibili": n_ok_caso,
        "casuale_totale": n_tot_caso,
        "casuale_finale_pct": float(caso_finale),
        "spiegazione": spiegazione,
    }
