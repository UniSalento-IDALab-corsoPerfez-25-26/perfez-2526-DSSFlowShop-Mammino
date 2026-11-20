"""Configurazione del progetto: percorsi, macchine, parametri e log.

I parametri modificabili stanno in config.json (anche dalla pagina
"Configura" della dashboard). Qui ci sono le costanti fisse del progetto e le
funzioni per leggere la configurazione.
"""
import json
import os

CONFIG_PATH = os.path.join(os.path.dirname(__file__), "config.json")

# Messaggi di debug in console: False per disattivarli tutti
DEBUG = True

# Il flow shop ha 4 macchine in serie: ogni ordine passa da MAC_01 a MAC_04
MACCHINE = [f"MAC_{j:02d}" for j in range(1, 5)]
N_MACCHINE = len(MACCHINE)

# Cartella in cui vengono salvate le sessioni (risultati delle ottimizzazioni)
PARETO_SAVE_DIR = "salvataggi_pareto"
os.makedirs(PARETO_SAVE_DIR, exist_ok=True)


def load_config():
    """Legge config.json. Viene chiamata a ogni ottimizzazione, quindi le
    modifiche fatte da "Configura" valgono subito, senza riavviare il server."""
    with open(CONFIG_PATH, "r", encoding="utf-8") as f:
        return json.load(f)


def log_debug(message: str):
    """Stampa un messaggio di debug, solo se DEBUG è attivo."""
    if DEBUG:
        print(f"[DEBUG] {message}")
