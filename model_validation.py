"""Validazione dei modelli di previsione (durata e potenza).

Domanda a cui risponde: "se il modello vede una lavorazione nuova, mai vista
in addestramento, quanto sbaglia?"

Come funziona:
  1. Lo storico viene diviso a caso in due parti: l'80% per allenare i
     modelli, il 20% (il "test") tenuto da parte e usato solo alla fine,
     come un esame.
  2. Si allenano XGBoost e, per confronto, due modelli molto più semplici.
  3. Si misura l'errore sul 20% mai visto con tre numeri:
       - MAE : errore medio assoluto, nella stessa unità del dato
               (ore per la durata, kW per la potenza). Più basso = meglio.
       - R²  : quanta parte della variabilità dei dati il modello spiega.
               1,00 = perfetto; 0 = inutile quanto prevedere sempre la media.
       - MAE%: il MAE espresso in % del valore medio, per capire se l'errore
               è piccolo o grande rispetto alla grandezza che si prevede.

Si può lanciare da solo (`python model_validation.py`) oppure viene chiamato
da app.py a ogni ottimizzazione, e il risultato finisce nella sessione salvata.

Nota sui dati: con i dati simulati il risultato è "circolare" (i dati sono
prodotti da formule note e il modello le reimpara), quindi un R² altissimo
non dimostra nulla sul mondo reale. Con dati reali questo stesso modulo
funziona senza modifiche: basta fornire un DataFrame con le stesse colonne.
"""
import numpy as np
from sklearn.dummy import DummyRegressor
from sklearn.linear_model import LinearRegression
from sklearn.metrics import mean_absolute_error, r2_score
from sklearn.model_selection import train_test_split

from config import log_debug
from ml_models import crea_modello_xgb, prepara_dataset

NOME_XGB = "xgboost"
NOME_LINEARE = "regressione_lineare"
NOME_MEDIA = "sempre_la_media"
NOME_FORMULA = "formula_q_su_v"


def _metriche(y_vero, y_pred):
    """Calcola MAE, R² e MAE% tra valori veri e previsti."""
    mae = float(mean_absolute_error(y_vero, y_pred))
    media = float(np.mean(y_vero))
    return {
        "mae": mae,
        "r2": float(r2_score(y_vero, y_pred)),
        "mae_pct": (mae / media * 100.0) if media else float("nan"),
    }


def valida_modelli(
    df_hist_global,
    prodotti_giornalieri,
    test_size=0.2,
    seed=None,
    modello_factory=crea_modello_xgb,
):
    """Valida i modelli di durata e potenza con uno split train/test.

    Parametri
    ---------
    df_hist_global : storico (simulato o, in futuro, reale).
    prodotti_giornalieri : i prodotti su cui il modello viene allenato.
    test_size : frazione di dati tenuta da parte per l'esame (default 20%).
    seed : rende lo split riproducibile (None = 42).
    modello_factory : funzione che crea il modello da valutare. Di default è
        lo stesso XGBoost usato dallo scheduler.

    Restituisce un dizionario serializzabile in JSON.
    """
    X, y_tempo, y_potenza = prepara_dataset(df_hist_global, prodotti_giornalieri)
    split_seed = 42 if seed is None else int(seed)

    # Un solo split per entrambi i target, così sono valutati sugli stessi esempi.
    idx_train, idx_test = train_test_split(
        np.arange(len(X)), test_size=test_size, random_state=split_seed
    )
    X_train, X_test = X.iloc[idx_train], X.iloc[idx_test]

    log_debug(
        f"Validazione modelli: {len(idx_train)} esempi per allenare,"
        f" {len(idx_test)} per l'esame."
    )

    def _valuta_target(y, con_formula_tempo=False):
        """Allena e valuta i tre modelli su un target (durata o potenza)."""
        y_train, y_test = y.iloc[idx_train], y.iloc[idx_test]

        modelli = {
            NOME_XGB: modello_factory(),
            NOME_LINEARE: LinearRegression(),
            NOME_MEDIA: DummyRegressor(strategy="mean"),
        }
        risultati = {}
        for nome, modello in modelli.items():
            modello.fit(X_train, y_train)
            risultati[nome] = _metriche(y_test, modello.predict(X_test))

        # Sovra-adattamento: se il modello va molto peggio sull'esame che sui
        # dati già visti, sta "imparando a memoria" invece di generalizzare
        # (confronto tra l'R² sui dati di allenamento e quello sull'esame).
        risultati[NOME_XGB]["r2_train"] = float(
            r2_score(y_train, modelli[NOME_XGB].predict(X_train))
        )

        if con_formula_tempo:
            # Riferimento "senza ML": durata = quantità / velocità. Dice quanto
            # si otterrebbe conoscendo già la formula fisica del processo.
            formula = X_test["Quantita_m2"] / X_test["Velocita"]
            risultati[NOME_FORMULA] = _metriche(y_test, formula)

        return risultati

    return {
        "n_train": int(len(idx_train)),
        "n_test": int(len(idx_test)),
        "test_size": float(test_size),
        "seed_split": split_seed,
        "tempo_h": _valuta_target(y_tempo, con_formula_tempo=True),
        "potenza_kw": _valuta_target(y_potenza),
        "media_tempo_h": float(y_tempo.iloc[idx_test].mean()),
        "media_potenza_kw": float(y_potenza.iloc[idx_test].mean()),
    }


def stampa_report(ris):
    """Stampa un riepilogo leggibile della validazione."""
    nomi = {
        NOME_XGB: "XGBoost (il nostro modello)",
        NOME_LINEARE: "Regressione lineare (semplice)",
        NOME_MEDIA: "Sempre la media (inutile)",
        NOME_FORMULA: "Formula fisica q/v (senza ML)",
    }
    print(
        f"\nValidazione: {ris['n_train']} esempi per allenare,"
        f" {ris['n_test']} per l'esame (seed {ris['seed_split']})"
    )
    for chiave, titolo, unita in (
        ("tempo_h", "DURATA", "h"),
        ("potenza_kw", "POTENZA", "kW"),
    ):
        print(f"\n--- {titolo} ---")
        print(f"{'Modello':36s} {'MAE ('+unita+')':>10s} {'MAE %':>8s} {'R²':>8s}")
        for nome, m in ris[chiave].items():
            print(
                f"{nomi.get(nome, nome):36s} {m['mae']:10.4f}"
                f" {m['mae_pct']:7.2f}% {m['r2']:8.4f}"
            )
        r2_tr = ris[chiave][NOME_XGB]["r2_train"]
        r2_te = ris[chiave][NOME_XGB]["r2"]
        print(f"XGBoost: R² sui dati di allenamento {r2_tr:.4f}"
              f" vs sull'esame {r2_te:.4f}")


if __name__ == "__main__":
    # Uso da solo: genera lo storico con il seed di config.json e stampa il report
    from data_generator import DataGenerator
    from config import load_config

    cfg = load_config()
    seed = cfg["ml_config"].get("NP_SEED")
    gen = DataGenerator(seed=seed)
    df_hist = gen.genera_storico_globale()
    prods, _ = gen.estrai_ordini_giornalieri(df_hist)
    stampa_report(valida_modelli(df_hist, prods, seed=seed))
