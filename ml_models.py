"""Modelli di previsione XGBoost: durata e potenza di una lavorazione.

Due modelli separati imparano dallo storico:
  - durata (ore) di una lavorazione;
  - potenza media assorbita (kW) durante la lavorazione;
in funzione di prodotto, macchina, velocità e quantità. Lo scheduler li usa
per sapere, per ogni schedulazione provata da NSGA-II, quanto dura ogni fase
e quanta energia consuma, senza dover conoscere le formule fisiche.
"""
import warnings

import numpy as np
import pandas as pd
import xgboost as xgb
from config import log_debug, MACCHINE

# Colonne da prevedere (target) e colonne da non usare come input. Il tempo di
# setup è escluso dagli input perché al momento della previsione non è noto:
# lo scheduler lo gestisce a parte (media storica per coppia prodotto/macchina).
# Se restasse tra gli input, il modello imparerebbe da una colonna che in uso
# reale varrebbe sempre 0.
TARGET_TEMPO = "Tempo_h"
TARGET_POTENZA = "Potenza_kW"
COLONNE_ESCLUSE_DALLE_FEATURE = [TARGET_TEMPO, TARGET_POTENZA, "Tempo_Setup_h"]


def crea_modello_xgb():
    """Crea un regressore XGBoost con gli iperparametri del progetto.

    È l'unico punto in cui si definiscono: addestramento e validazione usano
    quindi esattamente lo stesso modello.
    """
    # 25 alberi di profondità massima 3: un modello piccolo, veloce da allenare,
    # sufficiente per questi dati (vedi la validazione). n_jobs=-1 usa tutti i
    # core della CPU; random_state rende il risultato ripetibile.
    return xgb.XGBRegressor(
        n_estimators=25, max_depth=3, n_jobs=-1, random_state=42
    )


def prepara_dataset(df_hist_global, prodotti_giornalieri):
    """Trasforma lo storico in (X, y_tempo, y_potenza) pronti per il modello.

    - tiene solo i prodotti di interesse;
    - trasforma prodotto e macchina in colonne 0/1 (one-hot), perché i modelli
      lavorano con numeri e non con etichette come "P_12" o "MAC_03".
    """
    df_hist = df_hist_global[
        df_hist_global["ID_Prodotto"].isin(prodotti_giornalieri)
    ].copy()

    # Categorie fissate in anticipo: le colonne one-hot sono sempre le stesse
    # anche se un prodotto/macchina non compare in qualche sottoinsieme.
    df_hist["ID_Prodotto"] = pd.Categorical(
        df_hist["ID_Prodotto"], categories=prodotti_giornalieri
    )
    df_hist["ID_Macchina"] = pd.Categorical(
        df_hist["ID_Macchina"], categories=MACCHINE
    )

    df_encoded = pd.get_dummies(
        df_hist, columns=["ID_Prodotto", "ID_Macchina"]
    )

    X = df_encoded.drop(columns=COLONNE_ESCLUSE_DALLE_FEATURE)
    return X, df_encoded[TARGET_TEMPO], df_encoded[TARGET_POTENZA]


class XGBoostPredictor:
    """I due modelli (durata e potenza) allenati sui prodotti del giorno."""

    def __init__(self):
        self.model_tempo = crea_modello_xgb()
        self.model_potenza = crea_modello_xgb()
        self.feature_columns = []
        # Prodotti e macchine sconosciuti già segnalati (un avviso ciascuno)
        self.sconosciuti = set()

    def _segnala_sconosciuto(self, tipo, valore):
        """Avvisa, una volta sola, se si chiede una previsione per un prodotto
        o una macchina mai visti in addestramento. In quel caso la colonna 0/1
        corrispondente non esiste e il modello risponde "alla cieca", come per
        un prodotto generico: il risultato non è affidabile.
        """
        chiave = (tipo, valore)
        if chiave in self.sconosciuti:
            return
        self.sconosciuti.add(chiave)
        warnings.warn(
            f"XGBoost: {tipo} '{valore}' non presente nei dati di addestramento: "
            "le previsioni per questo elemento non sono affidabili.",
            stacklevel=3,
        )

    def train_on_demand(self, df_hist_global, prodotti_giornalieri):
        """Allena i due modelli solo sullo storico dei prodotti del giorno.

        Limitare l'addestramento ai prodotti che servono lo rende più veloce
        e concentra il modello sui casi che dovrà davvero prevedere.
        """
        log_debug("Filtraggio dello storico e addestramento mirato di XGBoost...")
        X, y_tempo, y_potenza = prepara_dataset(
            df_hist_global, prodotti_giornalieri
        )
        self.feature_columns = list(X.columns)

        self.model_tempo.fit(X, y_tempo)
        self.model_potenza.fit(X, y_potenza)
        log_debug("Addestramento di XGBoost completato.")

    def predict_many(self, requests_list):
        """Prevede durata e potenza di molte lavorazioni in una volta sola.

        requests_list: lista di dizionari
            {"p_id": prodotto, "m_id": macchina, "v_val": velocità, "q_val": quantità}.
        Restituisce due array: durate (h) e potenze (kW), nello stesso ordine.
        Una sola chiamata al modello per tutte le richieste è molto più veloce
        di una chiamata per lavorazione.
        """
        # Tabella con le stesse colonne usate in addestramento, costruita
        # colonna per colonna (più veloce che riga per riga): velocità,
        # quantità e le colonne 0/1 di prodotto e macchina, tutte a 0 all'inizio
        n = len(requests_list)
        colonne = {c: np.zeros(n, dtype=np.int64) for c in self.feature_columns}
        colonne["Velocita"] = np.array([r["v_val"] for r in requests_list], dtype=float)
        colonne["Quantita_m2"] = np.array([r["q_val"] for r in requests_list], dtype=float)

        # Un 1 nella colonna del prodotto e in quella della macchina
        for i, req in enumerate(requests_list):
            for tipo, colonna in (("prodotto", f"ID_Prodotto_{req['p_id']}"),
                                  ("macchina", f"ID_Macchina_{req['m_id']}")):
                if colonna in colonne:
                    colonne[colonna][i] = 1
                else:
                    self._segnala_sconosciuto(tipo, req["p_id" if tipo == "prodotto" else "m_id"])

        X_input = pd.DataFrame(colonne, columns=self.feature_columns)
        durate = self.model_tempo.predict(X_input)
        potenze = self.model_potenza.predict(X_input)

        return durate, potenze
