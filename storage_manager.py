"""Salvataggio e caricamento delle sessioni.

Ogni ottimizzazione viene salvata come file JSON nella cartella
salvataggi_pareto: contiene baseline, soluzioni, validazione dei modelli,
convergenza e tempi di calcolo. La dashboard può ricaricarla in seguito
senza rifare i calcoli.
"""
import glob
import json
import os
import time
import numpy as np
from config import PARETO_SAVE_DIR, log_debug


class NpEncoder(json.JSONEncoder):
    """Permette di salvare in JSON i numeri e gli array di numpy."""

    def default(self, obj):
        if isinstance(obj, (np.integer, np.floating)):
            return float(obj) if isinstance(obj, np.floating) else int(obj)
        if isinstance(obj, np.ndarray):
            return obj.tolist()
        return super().default(obj)


class StorageManager:
    """Funzioni per salvare, elencare e caricare le sessioni."""

    @staticmethod
    def salva_sessione(data_dict):
        """Salva una sessione con data e ora nel nome del file
        (session_AAAAMMGG_HHMMSS.json). Il nome, senza estensione, viene
        scritto anche nella sessione (chiave "session_id"): la dashboard lo
        usa per dare nomi riconoscibili ai file esportati."""
        timestamp = time.strftime("%Y%m%d_%H%M%S")
        data_dict["session_id"] = f"session_{timestamp}"
        filepath = os.path.join(PARETO_SAVE_DIR, f"session_{timestamp}.json")
        with open(filepath, "w") as f:
            json.dump(data_dict, f, indent=2, cls=NpEncoder)
        log_debug(f"Sessione salvata in: {filepath}")
        return filepath

    @staticmethod
    def elenca_sessioni():
        """Elenca le sessioni salvate, dalla più recente, per la dashboard."""
        if not os.path.exists(PARETO_SAVE_DIR):
            os.makedirs(PARETO_SAVE_DIR, exist_ok=True)
            return []

        # Dalla più recente per data di modifica (i nomi sono cambiati da
        # "sessione_..." a "session_...", quindi l'ordine alfabetico non basta)
        file_salvati = sorted(
            glob.glob(os.path.join(PARETO_SAVE_DIR, "*.json")),
            key=os.path.getmtime, reverse=True,
        )
        sessioni = []

        for filepath in file_salvati:
            filename = os.path.basename(filepath)
            mtime = os.path.getmtime(filepath)
            data_creazione = time.strftime(
                "%Y-%m-%d %H:%M:%S", time.localtime(mtime)
            )
            sessioni.append(
                {"filename": filename, "data_creazione": data_creazione}
            )

        return sessioni

    @staticmethod
    def carica_sessione(filename: str):
        """Carica una sessione dal nome del file; None se non esiste."""
        filepath = os.path.join(PARETO_SAVE_DIR, filename)
        if not os.path.exists(filepath):
            log_debug(f"File non trovato: {filepath}")
            return None

        log_debug(f"Caricamento file in corso: {filepath}")
        with open(filepath, "r") as f:
            data = json.load(f)

        return data
